import { useEffect, useState } from "react";

const RECOVERY_NOTICE_DELAY_MS = 5000;

/**
 * Keep brief recovery out of the interface, with a fresh grace period on foreground return.
 * @param recovering - whether the connection is currently being restored.
 * @returns true after recovery persists for five uninterrupted visible seconds.
 */
export function useSustainedRecovery(recovering: boolean): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!recovering) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = document.visibilityState !== "hidden";
    const schedule = () => {
      timer = setTimeout(() => setSustained(true), RECOVERY_NOTICE_DELAY_MS);
    };
    const visibilityChanged = () => {
      const next = document.visibilityState !== "hidden";
      if (next === visible) return;
      visible = next;
      clearTimeout(timer);
      setSustained(false);
      if (visible) schedule();
    };
    if (visible) schedule();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      setSustained(false);
    };
  }, [recovering]);
  return recovering && sustained;
}
