import { stat } from "node:fs/promises";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessInspectionSchema } from "@codexhost/shared-contracts";
import {
  CodeBuddyAcpClient,
  type CodeBuddyClient,
  type CodeBuddyClientFactory,
} from "./acp-client.js";
import { CODEBUDDY_ID, CodeBuddyError, failure, nativeError, record } from "./common.js";
import { CODEBUDDY_CAPABILITIES, configuration } from "./configuration.js";
import { validateNativeRef } from "./history.js";
import { CodeBuddySession, type CodeBuddyHistoryReader } from "./session.js";
import { readCodeBuddyChild } from "./subagent-history.js";
import type { HarnessSubagentCapability } from "@codexhost/harness-adapter";

export interface CodeBuddyAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  clientFactory?: CodeBuddyClientFactory;
  readHistory?: CodeBuddyHistoryReader;
}

export class CodeBuddyAdapter implements HarnessAdapter {
  readonly harnessId = CODEBUDDY_ID;
  readonly subagents: HarnessSubagentCapability = {
    readSnapshot: async ({ parent, nativeSubagentId, cwd }) => {
      try {
        if (this.#closed) return failure("invalidState", "Adapter is closed");
        const session = [...this.#sessions].find(
          (s) => s.initialState.nativeRef?.nativeSessionId === parent.nativeSessionId,
        );
        const snapshot = await readCodeBuddyChild(
          parent,
          nativeSubagentId,
          cwd,
          session?.environment ?? this.#environment,
          session?.subagents.state(nativeSubagentId)?.status,
        );
        return { ok: true, value: snapshot };
      } catch (error) {
        return { ok: false, error: nativeError(error) };
      }
    },
  };
  readonly #environment: NodeJS.ProcessEnv;
  readonly #factory: CodeBuddyClientFactory;
  readonly #sessions = new Set<CodeBuddySession>();
  readonly #inspections = new Set<CodeBuddyClient>();
  readonly #cache = new Map<string, Promise<HarnessInspection>>();
  #closed = false;
  constructor(readonly options: CodeBuddyAdapterOptions = {}) {
    this.#environment = { ...(options.environment ?? process.env) };
    this.#factory = options.clientFactory ?? ((options) => new CodeBuddyAcpClient(options));
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
      const config = configuration(opened.configOptions);
      return harnessInspectionSchema.parse({
        status: "ready",
        catalog: config.catalog,
        permissionModes: config.permissionModes,
        capabilities: CODEBUDDY_CAPABILITIES,
      });
    } catch (error) {
      const issue = nativeError(error);
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
    if (this.#closed) return failure("invalidState", "Adapter is closed");
    if (input.kind === "fork" || input.kind === "rollbackLastTurn")
      return failure(
        "unsupported",
        "CodeBuddy ACP does not expose a verified precise history boundary operation",
      );
    let session: CodeBuddySession | undefined;
    try {
      if (!(await stat(input.cwd)).isDirectory())
        throw new CodeBuddyError("invalidRequest", "Working directory is not a directory");
      if (input.kind === "resume") validateNativeRef(input.nativeRef);
      session = new CodeBuddySession(
        input,
        { ...this.#environment, ...input.environment },
        this.#factory,
        this.options.readHistory,
        () => {
          if (session) this.#sessions.delete(session);
        },
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
      return { ok: false, error: nativeError(issue) };
    }
  }

  async close() {
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#sessions, ...this.#inspections].map((resource) => resource.close()),
    );
    this.#sessions.clear();
    this.#inspections.clear();
    this.#cache.clear();
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "CodeBuddy process cleanup failed");
  }
}
