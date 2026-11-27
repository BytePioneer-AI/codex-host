/**
 * Real-binary smoke for the OmO adapter, opt-in via CODEXHOST_OMO_LIVE=1.
 *
 * Follows the repo's env-gated native-test pattern (see copilot's
 * `*.native.test.ts` and omp's `omp-native-ask.test.ts`): without the env var
 * the suite is skipped, so the default package run is unaffected. Requires the
 * `omo` CLI (5.1.83+) on PATH. Uses a throwaway agent directory through
 * OMO_CODING_AGENT_DIR / SENPI_CODING_AGENT_DIR, so it never reads or writes
 * `~/.omo`.
 *
 * Scope: discovery, the `--no-session` inspect handshake, open(create) with
 * the Native Session identity, close idempotence, and invalidState after
 * close. It makes no model calls and needs no credentials. Turn lifecycle,
 * interactions and process-tree receipts against a real engine were verified
 * with real model calls in the isolated evidence run recorded in
 * `.omo/evidence/task-9-add-omo-harness.md`; this smoke keeps the no-cost
 * subset executable on demand.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hostTurnIdSchema } from "@codexhost/shared-contracts";

import { createHarnessAdapter } from "../src/plugin.js";

/** A clean-Host-like environment pinned to a throwaway agent directory. */
function liveEnvironment(agentDir: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(OMO|SENPI|PI)_/.test(key)) continue;
    if (value !== undefined) environment[key] = value;
  }
  environment.OMO_CODING_AGENT_DIR = agentDir;
  environment.SENPI_CODING_AGENT_DIR = agentDir;
  environment.PI_SKIP_VERSION_CHECK = "1";
  environment.PI_TELEMETRY = "0";
  return environment;
}

describe.skipIf(process.env.CODEXHOST_OMO_LIVE !== "1")(
  "OmO live real-binary smoke (CODEXHOST_OMO_LIVE=1)",
  () => {
    const dirs: string[] = [];

    afterEach(async () => {
      await Promise.all(
        dirs
          .splice(0)
          .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
      );
    });

    it(
      "inspects availability and the full catalog through the real CLI",
      { timeout: 120_000 },
      async () => {
        const projectDir = await mkdtemp(path.join(os.tmpdir(), "omo-live-p0-project-"));
        const agentDir = await mkdtemp(path.join(os.tmpdir(), "omo-live-p0-agent-"));
        dirs.push(projectDir, agentDir);
        const adapter = createHarnessAdapter({
          platform: process.platform,
          managedRemoteHost: false,
          environment: liveEnvironment(agentDir),
        });
        try {
          const availability = await adapter.inspect({ cwd: projectDir, purpose: "availability" });
          expect(availability.status).toBe("ready");

          const full = await adapter.inspect({ cwd: projectDir });
          expect(full.status).toBe("ready");
          if (full.status !== "ready") return;
          expect(full.catalog.thinkingOptions.length).toBeGreaterThan(0);
        } finally {
          await adapter.close().catch(() => undefined);
        }
      },
    );

    it(
      "opens a create Session in the isolated agent dir and closes it idempotently",
      { timeout: 120_000 },
      async () => {
        const projectDir = await mkdtemp(path.join(os.tmpdir(), "omo-live-p0-project-"));
        const agentDir = await mkdtemp(path.join(os.tmpdir(), "omo-live-p0-agent-"));
        dirs.push(projectDir, agentDir);
        const adapter = createHarnessAdapter({
          platform: process.platform,
          managedRemoteHost: false,
          environment: liveEnvironment(agentDir),
        });
        try {
          const opened = await adapter.open({ kind: "create", cwd: projectDir, prewarm: true });
          expect(opened.ok).toBe(true);
          if (!opened.ok) return;
          const session = opened.value;
          const nativeRef = session.initialState.nativeRef;
          expect(nativeRef?.nativeSessionId).toBeTruthy();
          const locator = nativeRef?.locator;
          const sessionPath =
            typeof locator === "object" && locator !== null && !Array.isArray(locator)
              ? locator.sessionPath
              : undefined;
          expect(typeof sessionPath).toBe("string");
          expect(typeof sessionPath === "string" && sessionPath.startsWith(agentDir)).toBe(true);

          const snapshot = await session.readSnapshot();
          expect(snapshot.ok).toBe(true);
          if (snapshot.ok) expect(snapshot.value.turns).toEqual([]);

          await session.close();
          await session.close();
          const after = await session.execute({
            type: "turn.start",
            turnId: hostTurnIdSchema.parse("live-after-close"),
            input: [{ type: "text", text: "must not run" }],
          });
          expect(after.ok).toBe(false);
          if (!after.ok) expect(after.error.code).toBe("invalidState");
        } finally {
          await adapter.close().catch(() => undefined);
        }
      },
    );
  },
);
