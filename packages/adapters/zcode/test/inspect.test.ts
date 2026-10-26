import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ZcodeAdapter } from "../src/adapter.js";
import type { CliTransport } from "../src/transport.js";

const workspace = { workspacePath: tmpdir(), workspaceKey: tmpdir() };
function snapshot(available: unknown[]) {
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: "draft",
      workspace,
      title: "",
      status: "idle",
      mode: "build",
      createdAt: 0,
      updatedAt: 0,
      sessionKind: "main",
    },
    settings: {
      model: { available },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: { status: "idle", contextUsed: 0, contextWindow: 0 },
    messages: [],
    runtime: {},
  };
}
function adapterWith(signedIn: boolean, available: unknown[] = []) {
  const transport = {
    signedIn,
    startPlan: false,
    start: async () => undefined,
    close: async () => undefined,
    request: async (method: string) =>
      method === "createDraftSession" ? snapshot(available) : undefined,
  };
  return new ZcodeAdapter({ createTransport: () => transport as unknown as CliTransport });
}

describe("ZCode connection check without available models", () => {
  it("reports a signed-in account without an active plan as setup, not login", async () => {
    const adapter = adapterWith(true);
    const inspected = await adapter.inspect({ cwd: tmpdir() });
    expect(inspected).toMatchObject({
      status: "unavailable",
      error: { code: "configurationRequired", retryable: true },
    });
    if (inspected.status !== "unavailable") throw new Error("expected unavailable");
    expect(inspected.error?.message).toContain("ZCode is signed in");
    await adapter.close();
  });

  it("keeps the login prompt for a signed-out ZCode Desktop", async () => {
    const adapter = adapterWith(false);
    expect(await adapter.inspect({ cwd: tmpdir() })).toMatchObject({
      status: "unavailable",
      error: { code: "authenticationRequired", retryable: true },
    });
    await adapter.close();
  });

  it("is ready once the account exposes a model", async () => {
    const adapter = adapterWith(true, [
      {
        ref: { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
        label: "Start Plan / GLM-5.3-Flash",
      },
    ]);
    expect((await adapter.inspect({ cwd: tmpdir() })).status).toBe("ready");
    await adapter.close();
  });
});
