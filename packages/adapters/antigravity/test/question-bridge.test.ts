import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessOutput, HostQuestionInteraction } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { AntigravityQuestionBridge } from "../src/question-bridge.js";

// Shape captured from the real CLI's PreToolUse input, not an invented stdout event.
const input = {
  conversationId: "1832f234-8567-4381-adf0-28098745cde1",
  stepIdx: 2,
  toolCall: {
    name: "ask_question",
    args: {
      questions: [
        {
          question: "Choose the diagnostic option",
          options: ["Alpha", "Beta"],
          is_multi_select: false,
        },
      ],
      toolAction: "Asking diagnostic question",
    },
  },
};

async function fixture(timeoutMs = 5_000) {
  const outputs: HarnessOutput[] = [];
  const bridge = await AntigravityQuestionBridge.create({
    turnId: hostTurnIdSchema.parse("turn-test"),
    nativeSessionId: () => input.conversationId,
    schedule: (action) => action(),
    emit: (output) => outputs.push(output),
    timeoutMs,
  });
  const url = bridge.environment.CODEXHOST_AGY_QUESTION_URL;
  if (!url) throw new Error("Bridge did not publish its URL");
  return { bridge, outputs, url };
}

async function runHook(bridge: AntigravityQuestionBridge, payload: unknown = input) {
  const config = JSON.parse(
    await readFile(path.join(bridge.directory, ".agents", "hooks.json"), "utf8"),
  );
  const command = config["codexhost-question-bridge"].PreToolUse[0].hooks[0].command as string;
  const child = spawn(
    process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    [process.platform === "win32" ? "/c" : "-c", command],
    {
      env: { ...process.env, ...bridge.environment },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr += text;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
  child.stdin.end(JSON.stringify(payload));
  return done;
}

async function question(outputs: HarnessOutput[]): Promise<HostQuestionInteraction> {
  await vi.waitFor(() => expect(outputs.some(({ kind }) => kind === "interaction")).toBe(true));
  const output = outputs.find(({ kind }) => kind === "interaction");
  if (output?.kind !== "interaction" || output.interaction.type !== "question")
    throw new Error("No Question");
  return output.interaction;
}

describe("Antigravity question Hook bridge", () => {
  it("rejects answers past the announced deadline even before the timer callback runs", async () => {
    const { bridge, outputs } = await fixture();
    try {
      const done = runHook(bridge);
      const interaction = await question(outputs);
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(Date.parse(interaction.expiresAt ?? "") + 1);
      try {
        expect(
          bridge.respond({
            type: "interaction.respond",
            interactionId: interaction.interactionId,
            response: { type: "question", answers: { q1: ["Beta"] } },
          }),
        ).toMatchObject({ ok: false, error: { code: "invalidState" } });
      } finally {
        clock.mockRestore();
      }
      expect(JSON.parse((await done).stdout).reason).toContain("expired without an answer");
      expect(
        outputs.some(
          (output) =>
            output.kind === "event" &&
            output.event.type === "interaction.closed" &&
            output.event.reason === "expired",
        ),
      ).toBe(true);
    } finally {
      await bridge.dispose();
    }
  });

  it("runs the generated Hook and carries validated Desktop answers through deny.reason", async () => {
    const { bridge, outputs } = await fixture();
    try {
      const done = runHook(bridge);
      const interaction = await question(outputs);
      expect(interaction.questions[0]).toMatchObject({
        id: "q1",
        type: "choice",
        allowOther: true,
        multiple: false,
      });
      expect(
        bridge.respond({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: { invalid: ["Beta"] } },
        }),
      ).toMatchObject({ ok: false, error: { code: "invalidRequest" } });
      const answer = {
        type: "interaction.respond" as const,
        interactionId: interaction.interactionId,
        response: { type: "question" as const, answers: { q1: ["Beta"] } },
      };
      expect(bridge.respond(answer)).toEqual({ ok: true, value: { accepted: true } });
      expect(bridge.respond(answer)).toMatchObject({ ok: false, error: { code: "invalidState" } });
      const completed = await done;
      expect(completed.code).toBe(0);
      expect(completed.stderr).toBe("");
      expect(JSON.parse(completed.stdout)).toMatchObject({
        decision: "deny",
        reason: expect.stringContaining('"answers":["Beta"]'),
      });
      expect(
        outputs.map((output) => (output.kind === "event" ? output.event.type : output.kind)),
      ).toEqual(["item.started", "interaction", "interaction.closed", "item.completed"]);
      const config = JSON.parse(
        await readFile(path.join(bridge.directory, ".agents", "hooks.json"), "utf8"),
      );
      expect(config["codexhost-question-bridge"].PreToolUse[0].matcher).toBe("^ask_question$");
      expect(JSON.stringify(config)).not.toContain(bridge.environment.CODEXHOST_AGY_QUESTION_TOKEN);
    } finally {
      await bridge.dispose();
    }
    await expect(access(bridge.directory)).rejects.toThrow();
  });

  it.each(["cancelled", "expired", "turn-ended"] as const)(
    "closes %s questions without inventing an answer",
    async (mode) => {
      const { bridge, outputs } = await fixture(mode === "expired" ? 150 : 5000);
      try {
        const done = runHook(bridge);
        const interaction = await question(outputs);
        if (mode === "cancelled") {
          expect(
            bridge.respond({
              type: "interaction.respond",
              interactionId: interaction.interactionId,
              response: { type: "question", answers: {}, cancelled: true },
            }).ok,
          ).toBe(true);
        } else if (mode === "turn-ended") {
          bridge.stop();
        }
        const result = await done;
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).decision).toBe("deny");
        expect(JSON.parse(result.stdout).reason).not.toContain('"status":"answered"');
        expect(outputs).toContainEqual({
          kind: "event",
          event: {
            type: "interaction.closed",
            interactionId: interaction.interactionId,
            turnId: interaction.turnId,
            reason: mode === "expired" ? "expired" : "cancelled",
          },
        });
        expect(
          bridge.respond({
            type: "interaction.respond",
            interactionId: interaction.interactionId,
            response: { type: "question", answers: { q1: ["Alpha"] } },
          }),
        ).toMatchObject({ ok: false, error: { code: "invalidState" } });
      } finally {
        await bridge.dispose();
      }
    },
  );

  it("isolates two simultaneous bridges and rejects cross-session credentials and payloads", async () => {
    const first = await fixture();
    const second = await fixture();
    try {
      const unauthorized = await fetch(second.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${first.bridge.environment.CODEXHOST_AGY_QUESTION_TOKEN}`,
        },
        body: JSON.stringify(input),
      });
      expect(unauthorized.status).toBe(403);
      await unauthorized.text();
      const wrong = await runHook(first.bridge, { ...input, conversationId: "another-session" });
      expect(JSON.parse(wrong.stdout).reason).toContain("does not belong");
      expect(first.outputs).toHaveLength(0);
      expect(second.outputs).toHaveLength(0);
      const firstDone = runHook(first.bridge);
      const secondDone = runHook(second.bridge);
      const a = await question(first.outputs);
      const b = await question(second.outputs);
      expect(
        first.bridge.respond({
          type: "interaction.respond",
          interactionId: b.interactionId,
          response: { type: "question", answers: { q1: ["Beta"] } },
        }).ok,
      ).toBe(false);
      for (const [bridge, interaction, choice] of [
        [first.bridge, a, "Alpha"],
        [second.bridge, b, "Beta"],
      ] as const) {
        expect(
          bridge.respond({
            type: "interaction.respond",
            interactionId: interaction.interactionId,
            response: { type: "question", answers: { q1: [choice] } },
          }).ok,
        ).toBe(true);
      }
      expect(JSON.parse((await firstDone).stdout).reason).toContain('"answers":["Alpha"]');
      expect(JSON.parse((await secondDone).stdout).reason).toContain('"answers":["Beta"]');
      const duplicate = await runHook(first.bridge);
      expect(JSON.parse(duplicate.stdout).reason).toContain("Duplicate");
    } finally {
      await Promise.all([first.bridge.dispose(), second.bridge.dispose()]);
    }
  });

  it("closes a question when the Hook connection drops", async () => {
    const { bridge, outputs, url } = await fixture();
    try {
      const request = httpRequest(url, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.environment.CODEXHOST_AGY_QUESTION_TOKEN}` },
      });
      request.on("error", () => {});
      request.end(JSON.stringify(input));
      const interaction = await question(outputs);
      request.destroy();
      await vi.waitFor(() =>
        expect(
          outputs.some(
            (output) => output.kind === "event" && output.event.type === "interaction.closed",
          ),
        ).toBe(true),
      );
      expect(
        bridge.respond({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: { q1: ["Alpha"] } },
        }).ok,
      ).toBe(false);
    } finally {
      await bridge.dispose();
    }
  });

  it("executes the native shell command when the Hook path contains spaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost hook space "));
    const mockedTemp = vi.spyOn(os, "tmpdir").mockReturnValue(root);
    let bridge: AntigravityQuestionBridge | undefined;
    try {
      const created = await fixture();
      bridge = created.bridge;
      mockedTemp.mockRestore();
      const done = runHook(bridge);
      const interaction = await question(created.outputs);
      expect(
        bridge.respond({
          type: "interaction.respond",
          interactionId: interaction.interactionId,
          response: { type: "question", answers: { q1: ["Beta"] } },
        }).ok,
      ).toBe(true);
      const result = await done;
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).reason).toContain('"answers":["Beta"]');
    } finally {
      mockedTemp.mockRestore();
      await bridge?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { ...input, toolCall: { name: "run_command", args: { questions: [] } } },
    {
      ...input,
      toolCall: {
        name: "ask_question",
        args: { questions: [{ question: "Q", options: ["A", "A"] }] },
      },
    },
    {
      ...input,
      toolCall: {
        name: "ask_question",
        args: { questions: [{ question: "Q", options: ["A", "B"], is_multi_select: true }] },
      },
    },
  ])("rejects malformed or unsupported questions without emitting a card", async (payload) => {
    const { bridge, outputs } = await fixture();
    try {
      const result = await runHook(bridge, payload);
      expect(JSON.parse(result.stdout).decision).toBe("deny");
      expect(outputs).toHaveLength(0);
    } finally {
      await bridge.dispose();
    }
  });
});
