/** Stable process container; display policy changes visibility, never member parents. */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  CodeBlockFoldMemoryProvider,
  IconAgentPresetOutlineRegular,
  IconApiOutlineRegular,
  IconBrowseOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCodeOutlineRegular,
  IconEditOutlineRegular,
  IconGlobeOutlineRegular,
  IconPlanOutlineRegular,
  IconQuestionOutlineRegular,
  IconSearchOutlineRegular,
  IconSparkleRegular,
  IconThinkOutlineRegular,
  TextShimmer,
  focusWithoutRing,
  pointerModality,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { GroupKey, NodeReference } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { ProcessActivity } from "../contract/process-groups.ts";
import type { ChatStoreState } from "../contract/store.ts";
import type { ChatViewSlotProps } from "../contract/slots.ts";
import { storedTurnProcessEntry } from "../stores.ts";
import { ChatNodeSeat } from "./ChatNodeSeat.tsx";
import { useNearViewport } from "./near-viewport.ts";
import { chatRenderKey } from "./render-entry.ts";
import { processTitle } from "./step-process.ts";
import { useSearchableHidden } from "./searchable-hidden.ts";
import { useDisclosure } from "./use-disclosure.ts";
import { useProcessScroll } from "./use-process-scroll.ts";
import css from "./ChatGroupSeat.module.css";

type SeatProps = Omit<
  ComponentProps<typeof ChatNodeSeat>,
  "nodeKey" | "groupPart" | "mounted" | "placeholderHeight" | "registerRow"
>;
type ChatGroupSeatProps = SeatProps & {
  readonly groupKey: GroupKey;
  readonly useChatGroup: ChatViewSlotProps["useChatGroup"];
  /** Whether this top-level group's header and member subtree should be mounted. */
  readonly mounted?: boolean;
  /** Reserved height (px) while unmounted; ignored when the group is hidden. */
  readonly placeholderHeight?: number;
  /** Registers this top-level group shell with the transcript virtualizer. */
  readonly registerRow?: (flowKey: string, element: HTMLDivElement | null) => void;
};
const PROCESS_TITLE_MINIMUM_MS = 150;

type ProcessTitleActivity = ProcessActivity | "thinking";

interface LiveProcessTitle {
  readonly activity: ProcessTitleActivity;
  readonly detail: string;
  readonly preparing: boolean;
}

const PROCESS_ICONS: Record<ProcessTitleActivity, ReactNode> = {
  thinking: <IconThinkOutlineRegular />,
  read: <IconBrowseOutlineRegular size={14} />,
  readImage: <IconBrowseOutlineRegular size={14} />,
  search: <IconSearchOutlineRegular size={14} />,
  edit: <IconEditOutlineRegular size={14} />,
  write: <IconEditOutlineRegular size={14} />,
  commands: <IconApiOutlineRegular />,
  code: <IconCodeOutlineRegular size={14} />,
  webSearch: <IconGlobeOutlineRegular />,
  webFetch: <IconBrowseOutlineRegular size={14} />,
  subagents: <IconAgentPresetOutlineRegular size={14} />,
  plan: <IconPlanOutlineRegular />,
  questions: <IconQuestionOutlineRegular />,
  tools: <IconSparkleRegular size={14} />,
};

function sameLiveProcessTitle(left: LiveProcessTitle, right: LiveProcessTitle): boolean {
  return (
    left.activity === right.activity &&
    left.detail === right.detail &&
    left.preparing === right.preparing
  );
}

function useStableLiveProcessTitle(desired: LiveProcessTitle, active: boolean): LiveProcessTitle {
  const [displayed, setDisplayed] = useState(desired);
  const displayedRef = useRef(displayed);
  const desiredRef = useRef(desired);
  const displayedAtRef = useRef(Date.now());
  useEffect(() => {
    desiredRef.current = desired;
    if (!active || sameLiveProcessTitle(displayedRef.current, desired)) return;
    const remaining = PROCESS_TITLE_MINIMUM_MS - (Date.now() - displayedAtRef.current);
    const commit = (): void => {
      const next = desiredRef.current;
      displayedRef.current = next;
      displayedAtRef.current = Date.now();
      setDisplayed(next);
    };
    if (remaining <= 0) {
      commit();
      return;
    }
    const timer = setTimeout(commit, remaining);
    return () => {
      clearTimeout(timer);
    };
  }, [active, desired.activity, desired.detail, desired.preparing]);
  return active ? displayed : desired;
}

const GroupMembers = memo(function GroupMembers({
  members,
  ...props
}: SeatProps & {
  readonly members: readonly NodeReference[];
}) {
  return members.map((member) => (
    <ChatNodeSeat
      {...props}
      key={chatRenderKey(member)}
      nodeKey={member.key}
      {...(member.groupPart === undefined ? {} : { groupPart: member.groupPart })}
    />
  ));
});

const ProcessGroupHeader = memo(function ProcessGroupHeader({
  groupKey,
  useChatGroup,
  usePresentation,
  t,
  open,
  bodyId,
  toggle,
}: {
  readonly groupKey: GroupKey;
  readonly useChatGroup: ChatViewSlotProps["useChatGroup"];
  readonly usePresentation: ChatViewSlotProps["usePresentation"];
  readonly t: ChatViewSlotProps["t"];
  readonly open: boolean;
  readonly bodyId: string;
  readonly toggle: () => void;
}) {
  const data = useChatGroup(groupKey, (group) => group?.data);
  const detailed = usePresentation((policy) => data?.closed === false && policy.liveProcessDetail);
  const live = useStableLiveProcessTitle(
    {
      activity: data?.summary.running ?? "thinking",
      detail: data?.summary.runningDetail ?? "",
      preparing: data?.summary.preparing === true,
    },
    data !== undefined && !data.closed,
  );
  if (data === undefined) return null;
  const label = data.closed
    ? processTitle(data.summary, t)
    : live.preparing
      ? t(`message.stepProcess.prepare.${live.activity === "thinking" ? "tools" : live.activity}`)
      : t(`message.stepProcess.${live.activity}`);
  const detail = detailed && !data.closed ? live.detail : "";
  const title = detail === "" ? label : `${label}${t("message.turnProcess.separator")}${detail}`;
  const activity = data.closed ? (data.summary.counts[0]?.kind ?? "thinking") : live.activity;
  return (
    <button
      type="button"
      className={css.title}
      aria-expanded={open}
      aria-controls={bodyId}
      data-process-activity={activity}
      onClick={(event) => {
        const button = event.currentTarget;
        const body = button.ownerDocument.getElementById(bodyId);
        if (open && body?.contains(button.ownerDocument.activeElement)) {
          if (event.detail !== 0 || pointerModality()) {
            focusWithoutRing(button, { preventScroll: true });
          } else {
            button.focus({ preventScroll: true });
          }
        }
        toggle();
      }}
    >
      <span className={css.leading} aria-hidden="true">
        <span className={css.activityIcon} data-step-process-icon>
          {PROCESS_ICONS[activity]}
        </span>
        <span className={css.chevron} data-step-process-chevron>
          {open ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
        </span>
      </span>
      <TextShimmer active={!data.closed}>
        <TextShimmer className={css.label}>{title}</TextShimmer>
      </TextShimmer>
    </button>
  );
});

/** Mounted interior of a process group; owns body hidden/scroll refs so remounts rebind cleanly. */
const ChatGroupBody = memo(function ChatGroupBody({
  groupKey,
  useChatGroup,
  members,
  closed,
  grouped,
  open,
  setOpen,
  ...props
}: SeatProps & {
  readonly groupKey: GroupKey;
  readonly useChatGroup: ChatViewSlotProps["useChatGroup"];
  readonly members: readonly NodeReference[];
  readonly closed: boolean | undefined;
  readonly grouped: boolean;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}) {
  const reveal = useCallback(() => {
    setOpen(true);
  }, [setOpen]);
  const bodyRef = useSearchableHidden(grouped && !open, reveal);
  const contentRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const { edges, events, initialize } = useProcessScroll(bodyRef, contentRef, open, grouped);
  const toggle = useCallback(() => {
    if (!open) initialize(closed === false ? "bottom" : "top");
    setOpen(!open);
  }, [closed, initialize, open, setOpen]);
  const classes = [
    css.body,
    !grouped ? css.expandedBody : "",
    grouped && edges.canScrollUp ? css.fadeTop : "",
    grouped && edges.canScrollDown ? css.fadeBottom : "",
  ];
  return (
    <>
      <div hidden={!grouped}>
        <ProcessGroupHeader
          groupKey={groupKey}
          useChatGroup={useChatGroup}
          usePresentation={props.usePresentation}
          t={props.t}
          open={open}
          bodyId={bodyId}
          toggle={toggle}
        />
      </div>
      <div
        ref={bodyRef}
        id={bodyId}
        className={classes.join(" ")}
        data-step-process-body
        data-scroll-up={edges.canScrollUp || undefined}
        data-scroll-down={edges.canScrollDown || undefined}
        {...events}
      >
        <div ref={contentRef} className={css.content} data-step-process-content data-chat-flow="">
          <GroupMembers {...props} members={members} />
        </div>
      </div>
    </>
  );
});

/** Render a process group with local disclosure and the existing outer-Turn visibility. */
export const ChatGroupSeat = memo(function ChatGroupSeat({
  groupKey,
  useChatGroup,
  mounted = true,
  placeholderHeight,
  registerRow,
  ...props
}: ChatGroupSeatProps) {
  const members = useChatGroup(groupKey, (group) => group?.members);
  const turn = useChatGroup(groupKey, (group) => group?.data.turn);
  const closed = useChatGroup(groupKey, (group) => group?.data.closed);
  const foldCompleted = props.usePresentation((policy) => policy.foldCompletedTurns);
  const { expanded: open, setExpanded: setOpen } = useDisclosure();
  const firstKey = members?.[0]?.key ?? "";
  const presentation = props.useChatNodeProcess(firstKey);
  const turnLocation = props.useChatNode(firstKey, (node) => {
    const location = node?.location;
    return location?.kind === "turn" || location?.kind === "step" ? location.turn : undefined;
  });
  const grouped = props.usePresentation(
    (policy) =>
      policy.stepGrouping === "collapsed" ||
      (policy.stepGrouping === "history" && turnLocation?.status !== "open"),
  );
  const reason = turnLocation?.end?.data.reason.kind;
  const alwaysOpen =
    presentation?.turnClosed === false ||
    presentation?.hasInterleavedInput === true ||
    turnLocation?.end?.data.finalAssistantStep === null ||
    reason === "aborted" ||
    reason === "error";
  const spec = presentation?.spec;
  const selectStored = useCallback(
    (state: Readonly<ChatStoreState>) =>
      turn === undefined ? undefined : storedTurnProcessEntry(state, turn),
    [turn],
  );
  const stored = props.useStore(selectStored);
  const outerHidden =
    foldCompleted &&
    presentation?.turnClosed === true &&
    spec !== undefined &&
    !alwaysOpen &&
    stored?.answerStep !== (spec.answerStep ?? 0);
  const revealOuter = useCallback(() => {
    if (spec !== undefined && !alwaysOpen)
      props.actions.setTurnProcessOpen(spec.turn, spec.answerStep ?? 0, true);
  }, [props.actions, spec, alwaysOpen]);
  const rootRef = useSearchableHidden(outerHidden, revealOuter);
  const foldMemoryRef = useRef<Map<string, boolean> | null>(null);
  if (foldMemoryRef.current === null) foldMemoryRef.current = new Map();
  useNearViewport(rootRef, members !== undefined);
  useLayoutEffect(() => {
    if (registerRow === undefined || members === undefined) return;
    const element = rootRef.current;
    if (element === null) return;
    registerRow(groupKey, element);
    return () => {
      registerRow(groupKey, null);
    };
  }, [registerRow, groupKey, rootRef, members !== undefined]);
  useEffect(() => {
    if (outerHidden && rootRef.current?.hasAttribute("hidden")) setOpen(false);
  }, [outerHidden, rootRef, setOpen]);
  if (members === undefined) return null;
  const virtualizedPlaceholder =
    !mounted && !outerHidden && placeholderHeight !== undefined && placeholderHeight > 0;
  return (
    <div
      ref={rootRef}
      className={css.root}
      data-chat-group-key={groupKey}
      data-chat-flow-key={groupKey}
      data-chat-anchor-key={`group:${groupKey}`}
      data-chat-turn={turn}
      data-chat-paging-anchor={(grouped && !open) || undefined}
      data-step-process
      data-group-expanded-mode={!grouped || undefined}
      data-chat-virtualized={virtualizedPlaceholder ? "" : undefined}
      style={virtualizedPlaceholder ? { minHeight: placeholderHeight } : undefined}
    >
      {mounted ? (
        <CodeBlockFoldMemoryProvider memory={foldMemoryRef.current} scope={groupKey}>
          <ChatGroupBody
            {...props}
            groupKey={groupKey}
            useChatGroup={useChatGroup}
            members={members}
            closed={closed}
            grouped={grouped}
            open={open}
            setOpen={setOpen}
          />
        </CodeBlockFoldMemoryProvider>
      ) : null}
    </div>
  );
});
