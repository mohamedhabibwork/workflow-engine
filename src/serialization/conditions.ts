import { DefinitionError } from '../errors.js';
import type { WorkflowContext } from '../context.js';
import type { Condition, Metadata, WorkflowVars } from '../types.js';
import type { ConditionSpec, FieldConditionSpec } from './types.js';

/** A condition that remembers the declarative spec it was built from. */
export interface DeclarativeCondition<
  TVars extends WorkflowVars = WorkflowVars,
> extends Condition<TVars> {
  readonly spec: ConditionSpec;
}

/**
 * Builds a condition from a declarative spec. The returned function carries
 * its `.spec`, so definitions using it remain losslessly serializable.
 */
export function spec<TVars extends WorkflowVars = WorkflowVars>(
  conditionSpec: ConditionSpec,
): DeclarativeCondition<TVars> {
  return attachSpec(compileConditionSpec<TVars>(conditionSpec), conditionSpec);
}

function attachSpec<TVars extends WorkflowVars>(
  condition: Condition<TVars>,
  conditionSpec: ConditionSpec,
): DeclarativeCondition<TVars> {
  const declarative = condition as DeclarativeCondition<TVars>;
  Object.defineProperty(declarative, 'spec', {
    value: conditionSpec,
    enumerable: false,
    writable: false,
  });
  return declarative;
}

/** Extracts the spec behind a declarative condition, if any. */
export function conditionSpecOf<TVars extends WorkflowVars>(
  condition: Condition<TVars>,
): ConditionSpec | undefined {
  const candidate = condition as Partial<DeclarativeCondition<TVars>>;
  return typeof candidate.spec === 'object' && candidate.spec !== null ? candidate.spec : undefined;
}

/**
 * Compiles a declarative spec into a runtime condition. Malformed specs
 * throw `DefinitionError`; the caller adds the unit path to the message.
 */
export function compileConditionSpec<TVars extends WorkflowVars = WorkflowVars>(
  conditionSpec: ConditionSpec,
  path = 'preCondition',
): Condition<TVars> {
  validateShape(conditionSpec, path);
  if ('all' in conditionSpec) {
    const compiled = conditionSpec.all.map((child, index) =>
      compileConditionSpec<TVars>(child, `${path}.all[${String(index)}]`),
    );
    return async (ctx, meta) => {
      for (const condition of compiled) {
        if (!(await condition(ctx, meta))) return false;
      }
      return true;
    };
  }
  if ('any' in conditionSpec) {
    const compiled = conditionSpec.any.map((child, index) =>
      compileConditionSpec<TVars>(child, `${path}.any[${String(index)}]`),
    );
    return async (ctx, meta) => {
      for (const condition of compiled) {
        if (await condition(ctx, meta)) return true;
      }
      return false;
    };
  }
  if ('not' in conditionSpec) {
    const inner = compileConditionSpec<TVars>(conditionSpec.not, `${path}.not`);
    return async (ctx, meta) => !(await inner(ctx, meta));
  }
  const field = conditionSpec;
  return (ctx, meta) => checkField(field, ctx, meta);
}

function validateShape(conditionSpec: ConditionSpec, path: string): void {
  if (conditionSpec === null || typeof conditionSpec !== 'object') {
    throw new DefinitionError(`${path} must be a condition object`);
  }
  if ('all' in conditionSpec) {
    requireArray(conditionSpec.all, `${path}.all`);
    return;
  }
  if ('any' in conditionSpec) {
    requireArray(conditionSpec.any, `${path}.any`);
    return;
  }
  if ('not' in conditionSpec) {
    if (conditionSpec.not === null || typeof conditionSpec.not !== 'object') {
      throw new DefinitionError(`${path}.not must be a condition object`);
    }
    return;
  }
  const field = conditionSpec;
  if (typeof field.var !== 'string' && typeof field.meta !== 'string') {
    throw new DefinitionError(`${path} requires a source: a "var" or "meta" key (or all/any/not)`);
  }
}

function requireArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new DefinitionError(`${path} must be an array of conditions`);
  }
}

function checkField<TVars extends WorkflowVars>(
  field: FieldConditionSpec,
  ctx: WorkflowContext<TVars>,
  meta: Metadata,
): boolean {
  const value = field.var !== undefined ? ctx.get(field.var) : meta[field.meta ?? ''];
  return applyChecks(field, value);
}

/** One operator check: false when the field's operator is present and fails. */
type FieldCheck = (field: FieldConditionSpec, value: unknown) => boolean;

const FIELD_CHECKS: FieldCheck[] = [
  checkExists,
  checkEquals,
  checkNotEquals,
  checkMembership,
  checkExclusion,
  checkContains,
  checkGt,
  checkGte,
  checkLt,
  checkLte,
];

function applyChecks(field: FieldConditionSpec, value: unknown): boolean {
  for (const check of FIELD_CHECKS) {
    if (!check(field, value)) return false;
  }
  // Bare source without any explicit check behaves as a truthiness test.
  return hasOperator(field) ? true : Boolean(value);
}

function checkExists(field: FieldConditionSpec, value: unknown): boolean {
  if (!('exists' in field)) return true;
  const present = value !== undefined && value !== null;
  return present === (field.exists ?? true);
}

function checkEquals(field: FieldConditionSpec, value: unknown): boolean {
  return !('equals' in field) || value === field.equals;
}

function checkNotEquals(field: FieldConditionSpec, value: unknown): boolean {
  return !('notEquals' in field) || value !== field.notEquals;
}

function checkMembership(field: FieldConditionSpec, value: unknown): boolean {
  return !('in' in field && field.in !== undefined) || field.in.includes(value);
}

function checkExclusion(field: FieldConditionSpec, value: unknown): boolean {
  return !('notIn' in field && field.notIn !== undefined) || !field.notIn.includes(value);
}

function checkContains(field: FieldConditionSpec, value: unknown): boolean {
  return !('contains' in field) || containsValue(value, field.contains);
}

function checkGt(field: FieldConditionSpec, value: unknown): boolean {
  return !('gt' in field) || compare(value, field.gt, (a, b) => a > b);
}

function checkGte(field: FieldConditionSpec, value: unknown): boolean {
  return !('gte' in field) || compare(value, field.gte, (a, b) => a >= b);
}

function checkLt(field: FieldConditionSpec, value: unknown): boolean {
  return !('lt' in field) || compare(value, field.lt, (a, b) => a < b);
}

function checkLte(field: FieldConditionSpec, value: unknown): boolean {
  return !('lte' in field) || compare(value, field.lte, (a, b) => a <= b);
}

function hasOperator(field: FieldConditionSpec): boolean {
  return OPERATOR_KEYS.some((key) => key in field);
}

const OPERATOR_KEYS = [
  'equals',
  'notEquals',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'contains',
  'exists',
] as const;

function containsValue(container: unknown, needle: unknown): boolean {
  if (Array.isArray(container)) return container.includes(needle);
  if (typeof container === 'string') return container.includes(String(needle));
  return false;
}

function compare(
  left: unknown,
  right: unknown,
  operator: (a: number, b: number) => boolean,
): boolean {
  if (typeof left !== 'number' || typeof right !== 'number') return false;
  return operator(left, right);
}
