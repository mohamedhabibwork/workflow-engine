import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStorage, MemoryStorage, createEngine, silentLogger } from '../src/index.js';
import type { RunState, WorkflowStorage } from '../src/index.js';

function sampleRun(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'run-42',
    workflowName: 'flow',
    workflowMetadata: { tag: 'x' },
    status: 'running',
    position: { stageIndex: 0, stepIndex: 1, actionIndex: 2 },
    vars: { userId: 'u1' },
    results: { first: 'ok' },
    history: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('MemoryStorage', () => {
  it('round-trips run states', async () => {
    const storage = new MemoryStorage();
    await storage.saveRun(sampleRun());
    expect(await storage.getRun('run-42')).toEqual(sampleRun());
    expect(await storage.getRun('missing')).toBeNull();
  });

  it('filters listRuns by workflow and status', async () => {
    const storage = new MemoryStorage();
    await storage.saveRun(sampleRun({ runId: 'a', workflowName: 'one', status: 'failed' }));
    await storage.saveRun(sampleRun({ runId: 'b', workflowName: 'two', status: 'succeeded' }));
    await storage.saveRun(sampleRun({ runId: 'c', workflowName: 'one', status: 'succeeded' }));

    expect((await storage.listRuns()).map((run) => run.runId).sort()).toEqual(['a', 'b', 'c']);
    expect(
      (await storage.listRuns({ workflowName: 'one' })).map((run) => run.runId).sort(),
    ).toEqual(['a', 'c']);
    expect(
      (await storage.listRuns({ status: 'succeeded' })).map((run) => run.runId).sort(),
    ).toEqual(['b', 'c']);
    expect(await storage.listRuns({ workflowName: 'nope' })).toEqual([]);
  });

  it('deletes runs', async () => {
    const storage = new MemoryStorage();
    await storage.saveRun(sampleRun());
    await storage.deleteRun('run-42');
    expect(await storage.getRun('run-42')).toBeNull();
    await expect(storage.deleteRun('run-42')).resolves.toBeUndefined();
  });

  it('isolates callers from stored state (deep copies)', async () => {
    const storage = new MemoryStorage();
    await storage.saveRun(sampleRun());
    const loaded = await storage.getRun('run-42');
    if (loaded === null) throw new Error('run should exist');
    loaded.vars.userId = 'mutated';
    loaded.position.stageIndex = 9;
    expect((await storage.getRun('run-42'))?.vars.userId).toBe('u1');
    expect((await storage.getRun('run-42'))?.position.stageIndex).toBe(0);
  });
});

describe('JsonFileStorage', () => {
  const tempDirs: string[] = [];
  afterAll(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  });

  async function freshStorage(): Promise<JsonFileStorage> {
    const dir = await mkdtemp(join(tmpdir(), 'workflow-engine-'));
    tempDirs.push(dir);
    return new JsonFileStorage({ directory: dir, pretty: true });
  }

  it('persists and reloads run states', async () => {
    const storage = await freshStorage();
    await storage.saveRun(sampleRun());
    expect(await storage.getRun('run-42')).toEqual(sampleRun());
    expect(await storage.getRun('missing')).toBeNull();
  });

  it('lists and filters persisted runs', async () => {
    const storage = await freshStorage();
    await storage.saveRun(
      sampleRun({ runId: 'a', status: 'failed', updatedAt: '2026-01-02T00:00:00.000Z' }),
    );
    await storage.saveRun(
      sampleRun({ runId: 'b', status: 'succeeded', updatedAt: '2026-01-03T00:00:00.000Z' }),
    );
    expect((await storage.listRuns()).map((run) => run.runId)).toEqual(['b', 'a']);
    expect((await storage.listRuns({ status: 'failed' })).map((run) => run.runId)).toEqual(['a']);
  });

  it('deletes persisted runs and tolerates missing directories', async () => {
    const storage = await freshStorage();
    await storage.saveRun(sampleRun());
    await storage.deleteRun('run-42');
    expect(await storage.getRun('run-42')).toBeNull();
    expect(await storage.listRuns()).toEqual([]);
  });

  it('sanitizes unsafe run ids in file names', async () => {
    const storage = await freshStorage();
    await storage.saveRun(sampleRun({ runId: '../escape-attempt' }));
    const all = await storage.listRuns();
    expect(all.map((run) => run.runId)).toEqual(['../escape-attempt']);
    const runs = await storage.listRuns();
    expect(runs.length).toBe(1);
  });
});

describe('engine checkpointing', () => {
  it('persists a snapshot after every action', async () => {
    const saves: RunState[] = [];
    const inner = new MemoryStorage();
    const counting: WorkflowStorage = {
      saveRun: async (state) => {
        saves.push(state);
        await inner.saveRun(state);
      },
      getRun: (runId) => inner.getRun(runId),
      listRuns: (filter) => inner.listRuns(filter),
      deleteRun: (runId) => inner.deleteRun(runId),
    };

    const engine = createEngine({ logger: silentLogger, storage: counting });
    engine.define({
      name: 'checkpoints',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 't',
              actions: [
                { type: 'set', config: { key: 'a', value: 1 } },
                { type: 'set', config: { key: 'b', value: 2 } },
              ],
            },
          ],
        },
      ],
    });

    const result = await engine.run('checkpoints');

    // 2 action-end checkpoints + lifecycle events + final status, all persisted.
    expect(saves.length).toBeGreaterThanOrEqual(8);
    expect(saves.some((state) => state.position.actionIndex === 1)).toBe(true);
    expect(saves.some((state) => state.position.actionIndex === 2)).toBe(true);
    expect(result.status).toBe('succeeded');
  });
});
