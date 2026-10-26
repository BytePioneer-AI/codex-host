import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import {
  harnessPermissionModeIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { DevinAdapter } from "../src/adapter.js";
import { devinModelRef, devinThinkingOptionId } from "../src/models.js";

vi.mock("../src/command.js", () => ({
  devinInvocation: () => ({
    command: process.execPath,
    arguments: [fileURLToPath(new URL("./fixtures/history-acp.mjs", import.meta.url))],
    windowsVerbatimArguments: false,
  }),
}));
vi.mock("../src/credentials.js", () => ({
  devinApiKey: () => {
    throw new Error("Credential access is forbidden in synthetic history tests");
  },
}));
const sourceRef = nativeSessionRefSchema.parse({
  harnessId: "devin",
  nativeSessionId: "source",
  formatVersion: 1,
});
const checkpoint = (id: string) =>
  nativeCheckpointRefSchema.parse({
    harnessId: "devin",
    nativeSessionId: "source",
    checkpointId: id,
    formatVersion: 1,
  });
let root: string;
let adapter: DevinAdapter;
let log: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "devin-synthetic-history-"));
  log = path.join(root, "requests.jsonl");
  environment = { DEVIN_TEST_LOG: log, DEVIN_HISTORY_SCENARIO: "normal", DEVIN_SOURCE_CWD: root };
  adapter = new DevinAdapter({ environment, timeoutMs: 2_000 });
});
afterEach(async () => {
  await adapter.close();
  await rm(root, { recursive: true, force: true });
});
async function requests() {
  return (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("synthetic Devin native history wire", () => {
  it.each(["step-u2", "step-u3"])(
    "uses the native extension for %s and can continue the child",
    async (id) => {
      const opened = await adapter.open({
        kind: "fork",
        sourceRef,
        checkpoint: checkpoint(id),
        cwd: root,
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const child = opened.value;
      expect(child.initialState.nativeRef?.nativeSessionId).toBe(
        id === "step-u2" ? "fork-2" : "fork-3",
      );
      expect(child.capabilities.history).toEqual({
        fork: true,
        forkAcrossCwd: false,
        rollbackLastTurn: true,
      });
      const snapshot = await child.readSnapshot();
      expect(
        snapshot.ok && snapshot.value.turns.map((turn) => turn.nativeTurnRef.nativeTurnKey),
      ).toEqual(id === "step-u2" ? ["u1", "u2"] : ["u1", "u2", "u3"]);
      const before = await requests();
      expect(before.find((request) => request.method.endsWith("forkFromStep"))?.params).toEqual({
        sessionId: "source",
        stepId: id,
      });
      expect(
        before.some((request) =>
          /prompt|execute|resume|preview|session\/fork/.test(request.method),
        ),
      ).toBe(false);
      const outputs: HarnessOutput[] = [];
      const done = (async () => {
        for await (const output of child.outputs) outputs.push(output);
      })();
      try {
        await child.execute({
          type: "turn.start",
          turnId: hostTurnIdSchema.parse("next"),
          input: [{ type: "text", text: "synthetic continuation" }],
        });
        await vi.waitFor(() =>
          expect(outputs).toContainEqual(
            expect.objectContaining({
              event: expect.objectContaining({
                type: "turn.completed",
                nativeTurnRef: expect.objectContaining({
                  nativeSessionId: child.initialState.nativeRef?.nativeSessionId,
                  nativeTurnKey: "next",
                }),
                outcome: {
                  status: "succeeded",
                  checkpoint: expect.objectContaining({
                    nativeSessionId: child.initialState.nativeRef?.nativeSessionId,
                    checkpointId: "step-next",
                  }),
                },
              }),
            }),
          ),
        );
      } finally {
        await child.close();
        await done;
      }
    },
  );
  it.each(["normal", "single"])(
    "rolls back %s history with confirmed configuration",
    async (scenario) => {
      environment.DEVIN_HISTORY_SCENARIO = scenario;
      const opened = await adapter.open({
        kind: "rollbackLastTurn",
        sourceRef,
        cwd: root,
        model: devinModelRef("b"),
        thinkingOptionId: devinThinkingOptionId("high"),
        permissionModeId: harnessPermissionModeIdSchema.parse("plan"),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      const snapshot = await opened.value.readSnapshot();
      expect(snapshot.ok && snapshot.value.turns.length).toBe(scenario === "single" ? 0 : 2);
      expect(opened.value.initialState).toMatchObject({
        effectiveModel: devinModelRef("b"),
        effectiveThinkingOptionId: devinThinkingOptionId("high"),
        effectivePermissionModeId: "plan",
      });
      const trace = await requests();
      expect(trace.some((request) => /prompt|execute/.test(request.method))).toBe(false);
      expect(
        trace
          .filter((request) => request.method === "session/set_config_option")
          .every((request) => request.params.sessionId !== "source"),
      ).toBe(true);
      if (scenario === "single")
        expect(trace.some((request) => request.method === "session/new")).toBe(true);
    },
  );
  it.each(["fork-error", "wrong-id", "source-id", "wrong-prefix", "wrong-cwd", "old", "empty"])(
    "rejects %s without a guessed success",
    async (scenario) => {
      environment.DEVIN_HISTORY_SCENARIO = scenario;
      const result = await adapter.open(
        scenario === "empty"
          ? { kind: "rollbackLastTurn", sourceRef, cwd: root }
          : { kind: "fork", sourceRef, checkpoint: checkpoint("step-u2"), cwd: root },
      );
      expect(result).toMatchObject({ ok: false });
      const trace = await requests();
      expect(trace.some((request) => /prompt|execute|preview/.test(request.method))).toBe(false);
      if (scenario === "old") {
        expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
        expect(trace.some((request) => request.method.includes("revert/"))).toBe(false);
      }
      if (scenario === "wrong-id" || scenario === "wrong-prefix")
        expect(!result.ok && result.error.message).toContain("may remain on disk");
      if (scenario === "wrong-id")
        expect(!result.ok && result.error.message).toContain("different native Session ID");
      if (scenario === "wrong-cwd")
        expect(trace.some((request) => request.method === "session/load")).toBe(false);
      const pids = new Set<number>(trace.map((request) => request.pid));
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      });
    },
  );
});
