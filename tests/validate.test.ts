import { describe, expect, it } from 'vitest';
import { DefinitionError, validateWorkflowDefinition } from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

const valid: WorkflowDefinition = {
  name: 'valid',
  stages: [
    {
      name: 'stage',
      steps: [{ name: 'step', actions: [{ type: 'set', config: { key: 'k', value: 1 } }] }],
    },
  ],
};

function expectInvalid(definition: unknown, message: string): void {
  expect(() => {
    validateWorkflowDefinition(definition as WorkflowDefinition);
  }).toThrow(new DefinitionError(message));
}

describe('validateWorkflowDefinition', () => {
  it('accepts a valid definition', () => {
    expect(() => {
      validateWorkflowDefinition(valid);
    }).not.toThrow();
  });

  it('rejects a missing or empty workflow name', () => {
    expectInvalid({ stages: [] }, 'Workflow definition requires a non-empty "name" string');
    expectInvalid(
      { name: '', stages: [] },
      'Workflow definition requires a non-empty "name" string',
    );
  });

  it('rejects a workflow without stages', () => {
    expectInvalid({ name: 'x', stages: [] }, 'Workflow "x" requires at least one stage');
    expectInvalid({ name: 'x' }, 'Workflow "x" requires at least one stage');
  });

  it('rejects a stage without a name', () => {
    expectInvalid(
      { name: 'x', stages: [{ name: '', steps: [{ name: 's', actions: [{ type: 't' }] }] }] },
      'Stage 0 of "x" requires a non-empty "name" string',
    );
  });

  it('rejects a stage without steps', () => {
    expectInvalid(
      { name: 'x', stages: [{ name: 'empty-stage', steps: [] }] },
      'Stage "empty-stage" requires at least one step',
    );
  });

  it('rejects a step without a name', () => {
    expectInvalid(
      { name: 'x', stages: [{ name: 's', steps: [{ name: '', actions: [{ type: 't' }] }] }] },
      'Steps of stage "s" require a "name" string',
    );
  });

  it('rejects duplicate step names across the workflow', () => {
    expectInvalid(
      {
        name: 'x',
        stages: [
          { name: 's1', steps: [{ name: 'dup', actions: [{ type: 't' }] }] },
          { name: 's2', steps: [{ name: 'dup', actions: [{ type: 't' }] }] },
        ],
      },
      'Duplicate step name "dup" in workflow "x"; step names must be unique',
    );
  });

  it('rejects a step without actions', () => {
    expectInvalid(
      { name: 'x', stages: [{ name: 's', steps: [{ name: 'idle', actions: [] }] }] },
      'Step "idle" requires at least one action',
    );
  });

  it('rejects actions without a type', () => {
    expectInvalid(
      { name: 'x', stages: [{ name: 's', steps: [{ name: 't', actions: [{}] }] }] },
      'Action 0 of step "t" requires a "type" string',
    );
  });
});
