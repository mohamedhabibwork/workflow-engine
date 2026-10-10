import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActionError,
  WorkflowRunContext,
  createDefaultRegistry,
  interpolate,
} from '../src/index.js';
import type { ActionHandler, Logger } from '../src/index.js';

function recorder(): { logs: [string, string][]; logger: Logger } {
  const logs: [string, string][] = [];
  const logger: Logger = {
    debug: (m) => void logs.push(['debug', m]),
    info: (m) => void logs.push(['info', m]),
    warn: (m) => void logs.push(['warn', m]),
    error: (m) => void logs.push(['error', m]),
  };
  return { logs, logger };
}

function makeContext(logger?: Logger): WorkflowRunContext<Record<string, unknown>> {
  return new WorkflowRunContext<Record<string, unknown>>({
    runId: 'run-1',
    workflowName: 'test',
    workflowMetadata: {},
    logger: logger ?? recorder().logger,
    vars: { name: 'world', count: 42 },
  });
}

function handler(type: string): ActionHandler {
  const registry = createDefaultRegistry();
  const resolved = registry.get(type);
  if (resolved === undefined) throw new Error(`missing builtin: ${type}`);
  return resolved;
}

function run(type: string, config: Record<string, unknown>, ctx = makeContext()) {
  return handler(type)({ config, metadata: {} }, ctx);
}

describe('built-in actions', () => {
  it('registers all six built-in types', () => {
    const registry = createDefaultRegistry();
    expect(registry.types().sort()).toEqual(['delay', 'get', 'http', 'inline', 'log', 'set']);
  });

  it('log interpolates vars and writes to the logger', () => {
    const { logs, logger } = recorder();
    const ctx = makeContext(logger);
    const message = run('log', { message: 'hi {name} x{count}' }, ctx);
    expect(message).toBe('hi world x42');
    expect(logs).toContainEqual(['info', '[workflow:test] hi world x42']);
  });

  it('log honours the configured level', () => {
    const { logs, logger } = recorder();
    run('log', { message: 'careful', level: 'warn' }, makeContext(logger));
    expect(logs).toContainEqual(['warn', '[workflow:test] careful']);
  });

  it('interpolate stringifies objects as JSON', () => {
    const ctx = makeContext();
    ctx.set('payload', { a: 1 });
    expect(interpolate('p={payload}', ctx)).toBe('p={"a":1}');
  });

  it('set stores a var and get reads it back', () => {
    const ctx = makeContext();
    expect(run('set', { key: 'mode', value: 'fast' }, ctx)).toBe('fast');
    expect(ctx.get('mode')).toBe('fast');
    expect(run('get', { key: 'mode' }, ctx)).toBe('fast');
  });

  it('set without a key fails with ActionError', () => {
    expect(() => run('set', { value: 1 })).toThrow(ActionError);
  });

  it('delay waits the requested milliseconds', async () => {
    vi.useFakeTimers();
    const pending = run('delay', { ms: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('delay rejects a negative or non-numeric ms', async () => {
    await expect(run('delay', { ms: -5 })).rejects.toThrow(ActionError);
    await expect(run('delay', { ms: 'soon' })).rejects.toThrow(ActionError);
  });

  describe('http', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('fetches, parses JSON and stores under saveAs', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 7 }) })),
      );
      const ctx = makeContext();
      const payload = await run(
        'http',
        { url: 'https://api.test/orders', method: 'POST', body: { sku: 'x' }, saveAs: 'res' },
        ctx,
      );
      expect(payload).toEqual({ ok: true, status: 200, body: { id: 7 } });
      expect(ctx.get('res')).toEqual(payload);
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        'https://api.test/orders',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sku: 'x' }),
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    it('falls back to text when the body is not JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error('not json');
          },
          text: async () => 'server error',
        })),
      );
      const payload = await run('http', { url: 'https://api.test/fail' }, makeContext());
      expect(payload).toEqual({ ok: false, status: 500, body: 'server error' });
    });

    it('requires a url', async () => {
      await expect(run('http', {})).rejects.toThrow(ActionError);
    });
  });

  it('inline runs the provided function with the context', () => {
    const ctx = makeContext();
    const value = run('inline', { run: (c: typeof ctx) => `hello ${String(c.get('name'))}` }, ctx);
    expect(value).toBe('hello world');
  });

  it('inline without a run function fails with ActionError', () => {
    expect(() => run('inline', {})).toThrow(ActionError);
  });
});
