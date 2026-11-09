import { useEffect, useState } from "react";

const RECOVERY_NOTICE_DELAY_MS = 1000;

/**
 * Keep a recovery that finishes quickly out of the interface.
 * @param recovering - whether the connection is currently being restored.
 * @returns true once the same recovery has lasted long enough to tell the user.
 */
export function useSustainedRecovery(recovering: boolean): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!recovering) return;
    const timer = setTimeout(() => setSustained(true), RECOVERY_NOTICE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setSustained(false);
    };
  }, [recovering]);
  return recovering && sustained;
}
