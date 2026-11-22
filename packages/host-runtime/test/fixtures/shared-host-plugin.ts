/** A durable, CLI-free native session fixture for cross-process owner lifecycle tests. */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { harnessIdSchema, harnessModelCatalogSchema } from "@codexhost/shared-contracts";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  const data = context.environment.CODEXHOST_DATA_DIR;
  if (!data) throw new Error("Native fixture requires an isolated Host data directory");
  const root = join(data, "fixture-native");
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, "adapters.jsonl"), JSON.stringify({ pid: process.pid }) + "\n");
  const harnessId = harnessIdSchema.parse("fixture");
  const catalog = harnessModelCatalogSchema.parse({
    models: [{ ref: { id: "fixture" }, label: "Fixture Model" }],
    defaultModel: { id: "fixture" },
    thinkingOptions: [],
  });
  const sessions = new Set<FakeHarnessSession>();
  return {
    harnessId,
    inspect: async () => ({
      status: "ready",
      catalog,
      capabilities: {
        configuration: {
          selectModel: true,
          selectThinkingOption: false,
          selectPermissionMode: false,
          permissionModeScope: "live",
        },
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      },
    }),
    open: async (input) => {
      if (input.kind !== "create" && input.kind !== "resume")
        return {
          ok: false,
          error: {
            code: "unsupported",
            message: "Fixture supports create/resume only",
            retryable: false,
          },
        };
      const ref =
        input.kind === "create"
          ? { harnessId, nativeSessionId: randomUUID(), formatVersion: 1 as const }
          : input.nativeRef;
      const file = join(root, `${ref.nativeSessionId}.json`);
      if (input.kind === "resume" && !existsSync(file))
        return {
          ok: false,
          error: { code: "sessionNotFound", message: "Missing fixture history", retryable: false },
        };
      const snapshot = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { turns: [] };
      const session = new FakeHarnessSession(
        harnessId,
        catalog,
        input.model,
        ref,
        snapshot,
        false,
        input.cwd,
      );
      sessions.add(session);
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      writeFileSync(join(root, "descendant.json"), JSON.stringify({ pid: child.pid }));
      writeFileSync(file, JSON.stringify(snapshot));
      const persist = async () => {
        const read = await session.readSnapshot();
        if (read.ok) writeFileSync(file, JSON.stringify(read.value));
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const close = session.close.bind(session);
      session.close = async () => {
        clearTimeout(timer);
        child.kill();
        await persist();
        await close();
        sessions.delete(session);
      };
      return {
        ok: true,
        value: {
          ...session,
          execute: session.execute.bind(session),
          readSnapshot: session.readSnapshot.bind(session),
          close: session.close,
          outputs: {
            async *[Symbol.asyncIterator]() {
              for await (const output of session.outputs) {
                if (output.kind === "event" && output.event.type === "turn.started") {
                  appendFileSync(
                    join(root, "commands.jsonl"),
                    JSON.stringify({
                      pid: process.pid,
                      command: "turn.start",
                      turnId: output.event.turnId,
                    }) + "\n",
                  );
                  timer = setTimeout(() => {
                    session.appendText("completed without either viewer");
                    session.succeedTurn();
                    void persist();
                  }, 500);
                }
                yield output;
              }
            },
          },
        },
      };
    },
    close: async () => {
      await Promise.all([...sessions].map((session) => session.close()));
    },
  };
}
