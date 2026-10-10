import { PreconditionError, errorMessage } from './errors.js';
import type { WorkflowContext } from './context.js';
import type { Condition, Metadata, WorkflowVars } from './types.js';

/**
 * Evaluates a pre-condition. Missing conditions pass. Conditions that throw
 * are wrapped in `PreconditionError` — a throwing guard always fails the run,
 * it never degrades into a skip.
 */
export async function evaluate<TVars extends WorkflowVars>(
  condition: Condition<TVars> | undefined,
  ctx: WorkflowContext<TVars>,
  meta: Metadata,
): Promise<boolean> {
  if (condition === undefined) return true;
  try {
    return await condition(ctx, meta);
  } catch (cause) {
    throw new PreconditionError(`Pre-condition threw: ${errorMessage(cause)}`, {}, { cause });
  }
}
