import type { RunState } from '../state.js';
import type { RunFilter, WorkflowStorage } from './types.js';

/**
 * Storage backed by a Map. Runs are deep-copied in and out so callers can
 * never mutate engine state through a storage handle. Default adapter.
 */
export class MemoryStorage implements WorkflowStorage {
  private readonly runs = new Map<string, RunState>();

  saveRun(state: RunState): Promise<void> {
    this.runs.set(state.runId, structuredClone(state));
    return Promise.resolve();
  }

  getRun(runId: string): Promise<RunState | null> {
    return Promise.resolve(structuredClone(this.runs.get(runId) ?? null));
  }

  listRuns(filter?: RunFilter): Promise<RunState[]> {
    const all = [...this.runs.values()]
      .filter((run) => matchesFilter(run, filter))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((run) => structuredClone(run));
    return Promise.resolve(all);
  }

  deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
    return Promise.resolve();
  }
}

function matchesFilter(run: RunState, filter?: RunFilter): boolean {
  if (filter === undefined) return true;
  if (filter.workflowName !== undefined && run.workflowName !== filter.workflowName) {
    return false;
  }
  return filter.status === undefined || run.status === filter.status;
}

export function memoryStorage(): MemoryStorage {
  return new MemoryStorage();
}
