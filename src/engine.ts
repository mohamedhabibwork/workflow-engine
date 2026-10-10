import { createDefaultRegistry } from './builtins.js';
import { evaluate } from './conditions.js';
import { WorkflowRunContext } from './context.js';
import {
  ActionError,
  DefinitionError,
  UnknownActionTypeError,
  WorkflowError,
  errorMessage,
  serializeError,
} from './errors.js';
import type { ErrorLocation } from './errors.js';
import { WorkflowEventEmitter, createEvent } from './events.js';
import type { WorkflowEvent, WorkflowEventName, WorkflowEventListener } from './events.js';
import { randomId } from './ids.js';
import { consoleLogger } from './logger.js';
import type { Logger } from './logger.js';
import { PolicyRegistry, evaluateDefinitionPolicies, evaluatePolicies } from './policies.js';
import type { ActionRegistry } from './registry.js';
import { MapResolver } from './resolver.js';
import type { WorkflowResolver } from './resolver.js';
import { MemoryStorage } from './storage/memory-storage.js';
import type { WorkflowStorage } from './storage/types.js';
import { RunTracker, START_POSITION, createRunState, snapshotOf } from './state.js';
import type { RunPosition, RunState } from './state.js';
import { sleep } from './time.js';
import type {
  ActionDefinition,
  ActionHandler,
  ActionInput,
  Condition,
  Metadata,
  PolicyEvaluationReport,
  PolicyHandler,
  PolicyReference,
  RegisteredAction,
  RegisteredPolicy,
  RunResult,
  SerializedError,
  StageDefinition,
  StepDefinition,
  WorkflowDefinition,
  WorkflowVars,
} from './types.js';
import { validateWorkflowDefinition } from './validate.js';

export interface EngineOptions {
  /** Where definitions come from. Default: in-memory MapResolver. */
  resolver?: WorkflowResolver;
  /** Action type handlers. Default: the six built-ins. */
  registry?: ActionRegistry;
  /** Named policy handlers. Default: empty registry. */
  policies?: PolicyRegistry;
  /** Run persistence. Default: MemoryStorage. */
  storage?: WorkflowStorage;
  /** Logger injected into run contexts. Default: console. */
  logger?: Logger;
  /** Emitter for lifecycle events. Default: fresh emitter. */
  emitter?: WorkflowEventEmitter;
}

interface StepCursor<TVars extends WorkflowVars> {
  readonly ctx: WorkflowRunContext<TVars>;
  readonly stage: StageDefinition<TVars>;
  readonly step: StepDefinition<TVars>;
}

interface Launch<TVars extends WorkflowVars> {
  state: RunState<TVars>;
  resumed: boolean;
}

/** Everything the stage/step runners need, bundled to keep signatures small. */
interface RunScope<TVars extends WorkflowVars> {
  ctx: WorkflowRunContext<TVars>;
  tracker: RunTracker<TVars>;
  start: RunPosition;
}

/**
 * Runs workflows: stages in order, steps in order, actions in order, each
 * guarded by its pre-condition. Every completed action is checkpointed so
 * failed or interrupted runs can resume exactly where they stopped.
 */
export class WorkflowEngine {
  private readonly resolver: WorkflowResolver;
  private readonly registry: ActionRegistry;
  private readonly policyRegistry: PolicyRegistry;
  private readonly storage: WorkflowStorage;
  private readonly logger: Logger;
  private readonly emitter: WorkflowEventEmitter;

  constructor(options: EngineOptions = {}) {
    this.resolver = options.resolver ?? new MapResolver();
    this.registry = options.registry ?? createDefaultRegistry();
    this.policyRegistry = options.policies ?? new PolicyRegistry();
    this.storage = options.storage ?? new MemoryStorage();
    this.logger = options.logger ?? consoleLogger;
    this.emitter = options.emitter ?? new WorkflowEventEmitter();
  }

  registerPolicy(name: string, handler: PolicyHandler): this;
  registerPolicy(policy: RegisteredPolicy): this;
  registerPolicy(nameOrPolicy: string | RegisteredPolicy, handler?: PolicyHandler): this {
    if (typeof nameOrPolicy === 'string') {
      if (handler !== undefined) {
        this.policyRegistry.register(nameOrPolicy, handler);
      }
    } else {
      this.policyRegistry.register(nameOrPolicy.name, nameOrPolicy.handler);
    }
    return this;
  }

  register(type: string, handler: ActionHandler): this;
  register(action: RegisteredAction): this;
  register(typeOrAction: string | RegisteredAction, handler?: ActionHandler): this {
    if (typeof typeOrAction === 'string') {
      if (handler !== undefined) {
        this.registry.register(typeOrAction, handler);
      }
    } else {
      this.registry.register(typeOrAction.type, typeOrAction.handler);
    }
    return this;
  }

  /** Validates a definition and registers it on the default resolver. */
  define<TVars extends WorkflowVars>(definition: WorkflowDefinition<TVars>): this {
    validateWorkflowDefinition(definition);
    if (!(this.resolver instanceof MapResolver)) {
      throw new DefinitionError(
        `engine.define() writes into the default MapResolver, but this engine uses a custom ` +
          `resolver — register "${definition.name}" on your resolver instead`,
      );
    }
    this.resolver.add(definition);
    return this;
  }

  /**
   * Runs a workflow by name (resolved through the resolver) or by definition.
   * Execution failures are reported through the returned result
   * (`status: "failed"` + `error`), not by rejecting.
   */
  async run<TVars extends WorkflowVars = WorkflowVars>(
    nameOrDefinition: string | WorkflowDefinition<TVars>,
    input?: Partial<TVars>,
  ): Promise<RunResult<TVars>> {
    const definition = await this.resolveDefinition(nameOrDefinition);
    validateWorkflowDefinition(definition);
    const vars = { ...definition.initialContext, ...input } as TVars;
    const state = createRunState<TVars>({
      runId: randomId(),
      workflowName: definition.name,
      workflowMetadata: definition.metadata ?? {},
      vars,
    });
    return this.execute(definition, { state, resumed: false });
  }

  /**
   * Continues a stored run from its last checkpoint. Terminal runs return
   * their recorded result without executing anything.
   */
  async resume<TVars extends WorkflowVars = WorkflowVars>(
    runId: string,
  ): Promise<RunResult<TVars>> {
    const stored = await this.storage.getRun(runId);
    if (stored === null) {
      throw new WorkflowError(`Run "${runId}" was not found in storage`);
    }
    const state = stored as RunState<TVars>;
    if (state.status !== 'running' && state.status !== 'failed') {
      return this.toRunResult(state);
    }
    const definition = await this.resolveDefinition(state.workflowName);
    validateWorkflowDefinition(definition);
    return this.execute(definition as WorkflowDefinition<TVars>, { state, resumed: true });
  }

  /**
   * Evaluates policies without running anything: returns a nested report of
   * every workflow/stage/step/action level plus a flat `actions` list where
   * each entry's `isEnabled` is the cascaded verdict of all four levels.
   * Nothing is persisted and no events are emitted.
   */
  async evaluate<TVars extends WorkflowVars = WorkflowVars>(
    nameOrDefinition: string | WorkflowDefinition<TVars>,
    input?: Partial<TVars>,
  ): Promise<PolicyEvaluationReport> {
    const definition = await this.resolveDefinition(nameOrDefinition);
    validateWorkflowDefinition(definition);
    const vars = { ...definition.initialContext, ...input } as TVars;
    const ctx = new WorkflowRunContext<TVars>({
      runId: randomId(),
      workflowName: definition.name,
      workflowMetadata: definition.metadata ?? {},
      logger: this.logger,
      vars,
    });
    return evaluateDefinitionPolicies(definition, this.policyRegistry, ctx);
  }

  on(event: WorkflowEventName, listener: WorkflowEventListener): this {
    this.emitter.on(event, listener);
    return this;
  }

  onAny(listener: WorkflowEventListener): this {
    this.emitter.onAny(listener);
    return this;
  }

  off(event: WorkflowEventName, listener: WorkflowEventListener): this {
    this.emitter.off(event, listener);
    return this;
  }

  offAny(listener: WorkflowEventListener): this {
    this.emitter.offAny(listener);
    return this;
  }

  private async resolveDefinition<TVars extends WorkflowVars>(
    nameOrDefinition: string | WorkflowDefinition<TVars>,
  ): Promise<WorkflowDefinition<TVars>> {
    if (typeof nameOrDefinition !== 'string') return nameOrDefinition;
    return (await this.resolver.resolve(nameOrDefinition)) as WorkflowDefinition<TVars>;
  }

  private async execute<TVars extends WorkflowVars>(
    definition: WorkflowDefinition<TVars>,
    launch: Launch<TVars>,
  ): Promise<RunResult<TVars>> {
    const ctx = new WorkflowRunContext<TVars>({
      runId: launch.state.runId,
      workflowName: definition.name,
      workflowMetadata: launch.state.workflowMetadata,
      logger: this.logger,
      vars: launch.state.vars,
      results: launch.state.results,
    });
    const tracker = new RunTracker(launch.state, this.storage, this.emitter);
    try {
      if (!launch.resumed && (await this.beginWorkflow(definition, ctx, tracker))) {
        return this.toRunResult(tracker.current);
      }
      await this.runStages(definition, {
        ctx,
        tracker,
        start: launch.resumed ? launch.state.position : START_POSITION,
      });
      await tracker.record(workflowEvent(ctx, 'workflow:end'));
      return this.toRunResult(await tracker.finish('succeeded', undefined, snapshotOf(ctx)));
    } catch (cause) {
      return this.failRun(ctx, tracker, cause);
    }
  }

  /** Returns true when the workflow-level guards skipped the run. */
  private async beginWorkflow<TVars extends WorkflowVars>(
    definition: WorkflowDefinition<TVars>,
    ctx: WorkflowRunContext<TVars>,
    tracker: RunTracker<TVars>,
  ): Promise<boolean> {
    await tracker.record(workflowEvent(ctx, 'workflow:start'));
    const passed = await this.unitAllowed(definition, ctx);
    if (passed) return false;
    await tracker.record(workflowEvent(ctx, 'workflow:skip'));
    await tracker.finish('skipped', undefined, snapshotOf(ctx));
    return true;
  }

  /** Combined guard: the unit's pre-condition and all its policies must pass. */
  private async unitAllowed<TVars extends WorkflowVars>(
    unit: {
      preCondition?: Condition<TVars>;
      policies?: PolicyReference[];
      metadata?: Metadata;
    },
    ctx: WorkflowRunContext<TVars>,
  ): Promise<boolean> {
    const metadata = unit.metadata ?? {};
    const conditionPassed = await evaluate(unit.preCondition, ctx, metadata);
    if (!conditionPassed) return false;
    const verdict = await evaluatePolicies({
      policies: unit.policies,
      registry: this.policyRegistry,
      ctx,
      metadata,
    });
    return verdict.allowed;
  }

  private async failRun<TVars extends WorkflowVars>(
    ctx: WorkflowRunContext<TVars>,
    tracker: RunTracker<TVars>,
    cause: unknown,
  ): Promise<RunResult<TVars>> {
    const error = serializeError(cause);
    await tracker.record(workflowEvent(ctx, 'workflow:fail', error));
    return this.toRunResult(await tracker.finish('failed', error, snapshotOf(ctx)));
  }

  private async runStages<TVars extends WorkflowVars>(
    definition: WorkflowDefinition<TVars>,
    scope: RunScope<TVars>,
  ): Promise<void> {
    const { ctx, tracker, start } = scope;
    for (
      let stageIndex = start.stageIndex;
      stageIndex < definition.stages.length;
      stageIndex += 1
    ) {
      const stage = definition.stages[stageIndex];
      if (stage === undefined) break;
      const continuing = stageIndex === start.stageIndex && start.stepIndex > 0;
      if (!continuing) {
        const passed = await this.unitAllowed(stage, ctx);
        if (!passed) {
          await tracker.record(stageEvent(ctx, stage, 'stage:skip'));
          continue;
        }
        await tracker.record(stageEvent(ctx, stage, 'stage:start'));
      }
      const stepStart = continuing ? start.stepIndex : 0;
      await this.runSteps(stage, scope, { stageIndex, stepStart });
      await tracker.record(stageEvent(ctx, stage, 'stage:end'));
    }
  }

  private async runSteps<TVars extends WorkflowVars>(
    stage: StageDefinition<TVars>,
    scope: RunScope<TVars>,
    route: { stageIndex: number; stepStart: number },
  ): Promise<void> {
    const { ctx, tracker, start } = scope;
    for (let stepIndex = route.stepStart; stepIndex < stage.steps.length; stepIndex += 1) {
      const step = stage.steps[stepIndex];
      if (step === undefined) break;
      const continuing =
        route.stageIndex === start.stageIndex &&
        stepIndex === start.stepIndex &&
        start.actionIndex > 0;
      if (!continuing) {
        const passed = await this.unitAllowed(step, ctx);
        if (!passed) {
          await tracker.record(stepEvent({ ctx, stage, step }, 'step:skip'));
          await tracker.checkpoint(
            { stageIndex: route.stageIndex, stepIndex: stepIndex + 1, actionIndex: 0 },
            snapshotOf(ctx),
          );
          continue;
        }
        await tracker.record(stepEvent({ ctx, stage, step }, 'step:start'));
      }
      await this.runActions({ ctx, stage, step }, tracker, {
        stageIndex: route.stageIndex,
        stepIndex,
        actionStart: continuing ? start.actionIndex : 0,
      });
      await tracker.checkpoint(
        { stageIndex: route.stageIndex, stepIndex: stepIndex + 1, actionIndex: 0 },
        snapshotOf(ctx),
      );
    }
  }

  private async runActions<TVars extends WorkflowVars>(
    cursor: StepCursor<TVars>,
    tracker: RunTracker<TVars>,
    route: { stageIndex: number; stepIndex: number; actionStart: number },
  ): Promise<void> {
    const { step } = cursor;
    let lastResult: unknown;
    for (let actionIndex = route.actionStart; actionIndex < step.actions.length; actionIndex += 1) {
      const action = step.actions[actionIndex];
      if (action === undefined) break;
      const metadata = action.metadata ?? {};
      const passed = await this.unitAllowed(action, cursor.ctx);
      if (!passed) {
        await tracker.record(actionEvent(cursor, action, 'action:skip'));
        await tracker.checkpoint(
          {
            stageIndex: route.stageIndex,
            stepIndex: route.stepIndex,
            actionIndex: actionIndex + 1,
          },
          snapshotOf(cursor.ctx),
        );
        continue;
      }
      await tracker.record(actionEvent(cursor, action, 'action:start'));
      const handler = this.registry.get(action.type);
      if (handler === undefined) {
        throw new UnknownActionTypeError(action.type, this.locationOf(cursor, action));
      }
      const input: ActionInput = { config: action.config ?? {}, metadata };
      try {
        lastResult = await runWithRetries(
          () => handler(input, cursor.ctx),
          step.retries ?? 0,
          step.retryDelayMs ?? 0,
        );
      } catch (cause) {
        await this.handleActionFailure(cursor, tracker, { action, cause });
        return;
      }
      // Record before checkpointing so a crash between the two cannot lose the value.
      cursor.ctx.recordResult(step.name, lastResult);
      await tracker.record(actionEvent(cursor, action, 'action:end'));
      await tracker.checkpoint(
        { stageIndex: route.stageIndex, stepIndex: route.stepIndex, actionIndex: actionIndex + 1 },
        snapshotOf(cursor.ctx),
      );
    }
    await tracker.record(stepEvent(cursor, 'step:end'));
  }

  private async handleActionFailure<TVars extends WorkflowVars>(
    cursor: StepCursor<TVars>,
    tracker: RunTracker<TVars>,
    failure: { action: ActionDefinition<TVars>; cause: unknown },
  ): Promise<void> {
    const { action, cause } = failure;
    const error = serializeError(cause);
    await tracker.record(actionFailed(cursor, action, error));
    await tracker.record(stepEvent(cursor, 'step:fail', error));
    if (cursor.step.onFailure !== 'skip') {
      const attempts = String((cursor.step.retries ?? 0) + 1);
      throw new ActionError(
        `Action "${actionLabel(action)}" of step "${cursor.step.name}" failed after ${attempts} attempt(s): ${errorMessage(cause)}`,
        this.locationOf(cursor, action),
        { cause },
      );
    }
  }

  private locationOf<TVars extends WorkflowVars>(
    cursor: StepCursor<TVars>,
    action: ActionDefinition<TVars>,
  ): ErrorLocation {
    return {
      runId: cursor.ctx.runId,
      stage: cursor.stage.name,
      step: cursor.step.name,
      action: actionLabel(action),
    };
  }

  private toRunResult<TVars extends WorkflowVars>(state: RunState<TVars>): RunResult<TVars> {
    return {
      runId: state.runId,
      workflowName: state.workflowName,
      status: state.status,
      workflowMetadata: state.workflowMetadata,
      vars: state.vars,
      results: state.results,
      history: [...state.history],
      error: state.error,
    };
  }
}

function actionLabel<TVars extends WorkflowVars>(action: ActionDefinition<TVars>): string {
  return action.name ?? action.type;
}

async function runWithRetries(
  attempt: () => unknown,
  retries: number,
  delayMs: number,
): Promise<unknown> {
  const totalAttempts = retries + 1;
  let lastError: unknown;
  for (let tryIndex = 0; tryIndex < totalAttempts; tryIndex += 1) {
    try {
      return await attempt();
    } catch (cause) {
      lastError = cause;
      const hasAttemptsLeft = tryIndex < totalAttempts - 1;
      if (delayMs > 0 && hasAttemptsLeft) await sleep(delayMs);
    }
  }
  throw lastError;
}

function workflowEvent<TVars extends WorkflowVars>(
  ctx: WorkflowRunContext<TVars>,
  event: WorkflowEventName,
  error?: SerializedError,
): WorkflowEvent {
  return createEvent({
    event,
    runId: ctx.runId,
    workflowName: ctx.workflowName,
    unit: 'workflow',
    metadata: { ...ctx.workflowMetadata },
    error,
  });
}

function stageEvent<TVars extends WorkflowVars>(
  ctx: WorkflowRunContext<TVars>,
  stage: StageDefinition<TVars>,
  event: WorkflowEventName,
): WorkflowEvent {
  return createEvent({
    event,
    runId: ctx.runId,
    workflowName: ctx.workflowName,
    unit: 'stage',
    stage: stage.name,
    metadata: stage.metadata ?? {},
  });
}

function stepEvent<TVars extends WorkflowVars>(
  cursor: StepCursor<TVars>,
  event: WorkflowEventName,
  error?: SerializedError,
): WorkflowEvent {
  return createEvent({
    event,
    runId: cursor.ctx.runId,
    workflowName: cursor.ctx.workflowName,
    unit: 'step',
    stage: cursor.stage.name,
    step: cursor.step.name,
    metadata: cursor.step.metadata ?? {},
    error,
  });
}

function actionEvent<TVars extends WorkflowVars>(
  cursor: StepCursor<TVars>,
  action: ActionDefinition<TVars>,
  event: WorkflowEventName,
): WorkflowEvent {
  return createEvent({
    event,
    runId: cursor.ctx.runId,
    workflowName: cursor.ctx.workflowName,
    unit: 'action',
    stage: cursor.stage.name,
    step: cursor.step.name,
    action: actionLabel(action),
    metadata: action.metadata ?? {},
  });
}

function actionFailed<TVars extends WorkflowVars>(
  cursor: StepCursor<TVars>,
  action: ActionDefinition<TVars>,
  error: SerializedError,
): WorkflowEvent {
  return { ...actionEvent(cursor, action, 'action:fail'), error };
}
