/**
 * Composer Fast switch beside the Model trigger, matching Codex Desktop's Pi
 * Fast control: an outlined bolt when off, a filled bolt in the Model text
 * tone when on. The Harness advertises Fast as a separate Model ref on the
 * base Model, so toggling selects one ref or the other through the same
 * session selection RPC, keeping the current Thinking level. It never opens
 * the Model menu and is absent when the current Model has no Fast variant.
 */
import { useState, useSyncExternalStore } from "react";
import { IconWarningOutlineRegular, Toast, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { catalogModelOf } from "./fast-model.ts";
import type { ModelSelectInjected } from "./slots.ts";
import css from "./FastToggle.module.css";

// Codex Desktop's ModelPickerTriggerInlineModeIcon geometry (24-unit path), shared with
// the Desktop renderer extension so both clients draw the same bolt.
const BOLT =
  "M11.9125 21.4125C11.5292 21.8625 11.0292 22.0958 10.4125 22.1125C9.79586 22.1291 9.29586 21.9208 8.91252 21.4875C8.53752 21.0541 8.45836 20.4541 8.67503 19.6875L9.68752 16H4.57502C4.00836 16 3.56669 15.8375 3.25002 15.5125C2.93336 15.1791 2.77502 14.7791 2.77502 14.3125C2.77502 13.8375 2.92919 13.4125 3.23752 13.0375L12.1375 2.47497C12.5209 2.02497 13.0209 1.79164 13.6375 1.77497C14.2542 1.75831 14.75 1.96664 15.125 2.39997C15.5084 2.83331 15.5917 3.43331 15.375 4.19997L14.3125 7.99998H19.425C19.9917 7.99998 20.4334 8.16664 20.75 8.49997C21.075 8.83331 21.2375 9.23748 21.2375 9.71247C21.2375 10.1791 21.0792 10.5958 20.7625 10.9625L11.9125 21.4125Z";

export function FastToggle({
  locked,
  available,
  directory,
  select,
  t,
}: ModelSelectInjected & { locked: boolean } & PropsLocale<"model">) {
  const state = useSyncExternalStore(
    (fn) => directory.subscribe(fn),
    () => directory.getSnapshot(),
  );
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const { current } = state;
  const model = current === null ? undefined : catalogModelOf(state.groups, current);
  const fastModel = model?.fastModel;
  if (!available || current === null || model === undefined || fastModel === undefined) return null;
  const enabled = current.model === fastModel;
  const busy = state.pending !== null;

  const toggle = (): void => {
    void select({
      provider: current.provider,
      model: enabled ? model.id : fastModel,
      ...(current.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: current.reasoningEffort }),
    }).then((result) => {
      if (result === undefined || result.ok) return;
      const { error } = result;
      setToast((previous) => ({
        seq: (previous?.seq ?? 0) + 1,
        text:
          error.code === "session/writer-held"
            ? t("error.sessionInUse")
            : t("error.action", { message: `${error.code}: ${error.message}` }),
      }));
    });
  };

  return (
    <>
      <Tooltip
        portal
        side="top"
        maxWidth={300}
        label={`${t(enabled ? "fast.on" : "fast.off")}\n${t("fast.description")}`}
      >
        <button
          ref={setAnchor}
          type="button"
          className={css.toggle}
          data-enabled={enabled ? "" : undefined}
          aria-label="Fast"
          aria-pressed={enabled}
          disabled={locked || busy}
          onClick={toggle}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d={BOLT}
              fill={enabled ? "currentColor" : "none"}
              // Only the off state is outlined; a stroke would thicken the filled glyph.
              stroke={enabled ? "none" : "currentColor"}
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </Tooltip>
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={anchor?.closest<HTMLElement>("[data-composer-card]") ?? null}
          onDone={() => {
            setToast(null);
          }}
        />
      )}
    </>
  );
}
