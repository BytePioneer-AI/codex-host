import { describe, expect, it } from "vitest";

import {
  buildDiagnosticReport,
  issueUrl,
  redactHome,
  serializeDiagnosticReport,
} from "../src/diagnostic-report.js";

const home = "/Users/alice";

async function report() {
  return buildDiagnosticReport(
    {
      consoleVersion: "source",
      distribution: { version: "1.2.3", distribution: "npm", target: "macos-arm64" },
      summary: { state: "startup-failed", detail: "boom" },
      inspect: null,
      inspectError: null,
      startup: [
        {
          id: "1",
          pid: 1,
          launcherVersion: "1.2.3",
          startedAtMs: 1,
          finishedAtMs: 2,
          outcome: "failed",
          error: `bundled Shim '${home}/lib/codexhost-shim' is missing`,
          stages: [{ name: "launch requested", elapsedMs: 0 }],
          desktop: null,
        },
      ],
      controller: null,
      controllerAlive: false,
      logs: [
        { name: "host-runtime-2.log", size: 10, modifiedAt: 2 },
        { name: "host-runtime-1.log", size: 10, modifiedAt: 1 },
        { name: "host-runtime-0.log", size: 10, modifiedAt: 0 },
      ],
    },
    async (name) => `${name} at ${home}/x`,
    () => new Date(0),
  );
}

describe("diagnostic report", () => {
  it("includes the newest two log tails and redacts the home directory", async () => {
    const value = await report();
    expect(value.logs.map((log) => log.name)).toEqual(["host-runtime-2.log", "host-runtime-1.log"]);
    const text = serializeDiagnosticReport(value, home);
    expect(text).not.toContain(home);
    expect(text).toContain("~/lib/codexhost-shim");
  });

  it("redacts JSON-escaped Windows home paths", () => {
    const windowsHome = "C:\\Users\\alice";
    expect(redactHome(JSON.stringify({ path: `${windowsHome}\\app` }), windowsHome)).toBe(
      JSON.stringify({ path: "~\\app" }),
    );
  });

  it("prefills an issue without logs or the home directory", async () => {
    const url = issueUrl(await report(), home);
    const parameters = new URL(url).searchParams;
    expect(parameters.get("title")).toBe("codexhost failed to start");
    const body = parameters.get("body") ?? "";
    expect(body).toContain("codexhost: 1.2.3 (npm, macos-arm64)");
    expect(body).toContain("~/lib/codexhost-shim");
    expect(body).not.toContain(home);
    expect(body).not.toContain("host-runtime-2.log");
  });
});
