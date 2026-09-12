import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { readOfficialCliVersion } from "../src/codex-runtime/official-cli-version.js";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

describe("stock CLI version discovery", () => {
  it.each(["0.153.4", "0.154.0-alpha.6.2"])(
    "retains the exact native %s version",
    async (version) => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback !== "function") throw new Error("Missing callback");
        callback(null, `codex-cli ${version}\n`, "");
        return {} as ReturnType<typeof execFile>;
      });
      await expect(readOfficialCliVersion("/synthetic/codex", {})).resolves.toBe(version);
    },
  );
  it.each([
    "codex-cli 0.154.0-alpha.6.2\nunexpected",
    "codex-cli latest",
    "codex-cli 0.154.0-",
    "0.153.4",
  ])("rejects unrecognized version output", async (output) => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("Missing callback");
      callback(null, output, "");
      return {} as ReturnType<typeof execFile>;
    });
    await expect(readOfficialCliVersion("/synthetic/codex", {})).rejects.toThrow(
      "Unsupported official CLI version",
    );
  });
});
