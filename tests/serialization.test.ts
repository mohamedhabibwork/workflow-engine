import { describe, expect, it } from 'vitest';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  DefinitionError,
  SerializationError,
  compileConditionSpec,
  createEngine,
  detectFormat,
  dumpWorkflow,
  loadWorkflow,
  serializeWorkflow,
  silentLogger,
  spec,
  workflowBuilder,
  workflowFromJSON,
  workflowFromYAML,
  workflowToJSON,
  workflowToYAML,
} from '../src/index.js';
import type { ConditionSpec, WorkflowContext, WorkflowDefinition } from '../src/index.js';

const yamlParser = { parse: yamlParse, stringify: yamlStringify };

function portableFlow(): WorkflowDefinition {
  return workflowBuilder<Record<string, unknown>>('portable-flow')
    .meta({ domain: 'orders' })
    .version('1.0.0')
    .policies(['licensed'])
    .vars({ licensed: true, totalCents: 0 })
    .preCondition(spec({ var: 'licensed', equals: true }))
    .stage('payment', (stage) =>
      stage
        .meta({ sla: '1h' })
        .policies([{ name: 'budget', config: { maxCents: 5000 } }])
        .preCondition(
          spec({
            any: [
              { var: 'totalCents', lt: 100 },
              { var: 'skipReview', exists: false },
            ],
          }),
        )
        .step('charge', (step) =>
          step
            .meta({ critical: true })
            .retries(2)
            .retryDelayMs(500)
            .onFailure('skip')
            .preCondition(spec({ var: 'licensed' }))
            .policies(['licensed'])
            .action('set', { key: 'charged', value: true })
            .action({
              name: 'log-charge',
              type: 'log',
              config: { message: 'charged' },
              preCondition: spec({ var: 'charged', equals: true }),
              metadata: { tag: 'audit' },
            }),
        ),
    )
    .build();
}

describe('spec() declarative conditions', () => {
  const ctx = (vars: Record<string, unknown>) =>
    ({
      get: (key: string) => vars[key],
    }) as unknown as WorkflowContext;
  const meta = (values: Record<string, unknown>) => values;

  it('supports equality and existence checks', async () => {
    expect(await spec({ var: 'a', equals: 1 })(ctx({ a: 1 }), {})).toBe(true);
    expect(await spec({ var: 'a', equals: 1 })(ctx({ a: 2 }), {})).toBe(false);
    expect(await spec({ var: 'a', notEquals: 1 })(ctx({ a: 2 }), {})).toBe(true);
    expect(await spec({ var: 'a', exists: true })(ctx({ a: null }), {})).toBe(false);
    expect(await spec({ var: 'a', exists: false })(ctx({}), {})).toBe(true);
  });

  it('supports numeric and membership comparisons', async () => {
    expect(await spec({ var: 'n', gt: 5 })(ctx({ n: 6 }), {})).toBe(true);
    expect(await spec({ var: 'n', gte: 5 })(ctx({ n: 5 }), {})).toBe(true);
    expect(await spec({ var: 'n', lt: 5 })(ctx({ n: 4 }), {})).toBe(true);
    expect(await spec({ var: 'n', lte: 5 })(ctx({ n: 5 }), {})).toBe(true);
    expect(await spec({ var: 'n', lt: 5 })(ctx({ n: '4' }), {})).toBe(false); // non-numbers deny
    expect(await spec({ var: 'a', in: [1, 2] })(ctx({ a: 2 }), {})).toBe(true);
    expect(await spec({ var: 'a', notIn: [1, 2] })(ctx({ a: 3 }), {})).toBe(true);
    expect(await spec({ var: 'list', contains: 2 })(ctx({ list: [1, 2] }), {})).toBe(true);
    expect(await spec({ var: 'text', contains: 'ell' })(ctx({ text: 'hello' }), {})).toBe(true);
  });

  it('treats a bare source as a truthiness check', async () => {
    expect(await spec({ var: 'a' })(ctx({ a: 'yes' }), {})).toBe(true);
    expect(await spec({ var: 'a' })(ctx({ a: 0 }), {})).toBe(false);
    expect(await spec({ meta: 'role', equals: 'admin' })(ctx({}), meta({ role: 'admin' }))).toBe(
      true,
    );
  });

  it('supports nested all/any/not combinators', async () => {
    const condition = spec({
      all: [{ var: 'a' }, { any: [{ var: 'b' }, { not: { var: 'c' } }] }],
    });
    expect(await condition(ctx({ a: 1, b: 0, c: 0 }), {})).toBe(true);
    expect(await condition(ctx({ a: 1, b: 0, c: 1 }), {})).toBe(false);
    expect(await condition(ctx({ a: 0, b: 1, c: 0 }), {})).toBe(false);
  });

  it('compiles specs through compileConditionSpec with the same semantics', async () => {
    const condition = compileConditionSpec({ var: 'a', equals: true });
    expect(await condition(ctx({ a: true }), {})).toBe(true);
    expect(() => compileConditionSpec({ foo: 1 } as unknown as ConditionSpec)).toThrow(
      DefinitionError,
    );
    expect(() => compileConditionSpec({ all: 'nope' } as unknown as ConditionSpec)).toThrow(
      DefinitionError,
    );
  });
});

describe('JSON serialization', () => {
  it('round-trips a definition with declarative conditions', () => {
    const original = portableFlow();
    const restored = workflowFromJSON<Record<string, unknown>>(workflowToJSON(original));

    // Conditions compile to fresh functions, so compare the data projection.
    expect(serializeWorkflow(restored)).toEqual(serializeWorkflow(original));
    expect(restored.stages[0]!.steps[0]!.retries).toBe(2);
    expect(restored.stages[0]!.steps[0]!.onFailure).toBe('skip');
  });

  it('parsed definitions behave identically at runtime', async () => {
    const engine = createEngine({ logger: silentLogger });
    engine.registerPolicy('licensed', (_input, ctx) => ctx.get('licensed') === true);
    engine.registerPolicy(
      'budget',
      ({ config }, ctx) => Number(ctx.get('totalCents') ?? 0) <= Number(config['maxCents']),
    );
    const parsed = workflowFromJSON<Record<string, unknown>>(workflowToJSON(portableFlow()));
    engine.define(parsed);

    const allowed = await engine.run('portable-flow');
    expect(allowed.status).toBe('succeeded');
    expect(allowed.vars['charged']).toBe(true);

    const denied = await engine.run('portable-flow', { licensed: false });
    expect(denied.status).toBe('skipped');
  });

  it('rejects plain function conditions with a path-naming error', () => {
    const definition: WorkflowDefinition = {
      name: 'fn-conditions',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 't',
              preCondition: () => true,
              actions: [{ type: 'set', config: { key: 'k', value: 1 } }],
            },
          ],
        },
      ],
    };
    expect(() => workflowToJSON(definition)).toThrow(SerializationError);
    expect(() => workflowToJSON(definition)).toThrow('stages[0].steps[0].preCondition');
  });

  it('omits function conditions under onNonSerializableCondition omit', () => {
    const definition: WorkflowDefinition = {
      name: 'fn-conditions',
      stages: [
        {
          name: 's',
          preCondition: () => true,
          steps: [
            {
              name: 't',
              preCondition: () => true,
              actions: [{ type: 'set', config: { key: 'k', value: 1 } }],
            },
          ],
        },
      ],
    };
    const text = workflowToJSON(definition, { onNonSerializableCondition: 'omit' });
    const restored = workflowFromJSON(text);
    expect(restored.stages[0]!.preCondition).toBeUndefined();
    expect(restored.stages[0]!.steps[0]!.preCondition).toBeUndefined();
  });

  it('rejects functions inside config with a path-naming error', () => {
    const definition: WorkflowDefinition = {
      name: 'fn-config',
      stages: [
        {
          name: 's',
          steps: [
            {
              name: 't',
              actions: [{ type: 'inline', config: { run: () => 'x' } }],
            },
          ],
        },
      ],
    };
    expect(() => workflowToJSON(definition)).toThrow(/actions\[0\]\.config\.run/);
  });

  it('rejects unknown $format markers and malformed structures', () => {
    const badFormat = JSON.stringify({
      $format: 'other-engine/v9',
      name: 'x',
      stages: [{ name: 's', steps: [{ name: 't', actions: [{ type: 'set' }] }] }],
    });
    expect(() => workflowFromJSON(badFormat)).toThrow(DefinitionError);

    expect(() => workflowFromJSON('{"name":"x","stages":[]}')).toThrow(DefinitionError);
    expect(() => workflowFromJSON('not json')).toThrow();
  });
});

describe('YAML serialization', () => {
  it('round-trips through an injected parser', async () => {
    const original = portableFlow();
    const yamlText = await workflowToYAML(original, { yaml: yamlParser });
    expect(yamlText).toContain('portable-flow');
    const restored = await workflowFromYAML<Record<string, unknown>>(yamlText, {
      yaml: yamlParser,
    });
    expect(restored.metadata).toEqual(original.metadata);
    expect(restored.stages[0]!.steps[0]!.policies).toEqual(['licensed']);
  });

  it('parses hand-written YAML files', async () => {
    const yamlText = `
$format: workflow-engine/v1
name: file-flow
initialContext:
  userId: u-1
stages:
  - name: main
    steps:
      - name: greet
        preCondition:
          var: userId
          exists: true
        actions:
          - type: log
            config:
              message: "hello {userId}"
`;
    const parsed = await workflowFromYAML<Record<string, unknown>>(yamlText, { yaml: yamlParser });
    const engine = createEngine({ logger: silentLogger });
    engine.define(parsed);
    const result = await engine.run('file-flow');
    expect(result.status).toBe('succeeded');
    expect(result.results['greet']).toBe('hello u-1');
  });

  it('round-trips via the auto-imported yaml package', async () => {
    const restored = await workflowFromYAML(await workflowToYAML(portableFlow()));
    expect(restored.name).toBe('portable-flow');
  });
});

describe('load/dump facade', () => {
  it('infers the format from the filename', async () => {
    const original = portableFlow();
    const asYaml = await dumpWorkflow(original, { format: 'yaml' });
    const fromYml = await loadWorkflow(asYaml, { filename: 'flow.yml' });
    const fromYaml = await loadWorkflow(asYaml, { filename: 'flow.yaml' });
    const fromJson = await loadWorkflow(workflowToJSON(original), { filename: 'flow.json' });
    const noName = await loadWorkflow(workflowToJSON(original));
    expect(fromYml.name).toBe('portable-flow');
    expect(fromYaml.name).toBe('portable-flow');
    expect(fromJson.name).toBe('portable-flow');
    expect(noName.name).toBe('portable-flow');
  });

  it('dumpWorkflow emits json by default and detectFormat defaults to json', async () => {
    const text = await dumpWorkflow(portableFlow());
    expect(JSON.parse(text).name).toBe('portable-flow');
    expect(detectFormat()).toBe('json');
    expect(detectFormat('a.yaml')).toBe('yaml');
    expect(detectFormat('a.YML')).toBe('yml');
  });
});
