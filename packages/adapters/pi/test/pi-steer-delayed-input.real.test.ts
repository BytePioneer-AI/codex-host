import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import type { HarnessSession, HostEvent } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { PiAdapter } from "../src/pi-adapter.js";
import {
  PiRpcSession,
  PiRpcSteerRejectedError,
  piRpcProcessCommand,
} from "../src/pi-rpc-session.js";

const enabled = (process.env.CODEXHOST_STEER_REAL_HARNESSES ?? "").split(",").includes("pi");

// An opt-in native regression. Only the extra input hook is controlled; the Adapter,
// CLI, Model and persisted history are real. Uses existing auth and Model quota.
it.runIf(enabled)(
  "preserves the completed Pi Turn and recovers without replaying late input",
  async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codexhost-steer-delayed-"));
    const log = path.join(cwd, "native-hook.jsonl");
    const extension = path.join(cwd, "delayed-input.ts");
    const marker = `CODEXHOST_DELAYED_STEER_${randomUUID().replaceAll("-", "")}`;
    await writeFile(
      extension,
      `import { appendFileSync } from "node:fs";
export default function (pi) {
  let release = null;
  const log = (event) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event, at: Date.now() }) + "\\n");
  pi.on("agent_settled", () => {
    log("agent_settled");
    if (release) setTimeout(() => release?.(), 100);
  });
  pi.on("input", async (event) => {
    if (!event.text.startsWith(${JSON.stringify(marker)})) return { action: "continue" };
    log("steer_input_enter");
    await new Promise((resolve) => {
      const timeout = setTimeout(() => { log("hook_timeout"); resolve(); }, 20000);
      release = () => { clearTimeout(timeout); resolve(); };
    });
    log("steer_input_release");
    release = null;
    return { action: "continue" };
  });
}
`,
    );
    const children: ChildProcessWithoutNullStreams[] = [];
    const consumers: Promise<void>[] = [];
    const sessionsDirectory = path.join(cwd, "sessions");
    const adapter = new PiAdapter(
      {},
      {
        createTransport: (options) =>
          new PiRpcSession(
            {
              ...options,
              environment: {
                ...process.env,
                ...options.environment,
                PI_CODING_AGENT_SESSION_DIR: sessionsDirectory,
              },
              commandTimeoutMs: 45000,
            },
            {
              spawn(processOptions) {
                const invocation = piRpcProcessCommand(processOptions);
                const arguments_ = [...invocation.arguments];
                const mode = arguments_.indexOf("--mode");
                assert.ok(mode >= 0, "Delayed-input Gate requires direct Pi CLI arguments");
                arguments_.splice(mode, 0, "--extension", extension);
                const child = spawn(invocation.command, arguments_, {
                  cwd: processOptions.cwd,
                  env: processOptions.environment,
                  stdio: ["pipe", "pipe", "pipe"],
                  windowsHide: true,
                  windowsVerbatimArguments: invocation.windowsVerbatimArguments,
                });
                children.push(child);
                return child;
              },
            },
          ),
      },
    );
    const report: Record<string, unknown> = { status: "running", harness: "pi" };
    const collect = (session: HarnessSession): HostEvent[] => {
      const events: HostEvent[] = [];
      consumers.push(
        (async () => {
          for await (const output of session.outputs) {
            if (output.kind === "event") events.push(output.event);
          }
        })(),
      );
      return events;
    };
    const wait = async (
      events: HostEvent[],
      predicate: (event: HostEvent) => boolean,
      label: string,
    ): Promise<HostEvent> => {
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const event = events.find(predicate);
        if (event) return event;
        assert.ok(
          !events.some((event) => event.type === "session.faulted"),
          `Fault before ${label}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out: ${label}`);
    };
    try {
      const opened = await adapter.open({ kind: "create", cwd });
      assert.ok(opened.ok, opened.ok ? "" : opened.error.message);
      const session = opened.value;
      const events = collect(session);
      const turnId = hostTurnIdSchema.parse(randomUUID());
      assert.equal(
        (
          await session.execute({
            type: "turn.start",
            turnId,
            input: [
              {
                type: "text",
                text: "Run exactly one foreground shell command: sleep 3; printf 'ORIGINAL_TOOL_DONE\\n'. Wait for it, then reply exactly ORIGINAL_FINISHED. Do not run any other tools or read or modify files.",
              },
            ],
          })
        ).ok,
        true,
      );
      await wait(
        events,
        (event) =>
          event.type === "item.started" &&
          ["commandExecution", "toolExecution"].includes(event.item.type),
        "foreground tool",
      );
      assert.equal(session.capabilities.steer, true);
      const failure = await session
        .execute({
          type: "turn.steer",
          turnId,
          input: [{ type: "text", text: `${marker}. Reply exactly DELAYED_STEER_REACHED.` }],
        })
        .catch((error) => error);
      assert.ok(
        failure instanceof Error && !(failure instanceof PiRpcSteerRejectedError),
        "Late queue admission must not report acceptance or a safe-to-replay refusal",
      );
      const terminal = await wait(
        events,
        (event) => event.type === "turn.completed" && event.turnId === turnId,
        "original completion",
      );
      assert.ok(terminal.type === "turn.completed");
      assert.equal(terminal.outcome.status, "succeeded", JSON.stringify(terminal.outcome));
      assert.ok(terminal.nativeTurnRef);
      await consumers[0];
      const faultIndex = events.findIndex((event) => event.type === "session.faulted");
      assert.ok(
        faultIndex > events.indexOf(terminal),
        "Fault must follow, not replace, the completed Turn",
      );
      const originalProcess = children[0];
      assert.ok(originalProcess);
      assert.ok(
        originalProcess.exitCode !== null || originalProcess.signalCode !== null,
        "Retired runtime must have exited",
      );
      const nativeRef = events.findLast(
        (event): event is Extract<HostEvent, { type: "session.state.changed" }> =>
          event.type === "session.state.changed" && event.state.nativeRef !== undefined,
      )?.state.nativeRef;
      assert.ok(nativeRef, "Original native Session must remain resumable");
      const hookEvents = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        hookEvents.map((event) => event.event),
        ["steer_input_enter", "agent_settled", "steer_input_release"],
      );
      await session.close();
      const resumed = await adapter.open({ kind: "resume", nativeRef, cwd });
      assert.ok(resumed.ok, resumed.ok ? "" : resumed.error.message);
      const recovered = resumed.value;
      const recoveredRef = recovered.initialState.nativeRef;
      assert.ok(recoveredRef);
      assert.equal(recoveredRef.nativeSessionId, nativeRef.nativeSessionId);
      const recoveredEvents = collect(recovered);
      const followUpId = hostTurnIdSchema.parse(randomUUID());
      assert.equal(
        (
          await recovered.execute({
            type: "turn.start",
            turnId: followUpId,
            input: [
              {
                type: "text",
                text: "Reply exactly RECOVERY_OK. Do not run any tools or read or modify files.",
              },
            ],
          })
        ).ok,
        true,
      );
      const followUp = await wait(
        recoveredEvents,
        (event) => event.type === "turn.completed" && event.turnId === followUpId,
        "recovered completion",
      );
      assert.ok(followUp.type === "turn.completed");
      assert.equal(followUp.outcome.status, "succeeded", JSON.stringify(followUp.outcome));
      const snapshot = await recovered.readSnapshot();
      assert.ok(snapshot.ok);
      assert.equal(snapshot.value.turns.length, 2);
      assert.deepEqual(snapshot.value.turns[0]?.nativeTurnRef, terminal.nativeTurnRef);
      assert.ok(
        snapshot.value.turns.every((turn) =>
          turn.input.every((input) => !input.text.includes(marker)),
        ),
        "The retired queue must not leak into a later Turn",
      );
      const replies = recoveredEvents
        .flatMap((event) =>
          event.type === "item.completed" && event.snapshot.item.type === "agentMessage"
            ? [event.snapshot.item.text]
            : [],
        )
        .join("\n");
      assert.ok(replies.includes("RECOVERY_OK"));
      assert.ok(!replies.includes("DELAYED_STEER_REACHED"));
      Object.assign(report, {
        status: "passed",
        originalOutcome: terminal.outcome.status,
        recoveredOutcome: followUp.outcome.status,
        sameSession: true,
        staleInputReplayed: false,
        hookEvents,
      });
    } catch (error) {
      Object.assign(report, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      try {
        await adapter.close();
        await Promise.all(consumers);
        await rm(cwd, { recursive: true, force: true });
      } catch (error) {
        Object.assign(report, {
          status: "failed",
          cleanupError: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        const reportDirectory = path.resolve(".codexhost", "native-steer-real", "pi-delayed-input");
        await mkdir(reportDirectory, { recursive: true });
        await writeFile(
          path.join(reportDirectory, "result.json"),
          `${JSON.stringify(report, null, 2)}\n`,
        );
      }
    }
  },
  180000,
);
