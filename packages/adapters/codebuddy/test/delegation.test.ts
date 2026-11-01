import { describe, expect, it, vi } from "vitest";
import { CODEBUDDY_DELEGATION_INSTRUCTIONS, codeBuddyInvocation } from "../src/command.js";
import { CodeBuddyAdapter } from "../src/codebuddy-adapter.js";
import { fixture } from "./fixtures.js";
import { harnessPermissionModeIdSchema } from "@codexhost/shared-contracts";
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveHarnessExecutable: () => ({ executable: process.execPath }),
}));
const runtime = {
  CODEXHOST_CLI_PATH: "/configured/cli with spaces",
  CODEXHOST_RUNTIME_ENDPOINT: "/configured/runtime",
  CODEXHOST_RUNTIME_TOKEN: "private-test-runtime-token",
  CODEXHOST_THREAD_ID: "parent-thread",
};
describe("CodeBuddy cross-Harness delegation", () => {
  it("makes the configured CLI discoverable in native ACP without expanding secrets into arguments", () => {
    const invocation = codeBuddyInvocation({ ...process.env, ...runtime }, false);
    expect(invocation.arguments).toEqual([
      "--acp",
      "--append-system-prompt",
      CODEBUDDY_DELEGATION_INSTRUCTIONS,
    ]);
    expect(invocation.environment).toMatchObject(runtime);
    for (const value of Object.values(runtime))
      expect(invocation.arguments.join(" ")).not.toContain(value);
    expect(codeBuddyInvocation(runtime, true).arguments).toEqual([
      "--acp",
      "--no-session-persistence",
    ]);
    expect(
      codeBuddyInvocation({ ...runtime, CODEXHOST_RUNTIME_TOKEN: undefined }, false).arguments,
    ).toEqual(["--acp"]);
  });

  it("retains per-Thread delegation environment across create and resume", async () => {
    const native = fixture();
    const adapter = new CodeBuddyAdapter({
      ...native,
      environment: { ...runtime, CODEXHOST_THREAD_ID: "stale-parent" },
    });
    try {
      expect(
        await adapter.open({
          kind: "create",
          cwd: process.cwd(),
          executionPolicy: "unattended-full-access",
          permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
        }),
      ).toMatchObject({ error: { code: "invalidRequest" } });
      expect(native.clients).toHaveLength(0);
      const opened = await adapter.open({
        kind: "create",
        cwd: process.cwd(),
        environment: runtime,
        executionPolicy: "unattended-full-access",
      });
      if (!opened.ok) throw Error(opened.error.message);
      expect(opened.value.initialState.effectivePermissionModeId).toBe("fullAccess");
      expect(native.clients[0]?.context.environment).toMatchObject(runtime);
      const ref = opened.value.initialState.nativeRef;
      if (!ref) throw Error("No native identity");
      native.history.push({ id: "existing", type: "message", role: "user", content: "earlier" });
      await opened.value.close();
      const resumed = await adapter.open({
        kind: "resume",
        cwd: process.cwd(),
        nativeRef: ref,
        environment: runtime,
      });
      expect(resumed.ok).toBe(true);
      expect(native.clients.at(-1)?.context.environment).toMatchObject(runtime);
    } finally {
      await adapter.close();
    }
  });
});
