export type RendererAgent = "codex" | "pi";
export type ComposerAgentPhase = "draft" | "locked";

export interface DraftComposerState {
  agent: RendererAgent;
  phase: ComposerAgentPhase;
  composerId: string;
}

type MutableComposerState = DraftComposerState;

export interface DraftAgentControllerOptions {
  idFactory?: (sequence: number) => string;
}

export interface DraftAgentSwitchOperations {
  applyAgent(agent: RendererAgent): boolean;
  clearPrewarm(): Promise<void>;
}

function defaultIdFactory(sequence: number): string {
  return `codexhost-composer-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export class DraftAgentController<Composer extends object> {
  readonly #idFactory: (sequence: number) => string;
  readonly #states = new WeakMap<Composer, MutableComposerState>();
  readonly #switching = new Set<MutableComposerState>();
  #composerSequence = 0;

  constructor(options: DraftAgentControllerOptions = {}) {
    this.#idFactory = options.idFactory ?? defaultIdFactory;
  }

  get(composer: Composer): Readonly<DraftComposerState> {
    return this.#state(composer);
  }

  isSwitching(composer: Composer): boolean {
    return this.#switching.has(this.#state(composer));
  }

  lock(composer: Composer): Readonly<DraftComposerState> {
    const state = this.#state(composer);
    state.phase = "locked";
    return state;
  }

  transfer(source: Composer, replacement: Composer): boolean {
    const state = this.#states.get(source);
    if (!state) return false;
    if (source === replacement) return true;
    if (this.#states.has(replacement)) return false;
    this.#states.set(replacement, state);
    return true;
  }

  async switchAgent(
    composer: Composer,
    nextAgent: RendererAgent,
    operations: DraftAgentSwitchOperations,
  ): Promise<boolean> {
    const state = this.#state(composer);
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
