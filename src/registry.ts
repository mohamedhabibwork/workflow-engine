import type { ActionHandler, WorkflowVars } from './types.js';

/** Maps action type names (e.g. "http") to their handler functions. */
export class ActionRegistry {
  private readonly handlers = new Map<string, ActionHandler>();

  /** Registers (or replaces) the handler for an action type. Chainable. */
  register<TVars extends WorkflowVars>(type: string, handler: ActionHandler<TVars>): this {
    this.handlers.set(type, handler as unknown as ActionHandler);
    return this;
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  get(type: string): ActionHandler | undefined {
    return this.handlers.get(type);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}
