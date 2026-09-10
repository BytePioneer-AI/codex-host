import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { startIsolatedDelegationRuntime } from "../src/isolated-delegation-runtime.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-observer-runtime-"));
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("grok"));
  const runtime = await startIsolatedDelegationRuntime({
    dataDirectory: directory,
    cliPath: "/synthetic/cli",
    mode: "hermetic",
    externalAdapters: new Map([["grok", adapter]]),
  });
  const environment = runtime.childEnvironment();
  const call = async (route: string, body: unknown) => {
    const response = await fetch(`${runtime.endpoint}/v1/${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.CODEXHOST_RUNTIME_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(value));
    return value;
  };
  const start = () =>
    call("delegate/start", {
      harnessId: "grok",
      task: "controlled fixture",
      cwd: directory,
      requestId: crypto.randomUUID(),
    });
  const observe = (targets: unknown, output: PassThrough, fetchImpl?: typeof fetch) =>
    runDelegationCli({
      arguments: ["thread", "observe", "--targets-file", "-", "--timeout-ms", "4000"],
      stdin: Readable.from([JSON.stringify(targets)]),
      environment,
      output,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  return {
    adapter,
    call,
    start,
    observe,
    close: async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("observer through the real loopback Runtime and CLI", () => {
  it("keeps one caller promise pending through progress and returns a compact completion", async () => {
    const f = await fixture();
    try {
      const child = await f.start();
      const session = f.adapter.sessions[0];
      if (!session) throw new Error("Missing fixture Session");
      const output = new PassThrough();
      let observedRequests = 0;
      const fetchImpl: typeof fetch = async (url, init) => {
        observedRequests += 1;
        return fetch(url, init);
      };
      const done = vi.fn();
      const pending = f
        .observe([{ threadId: child.threadId, expectedTurnId: child.turnId }], output, fetchImpl)
        .then((code) => {
          done();
          return code;
        });
      await vi.waitFor(() => expect(observedRequests).toBeGreaterThanOrEqual(2));
      session.appendText("ordinary progress must stay inside the observer");
      await vi.waitFor(() => expect(observedRequests).toBeGreaterThanOrEqual(3));
      expect(done).not.toHaveBeenCalled();
      expect(output.readableLength).toBe(0);
      session.succeedTurn();
      expect(await pending).toBe(0);
      const value = JSON.parse(output.read().toString());
      expect(value.events).toEqual([{ threadId: child.threadId, reason: "terminal" }]);
      expect(value.inputVisibilityUnavailable).toEqual([]);
      expect(value.suppressedChanges).toBeGreaterThan(0);
      expect(JSON.stringify(value)).not.toContain("ordinary progress");
    } finally {
      await f.close();
    }
  });

  it.each(["question", "approval"])(
    "wakes on a real projected %s without answering it",
    async (kind) => {
      const f = await fixture();
      try {
        const child = await f.start();
        const session = f.adapter.sessions[0];
        if (!session) throw new Error("Missing fixture Session");
        const output = new PassThrough();
        const pending = f.observe([{ threadId: child.threadId }], output);
        await delay(50);
        if (kind === "question")
          session.askQuestion({
            id: "decision",
            type: "text",
            prompt: "Need input",
            optional: false,
            secret: false,
            multiline: false,
          });
        else session.requestApproval("Need approval");
        expect(await pending).toBe(0);
        const result = JSON.parse(output.read().toString());
        expect(result.events).toEqual([{ threadId: child.threadId, reason: "needs-input" }]);
        expect(result.statuses[0].pendingInteractions).toBe(1);
        expect(session.interactionResponses).toHaveLength(0);
        const status = await f.call("thread/status", { threadId: child.threadId });
        expect(status.status).toBe("running");
      } finally {
        await f.close();
      }
    },
  );
});
