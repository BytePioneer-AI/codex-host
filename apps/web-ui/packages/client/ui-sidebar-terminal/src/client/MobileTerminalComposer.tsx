/** Native mobile text editing, separate from the terminal emulator's keyboard. */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { IconSendOutlineMedium } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { MobileTerminalDraft } from "./mobile-terminal-draft.ts";
import { bindMobileTerminalSubmit } from "./mobile-terminal-submit.ts";
import type {} from "./locales.ts";
import css from "./MobileTerminalComposer.module.css";

interface Props extends PropsLocale<"sidebarTerminal"> {
  readonly draft: MobileTerminalDraft;
  readonly writable: boolean;
  readonly bracketedPaste: () => boolean;
  readonly send: (text: string, key?: string) => Promise<void>;
  readonly control: (key: string) => void;
}

function resizeEditor(editor: HTMLTextAreaElement | null): void {
  if (!editor) return;
  editor.style.height = "auto";
  editor.style.height = `${editor.scrollHeight}px`;
}

/** The OS edits raw text locally; Enter or an explicit action submits it to the PTY. */
export function MobileTerminalComposer({
  draft,
  writable,
  bracketedPaste,
  send,
  control,
  t,
}: Props): ReactNode {
  const state = useSyncExternalStore(draft.state.subscribe, draft.state.getSnapshot);
  const editor = useRef<HTMLTextAreaElement>(null);
  const submitOnEnter = useRef<() => void>();
  useEffect(() => {
    const textarea = editor.current;
    if (!textarea) return;
    const unbind = bindMobileTerminalSubmit(
      textarea,
      () => submitOnEnter.current?.(),
      (text) => draft.edit(text),
    );
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      resizeEditor(textarea);
    });
    observer.observe(textarea);
    return () => {
      unbind();
      observer.disconnect();
    };
  }, [draft]);
  useLayoutEffect(() => resizeEditor(editor.current), [state.text]);
  const [composing, setComposing] = useState(false);
  const [confirmation, setConfirmation] = useState<string>();
  const blocked = !writable || state.sending || composing;
  const submit = (key?: string): void => {
    if (blocked) return;
    // Read the native value after candidate selection, rather than a key event's data.
    const text = editor.current?.value ?? state.text;
    draft.edit(text);
    if (!text && !key) return;
    if ((state.uncertain || (/[\r\n]/u.test(text) && !bracketedPaste())) && confirmation !== text) {
      setConfirmation(text);
      return;
    }
    setConfirmation(undefined);
    void draft.submit((value) => send(value, key));
  };
  submitOnEnter.current = () => submit(state.enterMode === "send" ? "\r" : undefined);
  const keys = [
    { label: "Tab", name: t("mobile.tab"), key: "\t", flush: true },
    { label: "Esc", name: "Esc", key: "\x1b" },
    { label: "↑", name: t("mobile.up"), key: "up" },
    { label: "↓", name: t("mobile.down"), key: "down" },
    { label: "←", name: t("mobile.left"), key: "left" },
    { label: "→", name: t("mobile.right"), key: "right" },
    { label: "⌫", name: t("mobile.backspace"), key: "\x7f" },
    { label: "Ctrl+D", name: "Ctrl+D", key: "\x04" },
  ];
  return (
    <div className={css.root} data-terminal-composer>
      <div className={css.field}>
        <textarea
          ref={editor}
          className={css.editor}
          rows={1}
          value={state.text}
          readOnly={state.sending}
          aria-label={t("mobile.editor")}
          title={t("mobile.hint")}
          placeholder={t("mobile.placeholder")}
          autoCapitalize="none"
          autoCorrect="on"
          autoComplete="off"
          enterKeyHint={state.enterMode === "send" ? "send" : "enter"}
          spellCheck
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onBlur={() => setComposing(false)}
          onChange={(event) => {
            draft.edit(event.currentTarget.value);
            setConfirmation(undefined);
          }}
        />
        <button
          className={css.send}
          type="button"
          disabled={blocked}
          aria-label={state.text ? t("mobile.sendEnter") : t("mobile.enter")}
          title={state.text ? t("mobile.sendEnter") : t("mobile.enter")}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => submit("\r")}
        >
          <IconSendOutlineMedium size={20} />
        </button>
      </div>
      <div className={css.keys} role="group" aria-label={t("mobile.keys")}>
        <div className={css.mode} role="group" aria-label={t("mobile.enterMode")}>
          {(["insert", "send"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={state.enterMode === mode}
              aria-label={t(mode === "insert" ? "mobile.enterInsert" : "mobile.enterSend")}
              title={t(mode === "insert" ? "mobile.enterInsertHelp" : "mobile.enterSendHelp")}
              disabled={state.sending || composing}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (state.enterMode === mode) return;
                draft.setEnterMode(mode);
                setConfirmation(undefined);
              }}
            >
              {t(mode === "insert" ? "mobile.enterInsertShort" : "mobile.enterSendShort")}
            </button>
          ))}
        </div>
        <div className={css.keyStrip} data-terminal-key-strip>
          <button
            type="button"
            disabled={!writable || composing}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => control("\x03")}
          >
            Ctrl+C
          </button>
          {keys.map(({ label, name, key, flush }) => (
            <button
              key={key}
              type="button"
              aria-label={name}
              disabled={blocked}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => (flush ? submit(key) : control(key))}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {state.sending && (
        <p className={css.hint} role="status">
          {t("mobile.sending")}
        </p>
      )}
      {state.uncertain && (
        <p className={css.warning} role="alert">
          {t("mobile.uncertain")}
        </p>
      )}
      {confirmation !== undefined && (
        <p className={css.warning} role="alert">
          {t(state.uncertain ? "mobile.confirmUnknown" : "mobile.multiline")}
        </p>
      )}
    </div>
  );
}
