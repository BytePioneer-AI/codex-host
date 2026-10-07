import type {
  HarnessModelRef,
  HarnessPermissionModeId,
  HarnessThinkingOptionId,
} from "@codexhost/shared-contracts";

/** External IDs come from the target Host's plugin directory. */
export type RendererAgent = string;
export type ExternalRendererAgent = string;
export const DEFAULT_RENDERER_AGENTS: readonly RendererAgent[] = ["codex"];
export type RendererAgentAvailability =
  "checking" | "ready" | "notInstalled" | "unavailable" | "error";
export type ComposerAgentPhase = "draft" | "locked";

interface AgentConfiguration {
  model?: HarnessModelRef;
  thinkingOptionId?: HarnessThinkingOptionId;
  permissionModeId?: HarnessPermissionModeId;
}
export interface DraftComposerState {
  agent: RendererAgent;
  phase: ComposerAgentPhase;
  composerId: string;
  configurationByAgent?: Record<string, AgentConfiguration>;
}
type MutableComposerState = DraftComposerState;
interface TargetState {
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
function isIdentifiedTarget(target: readonly unknown[] | null): target is readonly unknown[] {
  return (
    target?.[0] === "conversation" ||
    (target?.[0] === "default" &&
      typeof target[1] === "string" &&
      target[1].startsWith("client-new-thread:"))
  );
}
function sameTarget(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class DraftAgentController<Composer extends object> {
  readonly #idFactory: (sequence: number) => string;
  readonly #defaultAgent: RendererAgent;
  #enabledAgents: ReadonlySet<RendererAgent>;
  readonly #targetStates: TargetState[] = [];
  readonly #modelRequestGenerations = new WeakMap<MutableComposerState, number>();
  readonly #ownershipRequestGenerations = new WeakMap<MutableComposerState, number>();
  readonly #states = new WeakMap<Composer, MutableComposerState>();
  readonly #switching = new Set<MutableComposerState>();
  readonly #pendingSubmissions = new Set<MutableComposerState>();
  #composerSequence = 0;
  #modelRequestSequence = 0;
  #ownershipRequestSequence = 0;
  #lastSubmittedAgent: RendererAgent;

  constructor(options: DraftAgentControllerOptions = {}) {
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#enabledAgents = new Set(options.enabledAgents ?? DEFAULT_RENDERER_AGENTS);
    if (!this.#enabledAgents.has("codex"))
      throw new Error("Renderer enabled Agents must include Codex");
    this.#defaultAgent = options.defaultAgent ?? "codex";

    this.#lastSubmittedAgent = this.#defaultAgent;
  }
  setEnabledAgents(agents: readonly RendererAgent[]): void {
    this.#enabledAgents = new Set(["codex", ...agents]);
  }
  get(composer: Composer): Readonly<DraftComposerState> {
    return this.#state(composer);
  }
  detach(composer: Composer, preservePendingSubmission = false): void {
    const state = this.#states.get(composer);
    if (state && !preservePendingSubmission) this.#pendingSubmissions.delete(state);
    this.#states.delete(composer);
  }
  mount(
    composer: Composer,
    target: readonly unknown[] | null,
    preferredNewThreadAgent?: RendererAgent,
  ): Readonly<DraftComposerState> {
    const bound = this.#targetState(target);
    if (bound) {
      this.#states.set(composer, bound);
      return bound;
    }
    // A saved preference survives directory loading or plugin removal. Availability gates
    // submission; silently changing its owner to Codex would send work to the wrong Harness.
    const preferredAgent = preferredNewThreadAgent ?? this.#lastSubmittedAgent;
    const state = this.#state(composer, isDefaultTarget(target) ? preferredAgent : "codex");
    if (isIdentifiedTarget(target)) this.#targetStates.push({ target, state });
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
    const generation = ++this.#ownershipRequestSequence;
    this.#ownershipRequestGenerations.set(this.#state(composer), generation);
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
    this.#pendingSubmissions.delete(previous);
    this.#modelRequestGenerations.set(previous, ++this.#modelRequestSequence);
    this.#ownershipRequestGenerations.set(previous, ++this.#ownershipRequestSequence);
    let state = this.#targetState(target);
    if (!state) {
      state = {
        agent: "codex",
        phase: "draft",
        composerId: this.#idFactory(++this.#composerSequence),
      };
      this.#targetStates.push({ target, state });
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
  ): Readonly<DraftComposerState> {
    // Ownership is a persisted fact, even when its plugin is no longer installed.
    const state = this.#state(composer);
    this.#pendingSubmissions.delete(state);
    state.agent = agent;
    state.phase = "locked";
    if (agent !== "codex") {
      state.configurationByAgent = {
        ...state.configurationByAgent,
        [agent]: {
          ...(model ? { model } : {}),
          ...(thinkingOptionId ? { thinkingOptionId } : {}),
          ...(permissionModeId ? { permissionModeId } : {}),
        },
      };
    }
    return state;
  }
  clearConfiguration(composer: Composer): void {
    delete this.#state(composer).configurationByAgent;
  }
  modelForAgent(composer: Composer, agent: RendererAgent): HarnessModelRef | undefined {
    return this.#state(composer).configurationByAgent?.[agent]?.model;
  }
  thinkingOptionForAgent(
    composer: Composer,
    agent: ExternalRendererAgent,
  ): HarnessThinkingOptionId | undefined {
    return this.#state(composer).configurationByAgent?.[agent]?.thinkingOptionId;
  }
  permissionModeForAgent(
    composer: Composer,
    agent: ExternalRendererAgent,
  ): HarnessPermissionModeId | undefined {
    return this.#state(composer).configurationByAgent?.[agent]?.permissionModeId;
  }
  setExternalPermissionMode(
    composer: Composer,
    agent: ExternalRendererAgent,
    permissionModeId: HarnessPermissionModeId,
  ): Readonly<DraftComposerState> {
    return this.#configure(composer, agent, { permissionModeId });
  }
  setExternalModel(
    composer: Composer,
    agent: ExternalRendererAgent,
    model: HarnessModelRef,
  ): Readonly<DraftComposerState> {
    return this.#configure(composer, agent, { model });
  }
  setExternalThinkingOption(
    composer: Composer,
    agent: ExternalRendererAgent,
    thinkingOptionId?: HarnessThinkingOptionId,
  ): Readonly<DraftComposerState> {
    const state = this.#configure(composer, agent, {});
    const configuration = state.configurationByAgent?.[agent];
    if (!configuration) return state;
    if (thinkingOptionId) configuration.thinkingOptionId = thinkingOptionId;
    else delete configuration.thinkingOptionId;
    return state;
  }
  #configure(
    composer: Composer,
    agent: string,
    patch: AgentConfiguration,
  ): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    state.configurationByAgent = {
      ...state.configurationByAgent,
      [agent]: { ...state.configurationByAgent?.[agent], ...patch },
    };
    return state;
  }
  lock(composer: Composer): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    this.#pendingSubmissions.delete(state);
    state.phase = "locked";
    return state;
  }
  markSubmissionPending(composer: Composer): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    if (state.phase === "draft") this.#pendingSubmissions.add(state);
    return state;
  }
  isSubmissionPending(composer: Composer): boolean {
    return this.#pendingSubmissions.has(this.#state(composer));
  }
  clearPendingSubmission(composer: Composer): void {
    this.#pendingSubmissions.delete(this.#state(composer));
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
    const bound = this.#targetState(target);
    if (bound && bound !== state) return false;
    if (source !== replacement) {
      if (this.#states.has(replacement)) return false;
      this.#states.set(replacement, state);
    }
    if (isIdentifiedTarget(target) && !bound) this.#targetStates.push({ target, state });
    if (isConversationTarget(target) && this.#pendingSubmissions.delete(state))
      state.phase = "locked";
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
    this.#pendingSubmissions.delete(state);
    this.#switching.add(state);
    try {
      if (!operations.applyAgent(nextAgent)) return false;
      try {
        await operations.clearPrewarm();
      } catch (error) {
        if (!operations.applyAgent(state.agent))
          throw new Error("Draft Agent switch could not restore the prior Agent", { cause: error });
        return false;
      }
      state.agent = nextAgent;
      return true;
    } finally {
      this.#switching.delete(state);
    }
  }
  #targetState(target: readonly unknown[] | null): MutableComposerState | null {
    if (!isIdentifiedTarget(target)) return null;
    return (
      this.#targetStates.find((candidate) => sameTarget(candidate.target, target))?.state ?? null
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
