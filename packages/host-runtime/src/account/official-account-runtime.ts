import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

import type {
  OfficialClientSession,
  OfficialRuntimeOwner,
} from "../codex-runtime/official-runtime-owner.js";
import { OfficialAdmissionError } from "../codex-runtime/official-work-gate.js";
import {
  sameCodexCredentialIdentity,
  type CodexCredentialIdentity,
  type NativeCodexCredentials,
} from "./native-codex-credentials.js";
import type { NativeAccountRuntime } from "./native-account-runtime.js";

const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const managementInitialization = {
  clientInfo: { name: "codexhost_account_management", version: "1" },
  capabilities: { experimentalApi: true },
};
const sources = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];
export class OfficialAccountVerificationError extends Error {
  constructor(
    readonly code:
      | "unsupported-version"
      | "unsupported-storage"
      | "authentication-failed"
      | "invalid-native-response",
  ) {
    super(`Codex Account ${code}`);
    this.name = "OfficialAccountVerificationError";
  }
}

type AccountRuntimeOwner = Pick<
  OfficialRuntimeOwner,
  | "gate"
  | "running"
  | "start"
  | "stop"
  | "attachManagement"
  | "controlRequest"
  | "captureThreadSettings"
>;

/** Native account operations. No refresh client, provider substitution or model inference. */
export class OfficialAccountRuntime implements NativeAccountRuntime {
  readonly #owner: AccountRuntimeOwner;
  readonly #sharedCodexHome: string;
  readonly #readCredentials: (home: string) => Promise<NativeCodexCredentials | null>;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #version: () => Promise<string>;
  readonly #reconcile: () => Promise<void>;
  readonly #control: OfficialClientSession;
  readonly #listeners = new Set<(value: JsonValue) => void>();
  #activeHome: string | undefined;

  constructor(input: {
    owner: AccountRuntimeOwner;
    sharedCodexHome: string;
    readCredentials(home: string): Promise<NativeCodexCredentials | null>;
    environment?: NodeJS.ProcessEnv;
    /** Read the immutable stock executable's version without starting an app-server. */
    nativeVersion(): Promise<string>;
    /** Reject any previous writer whose real exit cannot be established, including orphans. */
    reconcilePreviousWriter(): Promise<void>;
  }) {
    this.#owner = input.owner;
    this.#sharedCodexHome = input.sharedCodexHome;
    this.#readCredentials = input.readCredentials;
    this.#environment = input.environment ?? {};
    this.#version = input.nativeVersion;
    this.#reconcile = input.reconcilePreviousWriter;
    if (input.owner.running) this.#activeHome = input.sharedCodexHome;
    this.#control = input.owner.attachManagement(async ({ value }) => {
      for (const listener of this.#listeners) {
        try {
          listener(value);
        } catch {
          /* management subscribers are isolated */
        }
      }
    });
    this.#control.configure(managementInitialization);
  }

  get gate() {
    return this.#owner.gate;
  }

  async preflight(): Promise<void> {
    if (!this.#owner.running) await this.#reconcile();
    await this.#validateVersion();
    if (this.#owner.running) {
      await this.#configuration();
      await this.#authenticationMode();
      return;
    }
    if (this.#owner.gate.phase === "ready") throw new OfficialAdmissionError("unavailable");
    try {
      // Existing Desktop clients remain attached but are not initialized or resumed here.
      await this.#owner.start({ mode: "management-only" });
      this.#activeHome = this.#sharedCodexHome;
      await this.#configuration();
      await this.#authenticationMode();
      const loaded = await this.#read("thread/loaded/list", {});
      if (
        !Array.isArray(loaded.data) ||
        loaded.data.length !== 0 ||
        loaded.nextCursor !== null ||
        this.#owner.gate.busy
      )
        throw new OfficialAdmissionError("busy");
    } catch (error) {
      // A failed cold probe cannot leave an unverified writer behind. A successful
      // probe intentionally remains available for assertNativeIdle() and explicit stop().
      await this.stop();
      throw error;
    }
  }

  async #authenticationMode(): Promise<void> {
    const response = await this.#read("account/read", { refreshToken: true });
    if (
      response.account !== null &&
      (!object(response.account) || response.account.type !== "chatgpt")
    )
      throw new OfficialAccountVerificationError("unsupported-storage");
  }

  async #configuration(): Promise<void> {
    const response = await this.#read("config/read", { includeLayers: true });
    if (!object(response.config))
      throw new OfficialAccountVerificationError("invalid-native-response");
    if (response.config.cli_auth_credentials_store !== "file")
      throw new OfficialAccountVerificationError("unsupported-storage");
    const overrides = new Set([
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_AUTH_TOKEN",
      "CODEX_ACCESS_TOKEN",
    ]);
    if (
      Object.entries(this.#environment).some(
        ([key, value]) => overrides.has(key.toUpperCase()) && !!value,
      )
    )
      throw new OfficialAccountVerificationError("unsupported-storage");
  }

  async assertNativeIdle(): Promise<void> {
    if (this.#owner.gate.busy) throw new OfficialAdmissionError("busy");
    const threads = new Map<string, { status: JsonObject; archived: boolean }>();
    const loadedThreads = new Map<string, JsonObject>();
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page = await this.#read("thread/list", {
          archived,
          modelProviders: [],
          sourceKinds: sources,
          cursor,
          limit: 100,
        });
        if (
          !Array.isArray(page.data) ||
          !(page.nextCursor === null || typeof page.nextCursor === "string")
        )
          throw new OfficialAccountVerificationError("invalid-native-response");
        for (const thread of page.data) {
          if (!object(thread) || typeof thread.id !== "string" || !object(thread.status))
            throw new OfficialAccountVerificationError("invalid-native-response");
          threads.set(thread.id, { status: thread.status, archived });
        }
        if (threads.size > 100_000) throw new OfficialAdmissionError("busy");
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (seen.has(cursor))
            throw new OfficialAccountVerificationError("invalid-native-response");
          seen.add(cursor);
        }
      } while (cursor !== null);
    }
    // Include loaded ephemeral Threads absent from the persisted list.
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const loaded = await this.#read("thread/loaded/list", { cursor, limit: 100 });
      if (
        !Array.isArray(loaded.data) ||
        !(loaded.nextCursor === null || typeof loaded.nextCursor === "string")
      )
        throw new OfficialAccountVerificationError("invalid-native-response");
      for (const id of loaded.data) {
        if (typeof id !== "string")
          throw new OfficialAccountVerificationError("invalid-native-response");
        const read = await this.#read("thread/read", { threadId: id, includeTurns: false });
        if (!object(read.thread) || read.thread.id !== id || !object(read.thread.status))
          throw new OfficialAccountVerificationError("invalid-native-response");
        // A loaded in-memory Thread must not disappear during credential replacement.
        // Never force persistence by changing its native ephemeral/history contract.
        if (
          read.thread.ephemeral !== false ||
          typeof read.thread.path !== "string" ||
          !read.thread.path.trim()
        )
          throw new OfficialAdmissionError("busy");
        const terminals = await this.#read("thread/backgroundTerminals/list", {
          threadId: id,
          cursor: null,
          limit: 1,
        });
        if (
          !Array.isArray(terminals.data) ||
          terminals.data.length !== 0 ||
          terminals.nextCursor !== null
        )
          throw new OfficialAdmissionError("busy");
        threads.set(id, {
          status: read.thread.status,
          archived: threads.get(id)?.archived ?? false,
        });
        loadedThreads.set(id, read.thread);
        if (threads.size > 100_000) throw new OfficialAdmissionError("busy");
      }
      cursor = loaded.nextCursor;
      if (cursor !== null) {
        if (seen.has(cursor)) throw new OfficialAccountVerificationError("invalid-native-response");
        seen.add(cursor);
      }
    } while (cursor !== null);
    for (const [threadId, thread] of threads) {
      if (thread.status.type !== "idle" && thread.status.type !== "notLoaded")
        throw new OfficialAdmissionError("busy");
      // Archived Threads cannot auto-continue, and native queue/goal endpoints
      // reject archived IDs. Treating those expected errors as unknown state made
      // every installation with archived history permanently unswitchable.
      if (thread.archived) continue;
      const queue = await this.#read("thread/queue/list", { threadId, cursor: null, limit: 1 });
      if (!Array.isArray(queue.data) || queue.data.length !== 0 || queue.nextCursor !== null)
        throw new OfficialAdmissionError("busy");
      const goal = await this.#read("thread/goal/get", { threadId });
      if (goal.goal !== null && (!object(goal.goal) || goal.goal.status !== "complete"))
        throw new OfficialAdmissionError("busy");
    }
    if (this.#owner.gate.busy) throw new OfficialAdmissionError("busy");
    const settings: JsonObject[] = [];
    for (const threadId of loadedThreads.keys()) {
      const resumed = await this.#read("thread/resume", { threadId, excludeTurns: true });
      if (!object(resumed.thread) || resumed.thread.id !== threadId)
        throw new OfficialAccountVerificationError("invalid-native-response");
      settings.push(resumed);
    }
    this.#owner.captureThreadSettings(settings);
    if (this.#owner.gate.busy) throw new OfficialAdmissionError("busy");
  }

  async stop(): Promise<void> {
    await this.#owner.stop();
    await this.#reconcile();
    this.#activeHome = undefined;
  }
  async start(stagingHome?: string): Promise<void> {
    await this.#validateVersion();
    const wasRunning = this.#owner.running;
    try {
      await this.#owner.start(
        stagingHome === undefined
          ? { mode: "task" }
          : { homeOverride: stagingHome, mode: "management-only" },
      );
      this.#activeHome = stagingHome ?? this.#sharedCodexHome;
      // Never admit an unknown credential store merely because recovery reached start().
      await this.#configuration();
      await this.#authenticationMode();
    } catch (error) {
      if (!wasRunning) await this.stop();
      throw error;
    }
  }

  controlRequest(method: string, params: JsonObject): Promise<JsonObject> {
    return this.#owner.controlRequest(method, params);
  }

  async verify(identity: CodexCredentialIdentity | null): Promise<void> {
    await this.#validateVersion();
    await this.#configuration();
    const home = this.#activeHome;
    if (!home) throw new OfficialAccountVerificationError("invalid-native-response");
    const before = await this.#safeReadCredentials(home);
    if (identity === null) {
      const response = await this.#read("account/read", { refreshToken: true });
      if (before !== null || response.account !== null)
        throw new OfficialAccountVerificationError("authentication-failed");
      return;
    }
    if (!before || !sameCodexCredentialIdentity(before.identity, identity))
      throw new OfficialAccountVerificationError("authentication-failed");
    // The native backend performs any needed refresh; successful JWT decoding is not authentication.
    const account = await this.#read("account/read", { refreshToken: true });
    const quota = await this.#read("account/rateLimits/read", {});
    if (!object(quota.rateLimits))
      throw new OfficialAccountVerificationError("authentication-failed");
    const after = await this.#safeReadCredentials(home);
    if (
      !after ||
      !sameCodexCredentialIdentity(after.identity, identity) ||
      !object(account.account) ||
      account.account.type !== "chatgpt"
    )
      throw new OfficialAccountVerificationError("authentication-failed");
  }

  async #validateVersion(): Promise<void> {
    let version: string;
    try {
      version = await this.#version();
    } catch {
      throw new OfficialAccountVerificationError("unsupported-version");
    }
    // Only this version has the credential-free persisted queue/active goal bootstrap probe.
    if (version !== "0.153.4") throw new OfficialAccountVerificationError("unsupported-version");
  }

  subscribe(listener: (value: JsonValue) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #read(method: string, params: JsonObject): Promise<JsonObject> {
    let result: JsonObject;
    try {
      result = await this.#owner.controlRequest(method, params);
    } catch {
      throw new OfficialAccountVerificationError("invalid-native-response");
    }
    if (result.error || !object(result.result))
      throw new OfficialAccountVerificationError("invalid-native-response");
    return result.result;
  }

  async #safeReadCredentials(home: string): Promise<NativeCodexCredentials | null> {
    try {
      return await this.#readCredentials(home);
    } catch {
      // Native readers can encounter secret-bearing parser/storage errors. Never
      // retain them as a cause or interpolate them into a public error.
      throw new OfficialAccountVerificationError("invalid-native-response");
    }
  }
}
