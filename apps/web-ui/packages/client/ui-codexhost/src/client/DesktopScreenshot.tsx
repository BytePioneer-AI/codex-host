import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  IconCloseOutlineRegular,
  IconLoadingOutlineRegular,
  rankByName,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {
  InputTriggerCandidate,
  InputTriggerServiceContract,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import type { DesktopScreenshot } from "./desktop-screenshot.ts";
import { DesktopScreenshotViewer } from "./DesktopScreenshotViewer.tsx";
import css from "./DesktopScreenshot.module.css";

export interface DesktopScreenshotFace {
  screenshot: DesktopScreenshot;
  /** Register a browser file as a draft attachment of one Session, or release it again. */
  drafts: {
    create(sessionId: string, file: File): readonly { readonly id: string }[];
    release(drafts: readonly { readonly id: string }[]): void;
  };
}
type Locale = PropsLocale<"codexhostImport">;

export interface DesktopScreenshotButtonFace extends DesktopScreenshotFace {
  registerSource: InputTriggerServiceContract["registerSource"];
}

export function DesktopScreenshotButton({
  screenshot,
  registerSource,
  sessionId,
  overflowActions = false,
  t,
}: PropsRuntime<"conversation.input.right"> & DesktopScreenshotButtonFace & Locale) {
  const state = useSyncExternalStore(screenshot.subscribe, screenshot.getSnapshot);
  const sourceId = useId();
  const capture = useCallback(() => {
    if (sessionId !== undefined) void screenshot.refresh(sessionId);
  }, [screenshot, sessionId]);
  const live = useRef({ sessionId, overflowActions, t, capture });
  live.current = { sessionId, overflowActions, t, capture };
  useLayoutEffect(() => {
    if (!overflowActions) return;
    return registerSource({
      trigger: "/",
      name: `desktop-screenshot:${sourceId}`,
      launcher: "command",
      // Launcher groups start with interface actions at 0, then native commands/Skills.
      launcherOrder: -10,
      showGroupTitle: false,
      candidates: async (session, request) => {
        const current = live.current;
        if (
          request.launcher !== "command" ||
          !current.overflowActions ||
          session.sessionId !== current.sessionId
        )
          return [];
        const pending = screenshot.getSnapshot().pending;
        const items: InputTriggerCandidate[] = [
          {
            name: "desktop-screenshot",
            label: current.t("desktop.label"),
            showAlias: false,
            description: pending ? current.t("desktop.pending") : undefined,
            busy: pending,
            icon: DesktopScreenshotIcon,
          },
        ];
        return rankByName(items, request.query);
      },
      subscribeCandidates: (_session, listener) => {
        let pending = screenshot.getSnapshot().pending;
        return screenshot.subscribe(() => {
          const next = screenshot.getSnapshot().pending;
          if (pending === next) return;
          pending = next;
          listener();
        });
      },
      onPick: (pick) => {
        const current = live.current;
        if (current.overflowActions && pick.session.sessionId === current.sessionId)
          current.capture();
        return "handled";
      },
    });
  }, [registerSource, screenshot, sourceId, overflowActions]);
  // A late capture from the previous conversation must not enter the new one.
  useLayoutEffect(
    () => () => {
      if (sessionId !== undefined) screenshot.close(sessionId);
    },
    [screenshot, sessionId],
  );
  const seconds = useElapsedSeconds(state.startedAt);
  if (sessionId === undefined) return null;
  return (
    <Tooltip
      portal
      disabled={overflowActions}
      side="top"
      label={t(state.pending ? "desktop.pending" : "desktop.label")}
    >
      <button
        type="button"
        className={state.pending ? `${css.entry} ${css.entryBusy}` : css.entry}
        aria-label={t("desktop.label")}
        aria-busy={state.pending}
        data-composer-overflow-action
        onMouseDown={(event) => event.preventDefault()}
        onClick={capture}
      >
        {state.pending ? (
          <>
            <span className={css.spinner} aria-hidden="true">
              <IconLoadingOutlineRegular size={16} />
            </span>
            <span className={css.elapsed}>{seconds}s</span>
          </>
        ) : (
          <DesktopScreenshotIcon size={16} />
        )}
      </button>
    </Tooltip>
  );
}

function DesktopScreenshotIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="16" height="11" rx="2" />
      <path d="M10 14v3M6 17h8" />
    </svg>
  );
}

/** Whole seconds since `startedAt`, ticking once a second while it is set. */
function useElapsedSeconds(startedAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

const FLOAT_SIZE = 60;
const FLOAT_MARGIN = 8;
/** Pointer travel below which a press is a tap rather than a drag. */
const DRAG_THRESHOLD = 6;

interface FloatPosition {
  readonly x: number;
  readonly y: number;
}

/** Last dragged spot, kept across screenshots and conversation switches. */
let rememberedPosition: FloatPosition | undefined;

function clampPosition(position: FloatPosition): FloatPosition {
  return {
    x: Math.min(
      Math.max(position.x, FLOAT_MARGIN),
      Math.max(FLOAT_MARGIN, window.innerWidth - FLOAT_SIZE - FLOAT_MARGIN),
    ),
    y: Math.min(
      Math.max(position.y, FLOAT_MARGIN),
      Math.max(FLOAT_MARGIN, window.innerHeight - FLOAT_SIZE - FLOAT_MARGIN),
    ),
  };
}

function defaultPosition(): FloatPosition {
  return { x: window.innerWidth - FLOAT_SIZE - 12, y: 72 };
}

/**
 * Floating bubble for the latest desktop screenshot. Tapping it enlarges the
 * image, the corner cross closes it, and dragging moves it out of the way.
 */
export function DesktopScreenshotPreview({
  screenshot,
  drafts,
  inputActions,
  useInput,
  sessionId,
  t,
}: PropsRuntime<"conversation.input.notice"> & DesktopScreenshotFace & Locale) {
  const state = useSyncExternalStore(screenshot.subscribe, screenshot.getSnapshot);
  const { image, pending, progress, error } = state;
  const seconds = useElapsedSeconds(state.startedAt);
  const [position, setPosition] = useState<FloatPosition>(() =>
    clampPosition(rememberedPosition ?? defaultPosition()),
  );
  const [open, setOpen] = useState(false);
  const draftText = useInput((input) => input.draft);
  // A freshly captured image opens at once; remounting with an old one does not.
  const shown = useRef(image?.url);
  useEffect(() => {
    if (image === undefined || image.url === shown.current) return;
    shown.current = image.url;
    setOpen(true);
  }, [image]);
  const drag = useRef<{
    pointer: number;
    dx: number;
    dy: number;
    x: number;
    y: number;
    moved: boolean;
  }>();

  useEffect(() => {
    const keepInView = (): void => setPosition((current) => clampPosition(current));
    window.addEventListener("resize", keepInView);
    return () => window.removeEventListener("resize", keepInView);
  }, []);

  if (sessionId === undefined || state.sessionId !== sessionId) return null;
  if (image === undefined && !pending && error === undefined) return null;

  const activate = (): void => {
    if (pending) return;
    if (error !== undefined || image === undefined) void screenshot.refresh(sessionId);
    else setOpen(true);
  };
  const addToDraft = (blob: Blob): string | null => {
    const file = new File([blob], `desktop-screenshot-${String(Date.now())}.png`, {
      type: "image/png",
    });
    const created = drafts.create(sessionId, file);
    if (inputActions.addAttachments(created.map((draft) => draft.id as never))) return null;
    drafts.release(created);
    return t("desktop.attach.blocked");
  };
  const title =
    pending && progress !== undefined
      ? t("desktop.transferring", {
          loaded: formatMegabytes(progress.loaded),
          total: progress.total === undefined ? "?" : formatMegabytes(progress.total),
        })
      : pending
        ? t("desktop.pending")
        : error !== undefined
          ? `${t(`desktop.error.${error}`)} ${t("desktop.refresh")}`
          : image === undefined
            ? t("desktop.label")
            : t("desktop.captured", { time: new Date(image.capturedAt).toLocaleString() });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-float-close]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointer: event.pointerId,
      dx: event.clientX - position.x,
      dy: event.clientY - position.y,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;
    if (
      !current.moved &&
      Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD
    )
      return;
    current.moved = true;
    setPosition(clampPosition({ x: event.clientX - current.dx, y: event.clientY - current.dy }));
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const current = drag.current;
    if (current?.pointer !== event.pointerId) return;
    drag.current = undefined;
    if (current.moved) rememberedPosition = position;
    else if (!cancelled) activate();
  };

  return createPortal(
    <>
      <div
        className={css.float}
        style={{ left: position.x, top: position.y }}
        role="group"
        aria-label={t("desktop.label")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => onPointerEnd(event, false)}
        onPointerCancel={(event) => onPointerEnd(event, true)}
      >
        <button
          type="button"
          className={css.bubble}
          aria-label={
            image !== undefined && !pending && error === undefined ? t("desktop.enlarge") : title
          }
          aria-busy={pending}
          title={title}
          data-error={error !== undefined || undefined}
          onClick={(event) => {
            // Keyboard activation only; pointer taps are resolved on pointerup.
            if (event.detail === 0) activate();
          }}
        >
          {image !== undefined && <img src={image.url} alt="" draggable={false} />}
          {pending && (
            <span className={css.busy}>
              <span className={css.spinner} aria-hidden="true">
                <IconLoadingOutlineRegular size={16} />
              </span>
              <span className={css.elapsed}>{seconds}s</span>
            </span>
          )}
          {!pending && error !== undefined && <span className={css.alert}>!</span>}
        </button>
        <button
          type="button"
          className={css.dismiss}
          data-float-close
          aria-label={t("desktop.close")}
          onClick={() => screenshot.close(sessionId)}
        >
          <IconCloseOutlineRegular size={10} />
        </button>
        {error !== undefined && !pending && (
          <p role="status" className={css.caption}>
            {t(`desktop.error.${error}`)}
          </p>
        )}
      </div>
      {open && image !== undefined && (
        <DesktopScreenshotViewer
          src={image.url}
          t={t}
          onClose={() => setOpen(false)}
          onAttach={(blob) => addToDraft(blob)}
          onSend={async (blob, message) => {
            const failure = addToDraft(blob);
            if (failure !== null) return failure;
            if (message !== "") {
              // Append after whatever is already typed, then let the editor settle before submitting.
              const span = inputActions.captureInsertion("end");
              const text = draftText.trim() === "" ? message : `\n${message}`;
              if (!inputActions.insertText(text, span)) return t("desktop.attach.blocked");
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            inputActions.submit();
            return null;
          }}
        />
      )}
    </>,
    document.body,
  );
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
