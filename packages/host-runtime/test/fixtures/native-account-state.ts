import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

import { NativeAccountStore, newProfile } from "../../src/account/native-account-store.js";
import type {
  NativeAccountKeys,
  PrivateCredentialFiles,
} from "../../src/account/native-account-store.js";
import type { NativeAccountRuntime } from "../../src/account/native-account-runtime.js";
import { NativeCodexAccounts } from "../../src/account/native-codex-accounts.js";
import {
  NativeCodexCredentials,
  sameCodexCredentialIdentity,
  type CodexCredentialIdentity,
} from "../../src/account/native-codex-credentials.js";
import { nativeDigest } from "../../src/account/native-profile-vault.js";
import { OfficialWorkGate } from "../../src/codex-runtime/official-work-gate.js";
import type { NativePrivateFileLease } from "../../src/native-private-files.js";
import type { OfficialAppServerExit } from "../../src/official-app-server-connection.js";
import { syntheticNativeCredentials } from "./codex-account-fixtures.js";

type FileOperation = "read" | "replace" | "remove";
type FaultPhase = "before" | "after";

interface Fault {
  operation: FileOperation;
  phase: FaultPhase;
  matches?: (directory: string, name: string) => boolean;
  error: Error;
  run?: () => void;
}

const fileKey = (directory: string, name: string): string => path.join(directory, name);

/** Memory-backed private bytes with real, fixture-owned directories for stage cleanup. */
export class SyntheticPrivateFiles implements PrivateCredentialFiles {
  readonly #content = new Map<string, Buffer>();
  readonly #leases = new Map<string, PromiseWithResolvers<OfficialAppServerExit>>();
  readonly #faults: Fault[] = [];

  async ensureDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  async read(directory: string, name: string): Promise<Buffer | null> {
    this.#fail("read", "before", directory, name);
    const value = this.#content.get(fileKey(directory, name));
    this.#fail("read", "after", directory, name);
    return value ? Buffer.from(value) : null;
  }

  async replace(
    directory: string,
    name: string,
    content: Uint8Array,
    expected: string | null,
  ): Promise<void> {
    this.#fail("replace", "before", directory, name);
    const key = fileKey(directory, name);
    const previous = this.#content.get(key);
    const actual = previous ? nativeDigest(previous) : null;
    if (actual !== expected) {
      throw Object.assign(new Error("synthetic private-file conflict"), { code: "conflict" });
    }
    this.#content.set(key, Buffer.from(content));
    this.#fail("replace", "after", directory, name);
  }

  async remove(directory: string, name: string, expected: string): Promise<void> {
    this.#fail("remove", "before", directory, name);
    const key = fileKey(directory, name);
    const previous = this.#content.get(key);
    if (!previous || nativeDigest(previous) !== expected) {
      throw Object.assign(new Error("synthetic private-file conflict"), { code: "conflict" });
    }
    this.#content.delete(key);
    this.#fail("remove", "after", directory, name);
  }

  async lock(directory: string, name: string): Promise<NativePrivateFileLease> {
    const key = fileKey(directory, name);
    if (this.#leases.has(key)) throw new Error("synthetic lease conflict");
    const closed = Promise.withResolvers<OfficialAppServerExit>();
    this.#leases.set(key, closed);
    let released = false;
    return {
      closed: closed.promise,
      release: async () => {
        if (released) return;
        released = true;
        this.#leases.delete(key);
        closed.resolve({ code: 0, signal: null });
      },
    };
  }

  seed(directory: string, name: string, content: Uint8Array | string): void {
    this.#content.set(fileKey(directory, name), Buffer.from(content));
  }

  peek(directory: string, name: string): Buffer | null {
    const value = this.#content.get(fileKey(directory, name));
    return value ? Buffer.from(value) : null;
  }
  failNext(input: {
    operation: FileOperation;
    phase: FaultPhase;
    matches?: (directory: string, name: string) => boolean;
    error?: Error;
    run?: () => void;
  }): void {
    this.#faults.push({
      operation: input.operation,
      phase: input.phase,
      ...(input.matches ? { matches: input.matches } : {}),
      ...(input.run ? { run: input.run } : {}),
      error: input.error ?? new Error(`synthetic ${input.operation} ${input.phase} failure`),
    });
  }

  #fail(operation: FileOperation, phase: FaultPhase, directory: string, name: string): void {
    const index = this.#faults.findIndex(
      (fault) =>
        fault.operation === operation &&
        fault.phase === phase &&
        (fault.matches?.(directory, name) ?? true),
    );
    if (index < 0) return;
    const [fault] = this.#faults.splice(index, 1);
    fault?.run?.();
    throw fault?.error ?? new Error("synthetic persistence failure");
  }
}

export class SyntheticNativeAccountKeys implements NativeAccountKeys {
  #key: Buffer | null;
  reads = 0;
  creates = 0;

  constructor(key: Uint8Array | null = Buffer.alloc(32, 0x5a)) {
    this.#key = key ? Buffer.from(key) : null;
  }

  async read(): Promise<Buffer | null> {
    this.reads++;
    return this.#key ? Buffer.from(this.#key) : null;
  }

  async create(): Promise<Buffer> {
    this.creates++;
    if (this.#key) throw new Error("synthetic key already exists");
    this.#key = Buffer.alloc(32, 0x5a);
    return Buffer.from(this.#key);
  }
}

type RuntimeHook = (home: string) => void | Promise<void>;

export class SyntheticNativeAccountRuntime implements NativeAccountRuntime {
  readonly gate = new OfficialWorkGate();
  readonly starts: string[] = [];
  readonly verified: Array<CodexCredentialIdentity | null> = [];
  readonly controlRequests: Array<{ method: string; params: JsonObject }> = [];
  readonly #listeners = new Set<(value: JsonValue) => void>();
  readonly #stopHooks = new Map<string, RuntimeHook[]>();
  activeHome: string | undefined;
  maximumActive = 0;
  preflightError: Error | undefined;
  verifyError: Error | undefined;
  startHook: RuntimeHook | undefined;
  nativeIdle = true;
  readonly permanentHome: string;

  constructor(
    readonly store: NativeAccountStore,
    options: { ready?: boolean; permanentHome?: string } = {},
  ) {
    this.permanentHome = options.permanentHome ?? store.home;
    if (options.ready) this.gate.initialized();
  }

  async preflight(): Promise<void> {
    if (this.preflightError) throw this.preflightError;
  }

  async assertNativeIdle(): Promise<void> {
    if (!this.nativeIdle) throw Object.assign(new Error("synthetic native work"), { code: "busy" });
  }

  async stop(): Promise<void> {
    const home = this.activeHome;
    if (!home) {
      this.gate.retired();
      return;
    }
    const hooks = this.#stopHooks.get(home) ?? [];
    this.#stopHooks.delete(home);
    for (const hook of hooks) await hook(home);
    this.activeHome = undefined;
    this.gate.retired();
  }

  async start(stagingHome?: string): Promise<void> {
    if (this.activeHome) throw new Error("more than one synthetic backend would be active");
    const home = stagingHome ?? this.permanentHome;
    this.activeHome = home;
    this.starts.push(home);
    this.maximumActive = Math.max(this.maximumActive, this.activeHome ? 1 : 0);
    if (this.startHook) await this.startHook(home);
  }

  async verify(identity: CodexCredentialIdentity | null): Promise<void> {
    if (this.verifyError) {
      const error = this.verifyError;
      this.verifyError = undefined;
      throw error;
    }
    if (!this.activeHome) throw new Error("synthetic backend is stopped");
    const actual = await this.store.readCredentials(this.activeHome);
    if (
      identity === null
        ? actual !== null
        : !actual || !sameCodexCredentialIdentity(actual.identity, identity)
    ) {
      throw Object.assign(new Error("synthetic authentication mismatch"), {
        code: "authentication-failed",
      });
    }
    this.verified.push(identity ? { ...identity } : null);
  }

  async controlRequest(method: string, params: JsonObject): Promise<JsonObject> {
    this.controlRequests.push({ method, params });
    if (method === "account/login/start") {
      return {
        result: {
          type: "chatgptDeviceCode",
          loginId: "native-login",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABC",
        },
      };
    }
    return { result: {} };
  }

  subscribe(listener: (value: JsonValue) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(value: JsonValue): void {
    for (const listener of this.#listeners) listener(value);
  }

  rotateOnNextStop(home: string, credential: NativeCodexCredentials): void {
    const hooks = this.#stopHooks.get(home) ?? [];
    hooks.push(async () => {
      const current = await this.store.readCredentials(home);
      const directoryFiles = this.store.files as SyntheticPrivateFiles;
      directoryFiles.seed(home, "auth.json", credential.serializeForNativeStore());
      if (!current) throw new Error("rotation requires an installed credential");
    });
    this.#stopHooks.set(home, hooks);
  }
}

export const nativeAccountIds = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  c: "33333333-3333-4333-8333-333333333333",
} as const;

export const credential = (
  subject: string,
  generation = 1,
  expiresAtUnix = 1,
): NativeCodexCredentials =>
  NativeCodexCredentials.parse(syntheticNativeCredentials({ subject, generation, expiresAtUnix }));

export interface NativeAccountTestState {
  root: string;
  files: SyntheticPrivateFiles;
  keys: SyntheticNativeAccountKeys;
  store: NativeAccountStore;
  runtime: SyntheticNativeAccountRuntime;
  seedAccounts(input: {
    current: { accountId: string; credential: NativeCodexCredentials } | null;
    saved?: Array<{ accountId: string; credential: NativeCodexCredentials }>;
  }): Promise<void>;
  initializeManager(fetch?: typeof globalThis.fetch): Promise<NativeCodexAccounts>;
  close(): Promise<void>;
}

export async function createNativeAccountTestState(
  options: {
    readyRuntime?: boolean;
    key?: Uint8Array | null;
  } = {},
): Promise<NativeAccountTestState> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codexhost-native-state-")));
  const home = path.join(root, "home");
  const files = new SyntheticPrivateFiles();
  const keys = new SyntheticNativeAccountKeys(options.key);
  const store = new NativeAccountStore({ home, files, keys });
  await store.open();
  const runtime = new SyntheticNativeAccountRuntime(
    store,
    options.readyRuntime === undefined ? {} : { ready: options.readyRuntime },
  );

  return {
    root,
    files,
    keys,
    store,
    runtime,
    async seedAccounts(input) {
      await store.mutate((next) => {
        const entries = [...(input.current ? [input.current] : []), ...(input.saved ?? [])];
        next.accounts = entries.map((entry) => {
          const account = newProfile(entry.credential, entry.accountId);
          account.payload =
            input.current?.accountId === entry.accountId
              ? null
              : store.encrypt(account, entry.credential);
          return account;
        });
        next.currentAccountId = input.current?.accountId ?? null;
      });
      if (input.current) {
        files.seed(home, "auth.json", input.current.credential.serializeForNativeStore());
      }
    },
    async initializeManager(fetch) {
      // Store ownership is established above before the Manager can recover or import.
      const manager = new NativeCodexAccounts({
        store,
        runtime,
        ...(fetch ? { fetch } : {}),
      });
      await manager.initialize();
      return manager;
    },
    async close() {
      await runtime.stop();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
