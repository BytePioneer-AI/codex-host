import type { JsonObject } from "@codexhost/protocol-core";

import type {
  OfficialClientSession,
  OfficialRuntimeOwner,
} from "../codex-runtime/official-runtime-owner.js";
import { OfficialAdmissionError } from "../codex-runtime/official-work-gate.js";
import {
  codexCredentialStorageSupport,
  type CodexCredentialFiles,
} from "./codex-credential-files.js";
import type { SwitchingOfficialRuntime } from "./codex-account-switcher.js";
import {
  sameCodexCredentialIdentity,
  type CodexCredentialIdentity,
} from "./native-codex-credentials.js";

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
  "gate" | "running" | "start" | "stop" | "attach" | "controlRequest" | "captureThreadSettings"
>;

/** Native account operations. No refresh client, provider substitution or model inference. */
export class OfficialAccountRuntime implements SwitchingOfficialRuntime {
  readonly #owner: AccountRuntimeOwner;
  readonly #credentials: CodexCredentialFiles;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #version: () => Promise<string>;
  readonly #reconcile: () => Promise<void>;
  readonly #control: OfficialClientSession | undefined;

  constructor(input: {
    owner: AccountRuntimeOwner;
    credentials: CodexCredentialFiles;
    environment: NodeJS.ProcessEnv;
    /** Read the immutable stock executable's version without starting an app-server. */
    nativeVersion(): Promise<string>;
    /** Reject any previous writer whose real exit cannot be established, including orphans. */
    reconcilePreviousWriter(): Promise<void>;
    /** Loopback backends can retain an independent Host management connection. */
    persistentManagementClient?: boolean;
  }) {
    this.#owner = input.owner;
    this.#credentials = input.credentials;
    this.#environment = input.environment;
    this.#version = input.nativeVersion;
    this.#reconcile = input.reconcilePreviousWriter;
    if (input.persistentManagementClient) {
      this.#control = input.owner.attach(async () => {});
      this.#control.configure(managementInitialization);
    }
  }

  async preflight(): Promise<void> {
    this.#credentials.assertOwnership();
    // Only this version has the credential-free persisted queue/active goal bootstrap probe.
    if ((await this.#version()) !== "0.153.4")
      throw new OfficialAccountVerificationError("unsupported-version");
    if (this.#owner.running) {
      await this.#configuration();
      await this.#authenticationMode();
      return;
    }
    if (this.#owner.gate.phase === "ready") throw new OfficialAdmissionError("unavailable");
    await this.stop();
    const control = this.#control ?? this.#owner.attach(async () => {});
    control.configure(managementInitialization);
    try {
      // Existing Desktop clients remain attached but are not initialized or resumed here.
      await this.#owner.start(false);
      await control.initialize(managementInitialization);
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
    } finally {
      // Never clear an error by destroying only the logical management connection.
      try {
        await this.stop();
      } finally {
        if (control !== this.#control) control.close();
      }
    }
    this.#credentials.assertOwnership();
  }

  async #authenticationMode(): Promise<void> {
    const response = await this.#read("account/read", { refreshToken: false });
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
    const support = codexCredentialStorageSupport({
      nativeFileInterfaceAvailable: true,
      effectiveCredentialStore: response.config.cli_auth_credentials_store,
      environment: this.#environment,
    });
    if (!support.supported) throw new OfficialAccountVerificationError("unsupported-storage");
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
    this.#owner.captureThreadSettings([...loadedThreads.values()]);
    if (this.#owner.gate.busy) throw new OfficialAdmissionError("busy");
  }

  async stop(): Promise<void> {
    await this.#owner.stop();
    await this.#reconcile();
  }
  async start(): Promise<void> {
    await this.#owner.start();
    // Startup recovery runs before Desktop has attached an initialized client.
    // Loopback deployments retain a Host-owned management connection for verification.
    if (this.#control) await this.#control.initialize(managementInitialization);
  }

  controlRequest(method: string, params: JsonObject): Promise<JsonObject> {
    return this.#owner.controlRequest(method, params);
  }

  /** Verify migrated rollout IDs through the sole native backend before layout commit. */
  async validateMigratedThreads(threadIds: readonly string[]): Promise<void> {
    if (threadIds.length === 0) return;
    if (this.#owner.gate.phase === "ready" || this.#owner.gate.busy)
      throw new OfficialAdmissionError("busy");
    this.#credentials.assertOwnership();
    const control = this.#control ?? this.#owner.attach(async () => {});
    control.configure(managementInitialization);
    try {
      await this.#owner.start(false);
      await control.initialize(managementInitialization);
      for (const archived of [false, true]) {
        const listed = await this.#read("thread/list", {
          archived,
          modelProviders: [],
          sourceKinds: sources,
          cursor: null,
          limit: 100,
        });
        if (!Array.isArray(listed.data) || listed.nextCursor === undefined)
          throw new OfficialAccountVerificationError("invalid-native-response");
      }
      for (const threadId of threadIds) {
        const resumed = await this.#read("thread/resume", { threadId });
        if (!object(resumed.thread) || resumed.thread.id !== threadId)
          throw new OfficialAccountVerificationError("invalid-native-response");
        const read = await this.#read("thread/read", { threadId, includeTurns: false });
        if (!object(read.thread) || read.thread.id !== threadId)
          throw new OfficialAccountVerificationError("invalid-native-response");
      }
    } finally {
      try {
        await this.stop();
      } finally {
        if (control !== this.#control) control.close();
      }
    }
  }

  async verify(identity: CodexCredentialIdentity | null): Promise<void> {
    await this.#configuration();
    const before = await this.#credentials.readCurrent();
    if (identity === null) {
      const response = await this.#read("account/read", { refreshToken: false });
      if (before !== null || response.account !== null)
        throw new OfficialAccountVerificationError("authentication-failed");
      return;
    }
    if (!before || !sameCodexCredentialIdentity(before.identity, identity))
      throw new OfficialAccountVerificationError("authentication-failed");
    // The native backend performs any needed refresh; successful JWT decoding is not authentication.
    const quota = await this.#read("account/rateLimits/read", {});
    if (!object(quota.rateLimits))
      throw new OfficialAccountVerificationError("authentication-failed");
    const account = await this.#read("account/read", { refreshToken: false });
    const after = await this.#credentials.readCurrent();
    if (
      !after ||
      !sameCodexCredentialIdentity(after.identity, identity) ||
      !object(account.account) ||
      account.account.type !== "chatgpt" ||
      !after.email ||
      account.account.email !== after.email
    )
      throw new OfficialAccountVerificationError("authentication-failed");
    this.#credentials.assertOwnership();
  }

  async #read(method: string, params: JsonObject): Promise<JsonObject> {
    const result = await this.#owner.controlRequest(method, params);
    if (result.error || !object(result.result))
      throw new OfficialAccountVerificationError("invalid-native-response");
    return result.result;
  }
}
