import { describe, expect, it } from 'vitest';
import {
  action,
  createEngine,
  defineAction,
  logEvents,
  silentLogger,
  sleep,
} from '../src/index.js';
import type { Logger } from '../src/index.js';

describe('createEngine', () => {
  it('returns a working engine with defaults', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'default-engine',
      stages: [
        {
          name: 's',
          steps: [{ name: 't', actions: [{ type: 'inline', config: { run: () => 'ran' } }] }],
        },
      ],
    });
    const result = await engine.run('default-engine');
    expect(result.status).toBe('succeeded');
    expect(result.results.t).toBe('ran');
  });
});

describe('defineAction', () => {
  it('produces a registerable action with typed config', async () => {
    const engine = createEngine({ logger: silentLogger });
    const increment = defineAction<{ amount: number }>('increment', ({ config }, ctx) => {
      const total = Number(ctx.get('total') ?? 0) + config.amount;
      ctx.set('total', total);
      return total;
    });
    engine.register(increment);

    engine.define({
      name: 'counter',
      initialContext: { total: 10 },
      stages: [
        {
          name: 's',
          steps: [{ name: 'add', actions: [{ type: 'increment', config: { amount: 5 } }] }],
        },
      ],
    });

    const result = await engine.run('counter');
    expect(result.vars.total).toBe(15);
    expect(result.results.add).toBe(15);
  });
});

describe('action helper', () => {
  it('builds an action definition with config', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.define({
      name: 'helper-flow',
      stages: [
        {
          name: 's',
          steps: [{ name: 't', actions: [action('set', { key: 'src', value: 'helper' })] }],
        },
      ],
    });
    const result = await engine.run('helper-flow');
    expect(result.vars.src).toBe('helper');
  });
});

describe('logEvents', () => {
  it('logs lifecycle events and supports unsubscribe', async () => {
    const lines: string[] = [];
    const recorder: Logger = {
      debug: (m) => void lines.push(m),
      info: (m) => void lines.push(m),
      warn: (m) => void lines.push(m),
      error: (m) => void lines.push(m),
    };
    const engine = createEngine({ logger: silentLogger });
    const stop = logEvents(engine, recorder);
    engine.define({
      name: 'logged',
      stages: [
        {
          name: 'stage',
          steps: [{ name: 'step', actions: [{ type: 'set', config: { key: 'k', value: 1 } }] }],
        },
      ],
    });
    await engine.run('logged');
    stop();
    await engine.run('logged');

    expect(lines.some((line) => line.includes('start'))).toBe(true);
    expect(lines.some((line) => line.includes('(stage > step)'))).toBe(true);
    // Second run after unsubscribe logs nothing more.
    const countAfterStop = lines.length;
    expect(countAfterStop).toBeGreaterThan(0);
    await engine.run('logged');
    expect(lines.length).toBe(countAfterStop);
  });
});

describe('sleep', () => {
  it('resolves after the given delay', async () => {
    const started = Date.now();
    await sleep(25);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});
