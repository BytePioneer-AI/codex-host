import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { HMHarnessAdapter } from "../src/hmharness-adapter.js";
import {
  encodeHmHarnessModelRef,
  normalizeHmHarnessModelCatalog,
  parseHmHarnessProviderCatalog,
} from "../src/model-catalog.js";
import { hostItemIdSchema, hostTurnIdSchema } from "@codexhost/shared-contracts";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import type { HMHarnessBridgeInput } from "../src/hmharness-adapter.js";

const providerJson = `${JSON.stringify({
  version: "0.5.2",
  chat: "agnes",
  providers: [
    { name: "agnes", model: "agnes-model", purposes: ["chat"] },
    { name: "omnifusion", model: "@quality", purposes: [] },
  ],
})}\n`;

function model(provider: string, modelId: string) {
  return encodeHmHarnessModelRef({ provider, model: modelId });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

describe("HMHarness adapter", () => {
  it("normalizes a credential-free provider catalog", () => {
    const catalog = normalizeHmHarnessModelCatalog(parseHmHarnessProviderCatalog(providerJson));
    expect(catalog.models.map(({ label }) => label)).toEqual([
      "agnes / agnes-model",
      "omnifusion / @quality",
    ]);
    expect(catalog.defaultModel?.id).toBe(model("agnes", "agnes-model").id);
    expect(JSON.stringify(catalog)).not.toContain("apiKey");
  });

  it("runs a selected model and projects a completed turn", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hmharness-adapter-"));
    const calls: HMHarnessBridgeInput[] = [];
    const adapter = new HMHarnessAdapter(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      {
        randomUUID: () => crypto.randomUUID(),
        runBridge: async (input) => {
          calls.push(input);
          if (input.arguments.includes("providers")) {
            return { stdout: providerJson, stderr: "", exitCode: 0 };
          }
          return {
            stdout: `${JSON.stringify({ text: "HMH ready" })}\n`,
            stderr: "",
            exitCode: 0,
          };
        },
      },
    );
    try {
      const inspection = await adapter.inspect({ cwd: directory });
      expect(inspection).toMatchObject({ status: "ready" });
      const opened = await adapter.open({
        kind: "create",
        cwd: directory,
        model: model("omnifusion", "@quality"),
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const outputs: string[] = [];
      const consumed = (async () => {
        for await (const output of opened.value.outputs) {
          if (output.kind === "event") outputs.push(output.event.type);
        }
      })();
      const turnId = hostTurnIdSchema.parse("turn-1");
      const accepted = await opened.value.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "hello hmharness" }],
      });
      expect(accepted).toEqual({ ok: true, value: { turnId } });
      await waitFor(() => outputs.includes("turn.completed"));
      const snapshot = await opened.value.readSnapshot();
      expect(snapshot).toMatchObject({ ok: true });
      expect(snapshot.ok && snapshot.value.turns[0]?.items[0]?.item.type).toBe("agentMessage");
      await opened.value.close();
      await consumed;
      const run = calls.find(({ arguments: args }) => args.includes("run"));
      expect(run?.environment.HMH_CHAT_PROVIDER).toBe("omnifusion");
      expect(run?.stdin).toContain("hello hmharness");
      expect(outputs).toEqual(["turn.started", "item.started", "item.completed", "turn.completed"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await adapter.close();
    }
  });

  it("streams deltas and closes the same Item with authoritative final text", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hmharness-adapter-stream-"));
    const adapter = new HMHarnessAdapter(
      { command: process.execPath, environment: { PATH: process.env.PATH } },
      {
        randomUUID: () => crypto.randomUUID(),
        runBridge: async (input) => {
          if (input.arguments.includes("providers")) {
            return { stdout: providerJson, stderr: "", exitCode: 0 };
          }
          input.onStdoutLine?.(JSON.stringify({ type: "delta", text: "partial " }));
          input.onStdoutLine?.(JSON.stringify({ type: "delta", text: "progress" }));
          return {
            stdout:
              [
                JSON.stringify({ type: "delta", text: "partial " }),
                JSON.stringify({ type: "delta", text: "progress" }),
                JSON.stringify({ text: "partial authoritative" }),
              ].join("\n") + "\n",
            stderr: "",
            exitCode: 0,
          };
        },
      },
    );
    try {
      const opened = await adapter.open({ kind: "create", cwd: directory });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const outputs: HarnessOutput[] = [];
      const consumed = (async () => {
        for await (const output of opened.value.outputs) outputs.push(output);
      })();
      const turnId = hostTurnIdSchema.parse("turn-stream");
      await opened.value.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "stream hmharness" }],
      });
      await waitFor(() =>
        outputs.some((output) => output.kind === "event" && output.event.type === "turn.completed"),
      );
      await opened.value.close();
      await consumed;

      const events = outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
      expect(events.map((event) => event.type)).toEqual([
        "turn.started",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.completed",
      ]);
      const itemStarted = events[1];
      const itemCompleted = events[3];
      if (itemStarted?.type !== "item.started" || itemCompleted?.type !== "item.completed") {
        throw new Error("HMHarness streaming lifecycle was not projected");
      }
      expect(itemCompleted.snapshot.item.itemId).toBe(itemStarted.item.itemId);
      if (itemCompleted.snapshot.item.type !== "agentMessage") {
        throw new Error("HMHarness final Item is not an Agent Message");
      }
      expect(itemCompleted.snapshot.item.text).toBe("partial authoritative");
      expect(itemCompleted.snapshot.outcome.status).toBe("succeeded");
      const turnCompleted = events[4];
      if (turnCompleted?.type !== "turn.completed") {
        throw new Error("HMHarness streaming Turn did not complete");
      }
      if (!turnCompleted.nativeTurnRef) {
        throw new Error("HMHarness successful Turn has no Native Turn identity");
      }
      expect(turnCompleted).toMatchObject({
        turnId,
        outcome: { status: "succeeded" },
      });
      expect(turnCompleted.nativeTurnRef.nativeSessionId).toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
      await adapter.close();
    }
  });

  it("projects cancellation as a cancelled turn", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "hmharness-adapter-cancel-"));
    const adapter = new HMHarnessAdapter(
      { command: process.execPath },
      {
        randomUUID: () => crypto.randomUUID(),
        runBridge: (input) =>
          new Promise((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            });
          }),
      },
    );
    try {
      const opened = await adapter.open({ kind: "create", cwd: directory });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const outputs: unknown[] = [];
      const consumed = (async () => {
        for await (const output of opened.value.outputs) outputs.push(output);
      })();
      const turnId = hostTurnIdSchema.parse("turn-cancel");
      await opened.value.execute({
        type: "turn.start",
        turnId,
        input: [{ type: "text", text: "long task" }],
      });
      const cancelled = await opened.value.execute({ type: "turn.cancel", turnId });
      expect(cancelled).toEqual({ ok: true, value: { cancellationRequested: true } });
      await waitFor(() => outputs.length === 2);
      const completed = outputs.at(-1);
      expect(completed).toMatchObject({
        event: { type: "turn.completed", outcome: { status: "cancelled" } },
      });
      void hostItemIdSchema;
      await opened.value.close();
      await consumed;
    } finally {
      await rm(directory, { recursive: true, force: true });
      await adapter.close();
    }
  });
});
