import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { desktopRequestSettings, desktopHistorySettings } = createRequire(import.meta.url)(
  "../assets/companion/settings.cjs",
);

function setup(values: Record<string, unknown> = {}, available = true) {
  const executeCommand = vi.fn(async () => ({
    ask_user_question_v2: { val: { enabled: available }, vid: "private-experiment" },
    unrelated: { val: { token: "private-value" } },
  }));
  return {
    executeCommand,
    vscode: {
      workspace: { getConfiguration: () => ({ get: (key: string) => values[key] }) },
      commands: { executeCommand },
    },
  };
}

describe("TRAE CN app-owned request settings", () => {
  it("honors native fork feature flags without exporting experiment metadata", async () => {
    const executeCommand = vi.fn(async () => ({
      fork_chat: {
        val: {
          enable_v2: true,
          enable_create_from_message: false,
          enable_create_from_session: true,
        },
        vid: "private",
      },
    }));
    expect(await desktopHistorySettings({ commands: { executeCommand } })).toEqual({
      forkFromMessage: false,
      forkFromSession: true,
    });
    executeCommand.mockRejectedValue(new Error("unavailable"));
    expect(await desktopHistorySettings({ commands: { executeCommand } })).toEqual({
      forkFromMessage: true,
      forkFromSession: true,
    });
  });
  it("reads the Desktop preferences and experiment without exporting unrelated values", async () => {
    const test = setup(
      {
        "AI.agent.v2.ide.proactiveQuestioning": true,
        "AI.agent.v2.solo.proactiveQuestioning": false,
      },
      false,
    );
    expect(await desktopRequestSettings(test.vscode)).toEqual({
      ask_question_config: { feature_available: false, ide_enable: true, solo_enable: false },
    });
    expect(test.executeCommand).toHaveBeenCalledExactlyOnceWith("icube.event.getAllABTestConfigs");
  });

  it.each(["force_enabled", "force_disabled"])(
    "honors the native %s override without experiment reads",
    async (override) => {
      const test = setup({ "AI.agent.v2.askUserQuestion.featureOverride": override });
      const enabled = override === "force_enabled";
      expect(await desktopRequestSettings(test.vscode)).toEqual({
        ask_question_config: {
          feature_available: enabled,
          ide_enable: enabled,
          solo_enable: enabled,
        },
      });
      expect(test.executeCommand).not.toHaveBeenCalled();
    },
  );

  it("uses the native experiment fallback without enabling unset user preferences", async () => {
    const test = setup();
    test.executeCommand.mockRejectedValue(new Error("Experiment service unavailable"));
    expect(await desktopRequestSettings(test.vscode)).toEqual({
      ask_question_config: { feature_available: true, ide_enable: false, solo_enable: false },
    });
  });
});
