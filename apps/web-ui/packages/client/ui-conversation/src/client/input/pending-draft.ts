/**
 * Resident plain-text draft buffer for the Hero composer while a New Session is
 * still being created on the Host. Owns one lightweight Lexical editor so typing,
 * multiline breaks, IME composition, undo/redo, and plain-text paste match the
 * live composer without requiring a SessionBinding or enabling submission/uploads.
 */
import { createSnapshotStore, type ObservableSnapshot } from "@deepseek-ai/dsh-client-store";
import type { LexicalEditor } from "lexical";
import { DraftEditorRuntime } from "./editor/runtime.ts";

/** Creation lifecycle subset observed by the pending-draft buffer. */
export interface PendingSessionCreation {
  readonly state: "idle" | "creating" | "error";
  readonly token?: number;
  readonly initialPrompt?: string;
}

/** Captured text and edit flag handed to the newly created Session. */
export interface PendingDraftCapture {
  readonly text: string;
  readonly modified: boolean;
}

const EMPTY_LEXICON: ReadonlyMap<"/" | "@" | "#", readonly string[]> = new Map();

/** Lightweight Lexical-backed draft buffer used before a new Session exists. */
export class PendingDraftBuffer {
  private readonly runtime: DraftEditorRuntime;
  private readonly unregister: () => void;
  private readonly textStore = createSnapshotStore("");
  private activeToken: number | null = null;
  private modified = false;
  private seeding = false;

  /** Live plain-text content for placeholder visibility. */
  readonly text: ObservableSnapshot<string> = this.textStore;

  constructor() {
    this.runtime = new DraftEditorRuntime({
      onUpdate: () => {
        const prev = this.runtime.refreshProjection();
        const nextText = this.runtime.projection.clipboardText;
        if (prev.clipboardText !== nextText) {
          if (!this.seeding) this.modified = true;
          this.textStore.set(nextText);
        }
      },
      openReference: () => false,
      activeClaimToken: () => null,
      lexicon: () => EMPTY_LEXICON,
      resolveLexicon: () => undefined,
    });
    this.unregister = this.runtime.register();
  }

  /** Underlying Lexical editor bound to ComposerContentEditable while creating. */
  get editor(): LexicalEditor {
    return this.runtime.editor;
  }

  /**
   * Reconcile buffer ownership with the current New Session creation state.
   * Retries and in-place workspace switches keep the same token and preserve typed text.
   */
  syncCreation(state: PendingSessionCreation): void {
    if (state.state === "idle") {
      if (this.activeToken !== null || this.textStore.getSnapshot() !== "") {
        this.activeToken = null;
        this.clearEditor();
      }
      return;
    }
    const token = state.token ?? null;
    if (token === this.activeToken) return;
    this.activeToken = token;
    this.seed(state.initialPrompt ?? "");
  }

  /** Insert plain text from clipboard over the current selection. */
  paste(text: string): void {
    this.runtime.paste(text);
  }

  /**
   * Take the current pending draft for handoff to the newly created Session,
   * then reset the buffer. Returns undefined when no creation draft was active.
   */
  take(): PendingDraftCapture | undefined {
    if (this.activeToken === null) return undefined;
    const capture: PendingDraftCapture = {
      text: this.runtime.projection.clipboardText,
      modified: this.modified,
    };
    this.activeToken = null;
    this.clearEditor();
    return capture;
  }

  /** Release the underlying editor listeners. */
  dispose(): void {
    this.activeToken = null;
    this.unregister();
  }

  private seed(text: string): void {
    this.seeding = true;
    try {
      this.modified = false;
      this.runtime.setDraft(text);
      this.runtime.clearHistory();
      this.textStore.set(this.runtime.projection.clipboardText);
    } finally {
      this.seeding = false;
    }
  }

  private clearEditor(): void {
    this.seed("");
  }
}
