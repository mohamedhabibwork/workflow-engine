import { expectTypeOf } from 'vitest';
import type { RunResult, WorkflowContext, WorkflowDefinition } from '../src/index.js';

// Vars must be a type alias: unlike interfaces, aliases satisfy the
// Record<string, unknown> constraint through TypeScript's implicit index signature.
type OrderVars = {
  userId: string;
  total?: number;
};

const ctx = null as unknown as WorkflowContext<OrderVars>;

// Vars are typed end-to-end through the context.
expectTypeOf(ctx.get('userId')).toEqualTypeOf<string>();
expectTypeOf(ctx.get('total')).toEqualTypeOf<number | undefined>();
ctx.set('userId', 'u1');
ctx.set('total', 10);

// @ts-expect-error - the value must match the var's declared type
ctx.set('userId', 123);

// @ts-expect-error - unknown var keys are rejected
ctx.set('unknown-key', 'value');

// Definitions carry the vars type.
const definition = null as unknown as WorkflowDefinition<OrderVars>;
expectTypeOf(definition.initialContext).toEqualTypeOf<OrderVars | undefined>();

// Results carry the vars type.
const result = null as unknown as RunResult<OrderVars>;
expectTypeOf(result.vars).toEqualTypeOf<OrderVars>();
expectTypeOf(result.results).toEqualTypeOf<Record<string, unknown>>();
