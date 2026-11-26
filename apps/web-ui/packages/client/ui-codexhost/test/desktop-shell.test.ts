import { afterEach, expect, it, vi } from "vitest";
import { attachDesktopSessionPage } from "../src/client/desktop-shell.ts";

afterEach(() => vi.unstubAllGlobals());

it("confirms a repeated desktop wake without reopening the session", async () => {
  const claim = Promise.withResolvers<string>();
  let acknowledged: string | undefined;
  let loseReceipt = true;
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, { generation }: { generation: string }) => {
        if (command === "desktop_session_claim") return claim.promise;
        if (command !== "desktop_session_opened") throw new Error(`Unexpected ${command}`);
        if (loseReceipt) throw new Error("Receipt unavailable");
        acknowledged = generation;
        return undefined;
      },
    },
  });
  const opened: string[] = [];
  const page = attachDesktopSessionPage((sessionId) => opened.push(sessionId));
  const first = page.wake("1");
  const concurrent = page.wake("1");
  claim.resolve("target");
  await Promise.all([first, concurrent]);
  expect(opened).toEqual(["target"]);
  expect(acknowledged).toBeUndefined();

  loseReceipt = false;
  await page.wake("1");
  expect(acknowledged).toBe("1");
  expect(opened).toEqual(["target"]);
});
