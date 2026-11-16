import { createHash } from "node:crypto";

import type { HostTextInput } from "@codexhost/harness-adapter";
import type { InjectedTurnPrefix, StoredThreadRecordV1 } from "@codexhost/mapping-store";
import {
  decodeThreadInjectItemsRequest,
  type ExternalThreadRpcError,
  type JsonObject,
  type JsonRpcRequest,
} from "@codexhost/protocol-core";
import type { HostTurnId } from "@codexhost/shared-contracts";

import { errorMessage } from "./desktop-rpc.js";
import type { ExternalThreadRepository } from "./external-thread-repository.js";
import type { ExternalThread, ExternalThreadRuntime } from "./external-thread-runtime.js";

/**
 * Holds `thread/inject_items` text, such as Desktop's Side Chat boundary, for the next Turn.
 * External Harnesses have no item-history API, so the text leads that Turn's native input.
 */
export async function holdInjectedItems(input: {
  request: JsonRpcRequest;
  record: StoredThreadRecordV1;
  repository: ExternalThreadRepository;
  runtime: ExternalThreadRuntime;
}): Promise<ExternalThreadRpcError | null> {
  if (input.record.subagent) {
    return {
      code: -32076,
      message: "External Subagent Thread does not support thread/inject_items",
    };
  }
  let texts: string[];
  try {
    texts = decodeThreadInjectItemsRequest(input.request)?.texts ?? [];
  } catch (error) {
    return { code: -32602, message: errorMessage(error) };
  }
  try {
    const record = await input.repository.appendPendingInjectedText(
      input.record.hostThreadId,
      texts,
    );
    const live = input.runtime.get(record.hostThreadId);
    if (live) live.record = record;
    return null;
  } catch (error) {
    return { code: -32081, message: `Injected items could not be saved: ${errorMessage(error)}` };
  }
}

export interface InjectedTurnText {
  text: string;
  consumed: number;
  prefix?: Omit<InjectedTurnPrefix, "hostTurnId">;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Native Turn text that leads with held injected text, and how to recognize it on replay. */
export function withInjectedText(
  pending: readonly string[] | undefined,
  text: string,
): InjectedTurnText {
  if (!pending?.length) return { text, consumed: 0 };
  const prefix = `${pending.join("\n\n")}\n\n`;
  return {
    text: `${prefix}${text}`,
    consumed: pending.length,
    prefix: { length: prefix.length, sha256: sha256(prefix) },
  };
}

/** Once the Harness accepted the Turn, release the held text it carried. */
export async function releaseInjectedText(input: {
  thread: ExternalThread;
  turnId: HostTurnId;
  injected: InjectedTurnText;
  repository: ExternalThreadRepository;
}): Promise<void> {
  if (!input.injected.prefix) return;
  input.thread.record = await input.repository.consumePendingInjectedText(
    input.thread.id,
    input.injected.consumed,
    { hostTurnId: input.turnId, ...input.injected.prefix },
  );
}

/** A replayed Turn shows the user's own message: drop the delivered prefix it starts with. */
export function withoutInjectedText(
  input: HostTextInput[],
  prefix: InjectedTurnPrefix | undefined,
): HostTextInput[] {
  const first = input[0];
  if (!prefix || !first || first.text.length < prefix.length) return input;
  if (sha256(first.text.slice(0, prefix.length)) !== prefix.sha256) return input;
  return [{ ...first, text: first.text.slice(prefix.length) }, ...input.slice(1)];
}

/**
 * Like native Codex, an attached Side Chat lists only its own Turns; the history it inherited
 * from its source stays in the Native Session as context.
 */
export function ownTurns(record: StoredThreadRecordV1, turns: JsonObject[]): JsonObject[] {
  const count = record.attachedToThreadId ? (record.inheritedTurnCount ?? 0) : 0;
  if (count === 0) return turns;
  const inherited = new Set<string>(
    record.turnMappings.slice(0, count).map(({ hostTurnId }) => hostTurnId),
  );
  return turns.filter((turn) => !inherited.has(String(turn.id)));
}
