import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";

import type {
  HarnessAdapter,
  HarnessError,
  HarnessExecutionPolicy,
  HarnessOutput,
  HarnessSession,
  OpenSessionInput,
} from "@codexhost/harness-adapter";

import { consumeBrokerFrames, writeBrokerFrame } from "./framing.js";
import {
  HARNESS_BROKER_MAX_PENDING_REQUESTS,
  HARNESS_BROKER_PROTOCOL_VERSION,
  harnessBrokerHelloSchema,
  harnessBrokerDescriptorSchema,
  harnessBrokerRequestSchema,
  protocolError,
  type HarnessBrokerDescriptorV1,
  type HarnessBrokerRequest,
} from "./protocol.js";
import {
  brokerCommandInvocationSchema,
  brokerHostCommandSchema,
  brokerInspectInputSchema,
  brokerOpenInputSchema,
  sessionCommandExecuteParamsSchema,
  sessionExecuteParamsSchema,
  sessionParamsSchema,
  subagentReadSnapshotSchema,
} from "./validation.js";

interface ServerSession {
  id: string;
  generation: number;
  owner: string;
  cwd: string;
  executionPolicy: HarnessExecutionPolicy;
  nativeId?: string;
  nativeRef?: HarnessSession["initialState"]["nativeRef"];
  writerKey?: string;
  awaitingNativeIdentity: boolean;
  provisionalWriterLease: boolean;
  bootstrapTurnId?: string;
  session: HarnessSession;
  outputTask: Promise<void>;
  forwarderEpoch: number;
  faulted: boolean;
  selection: {
    model?: HarnessSession["initialState"]["effectiveModel"];
    thinkingOptionId?: HarnessSession["initialState"]["effectiveThinkingOptionId"];
    permissionModeId?: HarnessSession["initialState"]["effectivePermissionModeId"];
  };
}

interface ConnectionState {
  id: string;
  socket: Socket;
  authenticated: boolean;
  inputSequence: number;
  outputSequence: number;
  sessions: Set<string>;
  queue: Promise<void>;
  queuedFrames: number;
  closed: boolean;
}

export interface HarnessBrokerServer {
  readonly descriptor: HarnessBrokerDescriptorV1;
  close(): Promise<void>;
}

function harnessError(message: string, retryable = true): HarnessError {
  return { code: "unavailable", message, retryable, stage: "harnessBroker" };
}

function isAuthenticationTerminal(output: HarnessOutput): boolean {
  return (
    output.kind === "event" &&
    output.event.type === "turn.completed" &&
    output.event.outcome.status === "failed" &&
    output.event.outcome.error.code === "authenticationRequired"
  );
}

function nativeWriterKey(nativeSessionId: string): string {
  return nativeSessionId;
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Harness broker directory must be a real directory");
  }
  if (process.getuid && metadata.uid !== process.getuid()) {
    throw new Error("Harness broker directory belongs to another user");
  }
  await chmod(directory, 0o700);
  const hardened = await lstat(directory);
  if ((hardened.mode & 0o077) !== 0) {
    throw new Error("Harness broker directory must be owner-only");
  }
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertNoLiveDescriptor(descriptorPath: string): Promise<void> {
  try {
    const metadata = await lstat(descriptorPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Harness broker descriptor path must be a regular file");
    }
    if (process.platform !== "win32") {
      if ((metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid())) {
        throw new Error("Harness broker descriptor is not owner-only");
      }
    }
    const descriptor = harnessBrokerDescriptorSchema.parse(
      JSON.parse(await readFile(descriptorPath, "utf8")),
    );
    if (processIsAlive(descriptor.ownerPid)) {
      throw new Error("Harness broker descriptor already has a live owner");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function publishDescriptor(
  descriptorPath: string,
  descriptor: HarnessBrokerDescriptorV1,
): Promise<void> {
  const temporary = `${descriptorPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(descriptor)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, descriptorPath);
  if (process.platform !== "win32") await chmod(descriptorPath, 0o600);
}

function sessionMetadata(record: ServerSession): object {
  const initialState = { ...record.session.initialState };
  if (record.selection.model && initialState.effectiveModel?.id !== record.selection.model.id) {
    delete initialState.resolvedModelLabel;
  }
  if (
    record.selection.thinkingOptionId &&
    initialState.effectiveThinkingOptionId !== record.selection.thinkingOptionId
  ) {
    delete initialState.availableThinkingOptions;
  }
  return {
    sessionId: record.id,
    sessionGeneration: record.generation,
    capabilities: record.session.capabilities,
    initialState: {
      ...initialState,
      ...(record.nativeRef ? { nativeRef: record.nativeRef } : {}),
      ...(record.selection.model ? { effectiveModel: record.selection.model } : {}),
      ...(record.selection.thinkingOptionId
        ? { effectiveThinkingOptionId: record.selection.thinkingOptionId }
        : {}),
      ...(record.selection.permissionModeId
        ? { effectivePermissionModeId: record.selection.permissionModeId }
        : {}),
    },
    initialUsage: record.session.initialUsage,
    commands: record.session.commands !== undefined,
  };
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function prepareUnixSocketPath(socketPath: string): Promise<void> {
  try {
    const metadata = await lstat(socketPath);
    if (metadata.isSymbolicLink() || !metadata.isSocket()) {
      throw new Error("Harness broker socket path must not replace a non-socket entry");
    }
    if (process.getuid && metadata.uid !== process.getuid()) {
      throw new Error("Harness broker socket belongs to another user");
    }
    if (await socketAcceptsConnections(socketPath)) {
      throw new Error("Harness broker socket is already active");
    }
    await rm(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function startHarnessBrokerServer(input: {
  descriptorPath: string;
  socketPath: string;
  adapter: HarnessAdapter;
  generation?: string;
  token?: string;
}): Promise<HarnessBrokerServer> {
  if (input.adapter.harnessId !== "claude-code") {
    throw new Error("Harness broker accepts only the claude-code adapter");
  }
  if (
    process.platform !== "win32" &&
    path.dirname(input.descriptorPath) !== path.dirname(input.socketPath)
  ) {
    throw new Error("Harness broker descriptor and socket must share one private directory");
  }
  if (process.platform === "darwin" && Buffer.byteLength(input.socketPath) > 103) {
    throw new Error("Harness broker Unix socket path is too long for macOS");
  }
  await privateDirectory(path.dirname(input.descriptorPath));
  await assertNoLiveDescriptor(input.descriptorPath);
  if (process.platform !== "win32") await prepareUnixSocketPath(input.socketPath);

  const generation = input.generation ?? randomUUID();
  const token = input.token ?? randomBytes(32).toString("hex");
  const descriptor: HarnessBrokerDescriptorV1 = {
    schemaVersion: 1,
    protocolVersion: HARNESS_BROKER_PROTOCOL_VERSION,
    harnessId: "claude-code",
    generation,
    ownerPid: process.pid,
    socketPath: input.socketPath,
    token,
  };
  const sessions = new Map<string, ServerSession>();
  const nativeWriters = new Map<string, string>();
  let provisionalNativeWriter: string | undefined;
  const connections = new Set<ConnectionState>();
  let closed = false;

  const server: Server = net.createServer((socket) => {
    const state: ConnectionState = {
      id: randomUUID(),
      socket,
      authenticated: false,
      inputSequence: 0,
      outputSequence: 0,
      sessions: new Set(),
      queue: Promise.resolve(),
      queuedFrames: 0,
      closed: false,
    };
    connections.add(state);

    const send = async (frame: object): Promise<void> => {
      state.outputSequence += 1;
      await writeBrokerFrame(socket, {
        version: HARNESS_BROKER_PROTOCOL_VERSION,
        generation,
        sequence: state.outputSequence,
        ...frame,
      });
    };
    const respond = async (
      request: HarnessBrokerRequest,
      result: { ok: true; value: unknown } | { ok: false; error: ReturnType<typeof protocolError> },
    ): Promise<void> => {
      await send({ kind: "response", id: request.id, ...result });
    };

    const releaseProvisionalWriter = (record: ServerSession): void => {
      if (record.provisionalWriterLease && provisionalNativeWriter === record.id) {
        provisionalNativeWriter = undefined;
      }
      record.provisionalWriterLease = false;
      record.awaitingNativeIdentity = false;
    };

    const forwardOutputs = async (
      record: ServerSession,
      nativeSession: HarnessSession,
      sessionGeneration: number,
      forwarderEpoch: number,
    ): Promise<void> => {
      const isCurrent = (): boolean =>
        sessions.get(record.id) === record &&
        record.session === nativeSession &&
        record.generation === sessionGeneration &&
        record.forwarderEpoch === forwarderEpoch;
      try {
        for await (const output of nativeSession.outputs) {
          if (!isCurrent()) break;
          if (output.kind === "event" && output.event.type === "session.state.changed") {
            const state = output.event.state;
            const observedNativeId = state.nativeRef?.nativeSessionId;
            if (
              state.nativeRef &&
              record.nativeRef &&
              (record.nativeRef.harnessId !== state.nativeRef.harnessId ||
                record.nativeRef.nativeSessionId !== state.nativeRef.nativeSessionId ||
                record.nativeRef.formatVersion !== state.nativeRef.formatVersion)
            ) {
              record.faulted = true;
              await send({
                kind: "output",
                sessionId: record.id,
                sessionGeneration,
                output: {
                  kind: "event",
                  event: {
                    type: "session.faulted",
                    error: {
                      code: "protocolError",
                      message: "Native Claude Session identity changed after open",
                      retryable: false,
                      stage: "harnessBroker.identity",
                    },
                  },
                },
              });
              await nativeSession.close().catch(() => undefined);
              break;
            }
            if (observedNativeId && !record.writerKey) {
              const writerKey = nativeWriterKey(observedNativeId);
              const owner = nativeWriters.get(writerKey);
              if (owner && owner !== record.id) {
                record.faulted = true;
                releaseProvisionalWriter(record);
                await send({
                  kind: "output",
                  sessionId: record.id,
                  sessionGeneration,
                  output: {
                    kind: "event",
                    event: {
                      type: "session.faulted",
                      error: {
                        code: "sessionBusy",
                        message: "Native Claude Session already has an active writer",
                        retryable: true,
                        stage: "harnessBroker.identity",
                      },
                    },
                  },
                });
                await nativeSession.close().catch(() => undefined);
                break;
              }
              nativeWriters.set(writerKey, record.id);
              record.nativeId = observedNativeId;
              record.nativeRef = state.nativeRef;
              record.writerKey = writerKey;
              releaseProvisionalWriter(record);
            }
            if (state.effectiveModel) record.selection.model = state.effectiveModel;
            if (state.effectiveThinkingOptionId) {
              record.selection.thinkingOptionId = state.effectiveThinkingOptionId;
            }
            if (state.effectivePermissionModeId) {
              record.selection.permissionModeId = state.effectivePermissionModeId;
            }
          }
          const authenticationTerminal = isAuthenticationTerminal(output);
          if (output.kind === "event" && output.event.type === "session.faulted") {
            record.faulted = true;
            releaseProvisionalWriter(record);
          }
          if (authenticationTerminal) {
            record.faulted = true;
            releaseProvisionalWriter(record);
          }
          await send({
            kind: "output",
            sessionId: record.id,
            sessionGeneration,
            output,
          });
          if (authenticationTerminal) {
            await nativeSession.close().catch(() => undefined);
            break;
          }
        }
      } catch {
        if (isCurrent()) {
          record.faulted = true;
          releaseProvisionalWriter(record);
        }
      }
    };

    const closeRecord = async (record: ServerSession): Promise<void> => {
      if (sessions.get(record.id) !== record) return;
      sessions.delete(record.id);
      state.sessions.delete(record.id);
      record.forwarderEpoch += 1;
      const nativeSession = record.session;
      const outputTask = record.outputTask;
      await nativeSession.close().catch(() => undefined);
      await outputTask.catch(() => undefined);
      if (record.writerKey && nativeWriters.get(record.writerKey) === record.id) {
        nativeWriters.delete(record.writerKey);
      }
      releaseProvisionalWriter(record);
    };

    const requireSession = (params: unknown): ServerSession => {
      const candidate = params as { sessionId?: unknown; sessionGeneration?: unknown };
      const parsed = sessionParamsSchema.parse({
        sessionId: candidate.sessionId,
        sessionGeneration: candidate.sessionGeneration,
      });
      const record = sessions.get(parsed.sessionId);
      if (!record || record.owner !== state.id)
        throw new Error("Harness broker Session is unavailable");
      if (record.generation !== parsed.sessionGeneration) {
        throw new Error("Harness broker Session generation is stale");
      }
      return record;
    };

    const handleRequest = async (request: HarnessBrokerRequest): Promise<unknown> => {
      if (closed || state.closed) throw new Error("Harness broker connection is closed");
      if (request.method === "adapter.inspect") {
        const parsed = brokerInspectInputSchema.parse(request.params);
        return input.adapter.inspect({
          ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
          ...(parsed.refresh !== undefined ? { refresh: parsed.refresh } : {}),
        });
      }
      if (request.method === "adapter.subagent.readSnapshot") {
        const subagents = input.adapter.subagents;
        if (!subagents)
          return { ok: false, error: harnessError("Claude subagents are unavailable", false) };
        return subagents.readSnapshot(subagentReadSnapshotSchema.parse(request.params));
      }
      if (request.method === "adapter.open") {
        const openInput = brokerOpenInputSchema.parse(request.params) as OpenSessionInput;
        const sourceRef =
          openInput.kind === "create"
            ? undefined
            : openInput.kind === "resume"
              ? openInput.nativeRef
              : openInput.sourceRef;
        const sourceNativeId = sourceRef?.nativeSessionId;
        const sourceKey = sourceNativeId ? nativeWriterKey(sourceNativeId) : undefined;
        if (sourceKey && nativeWriters.has(sourceKey)) {
          return {
            ok: false,
            error: {
              code: "sessionBusy",
              message: "Native Claude Session already has an active writer",
              retryable: true,
              stage: "harnessBroker.open",
            },
          };
        }
        if (provisionalNativeWriter) {
          return {
            ok: false,
            error: {
              code: "sessionBusy",
              message: "Native Claude Session identity claim is already pending",
              retryable: true,
              stage: "harnessBroker.open",
            },
          };
        }
        const openReservation = randomUUID();
        if (sourceKey) nativeWriters.set(sourceKey, openReservation);
        const provisionalReservation = openInput.kind === "create" ? openReservation : undefined;
        if (provisionalReservation) provisionalNativeWriter = provisionalReservation;
        const releaseOpenReservations = (): void => {
          if (sourceKey && nativeWriters.get(sourceKey) === openReservation) {
            nativeWriters.delete(sourceKey);
          }
          if (provisionalReservation && provisionalNativeWriter === provisionalReservation) {
            provisionalNativeWriter = undefined;
          }
        };
        const opened = await input.adapter.open(openInput).catch((error: unknown) => {
          releaseOpenReservations();
          throw error;
        });
        if (!opened.ok) {
          releaseOpenReservations();
          return opened;
        }
        if (closed || state.closed) {
          releaseOpenReservations();
          await opened.value.close().catch(() => undefined);
          return { ok: false, error: harnessError("Harness broker connection closed") };
        }
        const openedRef = opened.value.initialState.nativeRef;
        if (
          sourceRef &&
          (!openedRef ||
            openedRef.harnessId !== sourceRef.harnessId ||
            openedRef.formatVersion !== sourceRef.formatVersion ||
            (openInput.kind === "resume" &&
              openedRef.nativeSessionId !== sourceRef.nativeSessionId))
        ) {
          releaseOpenReservations();
          await opened.value.close().catch(() => undefined);
          return {
            ok: false,
            error: {
              code: "protocolError",
              message: "Native Claude Session identity did not match the requested open",
              retryable: false,
              stage: "harnessBroker.open",
            },
          };
        }
        const nativeId = openedRef?.nativeSessionId;
        const nativeKey = nativeId ? nativeWriterKey(nativeId) : undefined;
        const nativeOwner = nativeKey ? nativeWriters.get(nativeKey) : undefined;
        if (nativeOwner && nativeOwner !== openReservation) {
          releaseOpenReservations();
          await opened.value.close().catch(() => undefined);
          return {
            ok: false,
            error: {
              code: "sessionBusy",
              message: "Native Claude Session already has an active writer",
              retryable: true,
              stage: "harnessBroker.open",
            },
          };
        }
        const delayedCreateIdentity = openInput.kind === "create" && !nativeKey;
        const record: ServerSession = {
          id: openReservation,
          generation: 1,
          owner: state.id,
          cwd: openInput.cwd,
          executionPolicy: openInput.executionPolicy ?? "default",
          ...(nativeId ? { nativeId } : {}),
          ...(opened.value.initialState.nativeRef
            ? { nativeRef: opened.value.initialState.nativeRef }
            : {}),
          ...(nativeKey ? { writerKey: nativeKey } : {}),
          awaitingNativeIdentity: delayedCreateIdentity,
          provisionalWriterLease: delayedCreateIdentity,
          session: opened.value,
          outputTask: Promise.resolve(),
          forwarderEpoch: 1,
          faulted: false,
          selection: {
            ...(opened.value.initialState.effectiveModel
              ? { model: opened.value.initialState.effectiveModel }
              : {}),
            ...(opened.value.initialState.effectiveThinkingOptionId
              ? { thinkingOptionId: opened.value.initialState.effectiveThinkingOptionId }
              : {}),
            ...(opened.value.initialState.effectivePermissionModeId
              ? { permissionModeId: opened.value.initialState.effectivePermissionModeId }
              : {}),
          },
        };
        sessions.set(record.id, record);
        state.sessions.add(record.id);
        if (nativeKey) nativeWriters.set(nativeKey, record.id);
        if (sourceKey && sourceKey !== nativeKey && nativeWriters.get(sourceKey) === record.id) {
          nativeWriters.delete(sourceKey);
        }
        if (!record.provisionalWriterLease && provisionalNativeWriter === provisionalReservation) {
          provisionalNativeWriter = undefined;
        }
        record.outputTask = forwardOutputs(
          record,
          opened.value,
          record.generation,
          record.forwarderEpoch,
        );
        return { ok: true, value: sessionMetadata(record) };
      }
      if (request.method === "session.execute") {
        const parsed = sessionExecuteParamsSchema.parse(request.params);
        const record = requireSession(parsed);
        const command = brokerHostCommandSchema.parse(parsed.command);
        if (record.awaitingNativeIdentity && !record.writerKey) {
          const isBootstrapTurn =
            command.type === "turn.start" &&
            record.provisionalWriterLease &&
            record.bootstrapTurnId === undefined;
          const isBootstrapTurnContinuation =
            record.bootstrapTurnId !== undefined &&
            ((command.type === "turn.cancel" && command.turnId === record.bootstrapTurnId) ||
              command.type === "interaction.respond");
          if (!isBootstrapTurn && !isBootstrapTurnContinuation) {
            return {
              ok: false,
              error: {
                code: "sessionBusy",
                message: "Native Claude Session identity has not been claimed yet",
                retryable: true,
                stage: "harnessBroker.identity",
              },
            };
          }
          if (command.type === "turn.start") record.bootstrapTurnId = command.turnId;
        }
        let result;
        if (command.type === "turn.start") result = await record.session.execute(command);
        else if (command.type === "turn.cancel") result = await record.session.execute(command);
        else if (command.type === "interaction.respond") {
          result = await record.session.execute({
            type: command.type,
            interactionId: command.interactionId,
            response:
              command.response.type === "question"
                ? {
                    type: "question",
                    answers: command.response.answers,
                    ...(command.response.cancelled !== undefined
                      ? { cancelled: command.response.cancelled }
                      : {}),
                  }
                : command.response,
          });
        } else if (command.type === "model.select") result = await record.session.execute(command);
        else if (command.type === "thinking.select") result = await record.session.execute(command);
        else result = await record.session.execute(command);
        if (
          !result.ok &&
          command.type === "turn.start" &&
          record.awaitingNativeIdentity &&
          record.bootstrapTurnId === command.turnId
        ) {
          delete record.bootstrapTurnId;
        }
        if (result.ok) {
          if (command.type === "model.select") record.selection.model = command.model;
          if (command.type === "thinking.select")
            record.selection.thinkingOptionId = command.thinkingOptionId;
          if (command.type === "permissionMode.select")
            record.selection.permissionModeId = command.permissionModeId;
        }
        return result;
      }
      if (request.method === "session.readSnapshot") {
        return requireSession(request.params).session.readSnapshot();
      }
      if (request.method === "session.refreshUsage") {
        const record = requireSession(request.params);
        const refreshUsage = (
          record.session as HarnessSession & { refreshUsage?: () => Promise<void> }
        ).refreshUsage;
        if (refreshUsage) await refreshUsage.call(record.session);
        return null;
      }
      if (request.method === "session.commands.list") {
        const commands = requireSession(request.params).session.commands;
        return commands
          ? commands.list()
          : { ok: false, error: harnessError("Commands unavailable", false) };
      }
      if (request.method === "session.commands.execute") {
        const parsed = sessionCommandExecuteParamsSchema.parse(request.params);
        const commands = requireSession(parsed).session.commands;
        const command = brokerCommandInvocationSchema.parse(parsed.command);
        return commands
          ? commands.execute({
              turnId: command.turnId,
              commandId: command.commandId,
              ...(command.arguments ? { arguments: command.arguments } : {}),
            })
          : { ok: false, error: harnessError("Commands unavailable", false) };
      }
      if (request.method === "session.reopen") {
        const record = requireSession(request.params);
        if (!record.faulted) {
          return { ok: true, value: sessionMetadata(record) };
        }
        if (!record.nativeRef) {
          return {
            ok: false,
            error: {
              code: "sessionBusy",
              message: "Faulted Claude Session has no authoritative native identity",
              retryable: false,
              stage: "harnessBroker.reopen",
            },
          };
        }
        const nativeRef = record.nativeRef;
        const oldSession = record.session;
        const oldOutputTask = record.outputTask;
        record.forwarderEpoch += 1;
        await oldSession.close().catch(() => undefined);
        await oldOutputTask.catch(() => undefined);
        const reopened = await input.adapter.open({
          kind: "resume",
          cwd: record.cwd,
          nativeRef,
          executionPolicy: record.executionPolicy,
        });
        if (!reopened.ok) return reopened;
        const reopenedRef = reopened.value.initialState.nativeRef;
        if (
          !reopenedRef ||
          reopenedRef.harnessId !== nativeRef.harnessId ||
          reopenedRef.nativeSessionId !== nativeRef.nativeSessionId ||
          reopenedRef.formatVersion !== nativeRef.formatVersion
        ) {
          await reopened.value.close().catch(() => undefined);
          return {
            ok: false,
            error: {
              code: "protocolError",
              message: "Claude Aqua broker reopen changed the native Session identity",
              retryable: false,
              stage: "harnessBroker.reopen",
            },
          };
        }
        if (record.selection.model && reopened.value.capabilities.configuration.selectModel) {
          const selected = await reopened.value.execute({
            type: "model.select",
            model: record.selection.model,
          });
          if (!selected.ok) {
            await reopened.value.close().catch(() => undefined);
            return selected;
          }
        }
        if (
          record.selection.thinkingOptionId &&
          reopened.value.capabilities.configuration.selectThinkingOption
        ) {
          const selected = await reopened.value.execute({
            type: "thinking.select",
            thinkingOptionId: record.selection.thinkingOptionId,
          });
          if (!selected.ok) {
            await reopened.value.close().catch(() => undefined);
            return selected;
          }
        }
        if (
          record.selection.permissionModeId &&
          record.executionPolicy === "default" &&
          reopened.value.capabilities.configuration.selectPermissionMode
        ) {
          const selected = await reopened.value.execute({
            type: "permissionMode.select",
            permissionModeId: record.selection.permissionModeId,
          });
          if (!selected.ok) {
            await reopened.value.close().catch(() => undefined);
            return selected;
          }
        }
        record.session = reopened.value;
        record.generation += 1;
        record.faulted = false;
        record.outputTask = forwardOutputs(
          record,
          reopened.value,
          record.generation,
          record.forwarderEpoch,
        );
        return { ok: true, value: sessionMetadata(record) };
      }
      const record = requireSession(request.params);
      await closeRecord(record);
      return null;
    };

    consumeBrokerFrames(
      socket,
      (raw) => {
        state.queuedFrames += 1;
        if (state.queuedFrames > HARNESS_BROKER_MAX_PENDING_REQUESTS) {
          state.closed = true;
          socket.destroy();
          return;
        }
        state.queue = state.queue
          .then(async () => {
            if (state.closed) return;
            if (!state.authenticated) {
              const hello = harnessBrokerHelloSchema.safeParse(raw);
              if (
                !hello.success ||
                hello.data.generation !== generation ||
                hello.data.token !== token
              ) {
                socket.destroy();
                return;
              }
              state.authenticated = true;
              state.inputSequence = 1;
              await send({ kind: "response", id: randomUUID(), ok: true, value: { ready: true } });
              return;
            }
            const parsed = harnessBrokerRequestSchema.safeParse(raw);
            if (
              !parsed.success ||
              parsed.data.generation !== generation ||
              parsed.data.sequence !== state.inputSequence + 1
            ) {
              socket.destroy();
              return;
            }
            state.inputSequence = parsed.data.sequence;
            try {
              await respond(parsed.data, { ok: true, value: await handleRequest(parsed.data) });
            } catch (error) {
              await respond(parsed.data, {
                ok: false,
                error: protocolError(error instanceof Error ? error.message : String(error)),
              });
            } finally {
              // One authenticated connection intentionally serializes requests. This bounds
              // native Harness concurrency at one while the client bounds queued requests.
            }
          })
          .finally(() => {
            state.queuedFrames -= 1;
          })
          .catch(() => {
            socket.destroy();
          });
      },
      () => socket.destroy(),
    );

    socket.once("close", () => {
      state.closed = true;
      connections.delete(state);
      for (const sessionId of [...state.sessions]) {
        const record = sessions.get(sessionId);
        if (record) void closeRecord(record);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    if (process.platform !== "win32") await chmod(input.socketPath, 0o600);
    await publishDescriptor(input.descriptorPath, descriptor);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") await rm(input.socketPath, { force: true });
    throw error;
  }

  return {
    descriptor,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const connection of connections) connection.socket.destroy();
      for (const record of sessions.values()) record.forwarderEpoch += 1;
      await Promise.all(
        [...sessions.values()].map((record) => record.session.close().catch(() => undefined)),
      );
      await Promise.all(
        [...sessions.values()].map((record) => record.outputTask.catch(() => undefined)),
      );
      await input.adapter.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(input.socketPath, { force: true });
      await rm(input.descriptorPath, { force: true });
    },
  };
}
