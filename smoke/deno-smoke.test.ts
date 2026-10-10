// Deno smoke test: imports the built ESM bundle and runs a workflow.
// Run with: deno test -A smoke/deno-smoke.test.ts
// Uses no external imports so it works fully offline.
import { createEngine, defineAction, silentLogger, workflowBuilder } from '../dist/index.js';

// A type alias (not an interface) so it satisfies Record<string, unknown>.
type SmokeVars = {
  greeting?: string;
};

Deno.test('workflow engine runs on Deno', async () => {
  const engine = createEngine({ logger: silentLogger });
  engine.register(
    defineAction<{ name: string }, SmokeVars>('greet', ({ config }, ctx) => {
      const greeting = `hello ${config.name} from deno`;
      ctx.set('greeting', greeting);
      return greeting;
    }),
  );

  engine.define(
    workflowBuilder<SmokeVars>('deno-smoke')
      .stage('only', (stage) =>
        stage.step('greet-step', (step) => step.action('greet', { name: 'deno' })),
      )
      .build(),
  );

  const result = await engine.run('deno-smoke');

  if (result.status !== 'succeeded') {
    throw new Error(`expected succeeded, got ${result.status}: ${String(result.error?.message)}`);
  }
  if (result.results['greet-step'] !== 'hello deno from deno') {
    throw new Error(`unexpected step result: ${String(result.results['greet-step'])}`);
  }
  if (result.vars.greeting !== 'hello deno from deno') {
    throw new Error(`unexpected vars: ${JSON.stringify(result.vars)}`);
  }
});

Deno.test('workflow engine resumes on Deno', async () => {
  const engine = createEngine({ logger: silentLogger });
  let shouldFail = true;
  engine.register('flaky', () => {
    if (shouldFail) throw new Error('deno flaky failure');
    return 'healed';
  });
  engine.define(
    workflowBuilder('deno-resume')
      .stage('s', (stage) =>
        stage
          .step('stable', (step) => step.action('set', { key: 'done', value: true }))
          .step('flaky', (step) => step.action('flaky')),
      )
      .build(),
  );

  const failed = await engine.run('deno-resume');
  if (failed.status !== 'failed') throw new Error(`expected failed, got ${failed.status}`);

  shouldFail = false;
  const resumed = await engine.resume(failed.runId);
  if (resumed.status !== 'succeeded') {
    throw new Error(`expected resumed succeeded, got ${resumed.status}`);
  }
  if (resumed.results.flaky !== 'healed') throw new Error('flaky step not healed');
  if (resumed.vars.done !== true) throw new Error('vars lost across resume');
});
