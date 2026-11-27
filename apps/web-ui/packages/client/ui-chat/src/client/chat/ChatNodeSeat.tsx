import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CodeBlockFoldMemoryProvider,
  JsonBlock,
  useCodeBlockFoldMemory,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {
  ConversationLocationDataStore,
  ConversationTurnDataMap,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {
  ChatNodeHookContext,
  ChatNodeOwnerProps,
  ChatViewSlotProps,
  UsePresentation,
} from "../contract/slots.ts";
import type { ChatNode } from "../contract/chat-nodes.ts";
import type { ChatNodeStore } from "../contract/snapshot.ts";
import {
  TURN_PROCESS_INDEPENDENT_KINDS,
  isIndependentProcessTool,
  turnProcessAlwaysOpen,
} from "../contract/turn-process.ts";
import { storedTurnProcessEntry } from "../stores.ts";
import { useNearViewport } from "./near-viewport.ts";
import { useSearchableHidden } from "./searchable-hidden.ts";
import { useTurnAnnotations } from "./turn-annotations.ts";
import css from "./ChatView.module.css";

interface ChatNodeSeatProps extends Omit<ChatNodeOwnerProps, "responseAnnotations"> {
  readonly nodeKey: string;
  /** A replaced Builder must rebind keyed hooks even when references and keys survive. */
  readonly nodeStore: ChatNodeStore;
  readonly useChatNode: ChatViewSlotProps["useChatNode"];
  readonly useChatNodeProcess: ChatViewSlotProps["useChatNodeProcess"];
  readonly usePresentation: UsePresentation;
  readonly useStore: ChatViewSlotProps["useStore"];
  readonly actions: ChatViewSlotProps["actions"];
  readonly renderSlot: ChatViewSlotProps["renderSlot"];
  readonly t: ChatViewSlotProps["t"];
  /** Whether this row's slot content should be mounted. Nested group members stay mounted. */
  readonly mounted?: boolean;
  /** Reserved height (px) while unmounted; ignored for hidden or zero-height seats. */
  readonly placeholderHeight?: number;
  /** Registers this top-level row shell with the transcript virtualizer. */
  readonly registerRow?: (flowKey: string, element: HTMLDivElement | null) => void;
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode["kind"]]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> };
}[ChatNode["kind"]];

function turnDataOf(
  node: ChatNode | undefined,
): ConversationLocationDataStore<ConversationTurnDataMap> | undefined {
  const location = node?.location;
  return location?.kind === "turn" || location?.kind === "step" ? location.turn.data : undefined;
}

function turnOf(node: ChatNode | undefined): number | undefined {
  const location = node?.location;
  return location?.kind === "turn" || location?.kind === "step" ? location.turn.turn : undefined;
}

/** File diffs and compaction stay visible; ordinary tools fold into work details. */
function isIndependentProcessToolNode(node: ChatNode | undefined): boolean {
  return node?.kind === "tool-call" && isIndependentProcessTool(node.data.root.name);
}

const CHAT_NODE_SLOT_NAME = "conversation.chat.node";

function seatSlotOf(wrapper: Element): Element | null {
  for (let child = wrapper.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.getAttribute("data-slot") === CHAT_NODE_SLOT_NAME) return child;
  }
  return null;
}

function isElementEmpty(element: Element): boolean {
  for (let node = element.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === Node.ELEMENT_NODE) return false;
    if (
      (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) &&
      (node.nodeValue?.length ?? 0) > 0
    ) {
      return false;
    }
  }
  return true;
}

function syncSeatEmptyAttribute(wrapper: HTMLElement, slot: Element | null): void {
  if (slot !== null && isElementEmpty(slot)) {
    wrapper.setAttribute("data-chat-empty", "");
  } else {
    wrapper.removeAttribute("data-chat-empty");
  }
}

/**
 * Subscribe, apply Turn-process visibility, and dispatch one stable Context key.
 * Policy reads select this seat's own conclusion, so a mode change re-renders
 * only seats whose visibility actually changes.
 */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey,
  groupPart,
  nodeStore,
  useChatNode,
  useChatNodeProcess,
  usePresentation,
  cwd,
  openFile,
  openSkill,
  inspectCall,
  forkAt,
  handoffAt,
  loadTurnDiffs,
  messageEditing,
  loadImage,
  renderMessageImages,
  fileMentions,
  useStore,
  actions,
  renderSlot,
  t,
  mounted = true,
  placeholderHeight,
  registerRow,
}: ChatNodeSeatProps) {
  const node = useChatNode(nodeKey);
  const routedNode = node as ChatNode | undefined;
  const turn = turnOf(routedNode);
  const processPresentation = useChatNodeProcess(nodeKey);
  const processSpec = processPresentation?.spec;
  const storedEntry = useStore((state) =>
    processSpec === undefined ? undefined : storedTurnProcessEntry(state, processSpec.turn),
  );
  const processEntry =
    processSpec !== undefined && storedEntry?.answerStep === (processSpec.answerStep ?? 0)
      ? storedEntry
      : undefined;
  const liveProcess = processPresentation !== undefined && !processPresentation.turnClosed;
  const interleavedInput = processPresentation?.hasInterleavedInput === true;
  const alwaysOpen = liveProcess || interleavedInput || turnProcessAlwaysOpen(routedNode);
  const processOpen = alwaysOpen || processEntry !== undefined;
  const setOpen = useCallback(
    (open: boolean) => {
      if (processSpec !== undefined && !alwaysOpen) {
        actions.setTurnProcessOpen(processSpec.turn, processSpec.answerStep ?? 0, open);
      }
    },
    [actions, processSpec, alwaysOpen],
  );
  const foldCompleted = usePresentation((policy) => policy.foldCompletedTurns);
  // A loaded end makes a partial historical Turn eligible without its start.
  const processWindowReady =
    processSpec !== undefined &&
    processPresentation !== undefined &&
    foldCompleted &&
    processPresentation.turn === processSpec.turn &&
    (processPresentation.turnStarted || processPresentation.turnClosed);
  const processAnswer =
    routedNode !== undefined &&
    processWindowReady &&
    !liveProcess &&
    groupPart !== "reasoning" &&
    routedNode.kind === "assistant-step" &&
    routedNode.data.step === processSpec.answerStep;
  // Live rows retain their first-token anchor, not their later settlement seq.
  const processMember =
    routedNode !== undefined &&
    processWindowReady &&
    !processAnswer &&
    !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind) &&
    !isIndependentProcessToolNode(routedNode) &&
    routedNode.anchorSeq >= processSpec.processStartSeq;
  const ownsDisclosure = routedNode?.kind === "turn-process" || processAnswer;
  const foldable = processWindowReady && (liveProcess || processMember || ownsDisclosure);
  const turnProcess = useMemo(
    () =>
      processSpec === undefined
        ? undefined
        : {
            spec: processSpec,
            foldable,
            hasContent:
              !interleavedInput &&
              (processPresentation?.hasExternalProcess === true || processSpec.inlineReasoning),
            open: processOpen,
            setOpen,
          },
    [
      foldable,
      interleavedInput,
      processOpen,
      processSpec,
      processPresentation?.hasExternalProcess,
      setOpen,
    ],
  );
  const controllerInactive = routedNode?.kind === "turn-process" && foldCompleted && !foldable;
  const compactAnswer =
    processAnswer && foldable && processPresentation.compactAnswer && !processOpen;
  const processHidden = controllerInactive || (foldable && processMember && !processOpen);
  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true);
  }, [processMember, setOpen]);
  const wrapperRef = useSearchableHidden(processHidden, revealProcess);
  useNearViewport(wrapperRef, node !== undefined);
  const flowKey =
    routedNode === undefined
      ? undefined
      : groupPart === undefined || groupPart === "response"
        ? routedNode.key
        : JSON.stringify([routedNode.key, groupPart]);
  const hasRow = routedNode !== undefined && flowKey !== undefined;
  // Reflect an empty direct `conversation.chat.node` slot onto the row shell so CSS
  // can collapse empty seats without `:has()` sibling selectors inside container queries.
  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (element === null) return;
    if (!mounted || !hasRow) {
      element.removeAttribute("data-chat-empty");
      return;
    }
    let observedSlot = seatSlotOf(element);
    syncSeatEmptyAttribute(element, observedSlot);
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      const nextSlot = seatSlotOf(element);
      if (nextSlot !== observedSlot) {
        observer.disconnect();
        observer.observe(element, { childList: true });
        if (nextSlot !== null) observer.observe(nextSlot, { childList: true });
        observedSlot = nextSlot;
      }
      syncSeatEmptyAttribute(element, nextSlot);
    });
    observer.observe(element, { childList: true });
    if (observedSlot !== null) observer.observe(observedSlot, { childList: true });
    return () => {
      observer.disconnect();
    };
  }, [mounted, hasRow, wrapperRef]);
  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (element === null || !mounted || !hasRow) return;
    syncSeatEmptyAttribute(element, seatSlotOf(element));
  });
  useLayoutEffect(() => {
    if (registerRow === undefined || flowKey === undefined) return;
    const element = wrapperRef.current;
    if (element === null) return;
    registerRow(flowKey, element);
    return () => {
      registerRow(flowKey, null);
    };
  }, [registerRow, flowKey, wrapperRef]);
  const [disclosureReset] = useState(() => createSnapshotStore(0));
  const inheritedFoldMemory = useCodeBlockFoldMemory();
  const ownFoldMemoryRef = useRef<Map<string, boolean> | null>(null);
  if (inheritedFoldMemory === undefined && ownFoldMemoryRef.current === null) {
    ownFoldMemoryRef.current = new Map();
  }
  const foldMemory = inheritedFoldMemory ?? ownFoldMemoryRef.current!;
  // A reply resolves its annotation citations against the message it answers.
  const responseAnnotations = useTurnAnnotations(nodeStore, turn);
  const turnData = turnDataOf(routedNode);
  const hookContext = useMemo<ChatNodeHookContext>(
    () => ({ turnData, disclosureReset }),
    [turnData, disclosureReset],
  );
  useEffect(() => {
    if (processMember && processHidden && wrapperRef.current?.hasAttribute("hidden")) {
      disclosureReset.set(disclosureReset.getSnapshot() + 1);
    }
  }, [processMember, processHidden, wrapperRef, disclosureReset]);
  const owner = useMemo<ChatNodeOwnerProps | null>(
    () =>
      node === undefined
        ? null
        : {
            ...(groupPart === undefined ? {} : { groupPart }),
            cwd,
            openFile,
            openSkill,
            inspectCall,
            forkAt,
            handoffAt,
            loadTurnDiffs,
            messageEditing,
            loadImage,
            renderMessageImages,
            fileMentions,
            turnProcess,
            responseAnnotations,
          },
    [
      node,
      groupPart,
      cwd,
      openFile,
      openSkill,
      inspectCall,
      forkAt,
      handoffAt,
      loadTurnDiffs,
      messageEditing,
      loadImage,
      renderMessageImages,
      fileMentions,
      turnProcess,
      responseAnnotations,
    ],
  );
  if (routedNode === undefined || owner === null || flowKey === undefined) return null;
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner;
  const virtualizedPlaceholder =
    !mounted && !processHidden && placeholderHeight !== undefined && placeholderHeight > 0;
  return (
    <div
      ref={wrapperRef}
      className={css.flowItem}
      data-chat-anchor-key={flowKey}
      data-chat-flow-key={flowKey}
      data-chat-paging-anchor={routedNode.kind !== "turn-process" || undefined}
      data-chat-node-key={routedNode.key}
      data-chat-group-part={groupPart}
      data-chat-flow-kind={routedNode.kind}
      data-chat-turn={turn}
      data-turn-process-member={processMember || undefined}
      data-turn-process-hidden={processHidden || undefined}
      data-turn-process-answer={compactAnswer || undefined}
      data-chat-virtualized={virtualizedPlaceholder ? "" : undefined}
      style={virtualizedPlaceholder ? { minHeight: placeholderHeight } : undefined}
    >
      {mounted ? (
        <CodeBlockFoldMemoryProvider memory={foldMemory} scope={flowKey}>
          {renderSlot("conversation.chat.node", routedOwner, {
            entryKey: routedNode.kind,
            hookContext,
            fallback: (
              <JsonBlock
                label={t("message.unknownSurface", { type: routedNode.kind })}
                payload={routedNode.data}
                truncatedLabel={(total) => t("json.truncated", { total })}
              />
            ),
          })}
        </CodeBlockFoldMemoryProvider>
      ) : null}
    </div>
  );
});
