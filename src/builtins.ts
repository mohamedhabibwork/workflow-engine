import { ActionError } from './errors.js';
import type { WorkflowContext } from './context.js';
import { ActionRegistry } from './registry.js';
import { sleep } from './time.js';
import type { ActionConfig, ActionHandler } from './types.js';
import type { LogLevel } from './logger.js';

const VARIABLE_PATTERN = /\{(\w+)\}/g;

/** Replaces `{varName}` placeholders with values from the run context. */
export function interpolate(template: string, ctx: WorkflowContext): string {
  return template.replaceAll(VARIABLE_PATTERN, (_, key: string) => {
    const value = ctx.get(key);
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

interface HttpConfig {
  url?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  saveAs?: string;
}

interface InlineConfig {
  run?: (ctx: WorkflowContext) => unknown;
}

/** Renders a log message value; objects are stringified as JSON. */
function toMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}

const logHandler: ActionHandler = ({ config }, ctx) => {
  const message = interpolate(toMessage(config.message), ctx);
  const level = (config.level ?? 'info') as LogLevel;
  ctx.logger[level](`[workflow:${ctx.workflowName}] ${message}`);
  return message;
};

const setHandler: ActionHandler = ({ config }, ctx) => {
  const key = requireString(config, 'key');
  ctx.set(key, config.value);
  return ctx.get(key);
};

const getHandler: ActionHandler = ({ config }, ctx) => {
  return ctx.get(requireString(config, 'key'));
};

const delayHandler: ActionHandler = async ({ config }) => {
  const rawMs = Number(config.ms ?? 0);
  if (!Number.isFinite(rawMs) || rawMs < 0) {
    throw new ActionError(`delay action requires a non-negative "ms", received: ${String(rawMs)}`);
  }
  await sleep(rawMs);
  return undefined;
};

const httpHandler: ActionHandler = async ({ config }, ctx) => {
  const httpConfig = config as HttpConfig;
  const url = httpConfig.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new ActionError('http action requires a non-empty "url"');
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  Object.assign(headers, httpConfig.headers);
  const response = await fetch(url, {
    method: httpConfig.method ?? 'GET',
    headers,
    body: httpConfig.body === undefined ? undefined : JSON.stringify(httpConfig.body),
  });
  const payload = {
    ok: response.ok,
    status: response.status,
    body: await readBody(response),
  };
  if (typeof httpConfig.saveAs === 'string') {
    ctx.set(httpConfig.saveAs, payload);
  }
  return payload;
};

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
}

const inlineHandler: ActionHandler = ({ config }, ctx) => {
  const run = (config as InlineConfig).run;
  if (typeof run !== 'function') {
    throw new ActionError('inline action requires a "run" function in its config');
  }
  return run(ctx);
};

function requireString(config: ActionConfig, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ActionError(`Action config requires a non-empty "${key}" string`);
  }
  return value;
}

/** Registry pre-loaded with the six built-in action types. */
export function createDefaultRegistry(): ActionRegistry {
  return new ActionRegistry()
    .register('log', logHandler)
    .register('set', setHandler)
    .register('get', getHandler)
    .register('delay', delayHandler)
    .register('http', httpHandler)
    .register('inline', inlineHandler);
}

export const BUILTIN_ACTION_TYPES = ['log', 'set', 'get', 'delay', 'http', 'inline'] as const;
