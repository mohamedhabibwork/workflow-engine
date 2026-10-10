import { describe, expect, it } from 'vitest';
import { createEngine, silentLogger } from '../src/index.js';
import type { WorkflowEvent } from '../src/index.js';

function newEngine() {
  return createEngine({ logger: silentLogger });
}

describe('WorkflowEngine', () => {
  it('executes stages, steps and actions in definition order', async () => {
    const order: string[] = [];
    const engine = newEngine();
    engine.define({
      name: 'ordered',
      stages: [
        {
          name: 'first-stage',
          steps: [
            {
              name: 'a',
              actions: [{ type: 'inline', config: { run: () => void order.push('a') } }],
            },
            {
              name: 'b',
              actions: [{ type: 'inline', config: { run: () => void order.push('b') } }],
            },
          ],
        },
        {
          name: 'second-stage',
          steps: [
            {
              name: 'c',
              actions: [{ type: 'inline', config: { run: () => void order.push('c') } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('ordered');

    expect(result.status).toBe('succeeded');
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('keys step results by step name using the last action return', async () => {
    const engine = newEngine();
    engine.define({
      name: 'results',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'compute',
              actions: [
                { type: 'set', config: { key: 'tmp', value: 1 } },
                { type: 'inline', config: { run: () => 'final-value' } },
              ],
            },
          ],
        },
      ],
    });

    const result = await engine.run('results');

    expect(result.results.compute).toBe('final-value');
  });

  it('merges initialContext with input and input wins', async () => {
    const engine = newEngine();
    engine.define({
      name: 'vars',
      initialContext: { userId: 'u1', mode: 'default' },
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'snapshot',
              actions: [
                {
                  type: 'inline',
                  config: {
                    run: (ctx: { get: (k: string) => unknown }) => ({
                      userId: ctx.get('userId'),
                      mode: ctx.get('mode'),
                    }),
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const result = await engine.run('vars', { mode: 'override' });

    expect(result.results.snapshot).toEqual({ userId: 'u1', mode: 'override' });
  });

  it('returns a failed result instead of throwing when an action fails', async () => {
    const engine = newEngine();
    engine.define({
      name: 'boom',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'explode',
              actions: [
                {
                  type: 'inline',
                  config: {
                    run: () => {
                      throw new Error('kaboom');
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const result = await engine.run('boom');

    expect(result.status).toBe('failed');
    expect(result.error?.name).toBe('ActionError');
    expect(result.error?.message).toContain('kaboom');
  });

  it('retries failed actions until they succeed', async () => {
    let calls = 0;
    const engine = newEngine();
    engine.register('flaky', () => {
      calls += 1;
      if (calls < 3) throw new Error('not yet');
      return 'ok';
    });
    engine.define({
      name: 'retry',
      stages: [
        {
          name: 's',
          steps: [{ name: 'try', retries: 2, actions: [{ type: 'flaky' }] }],
        },
      ],
    });

    const result = await engine.run('retry');

    expect(result.status).toBe('succeeded');
    expect(calls).toBe(3);
    expect(result.results.try).toBe('ok');
  });

  it('skips failed steps and continues when onFailure is skip', async () => {
    const order: string[] = [];
    const engine = newEngine();
    engine.define({
      name: 'tolerant',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'bad',
              onFailure: 'skip',
              actions: [
                {
                  type: 'inline',
                  config: {
                    run: () => {
                      throw new Error('nope');
                    },
                  },
                },
              ],
            },
            {
              name: 'good',
              actions: [{ type: 'inline', config: { run: () => void order.push('good') } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('tolerant');

    expect(result.status).toBe('succeeded');
    expect(order).toEqual(['good']);
    expect(result.results.bad).toBeUndefined();
    expect(result.history.some((e) => e.event === 'step:fail' && e.step === 'bad')).toBe(true);
  });

  it('emits lifecycle events in execution order', async () => {
    const events: string[] = [];
    const engine = newEngine();
    engine.onAny((event: WorkflowEvent) => void events.push(event.event));
    engine.define({
      name: 'events',
      stages: [
        {
          name: 'stage',
          steps: [{ name: 'step', actions: [{ type: 'set', config: { key: 'k', value: 1 } }] }],
        },
      ],
    });

    await engine.run('events');

    expect(events).toEqual([
      'workflow:start',
      'stage:start',
      'step:start',
      'action:start',
      'action:end',
      'step:end',
      'stage:end',
      'workflow:end',
    ]);
  });

  it('rejects with DefinitionError for an unknown workflow name', async () => {
    const engine = newEngine();
    await expect(engine.run('missing')).rejects.toThrow('Workflow "missing" is not defined');
  });
});
