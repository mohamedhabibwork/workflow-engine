import { DefinitionError } from './errors.js';
import type { WorkflowDefinition, WorkflowVars } from './types.js';

/**
 * Source of workflow definitions. Implement this to plug the engine into
 * your project: static maps, dynamic imports, a DI container, a database —
 * anything that can produce a definition for a name.
 */
export interface WorkflowResolver {
  resolve(name: string): Promise<WorkflowDefinition> | WorkflowDefinition;
}

/** In-memory resolver. The engine's default; `engine.define()` writes here. */
export class MapResolver implements WorkflowResolver {
  private readonly workflows = new Map<string, WorkflowDefinition>();

  add<TVars extends WorkflowVars>(definition: WorkflowDefinition<TVars>): this {
    this.workflows.set(definition.name, definition as WorkflowDefinition);
    return this;
  }

  has(name: string): boolean {
    return this.workflows.has(name);
  }

  names(): string[] {
    return [...this.workflows.keys()];
  }

  resolve(name: string): WorkflowDefinition {
    const definition = this.workflows.get(name);
    if (definition === undefined) {
      throw new DefinitionError(
        `Workflow "${name}" is not defined. Known: [${this.names().join(', ')}]`,
      );
    }
    return definition;
  }
}

/** Resolver delegating to a load function (lazy import, DB lookup, ...). */
export class LazyResolver implements WorkflowResolver {
  constructor(
    private readonly load: (name: string) => Promise<WorkflowDefinition> | WorkflowDefinition,
  ) {}

  async resolve(name: string): Promise<WorkflowDefinition> {
    return this.load(name);
  }
}

export function lazyResolver(
  load: (name: string) => Promise<WorkflowDefinition> | WorkflowDefinition,
): LazyResolver {
  return new LazyResolver(load);
}

/**
 * Composes resolvers front-to-back: the first one that produces a definition
 * wins; a resolver that throws is skipped and the next one is consulted.
 */
export function chainResolvers(primary: WorkflowResolver, ...fallbacks: WorkflowResolver[]) {
  const chain = [primary, ...fallbacks];
  return {
    async resolve(name: string): Promise<WorkflowDefinition> {
      for (const resolver of chain) {
        try {
          return await resolver.resolve(name);
        } catch {
          // Try the next resolver in the chain.
        }
      }
      throw new DefinitionError(`Workflow "${name}" could not be resolved by any resolver`);
    },
  };
}
