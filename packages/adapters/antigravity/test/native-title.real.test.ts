import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { hostTurnIdSchema, nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import { AntigravityAcpTransport } from "../src/acp-transport.js";
import { AntigravityAdapter, AntigravitySession } from "../src/antigravity-adapter.js";

const RUN_REAL = process.env.CODEXHOST_RUN_ANTIGRAVITY_TITLE_REAL === "1";

/**
 * Isolated real-CLI verification for native session titles (Issue #818).
 * Reuses the signed-in `agy` account: the resume case only reads
 * `conversation_summaries.db`, the create case sends one synthetic prompt and
 * removes the conversation it created.
 */
describe.skipIf(!RUN_REAL)("Antigravity real native titles", () => {
  const agyRoot = path.join(os.homedir(), ".gemini", "antigravity-cli");
  function collect(session: HarnessSession): HarnessOutput[] {
    const outputs: HarnessOutput[] = [];
    void (async () => {
      for await (const output of session.outputs) outputs.push(output);
    })();
    return outputs;
  }
  async function waitFor(
    outputs: HarnessOutput[],
    predicate: (output: HarnessOutput) => boolean,
    timeoutMs = 90_000,
  ): Promise<HarnessOutput> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = outputs.find(predicate);
      if (found) return found;
      await delay(25);
    }
    throw new Error("Timed out waiting for Antigravity output");
  }
  function normalizeExpectedTitle(value: string): string {
    return value.replaceAll("\0", "").trim().replace(/\s+/g, " ");
  }
  it("restores a stored native title on lazy resume without spawning acp", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-title-resume-"));
    const summaries = new DatabaseSync(path.join(agyRoot, "conversation_summaries.db"), {
      readOnly: true,
    });
    let stored: { conversation_id: string; title: string } | undefined;
    try {
      const candidates = summaries
        .prepare(
          `SELECT conversation_id, title FROM conversation_summaries
           WHERE parent_conversation_id = '' AND title != '' AND status = 'CASCADE_RUN_STATUS_IDLE'
           ORDER BY last_modified_time DESC LIMIT 20`,
        )
        .all() as Array<{ conversation_id: string; title: string }>;
      stored = candidates.find((row) => {
        const normalized = normalizeExpectedTitle(row.title);
        return normalized.length > 0 && normalized.length <= 4096;
      });
    } finally {
      summaries.close();
    }
    expect(stored?.title, "expected a titled idle native conversation").toBeTruthy();
    const expectedTitle = normalizeExpectedTitle(stored?.title ?? "");
    let transports = 0;
    const adapter = new AntigravityAdapter({
      environment: {
        ...process.env,
        CODEXHOST_DATA_DIR: path.join(workspace, "data"),
        CODEXHOST_THREAD_ID: randomUUID(),
      },
      commandTimeoutMs: 120_000,
      createTransport: (options) => {
        transports += 1;
        return new AntigravityAcpTransport(options);
      },
    });
    let session: HarnessSession | undefined;
    try {
      const opened = await adapter.open({
        kind: "resume",
        cwd: workspace,
        nativeRef: nativeSessionRefSchema.parse({
          harnessId: "antigravity",
          nativeSessionId: stored?.conversation_id,
          formatVersion: 1,
        }),
      });
      if (!opened.ok) throw new Error(opened.error.message);
      session = opened.value;
      const outputs = collect(session);
      const titled = await waitFor(
        outputs,
        (output) => output.kind === "event" && output.event.type === "session.title.changed",
      );
      if (titled.kind !== "event" || titled.event.type !== "session.title.changed")
        throw new Error("Missing title event");
      expect(titled.event.title).toBe(expectedTitle);
      expect(transports).toBe(0);
      await session.close();
    } finally {
      await adapter.close();
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 120_000);

  it("reports the live native title for a new session after one real prompt", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-title-create-"));
    const liveTitles: string[] = [];
    const adapter = new AntigravityAdapter({
      environment: {
        ...process.env,
        CODEXHOST_DATA_DIR: path.join(workspace, "data"),
        CODEXHOST_THREAD_ID: randomUUID(),
      },
      commandTimeoutMs: 120_000,
      createTransport: (options) => {
        const transport = new AntigravityAcpTransport(options);
        const setSessionEventHandler = transport.setSessionEventHandler.bind(transport);
        transport.setSessionEventHandler = (handler) => {
          setSessionEventHandler(
            handler
              ? (event) => {
                  if (event.type === "session.info" && typeof event.title === "string") {
                    liveTitles.push(event.title);
                  }
                  handler(event);
                }
              : null,
          );
        };
        return transport;
      },
    });
    const prompt =
      "This is a synthetic isolated integration test for CodexHost; responses are automated test data. Do not use any tools. Reply with exactly: AGY_TITLE_OK";
    let session: HarnessSession | undefined;
    let consuming: Promise<void> | undefined;
    let createdNativeSessionId: string | undefined;
    const outputs: HarnessOutput[] = [];
    let stage = "open";
    try {
      const opened = await adapter.open({ kind: "create", cwd: workspace });
      if (!opened.ok) throw new Error(opened.error.message);
      session = opened.value;
      consuming = (async () => {
        for await (const output of session.outputs) {
          outputs.push(output);
          if (
            !createdNativeSessionId &&
            output.kind === "event" &&
            output.event.type === "session.state.changed" &&
            output.event.state.nativeRef?.nativeSessionId
          ) {
            createdNativeSessionId = output.event.state.nativeRef.nativeSessionId;
          }
        }
      })();
      const turnId = hostTurnIdSchema.parse(randomUUID());
      stage = "prompt";
      expect(
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: prompt }],
        }),
      ).toMatchObject({ ok: true });
      const completed = await waitFor(
        outputs,
        (output) =>
          output.kind === "event" &&
          output.event.type === "turn.completed" &&
          output.event.turnId === turnId,
        180_000,
      );
      if (completed.kind !== "event" || completed.event.type !== "turn.completed")
        throw new Error("Missing completion");
      expect(completed.event.outcome.status).toBe("succeeded");
      if (!createdNativeSessionId && session instanceof AntigravitySession)
        createdNativeSessionId = session.nativeRef?.nativeSessionId;
      stage = "title";
      const titled = await waitFor(
        outputs,
        (output) => output.kind === "event" && output.event.type === "session.title.changed",
      );
      if (titled.kind !== "event" || titled.event.type !== "session.title.changed")
        throw new Error("Missing title event");
      const title = titled.event.title;
      expect(title.trim()).not.toBe("");
      expect(title).not.toContain("AGY_TITLE_OK");
      expect(liveTitles.map(normalizeExpectedTitle)).toContain(title);
      const stateIndex = outputs.findIndex(
        (output) =>
          output.kind === "event" &&
          output.event.type === "session.state.changed" &&
          output.event.state.nativeRef !== undefined,
      );
      expect(stateIndex).toBeGreaterThanOrEqual(0);
      expect(outputs.indexOf(titled)).toBeGreaterThan(stateIndex);
      stage = "passed";
    } finally {
      try {
        if (!createdNativeSessionId && session instanceof AntigravitySession)
          createdNativeSessionId = session.nativeRef?.nativeSessionId;
        await adapter.close();
        await consuming;
      } finally {
        try {
          if (createdNativeSessionId) {
            for (const suffix of ["", "-wal", "-shm"]) {
              await rm(
                path.join(agyRoot, "conversations", `${createdNativeSessionId}.db${suffix}`),
                { force: true },
              ).catch(() => undefined);
            }
            await rm(path.join(agyRoot, "brain", createdNativeSessionId), {
              recursive: true,
              force: true,
            }).catch(() => undefined);
            try {
              const summaries = new DatabaseSync(path.join(agyRoot, "conversation_summaries.db"));
              try {
                summaries
                  .prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?")
                  .run(createdNativeSessionId);
              } finally {
                summaries.close();
              }
            } catch {
              // Best-effort cleanup of synthetic test conversation row.
            }
          }
          const evidence = process.env.CODEXHOST_ANTIGRAVITY_TITLE_EVIDENCE_DIR;
          if (evidence) {
            await mkdir(evidence, { recursive: true });
            await writeFile(
              path.join(evidence, `${Date.now()}-${stage.replaceAll(" ", "-")}.json`),
              JSON.stringify(
                {
                  stage,
                  createdNativeSessionId,
                  liveTitles,
                  titles: outputs.flatMap((output) =>
                    output.kind === "event" && output.event.type === "session.title.changed"
                      ? [{ title: output.event.title }]
                      : [],
                  ),
                  outputs,
                },
                null,
                2,
              ),
              "utf8",
            );
          }
        } finally {
          await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }
    }
  }, 360_000);
});
