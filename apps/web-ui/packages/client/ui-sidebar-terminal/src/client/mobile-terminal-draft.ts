/** In-memory native-editor draft owned by one sidebar terminal view. */
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";

interface MobileTerminalDraftState {
  readonly text: string;
  readonly enterMode: "insert" | "send";
  readonly sending: boolean;
  readonly uncertain: boolean;
}

/** Retains unsent text across DOM remounts, without persisting commands to disk. */
export class MobileTerminalDraft {
  readonly state = createSnapshotStore<MobileTerminalDraftState>({
    text: "",
    enterMode: "send",
    sending: false,
    uncertain: false,
  });
  private revision = 0;

  /** Keep this terminal's keyboard choice across tab remounts, independently of its text. */
  setEnterMode(enterMode: MobileTerminalDraftState["enterMode"]): void {
    const state = this.state.getSnapshot();
    if (state.enterMode === enterMode) return;
    this.state.set({ ...state, enterMode });
  }

  /** @param text - exact editor value, including uncommitted IME text. */
  edit(text: string): void {
    if (text === this.state.getSnapshot().text) return;
    this.revision++;
    this.state.set({ ...this.state.getSnapshot(), text });
  }

  /**
   * Send once and clear only the unchanged, acknowledged draft. Failure retains
   * the text, because loss of a receipt does not prove the PTY received nothing.
   * @param send - sends text and optional explicit control key in order.
   * @returns whether the provider acknowledged the submission.
   */
  async submit(send: (text: string) => Promise<void>): Promise<boolean> {
    const state = this.state.getSnapshot();
    if (state.sending) return false;
    const revision = this.revision;
    this.state.set({ ...state, sending: true, uncertain: false });
    try {
      await send(state.text);
      const current = this.state.getSnapshot();
      this.state.set({
        ...current,
        sending: false,
        text: this.revision === revision ? "" : current.text,
      });
      return true;
    } catch {
      this.state.set({ ...this.state.getSnapshot(), sending: false, uncertain: true });
      return false;
    }
  }
}
