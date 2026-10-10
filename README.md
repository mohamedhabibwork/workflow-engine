# @mohamedhabibwork/workflow-engine

A cross-runtime TypeScript workflow engine. Workflows contain **stages**, stages contain
**steps**, steps contain **actions** — every level carries its own **pre-condition** and
**metadata**. Zero runtime dependencies, typed variables end-to-end, a fluent builder,
pluggable resolvers, and resumable persistence.

| Runtime            | Support                                                |
| ------------------ | ------------------------------------------------------ |
| Node.js 18+        | ✅ full (ESM + CJS)                                    |
| Bun                | ✅ full                                                |
| Deno               | ✅ full (`deno test -A smoke/deno-smoke.test.ts`)      |
| Browsers / workers | ✅ core (skip `JsonFileStorage`, which uses `node:fs`) |

The core only uses Web-standard APIs (`fetch`, `crypto.randomUUID`, `setTimeout`).
`JsonFileStorage` lazily imports `node:fs/promises` and is only loaded if you use it.

## Quickstart

```ts
import {
  createEngine,
  defineAction,
  jsonFileStorage,
  workflowBuilder,
} from '@mohamedhabibwork/workflow-engine';

// 1. A custom action, with a typed config
const charge = defineAction<{ amountCents: number }>(
  'charge',
  async ({ config, metadata }, ctx) => {
    ctx.set('chargedCents', config.amountCents);
    ctx.logger.info('charging', { metadata });
    return { ok: true };
  },
);

// 2. The engine — resumable runs persisted as JSON files
const engine = createEngine({ storage: jsonFileStorage('.workflow-runs') });
engine.register(charge);

// 3. Define a workflow with the fluent builder (typed vars!)
engine.define(
  workflowBuilder<{ userId: string; chargedCents?: number }>('order-flow')
    .meta({ domain: 'orders' })
    .vars({ userId: '' })
    .preCondition((ctx) => ctx.get('userId') !== '')
    .stage('payment', (stage) =>
      stage
        .meta({ sla: '1h' })
        .step('charge-step', (step) =>
          step
            .meta({ critical: true })
            .retries(2)
            .retryDelayMs(500)
            .action('charge', { amountCents: 1999 }),
        )
        .step('notify', (step) =>
          step
            .preCondition((ctx) => (ctx.get('chargedCents') ?? 0) > 0)
            .action('log', { message: 'charged {chargedCents} cents for {userId}' }),
        ),
    )
    .build(),
);

// 4. Run it
const result = await engine.run('order-flow', { userId: 'u-123' });
console.log(result.status, result.vars, result.results);
```

Plain definitions work exactly the same — the builder just produces the same object:

```ts
engine.define({
  name: 'order-flow',
  metadata: { domain: 'orders' },
  initialContext: { userId: '' },
  preCondition: (ctx) => ctx.get('userId') !== '',
  stages: [
    {
      name: 'payment',
      metadata: { sla: '1h' },
      steps: [
        {
          name: 'charge-step',
          metadata: { critical: true },
          retries: 2,
          retryDelayMs: 500,
          actions: [{ type: 'charge', config: { amountCents: 1999 } }],
        },
      ],
    },
  ],
});
```

## Execution semantics

- Stages run in definition order, steps in order, actions in order (all awaited sequentially).
- A **pre-condition** runs before its unit. Falsy → the unit is `skipped` and execution moves
  on. A pre-condition that **throws** fails the run with a `PreconditionError`.
  A falsy workflow-level pre-condition ends the run with the terminal status `skipped`.
- An action that fails is retried up to `step.retries` times (with `retryDelayMs` between
  attempts). If it still fails, `onFailure` decides: `'fail'` (default) fails the workflow,
  `'skip'` records the failure and continues.
- `engine.run()` does **not** reject on execution failures — it resolves with
  `status: 'failed'` and a serialized `error`. It only rejects on usage errors
  (unknown workflow name, unknown run id, invalid definition).
- The step's result in `results[stepName]` is the return value of its **last executed action**.

## Pre-conditions at every level

```ts
workflowBuilder('flow')
  .preCondition((ctx) => ctx.get('enabled') === true) // workflow
  .stage('s', (stage) =>
    stage // stage — meta is the guarded unit's metadata
      .meta({ region: 'eu' })
      .preCondition((ctx, meta) => meta['region'] === 'eu')
      .step('t', (step) =>
        step
          .preCondition(async () => true) // step (async works)
          .action('http', { url: '/ping' })
          .action({
            type: 'log',
            config: { message: 'pong' },
            preCondition: (ctx) => ctx.get('enabled') === true, // action
          }),
      ),
  );
```

Combine conditions with `all(...)`, `any(...)` and `not(...)`.

## Policies (multi-level)

Pre-conditions are inline guards local to a definition. **Policies** are named,
centrally-registered checks referenced at any level — **workflow, stage, step or
action** — and enforce the same skip semantics while also being introspectable:
`engine.evaluate()` returns a nested per-level report plus a **flat list of
actions, each with an `isEnabled` verdict** cascaded from all four levels.

```ts
import { createEngine, definePolicy } from '@mohamedhabibwork/workflow-engine';

const engine = createEngine();

// Register reusable, parameterized policies (like actions)
const licensed = definePolicy('licensed', (_input, ctx) => ctx.get('licensed') === true);
const budget = definePolicy<{ maxCents: number }>(
  'budget',
  ({ config }, ctx) => Number(ctx.get('totalCents') ?? 0) <= config.maxCents,
);
engine.registerPolicy(licensed).registerPolicy(budget);

engine.define(
  workflowBuilder('order-flow')
    .policies(['licensed']) // workflow: can it start?
    .stage('payment', (stage) =>
      stage
        .policies([{ name: 'budget', config: { maxCents: 5000 } }]) // stage gate
        .step('charge', (step) =>
          step
            .policies(['licensed']) // step control
            .action('http', { url: '/charge', method: 'POST' }),
        ),
    )
    .build(),
);
```

Reference shapes: `policies: ['name']` or `policies: [{ name: 'budget', config: { ... } }]`.
Handlers receive `({ config, metadata }, ctx)` where `metadata` is the
referencing unit's metadata; they may be async.

**Runtime enforcement** mirrors pre-conditions: a denied workflow-level policy
ends the run as `skipped`; a denied stage/step/action is skipped and execution
continues. A unit runs only when **both** its pre-condition and all its
policies allow. Unknown policy names surface as `UnknownPolicyError` (a failed
run from `run()`, a rejection from `evaluate()`). Policies are re-evaluated
fresh on every run and resume pass.

**Introspection without running anything:**

```ts
const report = await engine.evaluate('order-flow', { licensed: false });

report.workflow.isEnabled; // false — workflow level denied
report.workflow.stages; // nested tree with per-policy verdicts
report.actions; // flat list:
// [
//   { stage: 'payment', step: 'charge', action: 'http', isEnabled: false, policies: [...] },
// ]
```

Each tree node carries `{ unit, name, isEnabled, policies: [{ policy, allowed }] }`
so a denial always explains itself, and each flat action entry's `isEnabled` is
the **effective** verdict — workflow, stage, step and action levels must all
allow. Typical uses: licensing/tenant/maintenance/quota checks at the workflow
level, evidence gates on approval stages, severity-based step control, and
view-vs-approve action permissions.

> When to use which: **pre-conditions** for definition-local, inline business
> logic ("skip when not VIP"); **policies** for cross-cutting, reusable rules
> you want to centralize, parameterize, and expose through an authorization
> report.

## Metadata

Every unit accepts `metadata: Record<string, unknown>`. It is delivered to:

- **pre-conditions** — as the second argument `(ctx, meta)`
- **action handlers** — `({ config, metadata }, ctx)`
- **lifecycle events** — `event.metadata` on `workflow|stage|step|action` events
- **run history and results** — `RunResult.workflowMetadata` and history entries

## Built-in actions

| Type     | Config                                       | Behaviour                                                                              |
| -------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `log`    | `{ message, level? }`                        | Interpolates `{var}` from context vars, logs via injected logger. Returns the message. |
| `set`    | `{ key, value }`                             | Sets a context var.                                                                    |
| `get`    | `{ key }`                                    | Returns the var's value (becomes the step result).                                     |
| `delay`  | `{ ms }`                                     | Waits `ms` milliseconds.                                                               |
| `http`   | `{ method?, url, body?, headers?, saveAs? }` | `fetch` request; stores `{ ok, status, body }` under `saveAs` and returns it.          |
| `inline` | `{ run: (ctx) => unknown }`                  | Runs an arbitrary function — the escape hatch.                                         |

Register your own (see `defineAction` above), or `engine.register(type, handler)`.

## Typed variables

```ts
type OrderVars = { userId: string; chargedCents?: number }; // use a type ALIAS, not an interface

workflowBuilder<OrderVars>('order-flow').stage('s', (stage) =>
  stage.step('t', (step) =>
    step.action('inline', {
      run: (ctx) => {
        const userId: string = ctx.get('userId'); // fully typed
        ctx.set('chargedCents', 1999);
      },
    }),
  ),
);
```

> Use a **type alias** for your vars: TypeScript's implicit index signatures make aliases
> satisfy `Record<string, unknown>`, while interfaces do not.

## Resolvers — integrate with any project

Definitions are looked up through a `WorkflowResolver`, so your project decides where
workflows live:

```ts
import {
  createEngine,
  MapResolver,
  lazyResolver,
  chainResolvers,
} from '@mohamedhabibwork/workflow-engine';

// Static map (default): engine.define() writes here
const resolver = new MapResolver();

// Lazy: dynamic import, database, DI container, remote config...
const lazy = lazyResolver(async (name) => {
  const module = await import(`./flows/${name}.js`);
  return module.default;
});

// Compose: static first, lazy fallback
const engine = createEngine({ resolver: chainResolvers(resolver, lazy) });
```

`engine.define()` works with any `MapResolver` (including one you supply); with a non-map
resolver it throws a `DefinitionError` — register on your resolver instead. `resume()`
re-resolves the definition by name through the same resolver.

## Storage & resume

```ts
import { createEngine, jsonFileStorage, memoryStorage } from '@mohamedhabibwork/workflow-engine';

const engine = createEngine({ storage: jsonFileStorage('.workflow-runs') }); // or memoryStorage()

const failed = await engine.run('order-flow', { userId: 'u-1' }); // status: 'failed'
// ...fix the underlying issue, then:
const done = await engine.resume(failed.runId); // continues from the last completed action
```

- A snapshot (position + vars + step results + history) is checkpointed after **every action**.
- `resume(runId)` re-runs from the last completed action — already-completed actions and
  steps are never replayed, and all vars/results are restored.
- Terminal runs (`succeeded` / `skipped`) return their recorded result without executing.
- Implement the `WorkflowStorage` interface (`saveRun`, `getRun`, `listRuns`, `deleteRun`)
  to back runs with Redis, Postgres, or anything else.

## Events

```ts
engine.on('step:start', (event) => console.log(event.step, event.metadata));
engine.onAny((event) => audit(event));

// Or one-liner audit logging (returns an unsubscribe function):
const stop = logEvents(engine);
```

Event names: `workflow:start|end|skip|fail`, `stage:start|end|skip`, `step:start|end|skip|fail`,
`action:start|end|skip|fail`. Every payload carries `runId`, `workflowName`, the unit path
(`stage`/`step`/`action`), `status`, `metadata` and `at`; `*:fail` events also carry `error`.

## Development

Tooling is the [oxc](https://oxc.rs) ecosystem: [oxlint](https://oxc.rs/docs/guide/usage/linter/quickstart.html)
for linting and [oxfmt](https://oxc.rs/docs/guide/usage/formatter/quickstart.html) for formatting.
`oxlint` is not type-aware, so `npm run typecheck` (tsc) stays part of the gate.

```jsonc
npm run build        // tsup → dist (ESM + CJS + d.ts)
npm run test         // vitest (88 tests)
npm run test:bun     // same suite under Bun
npm run test:deno    // Deno smoke suite
npm run smoke        // plain-ESM end-to-end smoke against dist
npm run lint         // oxlint (clean-code limits, .oxlintrc.json)
npm run lint:fix     // oxlint --fix
npm run typecheck    // tsc --noEmit
npm run format       // oxfmt (.oxfmtrc.json)
npm run format:check // oxfmt --check
```

Clean-code limits enforced in `.oxlintrc.json`: `max-lines-per-function: 60`,
`max-params: 3`, `max-depth: 4`, `complexity: 10`, plus `no-console`
(the logger module is the single sanctioned touch-point) and the
`correctness`/`suspicious` categories. `unicorn/no-array-sort` is off because
the package targets Node 18 (no `Array#toSorted`) and every sort in the
codebase runs on a freshly created array.

> Note: `oxlint` is pinned to an exact version in devDependencies because a
> Windows Application Control policy on the development machine blocks newer
> binaries' native bindings.

## License

MIT
