import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  IconCloseOutlineMedium,
  IconMicrophoneOutlineMedium,
  IconStopFillMedium,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ComposerBlocks } from "@deepseek-ai/dsh-client-ui-conversation/client";
import { VOICE_LEVEL_BARS, type VoiceInput, type VoiceInputState } from "./voice-input.ts";
import { voiceApi } from "./api.ts";
import css from "./VoiceInput.module.css";

export interface VoiceInputFace {
  voice: VoiceInput;
  blocks: ComposerBlocks;
}
export interface VoiceFace {
  voice: VoiceInput;
}
type Locale = PropsLocale<"codexhostImport">;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** Keycaps for the start/finish shortcut handled in index.ts. */
export const VOICE_SHORTCUT_KEYS = isMac ? ["⌘", "⇧", "Space"] : ["Ctrl", "Shift", "Space"];

function useVoiceState(voice: VoiceInput): VoiceInputState {
  return useSyncExternalStore(voice.subscribe, voice.getSnapshot);
}

const isLive = (state: VoiceInputState) =>
  state.phase === "permission" || state.phase === "recording" || state.phase === "transcribing";

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** Idle entry, at its usual place left of the model selector. */
export function VoiceInputButton({
  voice,
  blocks,
  sessionId,
  inputActions,
  useInput,
  useSession,
  t,
}: PropsRuntime<"conversation.input.right"> & Locale & VoiceInputFace) {
  const state = useVoiceState(voice);
  const [available, setAvailable] = useState(false);
  const [stacked, setStacked] = useState(false);
  const entryRef = useRef<HTMLSpanElement>(null);
  const live = isLive(state);
  const visible = live || (available && state.phase === "idle");
  const block = useMemo(() => blocks.storeFor(sessionId), [blocks, sessionId]);
  const blocked = useSyncExternalStore(block.subscribe, block.getSnapshot) !== undefined;
  const busy = useInput((s) => s.phase !== "plain");
  const sessionLocked = useSession(
    (s) =>
      s.removed ||
      (s.subagent?.address.mode === "continuable" && s.subagent.parentAvailable !== true),
  );
  const locked = blocked || busy || sessionLocked;
  useLayoutEffect(
    () => voice.bind(inputActions, locked, available),
    [voice, inputActions, locked, available],
  );
  useLayoutEffect(() => {
    if (!live) return;
    return inputActions.bindPrimaryAction({
      disabled: state.phase !== "recording",
      run: () => voice.send(),
    });
  }, [voice, inputActions, live, state.phase]);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void voiceApi.status().then(
        (status) => {
          if (active && request === revision) setAvailable(status.available);
        },
        () => {
          if (active && request === revision) setAvailable(false);
        },
      );
    };
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", visible);
    };
  }, [sessionId]);

  useLayoutEffect(() => {
    const entry = entryRef.current;
    const row = entry?.closest<HTMLElement>("[data-composer-toolbar]");
    if (!entry || !row || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const anchor = entry.getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      const leading = row.querySelector("[data-composer-tools]")?.getBoundingClientRect();
      const rowLeft = bounds.left + parseFloat(getComputedStyle(row).paddingLeft);
      const left =
        leading && leading.bottom > anchor.top && leading.top < anchor.bottom
          ? Math.max(rowLeft, leading.right + 8)
          : rowLeft;
      const width = parseFloat(getComputedStyle(entry).getPropertyValue("--voice-bar-width"));
      setStacked(
        window.matchMedia("(max-width: 600px), (pointer: coarse)").matches ||
          anchor.right - left < width,
      );
    };
    const resize = new ResizeObserver(measure);
    resize.observe(row);
    resize.observe(entry);
    for (const child of row.children) resize.observe(child);
    measure();
    return () => resize.disconnect();
  }, [visible]);

  if (!visible) return null;
  return (
    <span ref={entryRef} className={css.entry} data-composer-tray={stacked ? "stacked" : "inline"}>
      {isLive(state) ? (
        <VoiceRecorder voice={voice} state={state} locked={locked} t={t} />
      ) : (
        <Tooltip portal side="top" label={t("voice.label")} shortcutKeys={VOICE_SHORTCUT_KEYS}>
          <button
            type="button"
            className={css.icon}
            aria-label={t("voice.label")}
            disabled={locked}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void voice.start()}
          >
            <IconMicrophoneOutlineMedium size={16} />
          </button>
        </Tooltip>
      )}
    </span>
  );
}

/** The recording bar grows to the left; "Done" takes the microphone's own place. */
function VoiceRecorder({
  voice,
  state,
  locked,
  t,
}: Locale & { voice: VoiceInput; state: VoiceInputState; locked: boolean }) {
  const recording = state.phase === "recording";
  const levels = state.levels ?? [];
  const status = t(
    state.phase === "permission"
      ? "voice.permission"
      : state.slow
        ? "voice.slow"
        : "voice.transcribing",
  );
  return (
    <span className={css.bar} role="group" aria-label={t("voice.label")}>
      <Tooltip portal side="top" label={t("voice.cancel")} shortcutKeys={["Esc"]}>
        <button
          type="button"
          className={css.round}
          aria-label={t("voice.cancel")}
          onClick={() => voice.cancel()}
        >
          <IconCloseOutlineMedium size={14} />
        </button>
      </Tooltip>
      <span className={css.meter}>
        {recording ? (
          state.silent ? (
            <span className={css.quiet} role="status">
              {t("voice.silent")}
            </span>
          ) : (
            <svg className={css.wave} viewBox="0 0 96 24" aria-hidden="true">
              {levels.every((level) => level < 0.02) ? (
                <path d="M2 12h92" />
              ) : (
                Array.from({ length: VOICE_LEVEL_BARS }, (_, index) => {
                  const level = levels[levels.length - VOICE_LEVEL_BARS + index] ?? 0;
                  const height = 1 + Math.round(level * 21);
                  const x = 2 + index * 4;
                  return <path key={index} d={`M${x} ${(24 - height) / 2}v${height}`} />;
                })
              )}
            </svg>
          )
        ) : (
          <span className={css.status} role="status" title={status}>
            <span className={css.spinner} aria-hidden="true" />
            <span className={css.statusText}>{status}</span>
          </span>
        )}
      </span>
      <span className={css.timer} role="timer">
        {clock(state.seconds)}
      </span>
      <Tooltip portal side="top" label={t("voice.send")}>
        <button
          type="button"
          className={css.send}
          aria-label={t("voice.send")}
          disabled={locked || !recording}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => voice.send()}
        >
          <span className={css.sendFace}>
            <SendIcon />
          </span>
        </button>
      </Tooltip>
      <Tooltip portal side="top" label={t("voice.stop")} shortcutKeys={VOICE_SHORTCUT_KEYS}>
        <button
          type="button"
          className={css.done}
          aria-label={t("voice.stop")}
          disabled={!recording}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => voice.stop()}
        >
          <span className={css.doneFace}>
            <IconStopFillMedium size={9} />
          </span>
        </button>
      </Tooltip>
    </span>
  );
}

function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5M6 11l6-6 6 6" />
    </svg>
  );
}

/** Errors, undo and unplaced results, inside the composer card above the draft. */
export function VoiceNotice({
  voice,
  t,
}: PropsRuntime<"conversation.input.notice"> & Locale & VoiceFace) {
  const state = useVoiceState(voice);
  if (state.phase === "cancelled") {
    return (
      <div className={css.notice} role="status">
        <p>{t("voice.cancelled", { time: clock(state.seconds) })}</p>
        <button type="button" className={css.primary} onClick={() => voice.undo()}>
          {t("voice.undo")}
        </button>
        <CloseButton label={t("voice.discard")} onClick={voice.discard} />
      </div>
    );
  }
  if (state.phase === "text") {
    return (
      <div className={css.card} role="region" aria-label={t("voice.label")}>
        <div className={css.cardHead}>
          <IconMicrophoneOutlineMedium size={14} />
          {t("voice.unplaced")}
        </div>
        <p className={css.cardText}>{state.text}</p>
        <div className={css.actions}>
          <button type="button" className={css.quietButton} onClick={voice.discard}>
            {t("voice.discard")}
          </button>
          <button
            type="button"
            className={css.secondary}
            onClick={() => void navigator.clipboard.writeText(state.text ?? "").catch(() => {})}
          >
            {t("voice.copy")}
          </button>
          <button
            type="button"
            className={css.primary}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => voice.insert()}
          >
            {t("voice.insert")}
          </button>
        </div>
      </div>
    );
  }
  if (!state.error) return null;
  const error = state.error;
  const failed = state.phase === "failed";
  // A transcript failure keeps the audio: retry it unless the audio itself was the problem.
  const canRetry =
    failed && !["audio-empty", "audio-too-large", "audio-format", "audio-invalid"].includes(error);
  const severe = failed || error === "record-failed";
  return (
    <div className={css.notice} data-tone={severe ? "error" : undefined} role="alert">
      <p>{t(`voice.error.${error}`)}</p>
      {failed ? (
        <button
          type="button"
          className={canRetry ? css.secondary : css.primary}
          onClick={() => voice.rerecord()}
        >
          {t("voice.rerecord")}
        </button>
      ) : null}
      {canRetry ? (
        <button type="button" className={css.primary} onClick={() => void voice.retry()}>
          {t("voice.retry")}
        </button>
      ) : null}
      {error === "permission-denied" || error === "no-microphone" || error === "record-failed" ? (
        <button type="button" className={css.secondary} onClick={() => voice.rerecord()}>
          {t("voice.tryAgain")}
        </button>
      ) : null}
      <CloseButton label={t("voice.discard")} onClick={voice.discard} />
    </div>
  );
}

function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={css.round} aria-label={label} onClick={onClick}>
      <IconCloseOutlineMedium size={14} />
    </button>
  );
}
