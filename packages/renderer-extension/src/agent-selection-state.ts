export type RendererAgent = "codex" | "pi";
export type SubmissionTrigger = "click" | "enter" | "submit";

export interface RendererSubmissionObservation {
  submissionId: string;
  composerId: string;
  agent: RendererAgent;
  trigger: SubmissionTrigger;
  capturedAt: string;
}

interface ComposerState {
  agent: RendererAgent;
  composerId: string;
  lastCapturedAt: number | null;
  lastObservation: RendererSubmissionObservation | null;
}

export interface AgentSelectionRegistryOptions {
  clock?: () => number;
  dedupeWindowMs?: number;
  idFactory?: (kind: "composer" | "submission", sequence: number) => string;
}

function defaultIdFactory(kind: "composer" | "submission", sequence: number): string {
  return `codexhost-${kind}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export class AgentSelectionRegistry<Composer extends object> {
  readonly #clock: () => number;
  readonly #dedupeWindowMs: number;
  readonly #idFactory: (kind: "composer" | "submission", sequence: number) => string;
  readonly #states = new WeakMap<Composer, ComposerState>();
  #composerSequence = 0;
  #submissionSequence = 0;

  constructor(options: AgentSelectionRegistryOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#dedupeWindowMs = options.dedupeWindowMs ?? 250;
    this.#idFactory = options.idFactory ?? defaultIdFactory;
  }

  get(composer: Composer): Readonly<ComposerState> {
    return this.#state(composer);
  }

  setAgent(composer: Composer, agent: RendererAgent): Readonly<ComposerState> {
    const state = this.#state(composer);
    state.agent = agent;
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

  capture(composer: Composer, trigger: SubmissionTrigger): RendererSubmissionObservation | null {
    const state = this.#state(composer);
    const now = this.#clock();
    if (
      state.lastCapturedAt !== null &&
      state.lastObservation !== null &&
      now - state.lastCapturedAt <= this.#dedupeWindowMs
    ) {
      return null;
    }
    const observation: RendererSubmissionObservation = {
      submissionId: this.#idFactory("submission", ++this.#submissionSequence),
      composerId: state.composerId,
      agent: state.agent,
      trigger,
      capturedAt: new Date(now).toISOString(),
    };
    state.lastCapturedAt = now;
    state.lastObservation = observation;
    return observation;
  }

  #state(composer: Composer): ComposerState {
    const existing = this.#states.get(composer);
    if (existing) return existing;
    const created: ComposerState = {
      agent: "codex",
      composerId: this.#idFactory("composer", ++this.#composerSequence),
      lastCapturedAt: null,
      lastObservation: null,
    };
    this.#states.set(composer, created);
    return created;
  }
}
