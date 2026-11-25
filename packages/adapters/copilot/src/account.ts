import { randomUUID } from "node:crypto";
import os from "node:os";
import type { CopilotClient, CopilotSession, GetAuthStatusResponse } from "@github/copilot-sdk";
import type { AccountCreditsSnapshot, HarnessAccountSnapshot } from "@codexhost/shared-contracts";
import { createCopilotClient } from "./client.js";
import { bounded, nativeError } from "./errors.js";
import { projectCopilotAccount } from "./account-usage.js";

const CACHE_MS = 15_000;
const identity = (auth: GetAuthStatusResponse) =>
  JSON.stringify([auth.authType, auth.host, auth.login]);

async function deleteDraft(client: CopilotClient, id: string): Promise<void> {
  try {
    await bounded(client.deleteSession(id), 5_000);
  } catch (error) {
    if (nativeError(error).code !== "sessionNotFound") throw error;
  }
}

export class CopilotAccount {
  private cached: { at: number; value: HarnessAccountSnapshot } | undefined;
  private pending: Promise<HarnessAccountSnapshot | null> | undefined;
  private client: CopilotClient | undefined;
  private readonly pendingDrafts = new Set<string>();
  private closing: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly environment: NodeJS.ProcessEnv) {}

  credits(): AccountCreditsSnapshot | null {
    if (this.closed || !this.cached || Date.now() - this.cached.at >= CACHE_MS) return null;
    return structuredClone(this.cached.value.credits ?? null);
  }

  refresh(): Promise<HarnessAccountSnapshot | null> {
    return this.credits() && this.cached
      ? Promise.resolve(structuredClone(this.cached.value))
      : this.inspect();
  }

  inspect(): Promise<HarnessAccountSnapshot | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.pending) return this.pending;
    // Retire the old observation before resolving native authentication again.
    this.cached = undefined;
    this.pending = this.read()
      .then((value) => {
        if (this.closed) return null;
        if (value) this.cached = { at: Date.now(), value };
        return value ? structuredClone(value) : null;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async read(): Promise<HarnessAccountSnapshot | null> {
    let session: CopilotSession | undefined;
    let ownedId: string | undefined;
    let client: CopilotClient | undefined;
    let result: HarnessAccountSnapshot | null = null;
    try {
      if (this.client) {
        await bounded(this.client.forceStop(), 5_000);
        this.client = undefined;
      }
      client = createCopilotClient({
        cwd: this.environment.HOME ?? this.environment.USERPROFILE ?? os.homedir(),
        environment: this.environment,
      });
      this.client = client;
      await bounded(client.start(), 8_000);
      if (this.closed) return null;
      const before = await bounded(client.getAuthStatus(), 3_000);
      if (!before.isAuthenticated) return null;
      if (this.closed) return null;
      ownedId = randomUUID();
      this.pendingDrafts.add(ownedId);
      // A quota-only draft provides native units without loading user extensions or sending input.
      session = await bounded(
        client.createSession({
          sessionId: ownedId,
          enableConfigDiscovery: false,
          enableSkills: false,
          enableFileHooks: false,
          enableHostGitOperations: false,
          onPermissionRequest: () => ({ kind: "denied-interactively-by-user" }),
        }),
        8_000,
      );
      if (session.sessionId !== ownedId)
        throw new Error("Copilot changed the quota draft identity");
      if (this.closed) return null;
      const quota = await bounded(session.rpc.quota.refresh(), 10_000);
      const after = await bounded(client.getAuthStatus(), 3_000);
      if (after.isAuthenticated && identity(before) === identity(after))
        result = projectCopilotAccount(quota);
    } catch {
      result = null;
    } finally {
      if (session)
        await bounded(session.disconnect(), 5_000).catch(() => {
          result = null;
        });
      if (client) {
        if (ownedId) {
          const id = ownedId;
          await deleteDraft(client, id)
            .then(() => {
              this.pendingDrafts.delete(id);
            })
            .catch(() => {
              result = null;
            });
        }
        let stopped = false;
        try {
          const errors = await bounded(client.stop(), 5_000);
          if (errors.length) await bounded(client.forceStop(), 5_000);
          stopped = true;
        } catch {
          result = null;
          await bounded(client.forceStop(), 5_000)
            .then(() => {
              stopped = true;
            })
            .catch(() => undefined);
        }
        if (stopped && this.client === client) this.client = undefined;
      }
    }
    return this.closed ? null : result;
  }

  close(): Promise<void> {
    this.closed = true;
    this.cached = undefined;
    return (this.closing ??= this.closeResources().finally(() => {
      this.closing = undefined;
    }));
  }

  private async closeResources(): Promise<void> {
    await this.pending;
    if (this.client) {
      await bounded(this.client.forceStop(), 5_000);
      this.client = undefined;
    }
    if (!this.pendingDrafts.size) return;
    const client = createCopilotClient({
      cwd: this.environment.HOME ?? this.environment.USERPROFILE ?? os.homedir(),
      environment: this.environment,
    });
    this.client = client;
    try {
      await bounded(client.start(), 8_000);
      for (const id of this.pendingDrafts) {
        await deleteDraft(client, id);
        this.pendingDrafts.delete(id);
      }
    } finally {
      await bounded(client.forceStop(), 5_000);
      this.client = undefined;
    }
  }
}
