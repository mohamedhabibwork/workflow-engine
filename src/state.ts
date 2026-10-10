import type { WorkflowRunContext } from './context.js';
import type { WorkflowEventEmitter, WorkflowEvent } from './events.js';
import type { WorkflowStorage } from './storage/types.js';
import type { Metadata, RunStatus, SerializedError, WorkflowVars } from './types.js';

/** Position of the next action to execute inside the definition. */
export interface RunPosition {
  stageIndex: number;
  stepIndex: number;
  actionIndex: number;
}

/** Persisted, resumable snapshot of a workflow run. */
export interface RunState<TVars extends WorkflowVars = WorkflowVars> {
  runId: string;
  workflowName: string;
  workflowMetadata: Metadata;
  status: RunStatus;
  position: RunPosition;
  vars: TVars;
  results: Record<string, unknown>;
  history: WorkflowEvent[];
  startedAt: string;
  updatedAt: string;
  error?: SerializedError;
}

export const START_POSITION: RunPosition = { stageIndex: 0, stepIndex: 0, actionIndex: 0 };

export interface RunStateInit<TVars extends WorkflowVars> {
  runId: string;
  workflowName: string;
  workflowMetadata: Metadata;
  vars: TVars;
}

/** Creates the initial state of a fresh run. */
export function createRunState<TVars extends WorkflowVars>(
  init: RunStateInit<TVars>,
): RunState<TVars> {
  const now = new Date().toISOString();
  return {
    runId: init.runId,
    workflowName: init.workflowName,
    workflowMetadata: init.workflowMetadata,
    status: 'running',
    position: { ...START_POSITION },
    vars: init.vars,
    results: {},
    history: [],
    startedAt: now,
    updatedAt: now,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Pure transition: moves the position forward for the next execution pass. */
export function advance<TVars extends WorkflowVars>(
  state: RunState<TVars>,
  position: RunPosition,
): RunState<TVars> {
  return { ...state, position: { ...position }, updatedAt: nowIso() };
}

/** Pure transition: appends an event to the run history. */
export function withEvent<TVars extends WorkflowVars>(
  state: RunState<TVars>,
  event: WorkflowEvent,
): RunState<TVars> {
  return { ...state, history: [...state.history, event], updatedAt: nowIso() };
}

/** Pure transition: settles the run's final status. */
export function settle<TVars extends WorkflowVars>(
  state: RunState<TVars>,
  status: RunStatus,
  error?: SerializedError,
): RunState<TVars> {
  return { ...state, status, error, updatedAt: nowIso() };
}

/** Mutable run data captured from the context at checkpoint time. */
export interface RunSnapshot<TVars extends WorkflowVars> {
  vars: TVars;
  results: Record<string, unknown>;
}

/**
 * Mutates a run snapshot through pure transitions and mirrors every change
 * into the storage and the event emitter. The engine's single write path.
 */
export class RunTracker<TVars extends WorkflowVars = WorkflowVars> {
  private state: RunState<TVars>;

  constructor(
    initial: RunState<TVars>,
    private readonly storage: WorkflowStorage,
    private readonly emitter: WorkflowEventEmitter,
  ) {
    this.state = initial;
  }

  get current(): Readonly<RunState<TVars>> {
    return this.state;
  }

  /** Records an event in history, emits it and persists the snapshot. */
  async record(event: WorkflowEvent): Promise<void> {
    this.state = withEvent(this.state, event);
    this.emitter.emit(event);
    await this.storage.saveRun(this.state);
  }

  /** Persists the execution position and the latest context state. */
  async checkpoint(position: RunPosition, snapshot?: RunSnapshot<TVars>): Promise<void> {
    this.state = {
      ...advance(this.state, position),
      ...(snapshot === undefined ? {} : { vars: snapshot.vars, results: snapshot.results }),
    };
    await this.storage.saveRun(this.state);
  }

  /** Persists the final status and returns the settled snapshot. */
  async finish(
    status: RunStatus,
    error?: SerializedError,
    snapshot?: RunSnapshot<TVars>,
  ): Promise<RunState<TVars>> {
    this.state = {
      ...settle(this.state, status, error),
      ...(snapshot === undefined ? {} : { vars: snapshot.vars, results: snapshot.results }),
    };
    await this.storage.saveRun(this.state);
    return this.state;
  }
}

/** Captures the context's vars and step results for persistence. */
export function snapshotOf<TVars extends WorkflowVars>(
  ctx: WorkflowRunContext<TVars>,
): RunSnapshot<TVars> {
  return { vars: ctx.toVars(), results: ctx.toResults() };
}
