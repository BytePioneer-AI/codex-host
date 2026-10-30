import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { checkQoderLogin, qoderLoginRequired } from "../src/qoder-login-check.js";

const result = vi.hoisted(() => ({
  error: null as { killed: boolean } | null,
  stdout: "",
  stderr: "",
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file, _args, _options, callback) =>
    callback(result.error, result.stdout, result.stderr),
  ),
}));
beforeEach(() => {
  result.error = { killed: false };
  result.stdout = "";
  result.stderr = "";
  vi.clearAllMocks();
});

describe("Qoder native login diagnostic", () => {
  it("recognizes explicit login failures without returning native output", async () => {
    result.stdout = "Not logged in. Run `qoderclicn login` to authenticate.";
    expect(await checkQoderLogin("/selected/qoderclicn", {}, "/workspace")).toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      "/selected/qoderclicn",
      ["--list-models"],
      expect.objectContaining({ cwd: "/workspace", env: {}, timeout: 10000, maxBuffer: 65536 }),
      expect.any(Function),
    );
  });
  it("does not infer login from network errors or generic transport failures", async () => {
    result.stderr = "Transport closed: connection reset";
    expect(await checkQoderLogin("qodercli", undefined, undefined)).toBe(false);
    expect(qoderLoginRequired("token budget exceeded")).toBe(false);
  });
  it("does not classify successful or timed-out commands as login errors", async () => {
    result.stdout = "Not logged in";
    result.error = null;
    expect(await checkQoderLogin("qodercli", undefined, undefined)).toBe(false);
    result.error = { killed: true };
    expect(await checkQoderLogin("qodercli", undefined, undefined)).toBe(false);
  });
});
