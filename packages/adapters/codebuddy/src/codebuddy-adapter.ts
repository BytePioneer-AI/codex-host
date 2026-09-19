import { stat } from "node:fs/promises";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessInspectionSchema, type HarnessCommandCatalog } from "@codexhost/shared-contracts";
import {
  CodeBuddyAcpClient,
  type CodeBuddyClient,
  type CodeBuddyClientFactory,
  type CodeBuddyInvocationFactory,
} from "./acp-client.js";
import { codeBuddyInvocation } from "./command.js";
import {
  CODEBUDDY_RUNTIME_PROFILE,
  CodeBuddyError,
  failure,
  nativeError,
  record,
  text,
  type CodeBuddyRuntimeProfile,
} from "./common.js";
import { capabilitiesForProfile, configuration } from "./configuration.js";
import { assertCodeBuddyDirectoryTrusted } from "./directory-trust.js";
import { deriveCodeBuddySession } from "./derivation.js";
import { codeBuddyCanonicalCwd, validateNativeRef } from "./history.js";
import { CodeBuddySession, type CodeBuddyHistoryReader } from "./session.js";
import { readCodeBuddyChild } from "./subagent-history.js";
import type { HarnessSubagentCapability } from "@codexhost/harness-adapter";
import { CODEBUDDY_COMMAND_CATALOG, nativeCommandsEnabled } from "./slash-commands.js";

export interface CodeBuddyAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  clientFactory?: CodeBuddyClientFactory;
  readHistory?: CodeBuddyHistoryReader;
  profile?: CodeBuddyRuntimeProfile;
  invocationFactory?: CodeBuddyInvocationFactory;
}

export class CodeBuddyAdapter implements HarnessAdapter {
  readonly harnessId;
  readonly commandCatalog?: HarnessCommandCatalog;
  readonly subagents: HarnessSubagentCapability = {
    readSnapshot: async ({ parent, nativeSubagentId, cwd }) => {
      try {
        if (this.#closed) return failure("invalidState", "Adapter is closed", this.#profile);
        const session = [...this.#sessions].find(
          (s) => s.initialState.nativeRef?.nativeSessionId === parent.nativeSessionId,
        );
        const snapshot = await readCodeBuddyChild(
          parent,
          nativeSubagentId,
          cwd,
          session?.environment ?? this.#environment,
          session?.subagents.state(nativeSubagentId)?.status,
          this.#profile,
        );
        return { ok: true, value: snapshot };
      } catch (error) {
        return { ok: false, error: nativeError(error, this.#profile) };
      }
    },
  };
  readonly #environment: NodeJS.ProcessEnv;
  readonly #profile: CodeBuddyRuntimeProfile;
  readonly #factory: CodeBuddyClientFactory;
  readonly #invocation: CodeBuddyInvocationFactory;
  readonly #sessions = new Set<CodeBuddySession>();
  readonly #inspections = new Set<CodeBuddyClient>();
  readonly #cache = new Map<string, Promise<HarnessInspection>>();
  #closed = false;
  readonly #abort = new AbortController();
  readonly #derivations = new Set<Promise<unknown>>();
  constructor(readonly options: CodeBuddyAdapterOptions = {}) {
    this.#profile = options.profile ?? CODEBUDDY_RUNTIME_PROFILE;
    this.harnessId = this.#profile.harnessId;
    if (nativeCommandsEnabled(this.#profile)) {
      const commandCatalog =
        this.#profile.staticCommandCatalog ??
        (this.#profile.harnessId === CODEBUDDY_RUNTIME_PROFILE.harnessId
          ? CODEBUDDY_COMMAND_CATALOG
          : undefined);
      if (commandCatalog) this.commandCatalog = commandCatalog;
    }
    this.#environment = { ...(options.environment ?? process.env) };
    this.#invocation = options.invocationFactory ?? codeBuddyInvocation;
    this.#factory =
      options.clientFactory ??
      ((clientOptions) => new CodeBuddyAcpClient(clientOptions, undefined, this.#invocation));
  }

  inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    const cwd = input.cwd ?? process.cwd();
    if (input.refresh) this.#cache.delete(cwd);
    let inspection = this.#cache.get(cwd);
    if (!inspection) {
      inspection = this.#inspect(cwd);
      this.#cache.set(cwd, inspection);
    }
    return inspection;
  }

  async #inspect(cwd: string): Promise<HarnessInspection> {
    let client: CodeBuddyClient | undefined;
    try {
      if (this.#closed) throw new CodeBuddyError("invalidState", "Adapter is closed");
      if (!(await stat(cwd)).isDirectory())
        throw new CodeBuddyError("invalidRequest", "Working directory is not a directory");
      assertCodeBuddyDirectoryTrusted(cwd, this.#environment, this.#profile);
      // Protocol-only disposable Session: no prompt, transcript or user Session is persisted.
      client = this.#factory({
        cwd,
        environment: this.#environment,
        ephemeral: true,
        handlers: {
          update: () => {},
          fault: () => {},
          permission: async () => ({ outcome: { outcome: "cancelled" } }),
          question: async () => ({ outcome: "cancelled" }),
        },
      });
      this.#inspections.add(client);
      await client.initialize();
      const opened = await client.open(cwd);
      const config = configuration(opened.configOptions, this.#profile, { cwd, environment: this.#environment });
      return harnessInspectionSchema.parse({
        status: "ready",
        catalog: config.catalog,
        permissionModes: config.permissionModes,
        capabilities: capabilitiesForProfile(this.#profile),
      });
    } catch (error) {
      const issue = nativeError(error, this.#profile);
      return {
        status: issue.code === "notInstalled" ? "notInstalled" : "unavailable",
        error: issue,
      };
    } finally {
      if (client) {
        await client.close().catch(() => {});
        this.#inspections.delete(client);
      }
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.#closed) return failure("invalidState", "Adapter is closed", this.#profile);
    if (
      input.kind === "create" &&
      input.executionPolicy === "unattended-full-access" &&
      input.permissionModeId &&
      input.permissionModeId !== "fullAccess"
    )
      return failure(
        "invalidRequest",
        "Unattended execution requires native fullAccess permissions",
        this.#profile,
      );
    let session: CodeBuddySession | undefined;
    try {
      if (!(await stat(input.cwd)).isDirectory())
        throw new CodeBuddyError("invalidRequest", "Working directory is not a directory");
      const environment = { ...this.#environment, ...input.environment };
      assertCodeBuddyDirectoryTrusted(input.cwd, environment, this.#profile);
      if (this.#closed)
        throw new CodeBuddyError("invalidState", "Adapter closed while opening Session");
      if (input.kind === "resume") validateNativeRef(input.nativeRef, this.#profile);
      if (input.kind === "fork" || input.kind === "rollbackLastTurn") {
        const capabilities = capabilitiesForProfile(this.#profile).history;
        if (
          (input.kind === "fork" && !capabilities.fork) ||
          (input.kind === "rollbackLastTurn" && !capabilities.rollbackLastTurn)
        )
          throw new CodeBuddyError(
            "unsupported",
            `${this.#profile.displayName} does not expose this verified history operation`,
          );
        const sourceRef = input.sourceRef;
        validateNativeRef(sourceRef, this.#profile);
        const source = [...this.#sessions].find(
          (candidate) =>
            candidate.initialState.nativeRef?.nativeSessionId === sourceRef.nativeSessionId,
        );
        const snapshot = await source?.readSnapshot();
        if (this.#closed)
          throw new CodeBuddyError("invalidState", "Adapter closed while reading source Session");
        if (snapshot && !snapshot.ok) return snapshot;
        const boundCwd = text(record(sourceRef.locator).boundCwd);
        const sourceCwd = (source?.input.cwd ?? boundCwd) || input.cwd;
        if (
          input.kind === "fork" &&
          !capabilities.forkAcrossCwd &&
          codeBuddyCanonicalCwd(sourceCwd) !== codeBuddyCanonicalCwd(input.cwd)
        )
          throw new CodeBuddyError(
            "unsupported",
            `${this.#profile.displayName} does not support cross-directory Fork`,
          );
        const derivation = deriveCodeBuddySession({
          input,
          sourceCwd,
          environment: { ...this.#environment, ...input.environment },
          factory: this.#factory,
          invocationFactory: this.#invocation,
          profile: this.#profile,
          signal: this.#abort.signal,
          ...(snapshot?.ok && snapshot.value.state ? { state: snapshot.value.state } : {}),
        });
        this.#derivations.add(derivation);
        try {
          input = await derivation;
        } finally {
          this.#derivations.delete(derivation);
        }
      }
      if (this.#closed)
        throw new CodeBuddyError("invalidState", "Adapter closed while opening Session");
      session = new CodeBuddySession(
        input,
        { ...this.#environment, ...input.environment },
        this.#factory,
        this.options.readHistory,
        () => {
          if (session) this.#sessions.delete(session);
        },
        this.#profile,
      );
      this.#sessions.add(session);
      await session.initialize();
      if (this.#closed)
        throw new CodeBuddyError("invalidState", "Adapter closed while opening Session");
      return { ok: true, value: session };
    } catch (error) {
      if (session) {
        await session.close().catch(() => {});
        this.#sessions.delete(session);
      }
      const issue =
        record(error).code === "ENOENT"
          ? new CodeBuddyError("invalidRequest", "Working directory does not exist")
          : error;
      return { ok: false, error: nativeError(issue, this.#profile) };
    }
  }

  async close() {
    this.#closed = true;
    this.#abort.abort();
    await Promise.allSettled([...this.#derivations]);
    const results = await Promise.allSettled(
      [...this.#sessions, ...this.#inspections].map((resource) => resource.close()),
    );
    this.#sessions.clear();
    this.#inspections.clear();
    this.#cache.clear();
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, `${this.#profile.displayName} process cleanup failed`);
  }
}
