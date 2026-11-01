import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";
import { createCopilotClient } from "../src/client.js";
import { nativeError } from "../src/errors.js";

const root = () =>
  path.join(process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot"), "session-state");
const resumeConfig = {
  workingDirectory: process.cwd(),
  allowTranscriptRecovery: false,
  onPermissionRequest: () => ({ kind: "denied-interactively-by-user" as const }),
};

describe.runIf(process.env.CODEXHOST_COPILOT_NATIVE_TEST === "1")(
  "real Copilot strict resume of owned journal fixtures (no model requests)",
  () => {
    it("rejects missing and corrupt journals without creating or repairing history", async () => {
      const missing = randomUUID(),
        corrupt = randomUUID();
      const directory = path.join(root(), corrupt),
        journal = path.join(directory, "events.jsonl");
      const client = createCopilotClient({ cwd: process.cwd(), environment: process.env });
      await mkdir(directory);
      const invalid = "{invalid test journal\n";
      await writeFile(journal, invalid);
      try {
        await client.start();
        for (const [id, code] of [
          [missing, "sessionNotFound"],
          [corrupt, "protocolError"],
        ] as const) {
          const outcome = await client.resumeSession(id, resumeConfig).then(
            async (session) => {
              await session.disconnect();
              return { resumed: true };
            },
            (error) => ({ resumed: false, error: nativeError(error, "session.resume") }),
          );
          expect(
            outcome,
            "error" in outcome ? outcome.error.diagnostic : "Unexpected resume success",
          ).toMatchObject({ resumed: false, error: { code } });
        }
        expect(
          await access(path.join(root(), missing)).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        expect(await readFile(journal, "utf8")).toBe(invalid);
      } finally {
        await client.stop();
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000);

    it("cold resumes the same native identity and complete root history without pre-reading it", async () => {
      const id = randomUUID(),
        directory = path.join(root(), id);
      const events: SessionEvent[] = JSON.parse(
        await readFile(new URL("./fixtures/basic.json", import.meta.url), "utf8"),
      );
      const durable = events.filter((event) => !event.ephemeral);
      let parent: string | null = null;
      for (const event of durable) {
        event.id = randomUUID();
        event.parentId = parent;
        parent = event.id;
        if (event.type === "session.start") event.data.sessionId = id;
      }
      const roots = durable.flatMap((event) =>
        event.type === "user.message" ? [event.data.messageId] : [],
      );
      await mkdir(directory);
      await writeFile(
        path.join(directory, "events.jsonl"),
        durable.map((event) => JSON.stringify(event)).join("\n") + "\n",
      );
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const client = createCopilotClient({ cwd: process.cwd(), environment: process.env });
          try {
            await client.start();
            const session = await client.resumeSession(id, resumeConfig);
            try {
              expect(session.sessionId).toBe(id);
              expect(session.transcriptRecovery).toBeUndefined();
              const restored = await session.getEvents();
              expect(restored.find((event) => event.type === "session.start")).toMatchObject({
                data: { sessionId: id },
              });
              const actual = restored.flatMap((event) =>
                event.type === "user.message" ? [event.data.messageId] : [],
              );
              expect(actual).toEqual(roots);
            } finally {
              await session.disconnect();
            }
          } finally {
            expect(await client.stop()).toEqual([]);
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
