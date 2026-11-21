import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ZcodeAdapter } from "../src/adapter.js";
import type { CliTransport, TransportOptions } from "../src/transport.js";

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
function adapterWith(
  signedIn: boolean,
  available: unknown[] = [],
  startPlanChecked = true,
  codingPlanIssue?: string,
  credentialIssue?: string,
) {
  const transport = {
    signedIn,
    startPlanChecked,
    codingPlanIssue,
    credentialIssue,
    startPlan: false,
    start: async () => undefined,
    close: async () => undefined,
    request: async (method: string) =>
      method === "createDraftSession" ? snapshot(available) : undefined,
  };
  return new ZcodeAdapter({ createTransport: () => transport as unknown as CliTransport });
}

describe("ZCode connection check without available models", () => {
  it("reports a personal credential failure without claiming the paid subscription is inactive", async () => {
    const issue =
      "Personal Coding Plan credentials could not be read; subscription status is unknown.";
    const adapter = adapterWith(true, [], true, issue);
    expect(await adapter.inspect({ cwd: tmpdir() })).toMatchObject({
      status: "unavailable",
      error: { code: "configurationRequired", message: issue },
    });
    await adapter.close();
  });
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

  it("does not claim there is no plan when the Start Plan balance could not be checked", async () => {
    const adapter = adapterWith(true, [], false);
    const inspected = await adapter.inspect({ cwd: tmpdir() });
    expect(inspected).toMatchObject({
      status: "unavailable",
      error: { code: "configurationRequired", retryable: true },
    });
    if (inspected.status !== "unavailable") throw new Error("expected unavailable");
    expect(inspected.error?.message).toContain("could not be checked");
    expect(inspected.error?.message).not.toContain("no active Start Plan");
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

  it("marks credential read failures non-retryable to avoid automatic Keychain prompt loops", async () => {
    const issue = "ZCode could not read credentials: macOS Keychain read timed out.";
    const adapter = adapterWith(false, [], false, undefined, issue);
    expect(await adapter.inspect({ cwd: tmpdir() })).toMatchObject({
      status: "unavailable",
      error: { code: "configurationRequired", message: issue, retryable: false },
    });
    await adapter.close();
  });

  it("deduplicates concurrent inspect calls and only retries denied Keychain on explicit full refresh", async () => {
    const seen: TransportOptions[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createTransport = vi.fn((options: TransportOptions) => {
      seen.push(options);
      return {
        signedIn: true,
        startPlanChecked: true,
        startPlan: false,
        start: async () => {
          if (seen.length === 1) await gate;
        },
        close: async () => undefined,
        request: async (method: string) =>
          method === "createDraftSession"
            ? snapshot([
                {
                  ref: { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3-Flash" },
                  label: "Start Plan / GLM-5.3-Flash",
                },
              ])
            : undefined,
      } as unknown as CliTransport;
    });
    const adapter = new ZcodeAdapter({ createTransport });
    const first = adapter.inspect({ cwd: tmpdir(), refresh: true, purpose: "availability" });
    const second = adapter.inspect({ cwd: tmpdir(), refresh: true, purpose: "availability" });
    release();
    expect(await Promise.all([first, second])).toMatchObject([
      { status: "ready" },
      { status: "ready" },
    ]);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(seen[0]?.retryDeniedKeychain).toBeUndefined();

    // Explicit non-availability refresh is allowed to retry a previously denied Keychain read.
    await adapter.inspect({ cwd: tmpdir(), refresh: true });
    expect(createTransport).toHaveBeenCalledTimes(2);
    expect(seen[1]?.retryDeniedKeychain).toBe(true);
    await adapter.close();
  });
});
