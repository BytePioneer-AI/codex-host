import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AccountOfficialListeners } from "../src/codex-runtime/account-official-listeners.js";
import type { LoopbackOfficialAppServerListener } from "../src/remote-official-app-server.js";

function listener(endpoint: string): LoopbackOfficialAppServerListener {
  return {
    closed: new Promise(() => undefined),
    listen: vi.fn(async () => endpoint),
    close: vi.fn(async () => undefined),
  };
}

describe("Windows Account official listeners", () => {
  it("isolates new Accounts while sharing each home across Desktop connections", async () => {
    const original = { codexHome: path.resolve("homes", "default") };
    const added = { codexHome: path.resolve("homes", "added") };
    const first = listener("ws://127.0.0.1:10001");
    const second = listener("ws://127.0.0.1:10002");
    const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const pool = new AccountOfficialListeners(create);

    expect(
      await Promise.all([
        pool.endpoint(original),
        pool.endpoint(added),
        pool.endpoint({ ...added }),
        pool.endpoint({ ...original }),
      ]),
    ).toEqual([
      "ws://127.0.0.1:10001",
      "ws://127.0.0.1:10002",
      "ws://127.0.0.1:10002",
      "ws://127.0.0.1:10001",
    ]);
    expect(create.mock.calls).toEqual([[original], [added]]);
    expect(first.listen).toHaveBeenCalledOnce();
    expect(second.listen).toHaveBeenCalledOnce();

    await pool.close();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    await expect(pool.endpoint(added)).rejects.toThrow("closed");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("cleans up failed startup before allowing a retry for that Account", async () => {
    const failed = listener("unused");
    vi.mocked(failed.listen).mockRejectedValue(new Error("startup failed"));
    const retry = listener("ws://127.0.0.1:10003");
    const create = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(retry);
    const pool = new AccountOfficialListeners(create);
    const account = { codexHome: path.resolve("homes", "added") };

    await expect(pool.endpoint(account)).rejects.toThrow("startup failed");
    expect(failed.close).toHaveBeenCalledOnce();
    await expect(pool.endpoint(account)).resolves.toBe("ws://127.0.0.1:10003");
    await pool.close();
    expect(retry.close).toHaveBeenCalledOnce();
  });

  it("closes listeners whose startup is still pending", async () => {
    const starting = listener("unused");
    const ready = Promise.withResolvers<string>();
    vi.mocked(starting.listen).mockReturnValue(ready.promise);
    const pool = new AccountOfficialListeners(() => starting);
    const pending = pool.endpoint({ codexHome: path.resolve("homes", "added") });
    await pool.close();
    expect(starting.close).toHaveBeenCalledOnce();
    ready.reject(new Error("closed during startup"));
    await expect(pending).rejects.toThrow("closed during startup");
  });
});
