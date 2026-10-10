import { describe, expect, it } from 'vitest';
import {
  DefinitionError,
  createEngine,
  definePolicy,
  silentLogger,
  workflowBuilder,
} from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

function policyEngine() {
  const engine = createEngine({ logger: silentLogger });
  const seen: Array<{ policy: string; config: unknown; metadata: unknown }> = [];
  engine.registerPolicy('licensed', (input, ctx) => ctx.get('licensed') === true);
  engine.registerPolicy('maintenance', () => false);
  engine.registerPolicy('inspector', ({ config, metadata }) => {
    seen.push({ policy: 'inspector', config, metadata });
    return true;
  });
  return { engine, seen };
}

describe('runtime policy enforcement', () => {
  it('skips the whole workflow when a workflow-level policy denies', async () => {
    const { engine } = policyEngine();
    engine.define({
      name: 'gated',
      policies: ['licensed'],
      stages: [
        {
          name: 's',
          steps: [{ name: 't', actions: [{ type: 'set', config: { key: 'k', value: 1 } }] }],
        },
      ],
    });

    const denied = await engine.run('gated');
    expect(denied.status).toBe('skipped');
    expect(denied.history.map((entry) => entry.event)).toEqual(['workflow:start', 'workflow:skip']);

    const allowed = await engine.run('gated', { licensed: true });
    expect(allowed.status).toBe('succeeded');
    expect((allowed.vars as Record<string, unknown>)['k']).toBe(1);
  });

  it('skips a denied stage but keeps later stages running', async () => {
    const order: string[] = [];
    const { engine } = policyEngine();
    engine.define({
      name: 'stages',
      initialContext: { licensed: true },
      stages: [
        {
          name: 'blocked',
          policies: ['maintenance'],
          steps: [
            {
              name: 'never',
              actions: [{ type: 'inline', config: { run: () => void order.push('never') } }],
            },
          ],
        },
        {
          name: 'open',
          steps: [
            {
              name: 'runs',
              actions: [{ type: 'inline', config: { run: () => void order.push('runs') } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('stages');
    expect(result.status).toBe('succeeded');
    expect(order).toEqual(['runs']);
    expect(result.history).toContainEqual(
      expect.objectContaining({ event: 'stage:skip', stage: 'blocked' }),
    );
  });

  it('skips a denied step and a denied action independently', async () => {
    const order: string[] = [];
    const { engine } = policyEngine();
    engine.define({
      name: 'units',
      initialContext: { licensed: true },
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'blocked-step',
              policies: ['maintenance'],
              actions: [{ type: 'inline', config: { run: () => void order.push('blocked-step') } }],
            },
            {
              name: 'mixed',
              actions: [
                {
                  name: 'blocked-action',
                  type: 'inline',
                  policies: ['maintenance'],
                  config: { run: () => void order.push('blocked-action') },
                },
                { type: 'inline', config: { run: () => 'kept' } },
              ],
            },
          ],
        },
      ],
    });

    const result = await engine.run('units');
    expect(order).toEqual([]);
    expect(result.status).toBe('succeeded');
    expect(result.results['mixed']).toBe('kept');
    expect(result.results['blocked-step']).toBeUndefined();
    expect(result.history).toContainEqual(
      expect.objectContaining({ event: 'action:skip', action: 'blocked-action' }),
    );
  });

  it('enforces pre-conditions and policies together', async () => {
    const order: string[] = [];
    const { engine } = policyEngine();
    engine.define({
      name: 'both-guards',
      initialContext: { licensed: true },
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 'condition-fails',
              preCondition: () => false,
              policies: ['licensed'],
              actions: [{ type: 'inline', config: { run: () => void order.push('nope') } }],
            },
            {
              name: 'policy-fails',
              preCondition: () => true,
              policies: ['maintenance'],
              actions: [{ type: 'inline', config: { run: () => void order.push('nope') } }],
            },
            {
              name: 'both-pass',
              preCondition: () => true,
              policies: ['licensed'],
              actions: [{ type: 'inline', config: { run: () => void order.push('yes') } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('both-guards');
    expect(order).toEqual(['yes']);
    expect(result.status).toBe('succeeded');
  });

  it('supports async policies and parameterized config with unit metadata', async () => {
    const { engine, seen } = policyEngine();
    engine.registerPolicy('budget', async ({ config }) => {
      const limit = Number(config['maxCents'] ?? 0);
      await Promise.resolve();
      return limit >= 2000;
    });
    engine.define({
      name: 'parameterized',
      stages: [
        {
          name: 'payment',
          steps: [
            {
              name: 'charge',
              metadata: { tenant: 'acme' },
              policies: [
                { name: 'inspector', config: { audit: true } },
                { name: 'budget', config: { maxCents: 5000 } },
              ],
              actions: [{ type: 'set', config: { key: 'charged', value: true } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('parameterized');
    expect(result.status).toBe('succeeded');
    expect(result.vars['charged']).toBe(true);
    expect(seen).toEqual([
      { policy: 'inspector', config: { audit: true }, metadata: { tenant: 'acme' } },
    ]);
  });
});

describe('engine.evaluate', () => {
  function licensedFlow(): WorkflowDefinition {
    return workflowBuilder('evaluate-flow')
      .policies(['licensed'])
      .vars({ licensed: false })
      .stage('visible', (stage) =>
        stage.step('view', (step) => step.action('log', { message: 'view' })),
      )
      .stage('approval', (stage) =>
        stage
          .policies(['maintenance'])
          .step('approve', (step) =>
            step
              .action('log', { message: 'approve' })
              .action({ name: 'sign', type: 'log', config: { message: 'sign' } }),
          ),
      )
      .build();
  }

  it('returns a flat actions list with effective isEnabled verdicts', async () => {
    const { engine } = policyEngine();
    engine.define(licensedFlow());

    const report = await engine.evaluate('evaluate-flow');

    expect(report.workflowName).toBe('evaluate-flow');
    expect(report.actions).toHaveLength(3);
    const entries = report.actions.map((entry) => [entry.action, entry.isEnabled]);
    // Workflow policy denies (licensed=false), so every action is disabled.
    expect(entries).toEqual([
      ['log', false],
      ['log', false],
      ['sign', false],
    ]);
  });

  it('cascades level verdicts into action isEnabled', async () => {
    const { engine } = policyEngine();
    engine.define(licensedFlow());

    const report = await engine.evaluate('evaluate-flow', { licensed: true });

    expect(report.workflow.isEnabled).toBe(true);
    const approvalStage = report.workflow.stages?.find((stage) => stage.name === 'approval');
    expect(approvalStage?.isEnabled).toBe(false); // maintenance policy denies

    const entries = report.actions.map((entry) => [entry.step, entry.action, entry.isEnabled]);
    expect(entries).toEqual([
      ['view', 'log', true], // all levels allow
      ['approve', 'log', false], // stage denied
      ['approve', 'sign', false], // stage denied
    ]);
  });

  it('reports per-policy results explaining each verdict', async () => {
    const { engine } = policyEngine();
    engine.define(
      workflowBuilder('explained')
        .policies(['licensed', 'maintenance'])
        .stage('s', (stage) => stage.step('t', (step) => step.action('log', { message: 'x' })))
        .build(),
    );

    const report = await engine.evaluate('explained', { licensed: true });
    expect(report.workflow.policies).toContainEqual({ policy: 'licensed', allowed: true });
    expect(report.workflow.policies).toContainEqual({ policy: 'maintenance', allowed: false });
    expect(report.workflow.isEnabled).toBe(false);
    expect(report.actions[0]?.isEnabled).toBe(false);
  });

  it('works with a definition passed by value', async () => {
    const { engine } = policyEngine();
    const report = await engine.evaluate(licensedFlow(), { licensed: true });
    expect(report.actions[0]?.isEnabled).toBe(true);
  });
});

describe('policy errors', () => {
  it('surfaces an unknown policy as a failed run', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'unknown-policy',
      policies: ['ghost'],
      stages: [
        {
          name: 's',
          steps: [{ name: 't', actions: [{ type: 'set', config: { key: 'k', value: 1 } }] }],
        },
      ],
    });

    const result = await engine.run('unknown-policy');
    expect(result.status).toBe('failed');
    expect(result.error?.name).toBe('UnknownPolicyError');
  });

  it('rejects evaluate() with UnknownPolicyError', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'unknown-policy',
      policies: ['ghost'],
      stages: [
        {
          name: 's',
          steps: [{ name: 't', actions: [{ type: 'set', config: { key: 'k', value: 1 } }] }],
        },
      ],
    });
    await expect(engine.evaluate('unknown-policy')).rejects.toThrow('Unknown policy "ghost"');
  });

  it('rejects malformed policy references with DefinitionError', () => {
    const engine = createEngine({ logger: silentLogger });
    expect(() =>
      engine.define({
        name: 'bad-policies',
        stages: [
          {
            name: 's',
            policies: [42 as unknown as string],
            steps: [{ name: 't', actions: [{ type: 'set', config: { key: 'k', value: 1 } }] }],
          },
        ],
      }),
    ).toThrow(DefinitionError);
  });
});

describe('definePolicy and registerPolicy overloads', () => {
  it('registers a typed policy object and by name+handler', async () => {
    const engine = createEngine({ logger: silentLogger });
    const hoursPolicy = definePolicy<{ open: number; close: number }>(
      'business-hours',
      ({ config }, ctx) => {
        const hour = Number(ctx.get('hour') ?? 0);
        return hour >= config.open && hour < config.close;
      },
    );
    engine.registerPolicy(hoursPolicy);
    engine.registerPolicy('always', () => true);

    engine.define({
      name: 'overloads',
      initialContext: { hour: 14 },
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 't',
              policies: [{ name: 'business-hours', config: { open: 9, close: 17 } }, 'always'],
              actions: [{ type: 'set', config: { key: 'ok', value: true } }],
            },
          ],
        },
      ],
    });

    const result = await engine.run('overloads');
    expect(result.status).toBe('succeeded');
    expect(result.vars['ok']).toBe(true);

    const report = await engine.evaluate('overloads', { hour: 20 });
    expect(report.actions[0]?.isEnabled).toBe(false);
  });
});
