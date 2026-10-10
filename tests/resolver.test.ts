import { describe, expect, it } from 'vitest';
import {
  DefinitionError,
  LazyResolver,
  MapResolver,
  chainResolvers,
  createEngine,
  lazyResolver,
  silentLogger,
} from '../src/index.js';
import type { WorkflowDefinition } from '../src/index.js';

const simpleFlow: WorkflowDefinition = {
  name: 'simple',
  stages: [
    {
      name: 's',
      steps: [{ name: 'hello', actions: [{ type: 'inline', config: { run: () => 'hi' } }] }],
    },
  ],
};

describe('MapResolver', () => {
  it('resolves added definitions and reports known names', () => {
    const resolver = new MapResolver().add(simpleFlow);
    expect(resolver.has('simple')).toBe(true);
    expect(resolver.resolve('simple')).toBe(simpleFlow);
    expect(resolver.names()).toEqual(['simple']);
    expect(() => resolver.resolve('other')).toThrow(DefinitionError);
  });
});

describe('LazyResolver', () => {
  it('delegates to the load function with the requested name', async () => {
    const resolver = lazyResolver(async (name: string) => ({ ...simpleFlow, name }));
    expect(await resolver.resolve('lazy-flow')).toMatchObject({ name: 'lazy-flow' });
    expect(new LazyResolver(() => simpleFlow)).toBeInstanceOf(LazyResolver);
  });
});

describe('chainResolvers', () => {
  it('falls back when the primary resolver misses', async () => {
    const chain = chainResolvers(new MapResolver(), new MapResolver().add(simpleFlow));
    expect(await chain.resolve('simple')).toBe(simpleFlow);
  });

  it('throws DefinitionError when every resolver misses', async () => {
    const chain = chainResolvers(new MapResolver(), new MapResolver());
    await expect(chain.resolve('simple')).rejects.toThrow(DefinitionError);
  });
});

describe('engine integration', () => {
  it('define registers into the default resolver and run resolves by name', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.define(simpleFlow);
    const result = await engine.run('simple');
    expect(result.status).toBe('succeeded');
    expect(result.results.hello).toBe('hi');
  });

  it('runs definitions resolved from a custom resolver', async () => {
    const resolver = lazyResolver(async (name: string) =>
      name === 'simple' ? simpleFlow : Promise.reject(new DefinitionError(`no ${name}`)),
    );
    const engine = createEngine({ logger: silentLogger, resolver });
    const result = await engine.run('simple');
    expect(result.status).toBe('succeeded');
    await expect(engine.run('unknown')).rejects.toThrow(DefinitionError);
  });

  it('define rejects when a non-map resolver is configured', () => {
    const engine = createEngine({
      logger: silentLogger,
      resolver: lazyResolver(() => simpleFlow),
    });
    expect(() => engine.define(simpleFlow)).toThrow(DefinitionError);
  });

  it('define writes into a user-supplied MapResolver', async () => {
    const resolver = new MapResolver();
    const engine = createEngine({ logger: silentLogger, resolver });
    engine.define(simpleFlow);
    expect(resolver.has('simple')).toBe(true);
    expect((await engine.run('simple')).status).toBe('succeeded');
  });
});
