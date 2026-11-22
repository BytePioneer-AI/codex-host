import { useEffect } from "react";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import css from "./AndroidHostSwitcherAction.module.css";

interface AndroidHostSwitcherBridge {
  openHostSwitcher?: () => void;
  getCurrentHostName?: () => string;
  registerMounted?: () => void;
}

declare global {
  interface Window {
    __codexhostAndroidHostSwitcher?: AndroidHostSwitcherBridge;
  }
}

export function AndroidHostSwitcherAction({
  wide,
  t,
}: PropsRuntime<"sidebar.footer.action"> & PropsLocale<"codexhostImport">) {
  const bridge = window.__codexhostAndroidHostSwitcher;
  useEffect(() => {
    bridge?.registerMounted?.();
  }, [bridge]);

  if (bridge === undefined) return null;

  const hostName = bridge.getCurrentHostName?.()?.trim() ?? "";
  const label = t("android.switchHost");
  const ariaLabel = hostName ? `${label} · ${hostName}` : label;

  return (
    <Tooltip disabled={wide} label={ariaLabel}>
      <button
        type="button"
        className={css.trigger}
        data-wide={wide}
        aria-label={ariaLabel}
        onClick={() => bridge.openHostSwitcher?.()}
      >
        <span className={css.icon} aria-hidden="true">
          <svg
            width={wide ? 16 : 18}
            height={wide ? 16 : 18}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9H4V6zM2 18h20" />
          </svg>
        </span>
        {wide ? (
          <>
            <span className={css.label}>{label}</span>
            {hostName ? (
              <span className={css.hostPill}>
                <span className={css.dot} aria-hidden="true" />
                <span className={css.hostName}>{hostName}</span>
              </span>
            ) : null}
          </>
        ) : null}
      </button>
    </Tooltip>
  );
}
