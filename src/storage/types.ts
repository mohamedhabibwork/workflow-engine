import type { RunState } from '../state.js';
import type { RunStatus } from '../types.js';

export interface RunFilter {
  workflowName?: string;
  status?: RunStatus;
}

/** Persistence boundary for run snapshots. Implement your own for any DB. */
export interface WorkflowStorage {
  saveRun(state: RunState): Promise<void>;
  getRun(runId: string): Promise<RunState | null>;
  listRuns(filter?: RunFilter): Promise<RunState[]>;
  deleteRun(runId: string): Promise<void>;
}
