import type {
  HarnessModelRef,
  HarnessPermissionModeId,
  HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

export const KNOWN_RENDERER_AGENTS = ["codex", "pi", "claude-code"] as const;
export const DEFAULT_RENDERER_AGENTS = ["codex", "pi", "claude-code"] as const;
export type RendererAgent = (typeof KNOWN_RENDERER_AGENTS)[number];
export type ExternalRendererAgent = Exclude<RendererAgent, "codex">;
export type ComposerAgentPhase = "draft" | "locked";

export interface DraftComposerState {
  agent: RendererAgent;
  phase: ComposerAgentPhase;
  composerId: string;
  piModel?: HarnessModelRef;
  piThinkingOptionId?: HarnessThinkingOptionId;
  claudeModel?: HarnessModelRef;
  claudeThinkingOptionId?: HarnessThinkingOptionId;
  permissionModeByAgent?: Partial<Record<ExternalRendererAgent, HarnessPermissionModeId>>;
}

type MutableComposerState = DraftComposerState;

interface ConversationState {
  target: readonly unknown[];
  state: MutableComposerState;
}

export interface DraftAgentControllerOptions {
  idFactory?: (sequence: number) => string;
  enabledAgents?: readonly RendererAgent[];
  defaultAgent?: RendererAgent;
}

export interface DraftAgentSwitchOperations {
  applyAgent(agent: RendererAgent): boolean;
  clearPrewarm(): Promise<void>;
}

function defaultIdFactory(sequence: number): string {
  return `codexhost-composer-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function isDefaultTarget(target: readonly unknown[] | null): target is readonly unknown[] {
  return target?.[0] === "default";
}

function isConversationTarget(target: readonly unknown[] | null): target is readonly unknown[] {
  return target?.[0] === "conversation";
}

function sameTarget(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class DraftAgentController<Composer extends object> {
  readonly #idFactory: (sequence: number) => string;
  readonly #defaultAgent: RendererAgent;
  readonly #enabledAgents: ReadonlySet<RendererAgent>;
  readonly #conversationStates: ConversationState[] = [];
  readonly #modelRequestGenerations = new WeakMap<MutableComposerState, number>();
  readonly #ownershipRequestGenerations = new WeakMap<MutableComposerState, number>();
  readonly #states = new WeakMap<Composer, MutableComposerState>();
  readonly #switching = new Set<MutableComposerState>();
  #composerSequence = 0;
  #modelRequestSequence = 0;
  #ownershipRequestSequence = 0;
  #lastSubmittedAgent: RendererAgent;

  constructor(options: DraftAgentControllerOptions = {}) {
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#enabledAgents = new Set(options.enabledAgents ?? DEFAULT_RENDERER_AGENTS);
    if (!this.#enabledAgents.has("codex")) {
      throw new Error("Renderer enabled Agents must include Codex");
    }
    this.#defaultAgent = options.defaultAgent ?? "codex";
    if (!this.#enabledAgents.has(this.#defaultAgent)) {
      throw new Error("Renderer default Agent must be enabled");
    }
    this.#lastSubmittedAgent = this.#defaultAgent;
  }

  get(composer: Composer): Readonly<DraftComposerState> {
    return this.#state(composer);
  }

  mount(composer: Composer, target: readonly unknown[] | null): Readonly<DraftComposerState> {
    const bound = this.#conversationState(target);
    if (bound) {
      this.#states.set(composer, bound);
      return bound;
    }
    const state = this.#state(
      composer,
      isDefaultTarget(target) ? this.#lastSubmittedAgent : "codex",
    );
    if (isConversationTarget(target)) {
      this.#conversationStates.push({ target, state });
    }
    return state;
  }

  isSwitching(composer: Composer): boolean {
    return this.#switching.has(this.#state(composer));
  }

  beginModelRequest(composer: Composer): number {
    const state = this.#state(composer);
    const generation = ++this.#modelRequestSequence;
    this.#modelRequestGenerations.set(state, generation);
    return generation;
  }

  invalidateModelRequests(composer: Composer): void {
    this.beginModelRequest(composer);
  }

  isCurrentModelRequest(composer: Composer, generation: number): boolean {
    return (this.#modelRequestGenerations.get(this.#state(composer)) ?? 0) === generation;
  }

  beginOwnershipRequest(composer: Composer): number {
    const state = this.#state(composer);
    const generation = ++this.#ownershipRequestSequence;
    this.#ownershipRequestGenerations.set(state, generation);
    return generation;
  }

  isCurrentOwnershipRequest(composer: Composer, generation: number): boolean {
    return (this.#ownershipRequestGenerations.get(this.#state(composer)) ?? 0) === generation;
  }

  rebindConversation(
    composer: Composer,
    target: readonly unknown[] | null,
  ): Readonly<DraftComposerState> | null {
    if (!isConversationTarget(target)) return null;
    const previous = this.#state(composer);
    this.#modelRequestGenerations.set(previous, ++this.#modelRequestSequence);
    this.#ownershipRequestGenerations.set(previous, ++this.#ownershipRequestSequence);

    let state = this.#conversationState(target);
    if (!state) {
      state = {
        agent: "codex",
        phase: "draft",
        composerId: this.#idFactory(++this.#composerSequence),
      };
      this.#conversationStates.push({ target, state });
    }
    this.#states.set(composer, state);
    this.#modelRequestGenerations.set(state, ++this.#modelRequestSequence);
    this.#ownershipRequestGenerations.set(state, ++this.#ownershipRequestSequence);
    return state;
  }

  restore(
    composer: Composer,
    agent: RendererAgent,
    model?: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
    permissionModeId?: HarnessPermissionModeId,
  ): Readonly<DraftComposerState> | null {
    if (!this.#enabledAgents.has(agent)) return null;
    const state = this.#state(composer);
    state.agent = agent;
    state.phase = "locked";
    if (agent === "pi" && model) state.piModel = model;
    if (agent === "claude-code" && model) state.claudeModel = model;
    if (agent === "pi" && thinkingOptionId) {
      state.piThinkingOptionId = thinkingOptionId;
    } else if (agent === "pi") {
      delete state.piThinkingOptionId;
    }
    if (agent === "claude-code" && thinkingOptionId) {
      state.claudeThinkingOptionId = thinkingOptionId;
    } else if (agent === "claude-code") {
      delete state.claudeThinkingOptionId;
    }
    if (agent !== "codex") {
      const permissionModeByAgent: NonNullable<DraftComposerState["permissionModeByAgent"]> = {};
      for (const candidate of ["pi", "claude-code"] as const) {
        const current = state.permissionModeByAgent?.[candidate];
        if (candidate !== agent && current) permissionModeByAgent[candidate] = current;
      }
      if (permissionModeId) permissionModeByAgent[agent] = permissionModeId;
      if (Object.keys(permissionModeByAgent).length > 0) {
        state.permissionModeByAgent = permissionModeByAgent;
      } else {
        delete state.permissionModeByAgent;
      }
    }
    return state;
  }

  modelForAgent(composer: Composer, agent: RendererAgent): HarnessModelRef | undefined {
    const state = this.#state(composer);
    return agent === "pi" ? state.piModel : agent === "claude-code" ? state.claudeModel : undefined;
  }

  thinkingOptionForAgent(
    composer: Composer,
    agent: ExternalRendererAgent,
  ): HarnessThinkingOptionId | undefined {
    const state = this.#state(composer);
    return agent === "pi" ? state.piThinkingOptionId : state.claudeThinkingOptionId;
  }

  permissionModeForAgent(
    composer: Composer,
    agent: ExternalRendererAgent,
  ): HarnessPermissionModeId | undefined {
    return this.#state(composer).permissionModeByAgent?.[agent];
  }

  setExternalPermissionMode(
    composer: Composer,
    agent: ExternalRendererAgent,
    permissionModeId: HarnessPermissionModeId,
  ): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    state.permissionModeByAgent = {
      ...state.permissionModeByAgent,
      [agent]: permissionModeId,
    };
    return state;
  }

  setExternalModel(
    composer: Composer,
    agent: ExternalRendererAgent,
    model: HarnessModelRef,
  ): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    if (agent === "pi") state.piModel = model;
    else state.claudeModel = model;
    return state;
  }

  setPiConfiguration(
    composer: Composer,
    model: HarnessModelRef,
    thinkingOptionId?: HarnessThinkingOptionId,
  ): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    state.piModel = model;
    if (thinkingOptionId) state.piThinkingOptionId = thinkingOptionId;
    else delete state.piThinkingOptionId;
    return state;
  }

  setPiModel(composer: Composer, model: HarnessModelRef): Readonly<DraftComposerState> {
    return this.setExternalModel(composer, "pi", model);
  }

  setExternalThinkingOption(
    composer: Composer,
    agent: ExternalRendererAgent,
    thinkingOptionId: HarnessThinkingOptionId,
  ): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    if (agent === "pi") state.piThinkingOptionId = thinkingOptionId;
    else state.claudeThinkingOptionId = thinkingOptionId;
    return state;
  }

  setPiThinkingOption(
    composer: Composer,
    thinkingOptionId: HarnessThinkingOptionId,
  ): Readonly<DraftComposerState> {
    return this.setExternalThinkingOption(composer, "pi", thinkingOptionId);
  }

  lock(composer: Composer): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    state.phase = "locked";
    return state;
  }

  recordSubmission(composer: Composer): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    this.#lastSubmittedAgent = state.agent;
    return state;
  }

  transfer(
    source: Composer,
    replacement: Composer,
    target: readonly unknown[] | null = null,
  ): boolean {
    const state = this.#states.get(source);
    if (!state) return false;
    const bound = this.#conversationState(target);
    if (bound && bound !== state) return false;
    if (source !== replacement) {
      if (this.#states.has(replacement)) return false;
      this.#states.set(replacement, state);
    }
    if (isConversationTarget(target) && !bound) {
      this.#conversationStates.push({ target, state });
    }
    return true;
  }

  async switchAgent(
    composer: Composer,
    nextAgent: RendererAgent,
    operations: DraftAgentSwitchOperations,
  ): Promise<boolean> {
    const state = this.#state(composer);
    if (!this.#enabledAgents.has(nextAgent)) return false;
    if (state.phase !== "draft" || this.#switching.has(state)) return false;
    if (state.agent === nextAgent) return true;

    this.#switching.add(state);
    try {
      if (!operations.applyAgent(nextAgent)) return false;
      try {
        await operations.clearPrewarm();
      } catch (error) {
        if (!operations.applyAgent(state.agent)) {
          throw new Error("Draft Agent switch could not restore the prior Agent", {
            cause: error,
          });
        }
        return false;
      }
      state.agent = nextAgent;
      return true;
    } finally {
      this.#switching.delete(state);
    }
  }

  #conversationState(target: readonly unknown[] | null): MutableComposerState | null {
    if (!isConversationTarget(target)) return null;
    return (
      this.#conversationStates.find((candidate) => sameTarget(candidate.target, target))?.state ??
      null
    );
  }

  #state(composer: Composer, initialAgent?: RendererAgent): MutableComposerState {
    const existing = this.#states.get(composer);
    if (existing) return existing;
    const created: MutableComposerState = {
      agent: initialAgent ?? this.#defaultAgent,
      phase: "draft",
      composerId: this.#idFactory(++this.#composerSequence),
    };
    this.#states.set(composer, created);
    return created;
  }
}
