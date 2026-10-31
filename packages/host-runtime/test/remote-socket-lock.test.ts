import { describe, expect, it, vi } from "vitest";

import { retryWhileWindowsSharingViolation } from "../src/remote-socket-lock.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation failed`), { code });
}

describe("retryWhileWindowsSharingViolation", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])(
    "retries %s on Windows until a contender's read ends",
    async (code) => {
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(errno(code))
        .mockRejectedValueOnce(errno(code))
        .mockResolvedValue("renamed");
      await expect(retryWhileWindowsSharingViolation(operation, "win32")).resolves.toBe("renamed");
      expect(operation).toHaveBeenCalledTimes(3);
    },
  );

  it("does not retry the same codes on other platforms", async () => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(errno("EPERM"));
    await expect(retryWhileWindowsSharingViolation(operation, "linux")).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry other errors on Windows", async () => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(errno("ENOENT"));
    await expect(retryWhileWindowsSharingViolation(operation, "win32")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("gives up on Windows when the violation persists", async () => {
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(errno("EPERM"));
    await expect(retryWhileWindowsSharingViolation(operation, "win32")).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(operation).toHaveBeenCalledTimes(100);
  });
});
