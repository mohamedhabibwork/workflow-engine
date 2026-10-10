import { describe, expect, it } from 'vitest';
import { createEngine, silentLogger } from '../src/index.js';
import type { WorkflowEvent } from '../src/index.js';

describe('metadata propagation', () => {
  it('flows workflow metadata into context, handlers and results', async () => {
    const engine = createEngine({ logger: silentLogger });
    const seen: unknown[] = [];
    engine.register('capture', (action, ctx) => {
      seen.push({ handlerMeta: action.metadata, workflowMeta: ctx.workflowMetadata });
      return 'done';
    });
    engine.define({
      name: 'meta-flow',
      metadata: { tenant: 'acme', version: 3 },
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 't',
              actions: [{ type: 'capture', metadata: { actor: 'scheduler', attempt: 1 } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('meta-flow');

    expect(seen).toEqual([
      {
        handlerMeta: { actor: 'scheduler', attempt: 1 },
        workflowMeta: { tenant: 'acme', version: 3 },
      },
    ]);
    expect(result.workflowMetadata).toEqual({ tenant: 'acme', version: 3 });
  });

  it('carries unit metadata on lifecycle events', async () => {
    const events: WorkflowEvent[] = [];
    const engine = createEngine({ logger: silentLogger });
    engine.onAny((event) => void events.push(event));
    engine.define({
      name: 'meta-events',
      metadata: { domain: 'billing' },
      stages: [
        {
          name: 'stage-1',
          metadata: { region: 'eu' },
          steps: [
            {
              name: 'step-1',
              metadata: { priority: 'high' },
              actions: [
                {
                  name: 'act',
                  type: 'set',
                  metadata: { kind: 'write' },
                  config: { key: 'k', value: 1 },
                },
              ],
            },
          ],
        },
      ],
    });

    await engine.run('meta-events');

    const byEvent = new Map(events.map((event) => [event.event, event]));
    expect(byEvent.get('workflow:start')?.metadata).toEqual({ domain: 'billing' });
    expect(byEvent.get('stage:start')?.metadata).toEqual({ region: 'eu' });
    expect(byEvent.get('step:start')?.metadata).toEqual({ priority: 'high' });
    expect(byEvent.get('action:start')?.metadata).toEqual({ kind: 'write' });
    expect(byEvent.get('action:start')?.action).toBe('act');
  });

  it('records unit metadata in run history', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'meta-history',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 't',
              metadata: { note: 'kept' },
              actions: [{ type: 'inline', config: { run: () => 'v' } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('meta-history');
    const stepStart = result.history.find((entry) => entry.event === 'step:start');
    expect(stepStart?.metadata).toEqual({ note: 'kept' });
    expect(stepStart?.unit).toBe('step');
    expect(typeof stepStart?.at).toBe('string');
  });
});
