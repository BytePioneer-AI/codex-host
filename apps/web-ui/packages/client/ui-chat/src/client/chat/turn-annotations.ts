/**
 * Annotations carried by the user message that opened a Turn, read from the
 * loaded Chat Nodes: a reply resolves its `:codex-annotation{index="N"}`
 * citations against the message it answers. Only annotated messages
 * contribute — every other Turn answers with one shared empty list, so its
 * seats never re-render for this.
 */
import { useMemo, useSyncExternalStore } from "react";
import type { ResponseAnnotation } from "@codexhost/shared-contracts";
import type { ObservableSnapshot } from "@deepseek-ai/dsh-client-store";
import type { ChatNodeStore } from "../contract/snapshot.ts";

/** Structural slice of a message node's payload this module reads. */
interface AnnotatedNode {
  readonly data?: { readonly responseAnnotations?: readonly ResponseAnnotation[] };
}

const NOTHING: readonly ResponseAnnotation[] = [];

const EMPTY_SOURCE: ObservableSnapshot<readonly ResponseAnnotation[]> = {
  getSnapshot: () => NOTHING,
  subscribe: () => () => {},
};

/** Subscribe to a Turn's annotated messages, with an identity stable until their content is. */
function sourceOf(
  users: ObservableSnapshot<readonly AnnotatedNode[]>,
  steerings: ObservableSnapshot<readonly AnnotatedNode[]>,
): ObservableSnapshot<readonly ResponseAnnotation[]> {
  let cached: readonly ResponseAnnotation[] = NOTHING;
  return {
    getSnapshot: () => {
      const next = [...users.getSnapshot(), ...steerings.getSnapshot()].flatMap(
        (node) => node.data?.responseAnnotations ?? [],
      );
      if (next.length === cached.length && next.every((entry, at) => entry === cached[at]))
        return cached;
      cached = next.length === 0 ? NOTHING : next;
      return cached;
    },
    subscribe: (listener) => {
      const off = [users.subscribe(listener), steerings.subscribe(listener)];
      return () => {
        for (const dispose of off) dispose();
      };
    },
  };
}

/**
 * Read one Turn's annotations.
 * @param nodeStore - the Chat target's node store.
 * @param turn - the Turn a reply belongs to, or undefined outside a Turn.
 * @returns annotations in attachment order, or a shared empty list.
 */
export function useTurnAnnotations(
  nodeStore: ChatNodeStore,
  turn: number | undefined,
): readonly ResponseAnnotation[] {
  const source = useMemo(
    () =>
      turn === undefined
        ? EMPTY_SOURCE
        : sourceOf(
            nodeStore.turnDataSource(turn, "user") as ObservableSnapshot<readonly AnnotatedNode[]>,
            nodeStore.turnDataSource(turn, "steering") as ObservableSnapshot<
              readonly AnnotatedNode[]
            >,
          ),
    [nodeStore, turn],
  );
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}
