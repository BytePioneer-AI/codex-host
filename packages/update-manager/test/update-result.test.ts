import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  discoverCurrentUpdateStatus,
  updateRepairRequired,
  type UpdateResultScope,
} from "../src/update-result.js";
import { cleanupTerminalUpdateState } from "../src/operation-state.js";
import { parseUpdateStatus } from "../src/status.js";
import { updateStatusSchema } from "@codexhost/shared-contracts";

test.each(["npm", "windows-installer"] as const)(
  "%s restarted target/restored Host finds its exact operation without a lock, before cleanup",
  async (installation) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "restart-result-"));
    try {
      const install = path.join(root, "install"),
        state = path.join(root, "updates"),
        op = path.join(state, "update-1.2.4-this");
      await mkdir(install);
      await mkdir(op, { recursive: true });
      const statusPath = path.join(op, "status-v1.json"),
        runtimeDescriptorPath = path.join(root, "runtime.json");
      await writeFile(
        path.join(op, "request-v1.json"),
        JSON.stringify({
          schema_version: 1,
          version: "1.2.4",
          wait_pid: 111,
          wait_started_at_micros: "111",
          status_path: statusPath,
          runtime_descriptor_path: runtimeDescriptorPath,
          installation: {
            kind: installation,
            ...(installation === "npm" ? { prefix: install } : { install_root: install }),
          },
        }),
      );
      const scope: UpdateResultScope = {
        installation,
        installationRoot: install,
        runtimeDescriptorPath,
        launcherPid: process.pid,
        launcherStartedAtMicros: "123456",
        version: "1.2.4",
      };
      for (const outcome of ["updated", "restored", "recovery-failed", "unknown"] as const) {
        scope.version = outcome === "updated" ? "1.2.4" : "1.2.3";
        const status = {
          schemaVersion: 1,
          version: "1.2.4",
          installation,
          phase: outcome === "updated" ? "succeeded" : "failed",
          outcome,
          updatedAt: 1,
          error: outcome === "updated" ? undefined : "diagnostic; not parsed",
          restart: {
            installationRoot: install,
            launcherPid: process.pid,
            launcherStartedAtMicros: "123456",
            version: scope.version,
          },
        };
        await writeFile(statusPath, JSON.stringify(status));
        await cleanupTerminalUpdateState(state, {
          now: Date.now() + 999999999,
          retentionSeconds: 0,
        });
        const found = await discoverCurrentUpdateStatus(state, scope);
        expect(found?.status).toMatchObject({ outcome, phase: status.phase });
        if (!found) throw new Error("missing bound operation");
        const publicStatus = {
          version: found.status.version,
          installation: found.status.installation,
          phase: found.status.phase,
          updatedAt: found.status.updatedAt,
          outcome: found.status.outcome,
          error: found.status.error,
        };
        expect(
          updateStatusSchema.parse({ ...publicStatus, error: publicStatus.error ?? null }).outcome,
        ).toBe(outcome);
        for (const wrong of [
          { launcherPid: process.pid + 1 },
          { launcherStartedAtMicros: "999" },
          { version: "9.9.9" },
          { runtimeDescriptorPath: path.join(root, "other-runtime.json") },
          { installationRoot: root },
        ])
          expect(await discoverCurrentUpdateStatus(state, { ...scope, ...wrong })).toBeNull();
      }
      // A restarted Host may initiate another update before its Launcher exits.
      // Rediscovery must show that active operation, not its previous result.
      const pending = path.join(state, "update-1.2.5-next");
      await mkdir(pending);
      const pendingStatus = path.join(pending, "status-v1.json");
      const pendingRequest = {
        ...JSON.parse(await readFile(path.join(op, "request-v1.json"), "utf8")),
        version: "1.2.5",
        status_path: pendingStatus,
        wait_pid: scope.launcherPid,
        wait_started_at_micros: scope.launcherStartedAtMicros,
      };
      await writeFile(path.join(pending, "request-v1.json"), JSON.stringify(pendingRequest));
      await writeFile(
        pendingStatus,
        JSON.stringify({
          schemaVersion: 1,
          version: "1.2.5",
          installation,
          phase: "prepared",
          updatedAt: 2,
        }),
      );
      await writeFile(
        path.join(state, "active-update-v1.lock"),
        JSON.stringify({ ownerPid: process.pid, statusPath: pendingStatus }),
      );
      expect((await discoverCurrentUpdateStatus(state, scope))?.statusPath).toBe(pendingStatus);
      await writeFile(
        path.join(pending, "request-v1.json"),
        JSON.stringify({ ...pendingRequest, wait_started_at_micros: "999" }),
      );
      expect((await discoverCurrentUpdateStatus(state, scope))?.statusPath).toBe(statusPath);
      await rm(path.join(state, "active-update-v1.lock"));
      await rm(pending, { recursive: true });
      const current = JSON.parse(await readFile(statusPath, "utf8"));
      delete current.restart;
      await writeFile(statusPath, JSON.stringify(current));
      expect(await discoverCurrentUpdateStatus(state, scope)).toBeNull();
      await writeFile(
        path.join(state, "active-update-v1.lock"),
        JSON.stringify({
          ownerPid: process.pid,
          statusPath,
          operationId: "this-operation",
          installationStarted: true,
        }),
      );
      const consoleScope: UpdateResultScope = {
        installation,
        installationRoot: install,
        runtimeDescriptorPath,
      };
      expect((await discoverCurrentUpdateStatus(state, consoleScope))?.status).toMatchObject({
        phase: "failed",
        outcome: "unknown",
      });
      expect(await updateRepairRequired(state, consoleScope)).toContain("original channel");
      expect(
        await updateRepairRequired(state, { ...consoleScope, installationRoot: root }),
      ).toBeNull();
      expect(
        await discoverCurrentUpdateStatus(state, { ...consoleScope, installationRoot: root }),
      ).toBeNull();
      expect(await discoverCurrentUpdateStatus(state, scope)).toBeNull();
      expect(() =>
        parseUpdateStatus({ ...current, outcome: "restored", phase: "succeeded" }),
      ).toThrow();
      expect(() =>
        updateStatusSchema.parse({
          version: "1.2.4",
          installation,
          phase: "succeeded",
          updatedAt: 1,
          outcome: "recovery-failed",
          error: null,
        }),
      ).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
