import type { CodeBuddyRuntimeProfile } from "@codexhost/adapter-codebuddy";
import { harnessCommandCatalogSchema, harnessIdSchema } from "@codexhost/shared-contracts";

export const WORKBUDDY_ID = harnessIdSchema.parse("workbuddy");

export const WORKBUDDY_COMMAND_CATALOG = harnessCommandCatalogSchema.parse({
  commands: [
    {
      id: "workbuddy.compact",
      invocation: "/compact",
      label: "Compact context",
      description: "Compact the current WorkBuddy Session context",
      argumentMode: "text",
    },
    {
      id: "workbuddy.init",
      invocation: "/init",
      label: "Initialize project guide",
      description: "Generate native project instructions with WorkBuddy",
      argumentMode: "none",
    },
  ],
});

export const WORKBUDDY_RUNTIME_PROFILE: CodeBuddyRuntimeProfile = {
  harnessId: WORKBUDDY_ID,
  displayName: "WorkBuddy",
  interactionIdPrefix: "workbuddy",
  configDirectoryEnvironmentVariables: ["WORKBUDDY_CONFIG_DIR"],
  defaultConfigDirectoryName: ".workbuddy-ai",
  // WorkBuddy's native PathUtils.compressPath preserves case, dots, spaces and Unicode.
  projectDirectoryName: (cwd) =>
    cwd
      .replace(/[/\\:]/gu, "-")
      .replace(/^-+/u, "")
      .replace(/-+$/u, "")
      .replace(/-+/gu, "-"),
  staticCommandCatalog: WORKBUDDY_COMMAND_CATALOG,
  nativeCommands: true,
  historyCapabilities: { fork: true, forkAcrossCwd: true, rollbackLastTurn: true },
};
