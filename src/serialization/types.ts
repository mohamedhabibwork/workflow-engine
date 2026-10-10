import type { Metadata, PolicyReference, SerializedError } from '../types.js';

/**
 * Declarative, JSON-safe condition used in serialized workflows. A field
 * condition picks a source (`var` from context vars, `meta` from the guarded
 * unit's metadata) and applies optional checks; a bare source is a truthiness
 * check. Combinators nest arbitrarily.
 */
export type ConditionSpec =
  | FieldConditionSpec
  | { all: ConditionSpec[] }
  | { any: ConditionSpec[] }
  | { not: ConditionSpec };

export interface FieldConditionSpec {
  /** Read from context vars (e.g. "licensed"). */
  var?: string;
  /** Read from the guarded unit's metadata (e.g. "role"). */
  meta?: string;
  equals?: unknown;
  notEquals?: unknown;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  in?: unknown[];
  notIn?: unknown[];
  contains?: unknown;
  /** When false, the condition requires the value to be null/undefined. */
  exists?: boolean;
}

/** Format marker written on dump and checked on load. */
export const WORKFLOW_FORMAT = 'workflow-engine/v1' as const;

/** Condition represented as data (the serialized form of a pre-condition). */
export type SerializedCondition = ConditionSpec;

export interface SerializedAction {
  name?: string;
  type: string;
  config?: Record<string, unknown>;
  preCondition?: SerializedCondition;
  policies?: PolicyReference[];
  metadata?: Metadata;
}

export interface SerializedStep {
  name: string;
  metadata?: Metadata;
  preCondition?: SerializedCondition;
  policies?: PolicyReference[];
  onFailure?: 'fail' | 'skip';
  retries?: number;
  retryDelayMs?: number;
  actions: SerializedAction[];
}

export interface SerializedStage {
  name: string;
  metadata?: Metadata;
  preCondition?: SerializedCondition;
  policies?: PolicyReference[];
  steps: SerializedStep[];
}

/** The portable, file-friendly projection of a workflow definition. */
export interface SerializedWorkflow {
  $format?: typeof WORKFLOW_FORMAT;
  name: string;
  version?: string;
  metadata?: Metadata;
  initialContext?: Record<string, unknown>;
  preCondition?: SerializedCondition;
  policies?: PolicyReference[];
  stages: SerializedStage[];
}

/** Minimal parser surface compatible with the popular `yaml` package. */
export interface YamlParserLike {
  parse(text: string, ...rest: never[]): unknown;
  stringify(value: unknown, ...rest: never[]): string;
}

export interface SerializeOptions {
  /** JSON indentation. Default 2. */
  indent?: number;
  /**
   * What to do with conditions that carry no declarative spec (plain
   * functions): "throw" (default) names the path in a SerializationError,
   * "omit" drops the condition.
   */
  onNonSerializableCondition?: 'throw' | 'omit';
}

export interface YamlSerializeOptions extends SerializeOptions {
  /** Parser to use; when omitted the engine dynamically imports `yaml`. */
  yaml?: YamlParserLike;
}

export interface LoadOptions {
  /** Used to infer the format when no explicit loader is chosen. */
  filename?: string;
  yaml?: YamlParserLike;
}

export type { Metadata, PolicyReference, SerializedError };
