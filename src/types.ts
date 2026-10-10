import type { WorkflowContext } from './context.js';

/** Free-form metadata bag attached to any workflow unit. */
export type Metadata = Record<string, unknown>;

/** Constraint for the per-run variable bag. */
export type WorkflowVars = Record<string, unknown>;

/** Declarative configuration for an action instance. */
export type ActionConfig = Record<string, unknown>;

/**
 * A pre-condition guard. Evaluated before the guarded unit runs with the
 * run context and the unit's own metadata. A falsy result skips the unit.
 */
export type Condition<TVars extends WorkflowVars = WorkflowVars> = (
  ctx: WorkflowContext<TVars>,
  meta: Metadata,
) => boolean | Promise<boolean>;

export interface ActionDefinition<TVars extends WorkflowVars = WorkflowVars> {
  /** Optional display label. Defaults to the action type. */
  name?: string;
  /** Action type resolved through the action registry (e.g. "http", "log"). */
  type: string;
  /** Type-specific configuration passed to the handler. */
  config?: ActionConfig;
  /** Skip this action when the condition resolves falsy. */
  preCondition?: Condition<TVars>;
  /** Named policies that must all allow this action for it to run. */
  policies?: PolicyReference[];
  /** Free-form metadata delivered to handlers and events. */
  metadata?: Metadata;
}

export interface StepDefinition<TVars extends WorkflowVars = WorkflowVars> {
  /** Must be unique across the workflow: step results are keyed by it. */
  name: string;
  /** Skip this step (and its actions) when the condition resolves falsy. */
  preCondition?: Condition<TVars>;
  /** Named policies that must all allow this step for it to run. */
  policies?: PolicyReference[];
  /** Free-form metadata delivered to events and history. */
  metadata?: Metadata;
  /** What happens when every retry of an action fails. Default "fail". */
  onFailure?: 'fail' | 'skip';
  /** Additional attempts after the first failure. Default 0. */
  retries?: number;
  /** Delay between retry attempts in milliseconds. Default 0. */
  retryDelayMs?: number;
  actions: ActionDefinition<TVars>[];
}

export interface StageDefinition<TVars extends WorkflowVars = WorkflowVars> {
  name: string;
  /** Skip this stage (and its steps) when the condition resolves falsy. */
  preCondition?: Condition<TVars>;
  /** Named policies that must all allow this stage for it to run. */
  policies?: PolicyReference[];
  /** Free-form metadata delivered to events and history. */
  metadata?: Metadata;
  steps: StepDefinition<TVars>[];
}

export interface WorkflowDefinition<TVars extends WorkflowVars = WorkflowVars> {
  name: string;
  version?: string;
  /** Initial variable values; merged with (and overridden by) run input. */
  initialContext?: TVars;
  /** Skips the whole run (terminal "skipped" status) when falsy. */
  preCondition?: Condition<TVars>;
  /** Named policies that must all allow the run for it to start. */
  policies?: PolicyReference[];
  /** Free-form metadata available on the context, events and results. */
  metadata?: Metadata;
  stages: StageDefinition<TVars>[];
}

/** What a registered action handler receives, besides the context. */
export interface ActionInput {
  config: ActionConfig;
  metadata: Metadata;
}

/** A named, ready-to-register action produced by `defineAction`. */
export interface RegisteredAction<TVars extends WorkflowVars = WorkflowVars> {
  readonly type: string;
  readonly handler: ActionHandler<TVars>;
}

/** Reference to a registered policy, optionally with per-site config. */
export type PolicyReference = string | { name: string; config?: ActionConfig };

/** What a registered policy handler receives, besides the context. */
export interface PolicyInput {
  config: ActionConfig;
  /** Metadata of the unit referencing the policy. */
  metadata: Metadata;
}

/**
 * Signature of a registered policy handler. Resolving falsy denies the
 * guarded unit; every referenced policy must allow for the unit to run.
 */
export type PolicyHandler<TVars extends WorkflowVars = WorkflowVars> = (
  input: PolicyInput,
  ctx: WorkflowContext<TVars>,
) => boolean | Promise<boolean>;

/** A named, ready-to-register policy produced by `definePolicy`. */
export interface RegisteredPolicy<TVars extends WorkflowVars = WorkflowVars> {
  readonly name: string;
  readonly handler: PolicyHandler<TVars>;
}

/** Verdict of a single referenced policy. */
export interface PolicyResult {
  policy: string;
  allowed: boolean;
}

/** Combined verdict over one unit's referenced policies. */
export interface PolicyVerdict {
  allowed: boolean;
  results: PolicyResult[];
}

/** One node of the nested policy evaluation tree. */
export interface PolicyUnitReport {
  unit: 'workflow' | 'stage' | 'step' | 'action';
  name: string;
  /** True when this level's own policies all allow. */
  isEnabled: boolean;
  policies: PolicyResult[];
  stages?: PolicyUnitReport[];
  steps?: PolicyUnitReport[];
  actions?: PolicyUnitReport[];
}

/** Flat entry: one action with its effective, cascaded verdict. */
export interface PolicyActionEntry {
  stage: string;
  step: string;
  action: string;
  /** Effective verdict: workflow, stage, step and action levels must all allow. */
  isEnabled: boolean;
  policies: PolicyResult[];
}

/** Result of `engine.evaluate()`: nested tree plus the flat action list. */
export interface PolicyEvaluationReport {
  workflowName: string;
  workflow: PolicyUnitReport;
  actions: PolicyActionEntry[];
}

/**
 * Signature every action handler (built-in or custom) follows. Handlers may
 * return a plain value or a promise; the engine awaits both.
 */
export type ActionHandler<TVars extends WorkflowVars = WorkflowVars> = (
  action: ActionInput,
  ctx: WorkflowContext<TVars>,
) => unknown;

/** Lifecycle status of a workflow run. */
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

/** Serializable error information persisted with a run. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export type WorkflowUnit = 'workflow' | 'stage' | 'step' | 'action';

export type WorkflowEventName =
  | 'workflow:start'
  | 'workflow:end'
  | 'workflow:skip'
  | 'workflow:fail'
  | 'stage:start'
  | 'stage:end'
  | 'stage:skip'
  | 'step:start'
  | 'step:end'
  | 'step:skip'
  | 'step:fail'
  | 'action:start'
  | 'action:end'
  | 'action:skip'
  | 'action:fail';

/** A single lifecycle event recorded (and emitted) during a run. */
export interface WorkflowEvent extends HistoryEntry {
  event: WorkflowEventName;
  runId: string;
  workflowName: string;
  error?: SerializedError;
}

export type WorkflowEventListener = (event: WorkflowEvent) => void;

export interface WorkflowEventInput {
  event: WorkflowEventName;
  runId: string;
  workflowName: string;
  unit: WorkflowUnit;
  stage?: string;
  step?: string;
  action?: string;
  metadata?: Metadata;
  error?: SerializedError;
}

/** Final outcome of a workflow run. */
export interface RunResult<TVars extends WorkflowVars = WorkflowVars> {
  runId: string;
  workflowName: string;
  status: RunStatus;
  workflowMetadata: Metadata;
  vars: TVars;
  /** Step name -> return value of the step's last executed action. */
  results: Record<string, unknown>;
  history: readonly WorkflowEvent[];
  error?: SerializedError;
}

/** One recorded lifecycle fact about a run. */
export interface HistoryEntry {
  unit: 'workflow' | 'stage' | 'step' | 'action';
  stage?: string;
  step?: string;
  action?: string;
  status: 'started' | 'succeeded' | 'skipped' | 'failed';
  metadata: Metadata;
  at: string;
}
