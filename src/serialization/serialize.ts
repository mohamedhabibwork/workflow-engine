import { SerializationError } from '../errors.js';
import type {
  ActionDefinition,
  Condition,
  StageDefinition,
  StepDefinition,
  WorkflowDefinition,
  WorkflowVars,
} from '../types.js';
import { conditionSpecOf } from './conditions.js';
import type {
  SerializedAction,
  SerializedCondition,
  SerializedStage,
  SerializedStep,
  SerializedWorkflow,
  SerializeOptions,
} from './types.js';
import { WORKFLOW_FORMAT } from './types.js';

/**
 * Projects a workflow definition into its portable, data-only form.
 * Conditions serialize only when built from a declarative spec; a plain
 * function condition throws `SerializationError` naming its path, or is
 * dropped under `onNonSerializableCondition: "omit"`.
 */
export function serializeWorkflow<TVars extends WorkflowVars>(
  definition: WorkflowDefinition<TVars>,
  options: SerializeOptions = {},
): SerializedWorkflow {
  const policy = options.onNonSerializableCondition ?? 'throw';
  return {
    $format: WORKFLOW_FORMAT,
    name: definition.name,
    version: definition.version,
    metadata: plainOrThrow(definition.metadata, 'metadata', definition.name),
    initialContext: plainOrThrow(definition.initialContext, 'initialContext', definition.name),
    preCondition: serializeCondition(definition.preCondition, 'preCondition', policy),
    policies: definition.policies,
    stages: definition.stages.map((stage, index) =>
      serializeStage(stage, `stages[${String(index)}]`, policy),
    ),
  };
}

function serializeStage<TVars extends WorkflowVars>(
  stage: StageDefinition<TVars>,
  path: string,
  policy: 'throw' | 'omit',
): SerializedStage {
  return {
    name: stage.name,
    metadata: plainOrThrow(stage.metadata, `${path}.metadata`, stage.name),
    preCondition: serializeCondition(stage.preCondition, `${path}.preCondition`, policy),
    policies: stage.policies,
    steps: stage.steps.map((step, index) =>
      serializeStep(step, `${path}.steps[${String(index)}]`, policy),
    ),
  };
}

function serializeStep<TVars extends WorkflowVars>(
  step: StepDefinition<TVars>,
  path: string,
  policy: 'throw' | 'omit',
): SerializedStep {
  return {
    name: step.name,
    metadata: plainOrThrow(step.metadata, `${path}.metadata`, step.name),
    preCondition: serializeCondition(step.preCondition, `${path}.preCondition`, policy),
    policies: step.policies,
    onFailure: step.onFailure,
    retries: step.retries,
    retryDelayMs: step.retryDelayMs,
    actions: step.actions.map((action, index) =>
      serializeAction(action, `${path}.actions[${String(index)}]`, policy),
    ),
  };
}

function serializeAction<TVars extends WorkflowVars>(
  action: ActionDefinition<TVars>,
  path: string,
  policy: 'throw' | 'omit',
): SerializedAction {
  const serialized: SerializedAction = {
    name: action.name,
    type: action.type,
    config: plainOrThrow(action.config, `${path}.config`, action.type),
    preCondition: serializeCondition(action.preCondition, `${path}.preCondition`, policy),
    policies: action.policies,
    metadata: plainOrThrow(action.metadata, `${path}.metadata`, action.type),
  };
  return serialized;
}

function serializeCondition<TVars extends WorkflowVars>(
  condition: Condition<TVars> | undefined,
  path: string,
  policy: 'throw' | 'omit',
): SerializedCondition | undefined {
  if (condition === undefined) return undefined;
  const conditionSpec = conditionSpecOf(condition);
  if (conditionSpec !== undefined) return conditionSpec;
  if (policy === 'omit') return undefined;
  throw new SerializationError(
    `Cannot serialize ${path}: the condition is a plain function with no declarative spec. ` +
      `Build conditions with spec({ ... }) to make them portable, or pass ` +
      `onNonSerializableCondition: "omit" to drop them.`,
  );
}

function plainOrThrow(
  value: unknown,
  path: string,
  unitName: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const offender = findFunction(value, path);
  if (offender !== undefined) {
    throw new SerializationError(
      `Cannot serialize ${offender}: functions are not portable data ` +
        `(workflow "${unitName}"). Move logic into registered actions or declarative conditions.`,
    );
  }
  return value as Record<string, unknown>;
}

function findFunction(value: unknown, path: string): string | undefined {
  if (typeof value === 'function') return path;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findFunction(item, `${path}[${String(index)}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const found = findFunction(item, `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
