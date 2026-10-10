import { describe, expect, it } from 'vitest';
import { WorkflowError, createEngine, silentLogger } from '../src/index.js';

function flakyEngine() {
  const order: string[] = [];
  const engine = createEngine({ logger: silentLogger });
  let shouldFail = true;
  engine.register('flaky', () => {
    if (shouldFail) throw new Error('service unavailable');
    return 'recovered';
  });
  return {
    engine,
    order,
    stopFailing: () => {
      shouldFail = false;
    },
  };
}

describe('resume', () => {
  it('continues a failed run from the last checkpoint', async () => {
    const { engine, order, stopFailing } = flakyEngine();
    engine.define({
      name: 'resumable',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'first',
              actions: [{ type: 'inline', config: { run: () => void order.push('first') } }],
            },
            { name: 'flaky-step', actions: [{ type: 'flaky' }] },
            {
              name: 'third',
              actions: [{ type: 'inline', config: { run: () => void order.push('third') } }],
            },
          ],
        },
      ],
    });

    const failed = await engine.run('resumable');
    expect(failed.status).toBe('failed');
    expect(order).toEqual(['first']);

    stopFailing();
    const resumed = await engine.resume(failed.runId);

    expect(resumed.status).toBe('succeeded');
    expect(order).toEqual(['first', 'third']);
    expect(resumed.results['flaky-step']).toBe('recovered');
    expect(resumed.results.first).toBeUndefined();
  });

  it('preserves vars and earlier step results across resume', async () => {
    const engine = createEngine({ logger: silentLogger });
    let shouldFail = true;
    engine.register('flaky', () => {
      if (shouldFail) throw new Error('down');
      return 'up';
    });
    engine.define({
      name: 'stateful',
      initialContext: { items: 5 },
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'double',
              actions: [
                {
                  type: 'inline',
                  config: {
                    run: (ctx: {
                      get: (k: string) => unknown;
                      set: (k: string, v: unknown) => void;
                    }) => {
                      const items = ctx.get('items');
                      ctx.set('items', items);
                      return items;
                    },
                  },
                },
              ],
            },
            { name: 'risky', actions: [{ type: 'flaky' }] },
          ],
        },
      ],
    });

    const failed = await engine.run('stateful');
    shouldFail = false;
    const resumed = await engine.resume(failed.runId);

    expect(resumed.status).toBe('succeeded');
    expect(resumed.results.double).toBe(5);
    expect(resumed.vars.items).toBe(5);
  });

  it('resumes mid-step without replaying already completed actions', async () => {
    const order: string[] = [];
    const engine = createEngine({ logger: silentLogger });
    let shouldFail = true;
    engine.register('flaky', () => {
      if (shouldFail) throw new Error('mid-step failure');
      return 'later';
    });
    engine.define({
      name: 'mid-step',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'two-actions',
              actions: [
                { type: 'inline', config: { run: () => void order.push('action-one') } },
                { type: 'flaky' },
              ],
            },
          ],
        },
      ],
    });

    const failed = await engine.run('mid-step');
    expect(failed.status).toBe('failed');
    expect(order).toEqual(['action-one']);

    shouldFail = false;
    const resumed = await engine.resume(failed.runId);

    expect(resumed.status).toBe('succeeded');
    expect(order).toEqual(['action-one']); // action-one not replayed
    expect(resumed.results['two-actions']).toBe('later');
  });

  it('rejects resuming an unknown run', async () => {
    const engine = createEngine({ logger: silentLogger });
    await expect(engine.resume('nope')).rejects.toThrow(WorkflowError);
  });

  it('returns the recorded result when resuming a terminal run', async () => {
    const order: string[] = [];
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'terminal',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 't',
              actions: [{ type: 'inline', config: { run: () => void order.push('once') } }],
            },
          ],
        },
      ],
    });

    const first = await engine.run('terminal');
    const second = await engine.resume(first.runId);

    expect(second.status).toBe('succeeded');
    expect(second.runId).toBe(first.runId);
    expect(order).toEqual(['once']);
  });

  it('returns the skipped result when resuming a skipped run', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'skippable',
      preCondition: () => false,
      stages: [
        {
          name: 's',
          steps: [{ name: 't', actions: [{ type: 'set', config: { key: 'k', value: 1 } }] }],
        },
      ],
    });

    const first = await engine.run('skippable');
    const second = await engine.resume(first.runId);

    expect(first.status).toBe('skipped');
    expect(second.status).toBe('skipped');
  });
});
