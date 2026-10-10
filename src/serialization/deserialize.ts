import { DefinitionError } from '../errors.js';
import type {
  ActionDefinition,
  Condition,
  PolicyReference,
  StageDefinition,
  StepDefinition,
  WorkflowDefinition,
  WorkflowVars,
} from '../types.js';
import { validateWorkflowDefinition } from '../validate.js';
import { spec } from './conditions.js';
import type { SerializedCondition } from './types.js';
import { WORKFLOW_FORMAT } from './types.js';

/**
 * Rebuilds a runnable workflow definition from its portable form: every
 * declarative condition spec is compiled into a real condition function and
 * the result is validated. Throws `DefinitionError` on unknown `$format`
 * markers, malformed specs, or invalid structure.
 */
export function deserializeWorkflow<TVars extends WorkflowVars = WorkflowVars>(
  serialized: unknown,
): WorkflowDefinition<TVars> {
  const record = requireRecord(serialized, 'workflow');
  checkFormatMarker(record);
  const definition = buildWorkflow(record);
  validateWorkflowDefinition(definition);
  return definition as WorkflowDefinition<TVars>;
}

function buildWorkflow(record: Record<string, unknown>): WorkflowDefinition {
  const name = requireString(record['name'], 'name');
  return {
    name,
    version: optionalString(record['version'], 'version'),
    metadata: optionalRecord(record['metadata'], 'metadata'),
    initialContext: optionalRecord(record['initialContext'], 'initialContext'),
    preCondition: optionalCondition(record['preCondition'], 'preCondition'),
    policies: optionalPolicies(record['policies'], 'policies'),
    stages: requireArray(record['stages'], 'stages').map((stage, index) =>
      buildStage(stage, `stages[${String(index)}]`),
    ),
  };
}

function buildStage(value: unknown, path: string): StageDefinition {
  const record = requireRecord(value, path);
  return {
    name: requireString(record['name'], `${path}.name`),
    metadata: optionalRecord(record['metadata'], `${path}.metadata`),
    preCondition: optionalCondition(record['preCondition'], `${path}.preCondition`),
    policies: optionalPolicies(record['policies'], `${path}.policies`),
    steps: requireArray(record['steps'], `${path}.steps`).map((step, index) =>
      buildStep(step, `${path}.steps[${String(index)}]`),
    ),
  };
}

function buildStep(value: unknown, path: string): StepDefinition {
  const record = requireRecord(value, path);
  return {
    name: requireString(record['name'], `${path}.name`),
    metadata: optionalRecord(record['metadata'], `${path}.metadata`),
    preCondition: optionalCondition(record['preCondition'], `${path}.preCondition`),
    policies: optionalPolicies(record['policies'], `${path}.policies`),
    onFailure: optionalFailureMode(record['onFailure'], path),
    retries: optionalNumber(record['retries'], `${path}.retries`),
    retryDelayMs: optionalNumber(record['retryDelayMs'], `${path}.retryDelayMs`),
    actions: requireArray(record['actions'], `${path}.actions`).map((action, index) =>
      buildAction(action, `${path}.actions[${String(index)}]`),
    ),
  };
}

function buildAction(value: unknown, path: string): ActionDefinition {
  const record = requireRecord(value, path);
  return {
    name: optionalString(record['name'], `${path}.name`),
    type: requireString(record['type'], `${path}.type`),
    config: optionalRecord(record['config'], `${path}.config`),
    preCondition: optionalCondition(record['preCondition'], `${path}.preCondition`),
    policies: optionalPolicies(record['policies'], `${path}.policies`),
    metadata: optionalRecord(record['metadata'], `${path}.metadata`),
  };
}

function checkFormatMarker(record: Record<string, unknown>): void {
  const format = record['$format'];
  if (format === undefined) return;
  if (format !== WORKFLOW_FORMAT) {
    throw new DefinitionError(
      `Unsupported $format "${String(format)}"; expected "${WORKFLOW_FORMAT}"`,
    );
  }
}

function optionalCondition(value: unknown, path: string): Condition | undefined {
  if (value === undefined) return undefined;
  try {
    // spec() compiles and attaches the spec, keeping parsed definitions
    // losslessly re-serializable.
    return spec(value as SerializedCondition);
  } catch (cause) {
    if (cause instanceof DefinitionError) throw cause;
    throw new DefinitionError(`${path}: ${String(cause)}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DefinitionError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DefinitionError(`${path} must be an array`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new DefinitionError(`${path} must be a string`);
  return value;
}

function requireString(value: unknown, path: string): string {
  const text = optionalString(value, path);
  if (text === undefined || text.length === 0) {
    throw new DefinitionError(`${path} must be a non-empty string`);
  }
  return text;
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DefinitionError(`${path} must be a finite number`);
  }
  return value;
}

function optionalFailureMode(value: unknown, path: string): 'fail' | 'skip' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'fail' && value !== 'skip') {
    throw new DefinitionError(`${path} must be "fail" or "skip"`);
  }
  return value;
}

function optionalRecord(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, path);
}

function optionalPolicies(value: unknown, path: string): PolicyReference[] | undefined {
  if (value === undefined) return undefined;
  return requireArray(value, path) as PolicyReference[];
}
