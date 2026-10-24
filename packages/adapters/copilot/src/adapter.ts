import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { CopilotClient } from "@github/copilot-sdk";
import type {
  HarnessAdapter,
  HarnessError,
  HarnessErrorCode,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import {
  harnessInspectionSchema,
  harnessPermissionModeCatalogSchema,
} from "@codexhost/shared-contracts";
import { createCopilotClient, copilotEnvironment } from "./client.js";
import { resolveCopilotExecutable } from "./command.js";
import { modelCatalog, readModels } from "./configuration.js";
import { bounded, failure, nativeError, CopilotOperationError } from "./errors.js";
import { forkBoundary, readPersistedEvents, rootMessages } from "./history.js";
import { copilotId, sessionIdFromRef, sessionRef, sessionIsUnattended } from "./refs.js";
import { CopilotHarnessSession, copilotCapabilities } from "./session.js";
import { projectHistory } from "./projection.js";
import { CopilotAccount } from "./account.js";

const permissionModes = harnessPermissionModeCatalogSchema.parse({
  defaultModeId: "manual",
  modes: [
    {
      id: "manual",
      label: "Manual",
      description: "Ask for native tool approvals.",
      localizations: { "zh-CN": { label: "手动审批", description: "按原生规则请求工具审批。" } },
    },
    {
      id: "assisted",
      label: "Assisted",
      description: "Copilot evaluates approvals using its native policy.",
      localizations: {
        "zh-CN": { label: "辅助审批", description: "由 Copilot 原生策略评估审批。" },
      },
    },
    {
      id: "allow-all",
      label: "Allow all",
      dangerous: true,
      description: "Native allow-all mode; managed restrictions still apply.",
      localizations: {
        "zh-CN": { label: "全部允许", description: "原生全部允许模式；仍受托管策略限制。" },
      },
    },
  ],
});

export class CopilotAdapter implements HarnessAdapter {
  readonly harnessId = copilotId;
  private readonly sessions = new Map<string, CopilotHarnessSession>();
  private readonly clients = new Set<CopilotClient>();
  private readonly inspections = new Map<string, Extract<HarnessInspection, { status: "ready" }>>();
  private readonly inspectionsInFlight = new Map<string, Promise<HarnessInspection>>();
  private closed = false;
  private readonly account: CopilotAccount;

  constructor(private readonly environment: NodeJS.ProcessEnv) {
    this.account = new CopilotAccount(environment);
  }

  inspectAccount() {
    return this.account.inspect();
  }
  credits() {
    return this.account.credits();
  }
  async refreshCredits() {
    return (await this.account.refresh())?.credits ?? null;
  }

  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.closed)
      return {
        status: "unavailable",
        error: { code: "invalidState", message: "Copilot Adapter is closed.", retryable: false },
      };
    const cwd = path.resolve(input.cwd ?? this.environment.HOME ?? process.cwd());
    const pending = this.inspectionsInFlight.get(cwd);
    if (pending) return pending;
    const cached = this.inspections.get(cwd);
    if (!input.refresh && cached) return cached;
    this.inspections.delete(cwd);
    const inspection = this.inspectCwd(cwd);
    this.inspectionsInFlight.set(cwd, inspection);
    return inspection.finally(() => {
      if (this.inspectionsInFlight.get(cwd) === inspection) this.inspectionsInFlight.delete(cwd);
    });
  }

  private async inspectCwd(cwd: string): Promise<HarnessInspection> {
    let client: CopilotClient | undefined;
    let result: HarnessInspection;
    let stage = "inspect.start";
    try {
      client = createCopilotClient({ cwd, environment: this.environment });
      this.clients.add(client);
      await bounded(client.start());
      if (this.closed)
        throw new CopilotOperationError("invalidState", "Copilot Adapter is closed.");
      stage = "inspect.status";
      await bounded(client.getStatus());
      // Authentication source and model entitlement are separate native facts.
      stage = "inspect.authentication";
      const auth = await bounded(client.getAuthStatus());
      stage = "inspect.models";
      const models = await readModels(client, undefined, auth);
      result =
        !auth.isAuthenticated && models.length === 0
          ? {
              status: "unavailable",
              error: {
                code: "authenticationRequired",
                message:
                  "Copilot authentication is unavailable. Run copilot and use /login on this Host.",
                retryable: true,
              },
            }
          : harnessInspectionSchema.parse({
              status: "ready",
              catalog: modelCatalog(models),
              permissionModes,
              capabilities: copilotCapabilities,
            });
    } catch (error) {
      const problem = nativeError(error, stage);
      result = {
        status: problem.code === "notInstalled" ? "notInstalled" : "unavailable",
        error: problem,
      };
    }
    if (client) {
      try {
        const errors = await bounded(client.stop(), 10_000).catch(() => [
          new Error("Copilot stop failed"),
        ]);
        if (errors.length) await bounded(client.forceStop(), 5_000);
        this.clients.delete(client);
      } catch (error) {
        result = {
          status: "unavailable",
          error: {
            code: "nativeFailure",
            message: "Copilot inspection resources could not be released.",
            retryable: true,
            stage: "inspect.close",
            diagnostic: nativeError(error, "inspect.close").diagnostic,
          },
        };
      }
    }
    if (this.closed)
      return {
        status: "unavailable",
        error: { code: "invalidState", message: "Copilot Adapter is closed.", retryable: false },
      };
    if (result.status === "ready") this.inspections.set(cwd, result);
    return result;
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    if (this.closed) return failure("invalidState", "Copilot Adapter is closed.");
    if (
      input.kind === "create" &&
      input.executionPolicy === "unattended-full-access" &&
      input.permissionModeId &&
      input.permissionModeId !== "allow-all"
    )
      return failure("invalidRequest", "Copilot permission conflicts with unattended execution.");
    try {
      if (!path.isAbsolute(input.cwd))
        return failure("invalidRequest", "Copilot cwd must be absolute.");
      if (!(await stat(input.cwd)).isDirectory())
        return failure("invalidRequest", "Copilot cwd must be a directory.");
      resolveCopilotExecutable({
        environment: copilotEnvironment(this.environment, input.environment),
      });
      if (input.kind === "fork" || input.kind === "rollbackLastTurn")
        return await this.derive(input);
      if (input.kind === "resume" && this.sessions.has(sessionIdFromRef(input.nativeRef)))
        return failure("sessionBusy", "Copilot session already has a writer.");
      const session = new CopilotHarnessSession(input, this.environment, () =>
        this.sessions.delete(session.nativeId),
      );
      this.sessions.set(session.nativeId, session);
      try {
        if (input.kind === "resume" || input.executionPolicy === "unattended-full-access")
          await session.initialize();
        return { ok: true, value: session };
      } catch (error) {
        const problem = nativeError(error, `session.${input.kind}`);
        try {
          await session.close();
        } catch {
          problem.diagnostic = [
            problem.diagnostic,
            "Copilot cleanup also failed; close can be retried.",
          ]
            .filter(Boolean)
            .join("; ");
        }
        return { ok: false, error: problem };
      }
    } catch (error) {
      return { ok: false, error: nativeError(error, `session.${input.kind}`) };
    }
  }

  private async derive(
    input: Extract<OpenSessionInput, { kind: "fork" | "rollbackLastTurn" }>,
  ): Promise<HarnessResult<HarnessSession>> {
    const sourceId = sessionIdFromRef(input.sourceRef);
    const source = this.sessions.get(sourceId);
    return source
      ? source.withIdleSource(() => this.deriveIdle(input, sourceId, source))
      : this.deriveIdle(input, sourceId);
  }

  private async deriveIdle(
    input: Extract<OpenSessionInput, { kind: "fork" | "rollbackLastTurn" }>,
    sourceId: string,
    source?: CopilotHarnessSession,
  ): Promise<HarnessResult<HarnessSession>> {
    const client = createCopilotClient({
      cwd: input.cwd,
      environment: this.environment,
      ...(input.environment ? { sessionEnvironment: input.environment } : {}),
    });
    this.clients.add(client);
    let created: string | undefined;
    let primary: HarnessError | undefined;
    let completed: HarnessSession | undefined;
    let copyClosed = true;
    const reject = (code: HarnessErrorCode, message: string): HarnessResult<HarnessSession> => {
      primary = { code, message, retryable: code === "sessionBusy" };
      return { ok: false, error: primary };
    };
    try {
      await bounded(client.start());
      if (
        !source &&
        (await client.rpc.sessions.checkInUse({ sessionIds: [sourceId] })).inUse.length
      )
        return reject("sessionBusy", "Copilot source is owned by another process.");
      const events = await bounded(readPersistedEvents(client, sourceId));
      const start = events.find((event) => event.type === "session.start");
      const sourceCwd = start?.data.context?.cwd;
      if (!sourceCwd || (await realpath(sourceCwd)) !== (await realpath(input.cwd)))
        return reject("unsupported", "Copilot Fork must retain the source working directory.");
      let toEventId: string | undefined;
      if (input.kind === "fork") {
        if (
          input.checkpoint.harnessId !== copilotId ||
          input.checkpoint.nativeSessionId !== sourceId ||
          input.checkpoint.formatVersion !== 1
        )
          return reject("checkpointNotFound", "Copilot checkpoint does not belong to this source.");
        try {
          toEventId = forkBoundary(events, input.checkpoint.checkpointId);
        } catch {
          return reject("checkpointNotFound", "Copilot checkpoint was not found.");
        }
      } else {
        toEventId = rootMessages(events).at(-1)?.id;
        if (!toEventId) return reject("invalidRequest", "Copilot history is empty.");
      }
      const fork = await bounded(
        client.rpc.sessions.fork({ sessionId: sourceId, ...(toEventId ? { toEventId } : {}) }),
      );
      if (fork.sessionId === sourceId) throw new Error("Copilot Fork reused its source identity");
      created = sessionRef(fork.sessionId).nativeSessionId;
      const actual = await readPersistedEvents(client, created);
      const expected = toEventId
        ? events.slice(
            0,
            events.findIndex((event) => event.id === toEventId),
          )
        : events;
      const ids = (values: typeof events) =>
        rootMessages(values).map((event) => event.data.messageId);
      if (JSON.stringify(ids(actual)) !== JSON.stringify(ids(expected)))
        throw new Error("Copilot Fork returned the wrong history prefix");
      const content = (id: string, values: typeof events) =>
        projectHistory(id, values).turns.map(({ input, items, outcome }) => ({
          input,
          items,
          outcome,
        }));
      if (JSON.stringify(content(created, actual)) !== JSON.stringify(content(sourceId, expected)))
        throw new Error("Copilot Fork changed the visible history prefix");
      const result = await this.open({
        kind: "resume",
        nativeRef: sessionRef(created, sessionIsUnattended(input.sourceRef)),
        cwd: input.cwd,
        ...(input.environment ? { environment: input.environment } : {}),
      });
      if (!result.ok) {
        primary = result.error;
        return result;
      }
      const state =
        input.kind === "rollbackLastTurn"
          ? {
              effectiveModel: input.model,
              effectiveThinkingOptionId: input.thinkingOptionId,
              effectivePermissionModeId: input.permissionModeId,
            }
          : source?.currentState();
      try {
        const derived = this.sessions.get(created);
        if (!derived) throw new Error("Copilot derived Session was not registered");
        if (
          state?.effectiveModel &&
          derived.currentState().effectiveModel?.id !== state.effectiveModel.id
        ) {
          const selected = await result.value.execute({
            type: "model.select",
            model: state.effectiveModel,
          });
          if (!selected.ok)
            throw new CopilotOperationError(
              selected.error.code,
              selected.error.message,
              selected.error.diagnostic,
              selected.error.retryable,
              selected.error.stage,
            );
        }
        if (
          state?.effectiveThinkingOptionId &&
          derived.currentState().effectiveThinkingOptionId !== state.effectiveThinkingOptionId
        ) {
          const selected = await result.value.execute({
            type: "thinking.select",
            thinkingOptionId: state.effectiveThinkingOptionId,
          });
          if (!selected.ok)
            throw new CopilotOperationError(
              selected.error.code,
              selected.error.message,
              selected.error.diagnostic,
              selected.error.retryable,
              selected.error.stage,
            );
        }
        if (
          state?.effectivePermissionModeId &&
          derived.currentState().effectivePermissionModeId !== state.effectivePermissionModeId
        ) {
          const selected = await result.value.execute({
            type: "permissionMode.select",
            permissionModeId: state.effectivePermissionModeId,
          });
          if (!selected.ok)
            throw new CopilotOperationError(
              selected.error.code,
              selected.error.message,
              selected.error.diagnostic,
              selected.error.retryable,
              selected.error.stage,
            );
        }
      } catch (error) {
        primary = nativeError(error, `session.${input.kind}`);
        try {
          await result.value.close();
        } catch {
          copyClosed = false;
          primary.diagnostic = [primary.diagnostic, "Copilot derived Session could not be closed."]
            .filter(Boolean)
            .join("; ");
        }
        return { ok: false, error: primary };
      }
      completed = result.value;
      return result;
    } catch (error) {
      primary = nativeError(error, `session.${input.kind}`);
      return { ok: false, error: primary };
    } finally {
      let cleanupFailed = !copyClosed;
      try {
        if (created && !completed && copyClosed)
          await bounded(client.deleteSession(created), 5_000);
      } catch {
        cleanupFailed = true;
      }
      try {
        const errors = await bounded(client.stop(), 10_000).catch(() => [
          new Error("Copilot stop failed"),
        ]);
        if (errors.length) await bounded(client.forceStop(), 5_000);
        this.clients.delete(client);
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        const diagnostic = `Copilot cleanup also failed${created ? `; temporary native Session ${created} may remain` : ""}.`;
        if (primary)
          primary.diagnostic = [primary.diagnostic, diagnostic].filter(Boolean).join("; ");
        else {
          if (completed) await completed.close().catch(() => {});
          throw new CopilotOperationError(
            "nativeFailure",
            "Copilot could not finish resource cleanup.",
            diagnostic,
          );
        }
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.inspections.clear();
    const results = await Promise.allSettled([
      ...[...this.sessions.values()].map((session) => session.close()),
      this.account.close(),
      ...[...this.clients].map((client) => client.forceStop()),
    ]);
    await Promise.allSettled([...this.inspectionsInFlight.values()]);
    this.inspectionsInFlight.clear();
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Copilot sessions could not all be closed; retry close.");
  }
}
