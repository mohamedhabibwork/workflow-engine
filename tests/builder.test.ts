import { describe, expect, it } from 'vitest';
import { workflowBuilder } from '../src/index.js';
import type { StageDefinition, StepDefinition } from '../src/index.js';

describe('workflowBuilder', () => {
  it('produces the same shape as a plain definition', () => {
    const condition = () => true;
    const built = workflowBuilder<{ userId: string }>('order-flow')
      .meta({ domain: 'orders' })
      .vars({ userId: '' })
      .version('2.1.0')
      .preCondition((ctx) => ctx.get('userId') !== '')
      .stage('process', (stage) =>
        stage.meta({ sla: '1h' }).step('charge', (step) =>
          step
            .meta({ critical: true })
            .preCondition(condition)
            .retries(2)
            .retryDelayMs(500)
            .onFailure('fail')
            .action('http', { method: 'POST', url: '/charge' })
            .action({ type: 'log', config: { message: 'done' }, metadata: { tag: 'audit' } }),
        ),
      )
      .build();

    expect(built.name).toBe('order-flow');
    expect(built.version).toBe('2.1.0');
    expect(built.metadata).toEqual({ domain: 'orders' });
    expect(built.initialContext).toEqual({ userId: '' });
    expect(built.preCondition).toBeInstanceOf(Function);

    const stage: StageDefinition<{ userId: string }> | undefined = built.stages[0];
    expect(stage?.name).toBe('process');
    expect(stage?.metadata).toEqual({ sla: '1h' });

    const step: StepDefinition<{ userId: string }> | undefined = stage?.steps[0];
    expect(step?.name).toBe('charge');
    expect(step?.metadata).toEqual({ critical: true });
    expect(step?.retries).toBe(2);
    expect(step?.retryDelayMs).toBe(500);
    expect(step?.onFailure).toBe('fail');
    expect(step?.actions).toEqual([
      { type: 'http', config: { method: 'POST', url: '/charge' } },
      { type: 'log', config: { message: 'done' }, metadata: { tag: 'audit' } },
    ]);
  });

  it('accepts plain definitions in place of builder callbacks', () => {
    const plainStep: StepDefinition = {
      name: 'plain-step',
      actions: [{ type: 'set', config: { key: 'k', value: 'v' } }],
    };
    const plainStage: StageDefinition = { name: 'plain-stage', steps: [plainStep] };

    const built = workflowBuilder('mixed')
      .stage(plainStage)
      .stage('callback', (stage) => stage.step('renamed'))
      .build();

    expect(built.stages[0]).toBe(plainStage);
    expect(built.stages[1]?.steps[0]?.name).toBe('renamed');
  });

  it('merges repeated meta calls and vars calls', () => {
    const built = workflowBuilder<{ a?: number; b?: number }>('merge')
      .meta({ one: 1 })
      .meta({ two: 2 })
      .vars({ a: 1 })
      .vars({ b: 2 })
      .stage('s', (stage) => stage.step('t', (step) => step.action('log', { message: 'x' })))
      .build();

    expect(built.metadata).toEqual({ one: 1, two: 2 });
    expect(built.initialContext).toEqual({ a: 1, b: 2 });
  });

  it('supports action definitions without config', () => {
    const built = workflowBuilder('no-config')
      .stage('s', (stage) =>
        stage.step('t', (step) => step.action('ping').action('named', { m: 1 })),
      )
      .build();
    expect(built.stages[0]?.steps[0]?.actions).toEqual([
      { type: 'ping', config: undefined },
      { type: 'named', config: { m: 1 } },
    ]);
  });
});
