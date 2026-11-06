import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { nativeConversationDbPath } from "../src/fork.js";
import { nativeTurnRecoveredFromError } from "../src/recovered-native-error.js";

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const ERROR_MESSAGE = 17;
const TOOL = 23;
const DONE = 3;
const RUNNING = 2;

const nativeError =
  'API error (attempt 1): request failed: Post "https://example.invalid/stream": local error: tls: bad record MAC';

interface Step {
  type: number;
  status?: number;
  payload?: string;
}

async function writeConversationDb(
  homedir: string,
  conversationId: string,
  steps: Step[],
): Promise<void> {
  const dbPath = nativeConversationDbPath(conversationId, homedir);
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, step_payload BLOB)",
    );
    const insert = db.prepare(
      "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
    );
    steps.forEach((step, idx) => {
      insert.run(idx, step.type, step.status ?? DONE, Buffer.from(step.payload ?? "step", "utf8"));
    });
  } finally {
    db.close();
  }
}

describe("nativeTurnRecoveredFromError", () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const home of homes.splice(0)) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  async function verdict(steps: Step[] | null, error = nativeError): Promise<boolean> {
    const homedir = await mkdtemp(path.join(os.tmpdir(), "codexhost-agy-recovered-"));
    homes.push(homedir);
    if (steps) await writeConversationDb(homedir, "conv", steps);
    return nativeTurnRecoveredFromError({ conversationId: "conv", error, homedir });
  }

  const errorStep: Step = { type: ERROR_MESSAGE, payload: `\u0012${nativeError}\u0000` };

  it("recognizes a Turn that kept going past the error to a final reply", async () => {
    await expect(
      verdict([
        { type: USER_INPUT },
        { type: PLANNER_RESPONSE },
        errorStep,
        { type: TOOL },
        { type: PLANNER_RESPONSE },
      ]),
    ).resolves.toBe(true);
  });

  it("treats an error only an earlier Turn hit as a stale repeat", async () => {
    // agy repeats the error an earlier, recovered Turn hit in the latest
    // Turn's result; the latest Turn has no error step and replied.
    await expect(
      verdict([
        { type: USER_INPUT },
        errorStep,
        { type: PLANNER_RESPONSE },
        { type: USER_INPUT },
        { type: TOOL },
        { type: PLANNER_RESPONSE },
      ]),
    ).resolves.toBe(true);
  });

  it("keeps a stale repeat failed when the latest Turn did not end with a reply", async () => {
    await expect(
      verdict([
        { type: USER_INPUT },
        errorStep,
        { type: PLANNER_RESPONSE },
        { type: USER_INPUT },
        { type: PLANNER_RESPONSE },
        { type: TOOL },
      ]),
    ).resolves.toBe(false);
  });

  it("keeps a stale repeat failed while the latest Turn is still settling", async () => {
    await expect(
      verdict([
        { type: USER_INPUT },
        errorStep,
        { type: PLANNER_RESPONSE },
        { type: USER_INPUT },
        { type: PLANNER_RESPONSE, status: RUNNING },
      ]),
    ).resolves.toBe(false);
  });

  it("keeps a Turn failed when no Turn of the Conversation hit the error", async () => {
    await expect(
      verdict([
        { type: USER_INPUT },
        { type: PLANNER_RESPONSE },
        { type: USER_INPUT },
        { type: PLANNER_RESPONSE },
      ]),
    ).resolves.toBe(false);
  });

  it("keeps a Turn whose error step is its last step failed", async () => {
    await expect(
      verdict([{ type: USER_INPUT }, { type: PLANNER_RESPONSE }, errorStep]),
    ).resolves.toBe(false);
  });

  it("keeps a Turn that did not end with a reply failed", async () => {
    await expect(verdict([{ type: USER_INPUT }, errorStep, { type: TOOL }])).resolves.toBe(false);
  });

  it("keeps a Turn whose steps after the error never finished failed", async () => {
    await expect(
      verdict([{ type: USER_INPUT }, errorStep, { type: PLANNER_RESPONSE, status: RUNNING }]),
    ).resolves.toBe(false);
  });

  it("keeps a Turn failed when the error text is not in the Turn", async () => {
    await expect(
      verdict(
        [{ type: USER_INPUT }, errorStep, { type: PLANNER_RESPONSE }],
        "Individual quota reached.",
      ),
    ).resolves.toBe(false);
  });

  it("keeps a Turn failed when the Conversation DB is missing", async () => {
    await expect(verdict(null)).resolves.toBe(false);
  });
});
