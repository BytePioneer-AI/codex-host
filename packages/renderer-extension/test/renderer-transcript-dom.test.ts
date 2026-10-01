import { describe, expect, it } from "vitest";

import {
  installReasoningTranscriptSoftWrap,
  recoveredTurnErrorKeys,
} from "../src/renderer-transcript-dom.js";

describe("Recovered external Turn errors", () => {
  const entry = (
    turnId: string,
    status: string,
    hostId = "local",
    conversationId = "thread-1",
    model: string | null = "codexhost/antigravity-native",
  ) => ({
    turnId,
    hostId,
    conversationId,
    turn: {
      status,
      error: status === "failed" ? { message: "native failure" } : null,
      params: { model },
    },
  });
  const key = (turnId: string, hostId = "local", conversationId = "thread-1") =>
    JSON.stringify([hostId, conversationId, turnId]);

  it("resolves a failed Turn only after later success, including hydrated history", () => {
    const failed = entry("failed", "failed");
    expect(recoveredTurnErrorKeys([failed, entry("retry", "inProgress")])).not.toContain(
      key("failed"),
    );
    expect(recoveredTurnErrorKeys([failed, entry("retry", "failed")])).not.toContain(key("failed"));
    const recovered = recoveredTurnErrorKeys([
      failed,
      entry("retry", "completed", "local", "thread-1", null),
      entry("new-failure", "failed"),
    ]);
    expect(recovered).toContain(key("failed"));
    expect(recovered).toContain(key("retry"));
    expect(recovered).not.toContain(key("new-failure"));
  });

  it("keeps Hosts, Threads, native Codex Turns and newer duplicate identities isolated", () => {
    const turns = [
      entry("shared", "failed", "remote"),
      entry("shared", "failed", "local", "other-thread"),
      entry("shared", "completed"),
      entry("shared", "failed"),
      entry("codex", "completed", "local", "native-thread", "gpt-6.1"),
    ];
    const recovered = recoveredTurnErrorKeys(turns);
    expect(recovered).not.toContain(key("shared", "remote"));
    expect(recovered).not.toContain(key("shared", "local", "other-thread"));
    expect(recovered).not.toContain(key("shared"));
    expect(recovered).not.toContain(key("codex", "local", "native-thread"));
  });
});

describe("Reasoning transcript soft wrap", () => {
  it("does not install styling when the owner document has no Window", () => {
    const dispose = installReasoningTranscriptSoftWrap({
      defaultView: null,
    } as unknown as Document);

    expect(dispose).not.toThrow();
    expect(() => dispose()).not.toThrow();
  });
});
