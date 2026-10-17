import { describe, expect, it } from "vitest";

import {
  GROK_CODEXHOST_SESSION_RULES,
  grokCodexhostSessionMeta,
} from "../src/grok-codexhost-session-rules.js";

describe("Grok CodexHost ACP session rules", () => {
  it("uses official session/new _meta.rules and keeps secrets out of the prompt text", () => {
    expect(GROK_CODEXHOST_SESSION_RULES).toContain("CodexHost started this Grok ACP session");
    expect(GROK_CODEXHOST_SESSION_RULES).toContain("Never print");
    expect(GROK_CODEXHOST_SESSION_RULES).toContain("flash-max");
    expect(GROK_CODEXHOST_SESSION_RULES).toContain("thread/realtime/*");
    expect(GROK_CODEXHOST_SESSION_RULES).toContain("AGENT_TOOLS_AND_RULES.md");
    expect(GROK_CODEXHOST_SESSION_RULES).not.toContain("echo $CODEXHOST_THREAD_ID");
    expect(GROK_CODEXHOST_SESSION_RULES).not.toContain("~/.grok/rules");
  });

  it("adds rules to create metadata and keeps Permission Mode flags", () => {
    expect(grokCodexhostSessionMeta("ask")).toEqual({
      yoloMode: false,
      autoMode: false,
      rules: GROK_CODEXHOST_SESSION_RULES,
    });
    expect(grokCodexhostSessionMeta()).toEqual({ rules: GROK_CODEXHOST_SESSION_RULES });
  });
});
