import { describe, expect, it, vi } from "vitest";
import { extractErrors, readJobErrors, redactLogLine } from "../src/ci-logs.mjs";
import { repo } from "./fixtures.mjs";

const diagnostic =
  "src/foo.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.";
const job = {
  id: 3,
  steps: [
    {
      conclusion: "failure",
      started_at: "2026-09-10T12:00:00Z",
      completed_at: "2026-09-10T12:00:10Z",
    },
  ],
};
const at = (text) => `2026-09-10T12:00:05.1234567Z ${text}`;
describe("literal, bounded and redacted CI excerpts", () => {
  it("strips runner timestamps and ANSI, retains diagnostics from the failed step only", () => {
    const log = [
      `2026-09-10T11:59:00Z ${diagnostic}`,
      at(`\u001b[31m${diagnostic}\u001b[0m`),
      at("##[error]Process completed with exit code 2."),
    ].join("\n");
    expect(extractErrors(log, job)).toEqual([diagnostic]);
    expect(extractErrors("unrecognised output", {})).toEqual([]);
  });
  it("recognizes Rust, Vitest and npm errors without interpretation", () => {
    for (const line of [
      "error[E0308]: mismatched types",
      "AssertionError: expected 2 to equal 1",
      "npm error code ELOCKVERIFY",
      "12:5 error Unexpected any @typescript-eslint/no-explicit-any",
    ]) {
      expect(extractErrors(at(line), job)).toEqual([line]);
    }
  });
  it("redacts named credentials, URLs, personal directories and token-shaped strings", () => {
    for (const line of [
      "Error: Authorization: Bearer private",
      "Error: MY_TOKEN=private",
      "Error: password=private",
      "Error: api_key=private",
    ])
      expect(redactLogLine(line)).not.toContain("private");
    expect(
      redactLogLine("Error: ghp_12345 https://user:pass@host/?sig=private /Users/alice/a.ts"),
    ).not.toMatch(/ghp_|user:pass|private|alice/u);
    expect(redactLogLine("Error: eyJhbGciOi.xxxxx.yyyyy")).not.toContain("eyJ");
    expect(redactLogLine(`Error: ${"a1".repeat(30)}`)).toBe("Error: [REDACTED]");
  });
  it("preserves long repository paths and includes Rust panic locations", () => {
    const test = " FAIL  packages/host-runtime/test/app-server-host.test.ts > example";
    const panic =
      "thread 'forwards_terminal_response_after_ready_handshake' panicked at crates/shim/tests/proxy.rs:42:5:";
    expect(extractErrors([at(test), at(panic)].join("\n"), job)).toEqual([test, panic]);
  });

  it("bounds lines and refuses oversized logs", () => {
    expect(
      extractErrors(Array.from({ length: 20 }, (_, i) => at(`Error: ${i}`)).join("\n"), job),
    ).toHaveLength(5);
    expect(extractErrors("x".repeat(8 * 1024 * 1024 + 1), job)).toEqual([]);
  });
  it("downloads a signed log URL without credentials or follow-up redirects", async () => {
    const fetchLog = vi.fn(async () => new Response(at(diagnostic)));
    const github = {
      rest: {
        actions: {
          downloadJobLogsForWorkflowRun: vi.fn(async () => {
            throw {
              status: 302,
              response: {
                status: 302,
                headers: { location: "https://logs.blob.core.windows.net/ci?sig=private" },
              },
            };
          }),
        },
      },
    };
    expect(await readJobErrors({ github, repo, job, fetchLog })).toEqual([diagnostic]);
    expect(fetchLog).toHaveBeenCalledWith(expect.any(URL), {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(github.rest.actions.downloadJobLogsForWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ job_id: 3, request: { redirect: "manual" } }),
    );
  });
  it("falls back without log content on API/host/download failure", async () => {
    const method = vi.fn();
    const github = { rest: { actions: { downloadJobLogsForWorkflowRun: method } } };
    const fetchLog = vi.fn();
    for (const url of [
      "http://logs.blob.core.windows.net/log",
      "https://example.com/log",
      "https://user:pass@logs.blob.core.windows.net/log",
    ]) {
      method.mockResolvedValue({ status: 302, headers: { location: url } });
      expect(await readJobErrors({ github, repo, job, fetchLog })).toEqual([]);
    }
    expect(fetchLog).not.toHaveBeenCalled();
    method.mockRejectedValue(new Error("unavailable"));
    expect(await readJobErrors({ github, repo, job, fetchLog })).toEqual([]);
    method.mockResolvedValue({
      status: 302,
      headers: { location: "https://logs.blob.core.windows.net/log" },
    });
    fetchLog.mockResolvedValue(new Response("x".repeat(8 * 1024 * 1024 + 1)));
    expect(await readJobErrors({ github, repo, job, fetchLog })).toEqual([]);
  });
});
