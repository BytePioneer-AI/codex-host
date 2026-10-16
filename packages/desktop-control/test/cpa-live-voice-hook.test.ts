import { describe, expect, it } from "vitest";

import {
  AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET,
  AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION,
  CPA_LIVE_VOICE_ENV,
  cpaLiveVoiceHookBootstrap,
  cpaLiveVoiceHookEnabled,
} from "../src/cpa-live-voice-hook.js";

describe("CPA live-voice controller bootstrap", () => {
  it("defaults on and opts out only with CODEXHOST_CPA_LIVE_VOICE=0", () => {
    expect(cpaLiveVoiceHookEnabled({})).toBe(true);
    expect(cpaLiveVoiceHookEnabled({ [CPA_LIVE_VOICE_ENV]: "1" })).toBe(true);
    expect(cpaLiveVoiceHookEnabled({ [CPA_LIVE_VOICE_ENV]: "0" })).toBe(false);
    expect(cpaLiveVoiceHookBootstrap({ [CPA_LIVE_VOICE_ENV]: "0" })).toBe("");
  });

  it("emits a frozen enable record by default", () => {
    const source = cpaLiveVoiceHookBootstrap({});
    expect(source.startsWith("globalThis.__codexhostCpaLiveVoiceHookV1 = Object.freeze(")).toBe(
      true,
    );
    expect(source).toContain(`"auditedDesktopVersion":"${AUDITED_CPA_LIVE_VOICE_DESKTOP_VERSION}"`);
    expect(source).toContain(
      `"auditedAppInitialAsset":"${AUDITED_CPA_LIVE_VOICE_APP_INITIAL_ASSET}"`,
    );
    expect(source).toContain('"enabled":true');
    expect(source).not.toContain("clientOwnsCall");
    expect(source).not.toContain("function pa");
  });
});
