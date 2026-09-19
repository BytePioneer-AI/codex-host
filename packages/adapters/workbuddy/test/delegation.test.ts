import { describe, expect, it } from "vitest";

import { type CodeBuddyClient, type CodeBuddyClientFactory } from "@codexhost/adapter-codebuddy";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";

import {
  WORKBUDDY_MACOS_CLI,
  WORKBUDDY_MACOS_ELECTRON,
  workBuddyInvocation,
} from "../src/command.js";
import { WORKBUDDY_DELEGATION_INSTRUCTIONS } from "../src/delegation.js";
import { WorkBuddyAdapter } from "../src/workbuddy-adapter.js";

const runtimeEnvironment = {
  CODEXHOST_CLI_PATH: "/configured/cli with spaces",
  CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:43123",
  CODEXHOST_RUNTIME_TOKEN: "private-test-runtime-token",
  CODEXHOST_THREAD_ID: "delegated-child",
};

const configOptions = [
  {
    id: "model",
    currentValue: "native/model",
    options: [{ value: "native/model", name: "Native Model" }],
  },
  {
    id: "mode",
    currentValue: "default",
    options: ["default", "plan", "fullAccess"].map((value) => ({ value, name: value })),
  },
  {
    id: "thought_level",
    currentValue: "low",
    options: ["low", "high"].map((value) => ({ value, name: value })),
  },
];

describe("WorkBuddy cross-Harness delegation", () => {
  it("exposes fixed native instructions while keeping Runtime credentials in the ACP environment", () => {
    const invocation = workBuddyInvocation({ HOME: "/Users/test", ...runtimeEnvironment }, false, {
      platform: "darwin",
      isExecutable: (candidate) =>
        candidate === WORKBUDDY_MACOS_ELECTRON || candidate === WORKBUDDY_MACOS_CLI,
    });
    const instructions = WORKBUDDY_DELEGATION_INSTRUCTIONS;
    expect(invocation.arguments).toEqual([
      WORKBUDDY_MACOS_CLI,
      "--acp",
      "--append-system-prompt",
      instructions,
    ]);
    expect(invocation.environment).toMatchObject(runtimeEnvironment);
    for (const value of Object.values(runtimeEnvironment)) {
      expect(invocation.arguments.join(" ")).not.toContain(value);
    }
    expect(instructions).toContain("Native WorkBuddy Agent subagents remain separate");

    const explicit = workBuddyInvocation(
      {
        HOME: "/Users/test",
        CODEXHOST_WORKBUDDY_COMMAND: "/custom/workbuddy",
        ...runtimeEnvironment,
      },
      false,
      {
        platform: "darwin",
        isExecutable: (candidate) => candidate === "/custom/workbuddy",
      },
    );
    expect(explicit.command).toBe("/custom/workbuddy");
    expect(explicit.arguments).toEqual(["--acp", "--append-system-prompt", instructions]);
    expect(explicit.environment).toMatchObject(runtimeEnvironment);
    expect(explicit.environment).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    for (const value of Object.values(runtimeEnvironment)) {
      expect(explicit.arguments.join(" ")).not.toContain(value);
    }

    expect(
      workBuddyInvocation({ HOME: "/Users/test", ...runtimeEnvironment }, true, {
        platform: "darwin",
        isExecutable: () => true,
      }).arguments,
    ).toEqual([WORKBUDDY_MACOS_CLI, "--acp", "--no-session-persistence"]);
    expect(
      workBuddyInvocation(
        {
          HOME: "/Users/test",
          ...runtimeEnvironment,
          CODEXHOST_RUNTIME_TOKEN: undefined,
        },
        false,
        { platform: "darwin", isExecutable: () => true },
      ).arguments,
    ).toEqual([WORKBUDDY_MACOS_CLI, "--acp"]);
  });

  it("preserves per-Thread delegation environment across create and resume", async () => {
    const contexts: Parameters<CodeBuddyClientFactory>[0][] = [];
    const factory: CodeBuddyClientFactory = (context) => {
      contexts.push(context);
      let options = structuredClone(configOptions);
      return {
        initialize: async () => ({ protocolVersion: 1 }),
        open: async (_cwd, sessionId) => ({
          sessionId: sessionId ?? "workbuddy-delegated",
          configOptions: options,
        }),
        configure: async (_sessionId, id, value) => {
          options = options.map((option) => ({
            ...option,
            currentValue: option.id === id ? value : option.currentValue,
          }));
          return { configOptions: options };
        },
        prompt: async () => ({ stopReason: "end_turn" }),
        cancel: async () => {},
        answer: async () => {},
        close: async () => {},
      } satisfies CodeBuddyClient;
    };
    const adapter = new WorkBuddyAdapter({
      environment: { ...runtimeEnvironment, CODEXHOST_THREAD_ID: "stale-parent" },
      clientFactory: factory,
      readHistory: async () => "",
    });
    try {
      await expect(
        adapter.open({
          kind: "create",
          cwd: process.cwd(),
          environment: runtimeEnvironment,
          executionPolicy: "unattended-full-access",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        }),
      ).resolves.toMatchObject({ error: { code: "invalidRequest" } });
      expect(contexts).toHaveLength(0);

      const created = await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        environment: runtimeEnvironment,
        executionPolicy: "unattended-full-access",
      });
      if (!created.ok) throw new Error(created.error.message);
      expect(created.value.initialState.effectivePermissionModeId).toBe("fullAccess");
      expect(contexts[0]?.environment).toMatchObject(runtimeEnvironment);
      const nativeRef = created.value.initialState.nativeRef;
      if (!nativeRef) throw new Error("WorkBuddy delegation did not expose Native identity");
      await created.value.close();

      const resumed = await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef,
        environment: runtimeEnvironment,
      });
      expect(resumed.ok).toBe(true);
      expect(contexts.at(-1)?.environment).toMatchObject(runtimeEnvironment);
    } finally {
      await adapter.close();
    }
  });
});
