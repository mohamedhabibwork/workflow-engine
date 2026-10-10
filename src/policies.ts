import type { WorkflowContext } from './context.js';
import { UnknownPolicyError } from './errors.js';
import type {
  ActionConfig,
  ActionDefinition,
  Metadata,
  PolicyActionEntry,
  PolicyEvaluationReport,
  PolicyHandler,
  PolicyReference,
  PolicyResult,
  PolicyUnitReport,
  PolicyVerdict,
  StageDefinition,
  StepDefinition,
  WorkflowDefinition,
  WorkflowVars,
} from './types.js';

/** Maps policy names to their handler functions. */
export class PolicyRegistry {
  private readonly handlers = new Map<string, PolicyHandler>();

  /** Registers (or replaces) the handler for a policy name. Chainable. */
  register<TVars extends WorkflowVars>(name: string, handler: PolicyHandler<TVars>): this {
    this.handlers.set(name, handler as unknown as PolicyHandler);
    return this;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  get(name: string): PolicyHandler | undefined {
    return this.handlers.get(name);
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }
}

interface ResolvedReference {
  name: string;
  config: ActionConfig;
}

function resolveReference(reference: PolicyReference): ResolvedReference {
  if (typeof reference === 'string') return { name: reference, config: {} };
  return { name: reference.name, config: reference.config ?? {} };
}

export interface PolicyEvaluationInput<TVars extends WorkflowVars> {
  policies?: PolicyReference[];
  registry: PolicyRegistry;
  ctx: WorkflowContext<TVars>;
  metadata: Metadata;
}

/**
 * Evaluates every referenced policy. All policies run (no short-circuit) so
 * the verdict always explains itself; an unknown policy name throws
 * `UnknownPolicyError`.
 */
export async function evaluatePolicies<TVars extends WorkflowVars>(
  input: PolicyEvaluationInput<TVars>,
): Promise<PolicyVerdict> {
  const { policies, registry, ctx, metadata } = input;
  if (policies === undefined || policies.length === 0) {
    return { allowed: true, results: [] };
  }
  const results: PolicyResult[] = [];
  let allowed = true;
  for (const reference of policies) {
    const { name, config } = resolveReference(reference);
    const handler = registry.get(name);
    if (handler === undefined) throw new UnknownPolicyError(name);
    const passed = await handler({ config, metadata }, ctx);
    results.push({ policy: name, allowed: passed });
    if (!passed) allowed = false;
  }
  return { allowed, results };
}

/**
 * Walks a definition and evaluates policies at every level. Each node reports
 * its own verdict; the flat `actions` list carries the effective (cascaded)
 * verdict: an action is enabled only when workflow, stage, step and action
 * levels all allow.
 */
export async function evaluateDefinitionPolicies<TVars extends WorkflowVars>(
  definition: WorkflowDefinition<TVars>,
  registry: PolicyRegistry,
  ctx: WorkflowContext<TVars>,
): Promise<PolicyEvaluationReport> {
  const input: WalkInput<TVars> = { registry, ctx };
  const workflowReport = await evaluateUnit('workflow', definition, input);
  const actions: PolicyActionEntry[] = [];
  const stages: PolicyUnitReport[] = [];
  const route: StageRoute<TVars> = {
    input,
    inheritedAllowed: workflowReport.isEnabled,
    actions,
  };
  for (const stage of definition.stages) {
    stages.push(await evaluateStageTree(stage, route));
  }
  workflowReport.stages = stages;
  return { workflowName: definition.name, workflow: workflowReport, actions };
}

interface WalkInput<TVars extends WorkflowVars> {
  registry: PolicyRegistry;
  ctx: WorkflowContext<TVars>;
}

interface StageRoute<TVars extends WorkflowVars> {
  input: WalkInput<TVars>;
  /** Effective verdict of all ancestor levels. */
  inheritedAllowed: boolean;
  /** Flat action list sink shared by the whole walk. */
  actions: PolicyActionEntry[];
  stageName?: string;
}

/** Evaluates one unit's own policies into a report node. */
async function evaluateUnit<TVars extends WorkflowVars>(
  unit: PolicyUnitReport['unit'],
  target: PolicyUnitTarget,
  input: WalkInput<TVars>,
): Promise<PolicyUnitReport> {
  const verdict = await evaluatePolicies({
    policies: target.policies,
    registry: input.registry,
    ctx: input.ctx,
    metadata: target.metadata ?? {},
  });
  return { unit, name: target.name, isEnabled: verdict.allowed, policies: verdict.results };
}

interface PolicyUnitTarget {
  name: string;
  policies?: PolicyReference[];
  metadata?: Metadata;
}

async function evaluateStageTree<TVars extends WorkflowVars>(
  stage: StageDefinition<TVars>,
  route: StageRoute<TVars>,
): Promise<PolicyUnitReport> {
  const report = await evaluateUnit('stage', stage, route.input);
  const steps: PolicyUnitReport[] = [];
  const stepRoute: StageRoute<TVars> = {
    ...route,
    inheritedAllowed: route.inheritedAllowed && report.isEnabled,
    stageName: stage.name,
  };
  for (const step of stage.steps) {
    steps.push(await evaluateStepTree(step, stepRoute));
  }
  report.steps = steps;
  return report;
}

async function evaluateStepTree<TVars extends WorkflowVars>(
  step: StepDefinition<TVars>,
  route: StageRoute<TVars>,
): Promise<PolicyUnitReport> {
  const report = await evaluateUnit('step', step, route.input);
  const actionReports: PolicyUnitReport[] = [];
  const allowed = route.inheritedAllowed && report.isEnabled;
  const stageName = route.stageName ?? '';
  for (const action of step.actions) {
    const actionReport = await evaluateUnit('action', actionTarget(action), route.input);
    actionReports.push(actionReport);
    route.actions.push({
      stage: stageName,
      step: step.name,
      action: actionReport.name,
      isEnabled: allowed && actionReport.isEnabled,
      policies: actionReport.policies,
    });
  }
  report.actions = actionReports;
  return report;
}

function actionTarget<TVars extends WorkflowVars>(
  action: ActionDefinition<TVars>,
): PolicyUnitTarget {
  return { name: action.name ?? action.type, policies: action.policies, metadata: action.metadata };
}
