// Plain-ESM smoke test: exercises the built dist bundle end-to-end.
// Run with: node smoke/runtime-smoke.mjs   (also works under `bun smoke/runtime-smoke.mjs`)
import { rm } from 'node:fs/promises';
import {
  createEngine,
  defineAction,
  jsonFileStorage,
  logEvents,
  silentLogger,
  workflowBuilder,
} from '../dist/index.js';

const failures = [];

function check(label, condition) {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures.push(label);
    console.error(`FAIL  ${label}`);
  }
}

let shouldFail = true;
const greet = defineAction('greet', ({ config }, ctx) => {
  const greeting = `hello ${String(config.name)} #${String(ctx.get('attempt') ?? 1)}`;
  ctx.set('greeting', greeting);
  return greeting;
});

function buildEngine(storage) {
  const engine = createEngine({ logger: silentLogger, storage });
  engine.register(greet);
  engine.register('flaky', () => {
    if (shouldFail) throw new Error('smoke failure');
    return 'healed';
  });
  return engine;
}

const engine = buildEngine(undefined);
const events = [];
logEvents(engine, {
  debug: () => undefined,
  info: (message) => events.push(message),
  warn: () => undefined,
  error: () => undefined,
});

engine.define(
  workflowBuilder('smoke-order')
    .meta({ suite: 'smoke' })
    .vars({ attempt: 1 })
    .preCondition((ctx) => ctx.get('attempt') === 1)
    .stage('process', (stage) =>
      stage
        .step('greet-step', (step) =>
          step.meta({ critical: true }).action('greet', { name: 'world' }),
        )
        .step('flaky-step', (step) => step.action('flaky')),
    )
    .build(),
);

const result = await engine.run('smoke-order');
check('run reports failed when an action keeps failing', result.status === 'failed');
check(
  'step results captured before the failure',
  result.results['greet-step'] === 'hello world #1',
);
check('metadata landed on the result', result.workflowMetadata.suite === 'smoke');
check(
  'events were logged with scope',
  events.some((line) => line.includes('process > greet-step')),
);

shouldFail = false;
const resumed = await engine.resume(result.runId);
check('resume healed the failed run', resumed.status === 'succeeded');
check('resume preserved vars', resumed.vars.greeting === 'hello world #1');
check('resume recorded the healed step', resumed.results['flaky-step'] === 'healed');

const runDir = '.workflow-runs-smoke';
const stored = buildEngine(jsonFileStorage(runDir));
stored.define(
  workflowBuilder('smoke-order')
    .vars({ attempt: 1 })
    .stage('process', (stage) =>
      stage.step('greet-step', (step) => step.action('greet', { name: 'file' })),
    )
    .build(),
);

const persisted = await stored.run('smoke-order');
const continued = await stored.resume(persisted.runId);
check('json file storage persists runs', continued.status === 'succeeded');
check('json storage run vars survive', continued.vars.greeting === 'hello file #1');

await rm(runDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log('\nAll smoke checks passed');
