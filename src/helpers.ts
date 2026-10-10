import { WorkflowEngine } from './engine.js';
import type { EngineOptions } from './engine.js';
import type { WorkflowContext } from './context.js';
import { consoleLogger } from './logger.js';
import type { Logger, LogLevel } from './logger.js';
import type {
  ActionConfig,
  ActionDefinition,
  ActionHandler,
  Condition,
  Metadata,
  PolicyHandler,
  RegisteredAction,
  RegisteredPolicy,
  WorkflowVars,
} from './types.js';
import type { WorkflowEvent } from './events.js';

/** Engine factory with sane defaults; the README entry point. */
export function createEngine(options: EngineOptions = {}): WorkflowEngine {
  return new WorkflowEngine(options);
}

/** Pre-condition that passes only when every given condition passes. */
export function all<TVars extends WorkflowVars = WorkflowVars>(
  ...conditions: Condition<TVars>[]
): Condition<TVars> {
  return async (ctx, meta) => {
    for (const condition of conditions) {
      if (!(await condition(ctx, meta))) return false;
    }
    return true;
  };
}

/** Pre-condition that passes when any given condition passes. */
export function any<TVars extends WorkflowVars = WorkflowVars>(
  ...conditions: Condition<TVars>[]
): Condition<TVars> {
  return async (ctx, meta) => {
    for (const condition of conditions) {
      if (await condition(ctx, meta)) return true;
    }
    return false;
  };
}

/** Negates a pre-condition. */
export function not<TVars extends WorkflowVars = WorkflowVars>(
  condition: Condition<TVars>,
): Condition<TVars> {
  return async (ctx, meta) => !(await condition(ctx, meta));
}

/**
 * Authors a custom action with a type-safe config. The result is registered
 * with `engine.register(myAction)` (or passed to `register(type, handler)`).
 */
export function defineAction<
  TConfig extends ActionConfig,
  TVars extends WorkflowVars = WorkflowVars,
>(
  type: string,
  handler: (
    action: { config: TConfig; metadata: Metadata },
    ctx: WorkflowContext<TVars>,
  ) => unknown,
): RegisteredAction<TVars> {
  return { type, handler: handler as ActionHandler<TVars> };
}

/** Builds an action definition with a typed config for plain-object authors. */
export function action<TConfig extends ActionConfig>(
  type: string,
  config: TConfig,
): ActionDefinition {
  return { type, config };
}

/**
 * Authors a named policy with a type-safe config. The result is registered
 * with `engine.registerPolicy(myPolicy)` (or `registerPolicy(name, handler)`)
 * and referenced from `policies` arrays on any workflow unit.
 */
export function definePolicy<
  TConfig extends ActionConfig,
  TVars extends WorkflowVars = WorkflowVars,
>(
  name: string,
  handler: (
    input: { config: TConfig; metadata: Metadata },
    ctx: WorkflowContext<TVars>,
  ) => boolean | Promise<boolean>,
): RegisteredPolicy<TVars> {
  return { name, handler: handler as PolicyHandler<TVars> };
}

/** Logs every lifecycle event; returns an unsubscribe function. */
export function logEvents(engine: WorkflowEngine, logger: Logger = consoleLogger): () => void {
  const listener = (event: WorkflowEvent): void => {
    const level: LogLevel = event.status === 'failed' ? 'error' : 'info';
    logger[level](describeEvent(event), { runId: event.runId, metadata: event.metadata });
  };
  engine.onAny(listener);
  return () => engine.offAny(listener);
}

function describeEvent(event: WorkflowEvent): string {
  const location = [event.stage, event.step, event.action].filter(Boolean).join(' > ');
  const scope = location.length > 0 ? ` (${location})` : '';
  const suffix = event.event.split(':')[SUFFIX_INDEX] ?? event.event;
  return `${event.workflowName}${scope}: ${suffix}`;
}

const SUFFIX_INDEX = 1;
