import type { Logger } from './logger.js';
import type { Metadata, WorkflowVars } from './types.js';

/** Read/write view of the run state exposed to conditions and handlers. */
export interface WorkflowContext<TVars extends WorkflowVars = WorkflowVars> {
  readonly runId: string;
  readonly workflowName: string;
  readonly workflowMetadata: Readonly<Metadata>;
  readonly logger: Logger;
  /** Completed step results keyed by step name. */
  readonly results: Readonly<Record<string, unknown>>;
  get<K extends keyof TVars & string>(key: K): TVars[K];
  set<K extends keyof TVars & string>(key: K, value: TVars[K]): void;
}

export interface ContextInit<TVars extends WorkflowVars> {
  runId: string;
  workflowName: string;
  workflowMetadata: Metadata;
  logger: Logger;
  vars: TVars;
  results?: Record<string, unknown>;
}

/**
 * Mutable context implementation used internally by the engine.
 * Conditions and handlers only see the `WorkflowContext` surface.
 */
export class WorkflowRunContext<
  TVars extends WorkflowVars = WorkflowVars,
> implements WorkflowContext<TVars> {
  readonly runId: string;
  readonly workflowName: string;
  readonly workflowMetadata: Readonly<Metadata>;
  readonly logger: Logger;

  private readonly vars: TVars;
  private stepResults: Record<string, unknown>;

  constructor(init: ContextInit<TVars>) {
    this.runId = init.runId;
    this.workflowName = init.workflowName;
    this.workflowMetadata = init.workflowMetadata;
    this.logger = init.logger;
    this.vars = init.vars;
    this.stepResults = init.results ?? {};
  }

  get results(): Readonly<Record<string, unknown>> {
    return this.stepResults;
  }

  get<K extends keyof TVars & string>(key: K): TVars[K] {
    return this.vars[key];
  }

  set<K extends keyof TVars & string>(key: K, value: TVars[K]): void {
    this.vars[key] = value;
  }

  /** Records the outcome of a completed step. */
  recordResult(stepName: string, value: unknown): void {
    this.stepResults = { ...this.stepResults, [stepName]: value };
  }

  /** Copy of the variables for persistence. */
  toVars(): TVars {
    return { ...this.vars };
  }

  /** Copy of the step results for persistence. */
  toResults(): Record<string, unknown> {
    return { ...this.stepResults };
  }
}
