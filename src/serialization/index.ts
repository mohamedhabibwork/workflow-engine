import type { WorkflowDefinition, WorkflowVars } from '../types.js';
import { workflowFromJSON, workflowToJSON } from './json.js';
import { workflowFromYAML, workflowToYAML } from './yaml.js';
import type {
  LoadOptions,
  SerializeOptions,
  YamlParserLike,
  YamlSerializeOptions,
} from './types.js';

export type WorkflowFileFormat = 'json' | 'yaml' | 'yml';

/** Infers the file format from a filename; defaults to json. */
export function detectFormat(filename?: string): WorkflowFileFormat {
  const extension = filename?.split('.').pop()?.toLowerCase();
  if (extension === 'yaml' || extension === 'yml') return extension;
  return 'json';
}

/**
 * Loads a workflow from JSON or YAML text, inferring the format from
 * `filename` when given (`.json`, `.yaml`, `.yml`; default json).
 */
export async function loadWorkflow<TVars extends WorkflowVars = WorkflowVars>(
  text: string,
  options: LoadOptions = {},
): Promise<WorkflowDefinition<TVars>> {
  if (detectFormat(options.filename) === 'json') {
    return workflowFromJSON<TVars>(text);
  }
  return workflowFromYAML<TVars>(text, { yaml: options.yaml });
}

/** Serializes a workflow to a JSON or YAML string. */
export async function dumpWorkflow<TVars extends WorkflowVars>(
  definition: WorkflowDefinition<TVars>,
  options: { format?: WorkflowFileFormat; yaml?: YamlParserLike } & SerializeOptions = {},
): Promise<string> {
  const format = options.format ?? 'json';
  if (format === 'json') {
    return workflowToJSON(definition, options);
  }
  return workflowToYAML(definition, options as YamlSerializeOptions);
}
