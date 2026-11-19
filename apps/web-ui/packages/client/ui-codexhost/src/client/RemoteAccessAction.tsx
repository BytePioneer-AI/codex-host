import { useEffect, useState } from "react";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { isLocalWebAccess } from "./api.ts";

export interface RemoteAccessActionFace {
  openSection: (id: string) => void;
}

/** Discovery is local-only; Settings retains its guidance for remote visitors. */
export function RemoteAccessAction({
  size,
  renderAction,
  openSection,
  t,
}: PropsRuntime<"sidebar.primary.action"> &
  PropsLocale<"codexhostImport"> &
  RemoteAccessActionFace) {
  const [local, setLocal] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void isLocalWebAccess(controller.signal)
      .then((allowed) => {
        if (!controller.signal.aborted) setLocal(allowed);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (!local) return null;
  return renderAction({
    label: t("remoteAccess"),
    onClick: () => openSection("codexhost-connect-devices"),
    icon: (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="6" y="2" width="12" height="20" rx="3" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 5h4M11 19h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  });
}
