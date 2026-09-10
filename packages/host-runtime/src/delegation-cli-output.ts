import type { DelegationCliCommand } from "./delegation-cli-help.js";
import {
  DelegationControlError,
  type DelegationStartResult,
  type DelegationThreadListResult,
  type DelegationThreadSnapshot,
  type HarnessInspectResult,
  type ThreadCancelResult,
  type ThreadSendResult,
} from "./delegation-types.js";

export type DelegationCliFormat = "json" | "compact";

function threadLink(threadId: string): string {
  return `codex://threads/${threadId}`;
}

function inspectOutput({ harnessId, inspection }: HarnessInspectResult): unknown {
  if (inspection.status !== "ready") return { harnessId, ...inspection };
  const { catalog } = inspection;
  return {
    harnessId,
    status: inspection.status,
    models: catalog.models.map(({ ref, label, supportedThinkingOptionIds }) => ({
      id: ref.id,
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
    thread: threadLink(snapshot.threadId),
    harnessId: snapshot.harnessId,
    status: snapshot.status,
    ...(snapshot.timedOut !== undefined ? { timedOut: snapshot.timedOut } : {}),
  };
  if (view === "messages") {
    if (typeof snapshot.hasMore !== "boolean") {
      throw new DelegationControlError(
        "INTERNAL_ERROR",
        "Compact message pagination requires an updated Host Runtime; use --format json with this Runtime.",
      );
    }
    return {
      ...common,
      messages: (snapshot.messages ?? []).map(({ role, phase, text }) => ({
        role,
        ...(phase ? { phase } : {}),
        text,
      })),
      hasMore: snapshot.hasMore,
      nextCursor: snapshot.nextCursor,
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
        ...(result.parentThreadId ? { parent: threadLink(result.parentThreadId) } : {}),
        ...(effective?.resolvedModelLabel ? { model: effective.resolvedModelLabel } : {}),
        ...(effective?.effectiveThinkingOptionId
          ? { thinking: effective.effectiveThinkingOptionId }
          : {}),
      };
    }
    case "thread send": {
      const result = body as ThreadSendResult;
      return {
        thread: threadLink(result.threadId),
        harnessId: result.harnessId,
        status: result.status,
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
