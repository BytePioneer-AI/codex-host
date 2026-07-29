export const KNOWN_RENDERER_AGENTS = ["codex", "pi", "claude-code"] as const;
export const DEFAULT_RENDERER_AGENTS = ["codex", "pi"] as const;
export type RendererAgent = (typeof KNOWN_RENDERER_AGENTS)[number];
export type ComposerAgentPhase = "draft" | "locked";

export interface DraftComposerState {
  agent: RendererAgent;
  phase: ComposerAgentPhase;
  composerId: string;
}

type MutableComposerState = DraftComposerState;

interface ConversationState {
  target: readonly unknown[];
  state: MutableComposerState;
}

export interface DraftAgentControllerOptions {
  idFactory?: (sequence: number) => string;
  enabledAgents?: readonly RendererAgent[];
}

export interface DraftAgentSwitchOperations {
  applyAgent(agent: RendererAgent): boolean;
  clearPrewarm(): Promise<void>;
}

function defaultIdFactory(sequence: number): string {
  return `codexhost-composer-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function isConversationTarget(target: readonly unknown[] | null): target is readonly unknown[] {
  return target?.[0] === "conversation";
}

function sameTarget(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class DraftAgentController<Composer extends object> {
  readonly #idFactory: (sequence: number) => string;
  readonly #enabledAgents: ReadonlySet<RendererAgent>;
  readonly #conversationStates: ConversationState[] = [];
  readonly #states = new WeakMap<Composer, MutableComposerState>();
  readonly #switching = new Set<MutableComposerState>();
  #composerSequence = 0;

  constructor(options: DraftAgentControllerOptions = {}) {
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#enabledAgents = new Set(options.enabledAgents ?? DEFAULT_RENDERER_AGENTS);
    if (!this.#enabledAgents.has("codex")) {
      throw new Error("Renderer enabled Agents must include Codex");
    }
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
    const state = this.#state(composer);
    if (isConversationTarget(target)) {
      this.#conversationStates.push({ target, state });
    }
    return state;
  }

  isSwitching(composer: Composer): boolean {
    return this.#switching.has(this.#state(composer));
  }

  lock(composer: Composer): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    state.phase = "locked";
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

  #state(composer: Composer): MutableComposerState {
    const existing = this.#states.get(composer);
    if (existing) return existing;
    const created: MutableComposerState = {
      agent: "codex",
      phase: "draft",
      composerId: this.#idFactory(++this.#composerSequence),
    };
    this.#states.set(composer, created);
    return created;
  }
}
