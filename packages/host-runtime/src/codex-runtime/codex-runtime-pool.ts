import type { Writable } from "node:stream";
import { mkdir } from "node:fs/promises";

import type { JsonObject } from "@codexhost/protocol-core";

import type { AccountRepositoryLike, CodexAccount } from "../account/account-repository.js";
import type { ThreadAccountStoreLike } from "../account/thread-account-store.js";
import type { OfficialAppServerConnection } from "../official-app-server-connection.js";
import { CodexRuntime, type CodexRuntimeOutput } from "./codex-runtime.js";

export class UnknownCodexThreadAccountError extends Error {
  constructor(readonly threadId: string) {
    super(`Official Thread '${threadId}' has no Codex Account binding`);
    this.name = "UnknownCodexThreadAccountError";
  }
}

export class CodexRuntimePool {
  readonly #accounts: AccountRepositoryLike;
  readonly #threadAccounts: ThreadAccountStoreLike;
  readonly #createConnection: (account: CodexAccount) => Promise<OfficialAppServerConnection>;
  readonly #diagnosticOutput: Writable;
  readonly #onOutput: CodexRuntimeOutput;
  readonly #diagnose: (error: unknown) => void;
  readonly #runtimes = new Map<string, CodexRuntime>();
  readonly #ownedRuntimes = new Set<CodexRuntime>();
  readonly #starting = new Map<string, Promise<CodexRuntime>>();
  readonly #initialized = new Map<string, JsonObject>();
  readonly #initializing = new Map<string, Promise<JsonObject>>();
  readonly #failure = Promise.withResolvers<Error>();
  #initializationParams: JsonObject | null = null;
  #closed = false;

  constructor(input: {
    accounts: AccountRepositoryLike;
    threadAccounts: ThreadAccountStoreLike;
    createConnection(account: CodexAccount): Promise<OfficialAppServerConnection>;
    diagnosticOutput: Writable;
    onOutput: CodexRuntimeOutput;
    diagnose(error: unknown): void;
  }) {
    this.#accounts = input.accounts;
    this.#threadAccounts = input.threadAccounts;
    this.#createConnection = input.createConnection;
    this.#diagnosticOutput = input.diagnosticOutput;
    this.#onOutput = input.onOutput;
    this.#diagnose = input.diagnose;
  }

  async initialize(): Promise<void> {
    await Promise.all([this.#accounts.initialize(), this.#threadAccounts.initialize()]);
  }

  async active(): Promise<CodexRuntime> {
    return this.get(await this.#accounts.getActiveAccountId());
  }

  failure(): Promise<Error> {
    return this.#failure.promise;
  }

  async initializeProtocol(params: JsonObject): Promise<JsonObject> {
    if (
      this.#initializationParams &&
      JSON.stringify(this.#initializationParams) !== JSON.stringify(params)
    ) {
      throw new Error("Codex runtime pool was initialized with different client parameters");
    }
    this.#initializationParams = { ...params };
    const accountId = await this.#accounts.getActiveAccountId();
    return this.#ensureInitialized(await this.#load(accountId));
  }

  async forThread(threadId: string): Promise<CodexRuntime> {
    const accountId =
      (await this.#threadAccounts.getAccountId(threadId)) ??
      (await this.#discoverHistoricalThreadAccount(threadId));
    if (!accountId) throw new UnknownCodexThreadAccountError(threadId);
    return this.get(accountId);
  }

  async get(accountId: string): Promise<CodexRuntime> {
    if (this.#closed) throw new Error("Codex Runtime Pool is closed");
    const runtime = await this.#load(accountId);
    if (this.#initializationParams) {
      const response = await this.#ensureInitialized(runtime);
      if (response.error) {
        throw new Error(`Codex Account runtime '${accountId}' initialization failed`);
      }
    }
    return runtime;
  }

  async bindThread(threadId: string, accountId: string): Promise<void> {
    await this.#threadAccounts.bind(threadId, accountId);
  }

  accountIdForThread(threadId: string): Promise<string | null> {
    return this.#threadAccounts.getAccountId(threadId);
  }

  listAccounts(): Promise<CodexAccount[]> {
    return this.#accounts.list();
  }

  async requestActive(method: string, params: JsonObject): Promise<JsonObject> {
    return (await this.active()).request(method, params);
  }

  async requestForThread(
    threadId: string,
    method: string,
    params: JsonObject,
  ): Promise<JsonObject> {
    return (await this.forThread(threadId)).request(method, params);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pending = await Promise.allSettled(this.#starting.values());
    const runtimes = new Set(this.#ownedRuntimes);
    for (const result of pending) if (result.status === "fulfilled") runtimes.add(result.value);
    for (const runtime of runtimes) runtime.close();
    this.#runtimes.clear();
    this.#ownedRuntimes.clear();
    this.#initialized.clear();
    this.#initializing.clear();
  }

  async #load(accountId: string): Promise<CodexRuntime> {
    const loaded = this.#runtimes.get(accountId);
    if (loaded) return loaded;
    const pending = this.#starting.get(accountId);
    if (pending) return pending;
    const starting = this.#start(accountId);
    this.#starting.set(accountId, starting);
    try {
      return await starting;
    } finally {
      this.#starting.delete(accountId);
    }
  }

  async #ensureInitialized(runtime: CodexRuntime): Promise<JsonObject> {
    const accountId = runtime.account.accountId;
    const initialized = this.#initialized.get(accountId);
    if (initialized) return initialized;
    const pending = this.#initializing.get(accountId);
    if (pending) return pending;
    const params = this.#initializationParams;
    if (!params) throw new Error("Codex runtime pool has no initialization parameters");
    const initializing = (async () => {
      const response = await runtime.request("initialize", params);
      if (!response.error) {
        await runtime.send({ method: "initialized" });
        this.#initialized.set(accountId, response);
      }
      return response;
    })();
    this.#initializing.set(accountId, initializing);
    try {
      return await initializing;
    } finally {
      this.#initializing.delete(accountId);
    }
  }

  async #start(accountId: string): Promise<CodexRuntime> {
    const account = await this.#accounts.get(accountId);
    if (!account) throw new Error(`Unknown Codex Account '${accountId}'`);
    await mkdir(account.codexHome, { recursive: true, mode: 0o700 });
    const connection = await this.#createConnection(account);
    const runtime = new CodexRuntime({
      account,
      connection,
      onOutput: this.#onOutput,
      diagnosticOutput: this.#diagnosticOutput,
      onClosed: (error) => {
        if (this.#runtimes.get(accountId) === runtime) {
          this.#runtimes.delete(accountId);
          this.#initialized.delete(accountId);
          this.#initializing.delete(accountId);
        }
        if (error && !this.#closed) {
          this.#diagnose(error);
          this.#failure.resolve(error);
        }
      },
    });
    this.#runtimes.set(accountId, runtime);
    this.#ownedRuntimes.add(runtime);
    return runtime;
  }

  async #discoverHistoricalThreadAccount(threadId: string): Promise<string | null> {
    const accounts = await this.#accounts.list();
    // A missing binding in a single-account installation remains an explicit
    // error. Discovery is a migration path for pre-pool tasks once multiple
    // isolated CODEX_HOMEs exist.
    if (accounts.length < 2) return null;
    const loadedAccounts = accounts.filter((account) => this.#runtimes.has(account.accountId));
    const unloadedAccounts = accounts.filter((account) => !this.#runtimes.has(account.accountId));
    for (const candidates of [loadedAccounts, unloadedAccounts]) {
      const matches: string[] = [];
      for (const account of candidates) {
        try {
          const response = await (
            await this.get(account.accountId)
          ).request("thread/read", {
            threadId,
            includeTurns: false,
          });
          const result = response.error ? null : response.result;
          const thread =
            result && typeof result === "object" && !Array.isArray(result) && "thread" in result
              ? result.thread
              : null;
          if (
            thread &&
            typeof thread === "object" &&
            !Array.isArray(thread) &&
            "id" in thread &&
            thread.id === threadId
          ) {
            matches.push(account.accountId);
          }
        } catch (error) {
          this.#diagnose(error);
        }
      }
      if (matches.length > 1) return null;
      const accountId = matches[0];
      if (!accountId) continue;
      await this.#threadAccounts.bind(threadId, accountId);
      return accountId;
    }
    return null;
  }
}
