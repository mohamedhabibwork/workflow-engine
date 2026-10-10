import type { SerializedError } from './types.js';

/** Where in the hierarchy an error originated. */
export interface ErrorLocation {
  runId?: string;
  stage?: string;
  step?: string;
  action?: string;
}

/** Base class for every error thrown by the engine. */
export class WorkflowError extends Error {
  readonly location: ErrorLocation;

  constructor(message: string, location: ErrorLocation = {}, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkflowError';
    this.location = location;
  }
}

/** A workflow definition failed validation. */
export class DefinitionError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = 'DefinitionError';
  }
}

/** An action referenced a type that is not in the registry. */
export class UnknownActionTypeError extends WorkflowError {
  constructor(type: string, location: ErrorLocation = {}) {
    super(`Unknown action type "${type}". Register it on the engine first.`, location);
    this.name = 'UnknownActionTypeError';
  }
}

/** A policy reference named a policy that is not registered. */
export class UnknownPolicyError extends WorkflowError {
  constructor(name: string, location: ErrorLocation = {}) {
    super(`Unknown policy "${name}". Register it on the engine first.`, location);
    this.name = 'UnknownPolicyError';
  }
}

/** An action handler kept failing until retries were exhausted. */
export class ActionError extends WorkflowError {
  constructor(message: string, location: ErrorLocation = {}, options?: { cause?: unknown }) {
    super(message, location, options);
    this.name = 'ActionError';
  }
}

/** A pre-condition threw instead of resolving. Always fails the run. */
export class PreconditionError extends WorkflowError {
  constructor(message: string, location: ErrorLocation = {}, options?: { cause?: unknown }) {
    super(message, location, options);
    this.name = 'PreconditionError';
  }
}

/** A workflow definition could not be serialized (e.g. a function condition). */
export class SerializationError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

/** Extracts a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Converts any thrown value into a JSON-safe error record. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'Error', message: String(error) };
}
