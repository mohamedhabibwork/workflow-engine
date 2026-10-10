import { DefinitionError } from './errors.js';
import type { WorkflowDefinition, WorkflowVars } from './types.js';

interface StageContext {
  workflowName: string;
  index: number;
  stepNames: Set<string>;
}

interface StepContext {
  workflowName: string;
  stageName: string;
  stepNames: Set<string>;
}

/** Narrows an untrusted value to a record without asserting its shape. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Validates the shape of a workflow definition before it is used. Types are
 * checked defensively because definitions may arrive from untyped sources
 * (JSON, databases) where TypeScript's guarantees do not apply.
 */
export function validateWorkflowDefinition<TVars extends WorkflowVars>(
  definition: WorkflowDefinition<TVars>,
): void {
  const record = asRecord(definition);
  const name = record?.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new DefinitionError('Workflow definition requires a non-empty "name" string');
  }
  const stages = record?.stages;
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new DefinitionError(`Workflow "${name}" requires at least one stage`);
  }
  validatePolicies(record?.policies, `workflow "${name}"`);
  const stepNames = new Set<string>();
  stages.forEach((stage, index) => {
    validateStage(stage, { workflowName: name, index, stepNames });
  });
}

function validateStage(stage: unknown, context: StageContext): void {
  const record = asRecord(stage);
  const name = record?.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new DefinitionError(
      `Stage ${String(context.index)} of "${context.workflowName}" requires a non-empty "name" string`,
    );
  }
  const steps = record?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new DefinitionError(`Stage "${name}" requires at least one step`);
  }
  validatePolicies(record?.policies, `stage "${name}"`);
  steps.forEach((step) => {
    validateStep(step, {
      workflowName: context.workflowName,
      stageName: name,
      stepNames: context.stepNames,
    });
  });
}

function validateStep(step: unknown, context: StepContext): void {
  const record = asRecord(step);
  const name = record?.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new DefinitionError(`Steps of stage "${context.stageName}" require a "name" string`);
  }
  if (context.stepNames.has(name)) {
    throw new DefinitionError(
      `Duplicate step name "${name}" in workflow "${context.workflowName}"; step names must be unique`,
    );
  }
  context.stepNames.add(name);
  const actions = record?.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new DefinitionError(`Step "${name}" requires at least one action`);
  }
  validatePolicies(record?.policies, `step "${name}"`);
  actions.forEach((action, actionIndex) => {
    const actionRecord = asRecord(action);
    const type = actionRecord?.type;
    if (typeof type !== 'string' || type.length === 0) {
      throw new DefinitionError(
        `Action ${String(actionIndex)} of step "${name}" requires a "type" string`,
      );
    }
    validatePolicies(actionRecord?.policies, `action "${type}" of step "${name}"`);
  });
}

/** Policy references must be non-empty strings or `{ name }` objects. */
function validatePolicies(policies: unknown, unitLabel: string): void {
  if (policies === undefined) return;
  if (!Array.isArray(policies)) {
    throw new DefinitionError(`"policies" of ${unitLabel} must be an array of policy references`);
  }
  policies.forEach((reference) => {
    const record = asRecord(reference);
    const isName = typeof reference === 'string' && reference.length > 0;
    const isReference =
      record !== undefined && typeof record.name === 'string' && record.name.length > 0;
    if (!isName && !isReference) {
      throw new DefinitionError(
        `Policy references of ${unitLabel} must be non-empty strings or { name } objects`,
      );
    }
  });
}
