import { rename } from "node:fs/promises";
import { platform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const WINDOWS_RENAME_DELAYS_MS = [10, 30, 70, 150, 300] as const;

/** Atomically replace a file, allowing Windows readers time to release the destination. */
export async function replaceFile(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const wait = WINDOWS_RENAME_DELAYS_MS[attempt];
      const code = (error as NodeJS.ErrnoException).code;
      if (
        platform() !== "win32" ||
        wait === undefined ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")
      )
        throw error;
      await delay(wait);
    }
  }
}
