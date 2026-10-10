import { SerializationError } from '../errors.js';
import type { WorkflowDefinition, WorkflowVars } from '../types.js';
import { deserializeWorkflow } from './deserialize.js';
import { serializeWorkflow } from './serialize.js';
import type { YamlParserLike, YamlSerializeOptions } from './types.js';

/**
 * Serializes a workflow definition to YAML. Uses the injected parser, or
 * dynamically imports the `yaml` package when none is provided.
 */
export async function workflowToYAML<TVars extends WorkflowVars>(
  definition: WorkflowDefinition<TVars>,
  options: YamlSerializeOptions = {},
): Promise<string> {
  const parser = await resolveYamlParser(options.yaml);
  return parser.stringify(serializeWorkflow(definition, options));
}

/**
 * Parses a YAML string into a runnable workflow definition. Uses the
 * injected parser, or dynamically imports the `yaml` package.
 */
export async function workflowFromYAML<TVars extends WorkflowVars = WorkflowVars>(
  text: string,
  options: YamlSerializeOptions = {},
): Promise<WorkflowDefinition<TVars>> {
  const parser = await resolveYamlParser(options.yaml);
  return deserializeWorkflow<TVars>(parser.parse(text));
}

async function resolveYamlParser(injected?: YamlParserLike): Promise<YamlParserLike> {
  if (injected !== undefined) return injected;
  try {
    const module = (await import('yaml')) as Record<string, unknown>;
    return pickParser(module);
  } catch {
    throw new SerializationError(
      'No YAML parser available. Install the "yaml" package (npm i yaml) or pass one via ' +
        'options.yaml — any object with parse(text) and stringify(value) works.',
    );
  }
}

/** Accepts both the namespace (`yaml.parse`) and default-object export shapes. */
function pickParser(module: Record<string, unknown>): YamlParserLike {
  const candidate = (module['parse'] !== undefined ? module : module['default']) as
    | YamlParserLike
    | undefined;
  if (candidate !== undefined && typeof candidate.parse === 'function') {
    return candidate;
  }
  throw new SerializationError(
    'The resolved "yaml" module does not expose parse/stringify; pass a parser via options.yaml.',
  );
}
