import type { WorkflowDefinition, WorkflowVars } from '../types.js';
import { deserializeWorkflow } from './deserialize.js';
import { serializeWorkflow } from './serialize.js';
import type { SerializeOptions } from './types.js';

/** Serializes a workflow definition to a JSON string. */
export function workflowToJSON<TVars extends WorkflowVars>(
  definition: WorkflowDefinition<TVars>,
  options: SerializeOptions = {},
): string {
  return JSON.stringify(serializeWorkflow(definition, options), null, options.indent ?? 2);
}

/** Parses a JSON string produced by `workflowToJSON` into a runnable definition. */
export function workflowFromJSON<TVars extends WorkflowVars = WorkflowVars>(
  text: string,
): WorkflowDefinition<TVars> {
  return deserializeWorkflow<TVars>(JSON.parse(text));
}
