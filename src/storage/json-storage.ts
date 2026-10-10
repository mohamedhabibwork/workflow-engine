import type { RunState } from '../state.js';
import type { RunFilter, WorkflowStorage } from './types.js';
import type * as FileSystem from 'node:fs/promises';

export interface JsonFileStorageOptions {
  /** Directory holding one JSON file per run. Default ".workflow-runs". */
  directory?: string;
  /** Pretty-print run files. Default false. */
  pretty?: boolean;
}

const DEFAULT_DIRECTORY = '.workflow-runs';
const UNSAFE_CHARACTERS = /[^a-zA-Z0-9_-]/g;
const JSON_INDENT = 2;

/**
 * Storage persisting each run as a JSON file. Uses `node:fs/promises`
 * through a lazy import so bundling the package for non-Node runtimes
 * (browsers, edge workers) stays clean when this adapter is not used.
 */
export class JsonFileStorage implements WorkflowStorage {
  private readonly directory: string;
  private readonly pretty: boolean;

  constructor(options: JsonFileStorageOptions = {}) {
    this.directory = options.directory ?? DEFAULT_DIRECTORY;
    this.pretty = options.pretty ?? false;
  }

  private async fileFor(runId: string): Promise<string> {
    const pathModule = await import('node:path');
    const safeId = runId.replaceAll(UNSAFE_CHARACTERS, '_');
    return pathModule.join(this.directory, `${safeId}.json`);
  }

  private async write(path: string, data: string): Promise<void> {
    const fs = await import('node:fs/promises');
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(path, data, 'utf8');
  }

  async saveRun(state: RunState): Promise<void> {
    const path = await this.fileFor(state.runId);
    const json = JSON.stringify(state, null, this.pretty ? JSON_INDENT : undefined);
    await this.write(path, json);
  }

  async getRun(runId: string): Promise<RunState | null> {
    const path = await this.fileFor(runId);
    try {
      const fs = await import('node:fs/promises');
      const text = await fs.readFile(path, 'utf8');
      return JSON.parse(text) as RunState;
    } catch {
      return null;
    }
  }

  async listRuns(filter?: RunFilter): Promise<RunState[]> {
    const fs = await import('node:fs/promises');
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch {
      return [];
    }
    const states: RunState[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const run = await this.readEntry(entry, fs);
      if (run !== null && matches(run, filter)) states.push(run);
    }
    return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async readEntry(entry: string, fs: typeof FileSystem): Promise<RunState | null> {
    try {
      const text = await fs.readFile(`${this.directory}/${entry}`, 'utf8');
      return JSON.parse(text) as RunState;
    } catch {
      return null;
    }
  }

  async deleteRun(runId: string): Promise<void> {
    const path = await this.fileFor(runId);
    try {
      const fs = await import('node:fs/promises');
      await fs.unlink(path);
    } catch {
      // Deleting a missing run is a no-op.
    }
  }
}

function matches(run: RunState, filter?: RunFilter): boolean {
  if (filter === undefined) return true;
  if (filter.workflowName !== undefined && run.workflowName !== filter.workflowName) {
    return false;
  }
  return filter.status === undefined || run.status === filter.status;
}

export function jsonFileStorage(directory: string, pretty = false): JsonFileStorage {
  return new JsonFileStorage({ directory, pretty });
}
