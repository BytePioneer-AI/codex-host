import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMimo } from "../src/server.js";

vi.mock("@codexhost/harness-discovery", () => ({
  resolveHarnessExecutable: () => ({ executable: "mimo" }),
  commandInvocation: () => ({ command: "mimo", arguments: [] }),
}));
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      child.stdout.write("mimocode server listening on http://127.0.0.1:12345\n");
    });
    return child;
  },
}));

afterEach(() => vi.unstubAllGlobals());

describe("MiMo service compatibility", () => {
  function health(version: string, healthy = true) {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (request: Request) => {
      requests.push(request);
      return Response.json({ healthy, version });
    });
    return requests;
  }

  it.each(["0.1.14", "0.1.15"])("connects to validated CLI %s", async (version) => {
    const requests = health(version);
    const connection = await connectMimo({ cwd: process.cwd(), environment: {} });
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/global/health");
    await connection.close();
    expect(requests[0]?.signal.aborted).toBe(true);
  });

  it.each(["0.1.13", "0.1.16", "0.2.0", "0.1.15-preview"])(
    "rejects unvalidated CLI %s with the actual version",
    async (version) => {
      const requests = health(version);
      await expect(connectMimo({ cwd: process.cwd(), environment: {} })).rejects.toMatchObject({
        code: "unsupported",
        message: `MiMo integration supports native CLI 0.1.14 or 0.1.15; received ${version}`,
      });
      expect(requests[0]?.signal.aborted).toBe(true);
    },
  );

  it("reports an unhealthy service as unavailable and cleans up the connection", async () => {
    const requests = health("0.1.15", false);
    await expect(connectMimo({ cwd: process.cwd(), environment: {} })).rejects.toMatchObject({
      code: "unavailable",
      message: "MiMo service health check failed",
    });
    expect(requests[0]?.signal.aborted).toBe(true);
  });
});
