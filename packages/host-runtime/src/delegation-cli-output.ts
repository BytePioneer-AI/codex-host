import type { DelegationCliCommand } from "./delegation-cli-help.js";
import {
  type DelegationStartResult,
  type DelegationThreadListResult,
  type DelegationThreadSnapshot,
  type HarnessInspectResult,
  type ThreadCancelResult,
  type ThreadSendResult,
  type ThreadWatchListResult,
  type ThreadWatchResult,
} from "./delegation-types.js";
import { originClientName } from "./external-client-origin.js";

/** A Thread as a link; a client origin is no Thread, so it is shown as is. */
function targetLink(identifier: string): string {
  return originClientName(identifier) !== undefined ? identifier : threadLink(identifier);
}

export type DelegationCliFormat = "json" | "compact" | "text";

function threadLink(threadId: string): string {
  return `codex://threads/${threadId}`;
}

function watchOutput(watch: DelegationStartResult["watch"]): { watch?: unknown } {
  if (!watch) return {};
  return {
    watch:
      watch.state === "notRegistered"
        ? watch
        : {
            state: watch.state,
            notify: targetLink(watch.notifyThreadId),
            timeoutMs: watch.timeoutMs,
          },
  };
}

function inspectOutput({ harnessId, inspection }: HarnessInspectResult): unknown {
  if (inspection.status !== "ready") return { harnessId, ...inspection };
  const { catalog } = inspection;
  return {
    harnessId,
    status: inspection.status,
    models: catalog.models.map(({ ref, label, nativeId, supportedThinkingOptionIds }) => ({
      id: ref.id,
      ...(nativeId ? { nativeId } : {}),
      label,
      ...(supportedThinkingOptionIds ? { thinking: supportedThinkingOptionIds } : {}),
    })),
    ...(catalog.defaultModel ? { defaultModel: catalog.defaultModel.id } : {}),
    thinkingOptions: catalog.thinkingOptions,
    ...(catalog.defaultThinkingOptionId
      ? { defaultThinkingOptionId: catalog.defaultThinkingOptionId }
      : {}),
    capabilities: inspection.capabilities,
  };
}

function snapshotOutput(
  snapshot: DelegationThreadSnapshot & { timedOut?: boolean },
  view: "result" | "messages",
): unknown {
  const common = {
    thread: snapshot.hostId
      ? `thread://${snapshot.threadId}?hostId=${encodeURIComponent(snapshot.hostId)}`
      : threadLink(snapshot.threadId),
    harnessId: snapshot.harnessId,
    status: snapshot.status,
    ...(snapshot.timedOut !== undefined ? { timedOut: snapshot.timedOut } : {}),
  };
  if (view === "messages") {
    return {
      ...common,
      totalTurns: snapshot.totalTurns,
      from: snapshot.from,
      to: snapshot.to,
      turns: (snapshot.turns ?? []).map(({ turnNumber, status, messages }) => ({
        turnNumber,
        status,
        messages: messages.map(({ role, phase, text }) => ({
          role,
          ...(phase ? { phase } : {}),
          text,
        })),
      })),
      ...(snapshot.result.message ? { error: snapshot.result.message } : {}),
    };
  }
  const progress = snapshot.progress.filter(({ text }) => text.trim()).at(-1)?.text;
  return {
    ...common,
    result: snapshot.result,
    ...(snapshot.status === "running" && progress ? { progress } : {}),
  };
}

// JSON bodies cross the CLI HTTP boundary as unknown; these projections use the
// owning Runtime contracts and leave the compatible full JSON response untouched.
export function compactDelegationOutput(
  command: DelegationCliCommand,
  body: unknown,
  view: "result" | "messages" = "result",
): unknown {
  switch (command) {
    case "host info":
    case "project list":
    case "thread file":
    case "thread export":
    case "harness list":
      return body;
    case "harness inspect":
      return inspectOutput(body as HarnessInspectResult);
    case "delegate start": {
      const result = body as DelegationStartResult;
      const effective = result.configuration?.effective;
      return {
        thread: result.deepLink,
        harnessId: result.harnessId,
        status: result.status,
        ...(result.cwd ? { cwd: result.cwd } : {}),
        ...(result.worktree ? { worktree: result.worktree } : {}),
        ...(result.parentThreadId
          ? {
              parent: targetLink(result.parentThreadId),
            }
          : {}),
        ...(effective?.resolvedModelLabel ? { model: effective.resolvedModelLabel } : {}),
        ...(effective?.effectiveThinkingOptionId
          ? { thinking: effective.effectiveThinkingOptionId }
          : {}),
        ...watchOutput(result.watch),
      };
    }
    case "thread send": {
      const result = body as ThreadSendResult;
      return {
        thread: threadLink(result.threadId),
        harnessId: result.harnessId,
        status: result.status,
        ...watchOutput(result.watch),
      };
    }
    case "thread cancel": {
      const result = body as ThreadCancelResult;
      return {
        thread: threadLink(result.threadId),
        harnessId: result.harnessId,
        cancelRequested: result.cancelled,
      };
    }
    case "thread read":
    case "thread wait":
      return snapshotOutput(body as DelegationThreadSnapshot, view);
    case "thread watch": {
      const result = body as ThreadWatchResult;
      return {
        thread: threadLink(result.threadId),
        notify: targetLink(result.notifyThreadId),
        state: result.state,
        status: result.status,
        timeoutMs: result.timeoutMs,
      };
    }
    case "thread watches": {
      const result = body as ThreadWatchListResult;
      return {
        watches: result.watches.map(
          ({
            threadId,
            notifyThreadId,
            state,
            outcome,
            reason,
            taskName,
            threadStatus,
            watchedForMs,
          }) => ({
            thread: threadLink(threadId),
            notify: targetLink(notifyThreadId),
            state,
            ...(outcome ? { outcome } : {}),
            ...(reason ? { reason } : {}),
            ...(taskName ? { taskName } : {}),
            ...(threadStatus ? { threadStatus } : {}),
            ...(watchedForMs !== undefined ? { watchedForMs } : {}),
          }),
        ),
      };
    }
    case "thread list": {
      const result = body as DelegationThreadListResult;
      return {
        threads: result.threads.map(({ deepLink, harnessId, status, title, cwd }) => ({
          thread: deepLink,
          harnessId,
          status,
          ...(title ? { title } : {}),
          ...(cwd ? { cwd } : {}),
        })),
        nextCursor: result.nextCursor,
      };
    }
  }
}
