import { describe, expect, it } from 'vitest';
import { all, any, createEngine, not, silentLogger } from '../src/index.js';
import type { WorkflowContext } from '../src/index.js';

describe('pre-conditions', () => {
  it('skips the whole workflow when the workflow pre-condition is falsy', async () => {
    const order: string[] = [];
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'guarded',
      preCondition: (ctx) => ctx.get('enabled') === true,
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 't',
              actions: [{ type: 'inline', config: { run: () => void order.push('ran') } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('guarded');

    expect(result.status).toBe('skipped');
    expect(order).toEqual([]);
    const names = result.history.map((entry) => entry.event);
    expect(names).toEqual(['workflow:start', 'workflow:skip']);
  });

  it('fails the run with PreconditionError when a pre-condition throws', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'throwing',
      preCondition: () => {
        throw new Error('guard exploded');
      },
      stages: [
        {
          name: 's',
          steps: [{ name: 't', actions: [{ type: 'set', config: { key: 'k', value: 1 } }] }],
        },
      ],
    });

    const result = await engine.run('throwing');

    expect(result.status).toBe('failed');
    expect(result.error?.name).toBe('PreconditionError');
  });

  it('skips a stage and continues with the next one', async () => {
    const order: string[] = [];
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'stages',
      stages: [
        {
          name: 'off',
          preCondition: () => false,
          steps: [
            {
              name: 'nope',
              actions: [{ type: 'inline', config: { run: () => void order.push('nope') } }],
            },
          ],
        },
        {
          name: 'on',
          steps: [
            {
              name: 'yes',
              actions: [{ type: 'inline', config: { run: () => void order.push('yes') } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('stages');

    expect(order).toEqual(['yes']);
    expect(result.history).toContainEqual(
      expect.objectContaining({ event: 'stage:skip', stage: 'off', status: 'skipped' }),
    );
  });

  it('skips a step whose pre-condition is falsy', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'steps',
      initialContext: { vip: false },
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'premium',
              preCondition: (ctx) => ctx.get('vip'),
              actions: [{ type: 'inline', config: { run: () => 'premium' } }],
            },
            { name: 'basic', actions: [{ type: 'inline', config: { run: () => 'basic' } }] },
          ],
        },
      ],
    });

    const result = await engine.run('steps');

    expect(result.status).toBe('succeeded');
    expect(result.results.premium).toBeUndefined();
    expect(result.results.basic).toBe('basic');
    expect(result.history).toContainEqual(
      expect.objectContaining({ event: 'step:skip', step: 'premium' }),
    );
  });

  it('skips a single action but keeps the step running', async () => {
    const order: string[] = [];
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'actions',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 't',
              actions: [
                {
                  name: 'skip-me',
                  type: 'inline',
                  preCondition: () => false,
                  config: { run: () => void order.push('skipped') },
                },
                { type: 'inline', config: { run: () => void order.push('kept') } },
              ],
            },
          ],
        },
      ],
    });

    const result = await engine.run('actions');

    expect(order).toEqual(['kept']);
    expect(result.history).toContainEqual(
      expect.objectContaining({ event: 'action:skip', action: 'skip-me' }),
    );
    expect(result.history).toContainEqual(
      expect.objectContaining({ event: 'step:end', step: 't' }),
    );
  });

  it('supports async pre-conditions', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'async-guard',
      preCondition: async () => true,
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 't',
              preCondition: async () => false,
              actions: [{ type: 'inline', config: { run: () => 'x' } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('async-guard');
    expect(result.status).toBe('succeeded');
    expect(result.results.t).toBeUndefined();
  });

  it('passes the guarded unit metadata to the condition', async () => {
    const seen: Record<string, unknown>[] = [];
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'meta-guard',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'admin-only',
              metadata: { role: 'admin' },
              preCondition: (_ctx: WorkflowContext, meta: Record<string, unknown>) => {
                seen.push(meta);
                return meta.role === 'admin';
              },
              actions: [{ type: 'inline', config: { run: () => 'allowed' } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('meta-guard');
    expect(seen).toEqual([{ role: 'admin' }]);
    expect(result.results['admin-only']).toBe('allowed');
  });
});

describe('condition combinators', () => {
  const truthy = () => true;
  const falsy = () => false;
  const asyncTruthy = async () => true;
  const ctx = undefined as unknown as WorkflowContext;

  it('all requires every condition', async () => {
    expect(await all(truthy, truthy)(ctx, {})).toBe(true);
    expect(await all(truthy, falsy)(ctx, {})).toBe(false);
    expect(await all(truthy, asyncTruthy)(ctx, {})).toBe(true);
  });

  it('any requires at least one condition', async () => {
    expect(await any(falsy, falsy)(ctx, {})).toBe(false);
    expect(await any(falsy, asyncTruthy)(ctx, {})).toBe(true);
  });

  it('not inverts a condition', async () => {
    expect(await not(falsy)(ctx, {})).toBe(true);
    expect(await not(asyncTruthy)(ctx, {})).toBe(false);
  });
});
