import type {
  HistoryEntry,
  WorkflowEvent,
  WorkflowEventListener,
  WorkflowEventInput,
  WorkflowEventName,
} from './types.js';

export type {
  WorkflowEvent,
  WorkflowEventInput,
  WorkflowEventName,
  WorkflowEventListener,
  WorkflowUnit,
} from './types.js';

const SUFFIX_INDEX = 1;

const STATUS_BY_SUFFIX: Record<string, HistoryEntry['status']> = {
  start: 'started',
  end: 'succeeded',
  skip: 'skipped',
  fail: 'failed',
};

/** Builds an immutable event with a timestamp and derived status. */
export function createEvent(input: WorkflowEventInput): WorkflowEvent {
  const suffix = input.event.split(':')[SUFFIX_INDEX] ?? '';
  const status = STATUS_BY_SUFFIX[suffix] ?? 'started';
  return {
    ...input,
    status,
    metadata: input.metadata ?? {},
    at: new Date().toISOString(),
  };
}

/** Minimal typed emitter; listeners are synchronous and fire-and-forget. */
export class WorkflowEventEmitter {
  private readonly listeners = new Map<WorkflowEventName, Set<WorkflowEventListener>>();
  private readonly catchAllListeners = new Set<WorkflowEventListener>();

  on(event: WorkflowEventName, listener: WorkflowEventListener): this {
    const bucket = this.listeners.get(event) ?? new Set<WorkflowEventListener>();
    bucket.add(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  /** Subscribes to every event regardless of name. */
  onAny(listener: WorkflowEventListener): this {
    this.catchAllListeners.add(listener);
    return this;
  }

  off(event: WorkflowEventName, listener: WorkflowEventListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  offAny(listener: WorkflowEventListener): this {
    this.catchAllListeners.delete(listener);
    return this;
  }

  emit(event: WorkflowEvent): void {
    for (const listener of this.listeners.get(event.event) ?? []) {
      listener(event);
    }
    for (const listener of this.catchAllListeners) {
      listener(event);
    }
  }
}
