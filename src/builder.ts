import type {
  ActionConfig,
  ActionDefinition,
  Condition,
  Metadata,
  PolicyReference,
  StageDefinition,
  StepDefinition,
  WorkflowDefinition,
  WorkflowVars,
} from './types.js';

/** Fluent entry point: `workflowBuilder('name').stage(...).build()`. */
export function workflowBuilder<TVars extends WorkflowVars = WorkflowVars>(
  name: string,
): WorkflowBuilder<TVars> {
  return new WorkflowBuilder<TVars>(name);
}

/** Builds a `WorkflowDefinition` through chained, typed calls. */
export class WorkflowBuilder<TVars extends WorkflowVars = WorkflowVars> {
  private readonly workflowName: string;
  private workflowVersion?: string;
  private initialVars?: TVars;
  private workflowPreCondition?: Condition<TVars>;
  private workflowPolicies: PolicyReference[] = [];
  private workflowMetadata: Metadata = {};
  private readonly stageList: StageDefinition<TVars>[] = [];

  constructor(name: string) {
    this.workflowName = name;
  }

  /** Merges free-form metadata into the workflow's metadata bag. */
  meta(metadata: Metadata): this {
    this.workflowMetadata = { ...this.workflowMetadata, ...metadata };
    return this;
  }

  /** Sets (and merges) initial variable values for runs of this workflow. */
  vars(initial: TVars): this {
    this.initialVars = { ...this.initialVars, ...initial };
    return this;
  }

  /** Alias of `vars` mirroring the plain-definition field name. */
  initialContext(initial: TVars): this {
    return this.vars(initial);
  }

  version(version: string): this {
    this.workflowVersion = version;
    return this;
  }

  preCondition(condition: Condition<TVars>): this {
    this.workflowPreCondition = condition;
    return this;
  }

  /** Attaches named policy references to the workflow. */
  policies(references: PolicyReference[]): this {
    this.workflowPolicies = [...this.workflowPolicies, ...references];
    return this;
  }

  /** Adds a stage by name (+ optional configure callback) or definition. */
  stage(
    nameOrStage: string | StageDefinition<TVars>,
    configure?: (builder: StageBuilder<TVars>) => void,
  ): this {
    this.stageList.push(
      typeof nameOrStage === 'string'
        ? configureStage(new StageBuilder<TVars>(nameOrStage), configure)
        : nameOrStage,
    );
    return this;
  }

  build(): WorkflowDefinition<TVars> {
    return {
      name: this.workflowName,
      version: this.workflowVersion,
      initialContext: this.initialVars,
      preCondition: this.workflowPreCondition,
      policies: this.workflowPolicies,
      metadata: this.workflowMetadata,
      stages: this.stageList,
    };
  }
}

/** Builds a `StageDefinition`. Obtained inside `WorkflowBuilder.stage()`. */
export class StageBuilder<TVars extends WorkflowVars = WorkflowVars> {
  private stagePreCondition?: Condition<TVars>;
  private stagePolicies: PolicyReference[] = [];
  private stageMetadata: Metadata = {};
  private readonly stepList: StepDefinition<TVars>[] = [];

  constructor(private readonly stageName: string) {}

  meta(metadata: Metadata): this {
    this.stageMetadata = { ...this.stageMetadata, ...metadata };
    return this;
  }

  preCondition(condition: Condition<TVars>): this {
    this.stagePreCondition = condition;
    return this;
  }

  /** Attaches named policy references to the stage. */
  policies(references: PolicyReference[]): this {
    this.stagePolicies = [...this.stagePolicies, ...references];
    return this;
  }

  /** Adds a step by name (+ optional configure callback) or definition. */
  step(
    nameOrStep: string | StepDefinition<TVars>,
    configure?: (builder: StepBuilder<TVars>) => void,
  ): this {
    this.stepList.push(
      typeof nameOrStep === 'string'
        ? configureStep(new StepBuilder<TVars>(nameOrStep), configure)
        : nameOrStep,
    );
    return this;
  }

  build(): StageDefinition<TVars> {
    return {
      name: this.stageName,
      preCondition: this.stagePreCondition,
      policies: this.stagePolicies,
      metadata: this.stageMetadata,
      steps: this.stepList,
    };
  }
}

/** Builds a `StepDefinition`. Obtained inside `StageBuilder.step()`. */
export class StepBuilder<TVars extends WorkflowVars = WorkflowVars> {
  private stepPreCondition?: Condition<TVars>;
  private stepPolicies: PolicyReference[] = [];
  private stepMetadata: Metadata = {};
  private onFailureMode?: 'fail' | 'skip';
  private retryCount?: number;
  private retryDelay?: number;
  private readonly actionList: ActionDefinition<TVars>[] = [];

  constructor(private readonly stepName: string) {}

  meta(metadata: Metadata): this {
    this.stepMetadata = { ...this.stepMetadata, ...metadata };
    return this;
  }

  preCondition(condition: Condition<TVars>): this {
    this.stepPreCondition = condition;
    return this;
  }

  /** Attaches named policy references to the step. */
  policies(references: PolicyReference[]): this {
    this.stepPolicies = [...this.stepPolicies, ...references];
    return this;
  }

  /** Sets the failure mode when every attempt of an action fails. */
  onFailure(mode: 'fail' | 'skip'): this {
    this.onFailureMode = mode;
    return this;
  }

  retries(count: number): this {
    this.retryCount = count;
    return this;
  }

  retryDelayMs(milliseconds: number): this {
    this.retryDelay = milliseconds;
    return this;
  }

  /** Adds an action by type (+ config) or as a full definition. */
  action(typeOrDefinition: string | ActionDefinition<TVars>, config?: ActionConfig): this {
    this.actionList.push(
      typeof typeOrDefinition === 'string' ? { type: typeOrDefinition, config } : typeOrDefinition,
    );
    return this;
  }

  build(): StepDefinition<TVars> {
    return {
      name: this.stepName,
      preCondition: this.stepPreCondition,
      policies: this.stepPolicies,
      metadata: this.stepMetadata,
      onFailure: this.onFailureMode,
      retries: this.retryCount,
      retryDelayMs: this.retryDelay,
      actions: this.actionList,
    };
  }
}

function configureStage<TVars extends WorkflowVars>(
  builder: StageBuilder<TVars>,
  configure?: (builder: StageBuilder<TVars>) => void,
): StageDefinition<TVars> {
  configure?.(builder);
  return builder.build();
}

function configureStep<TVars extends WorkflowVars>(
  builder: StepBuilder<TVars>,
  configure?: (builder: StepBuilder<TVars>) => void,
): StepDefinition<TVars> {
  configure?.(builder);
  return builder.build();
}
