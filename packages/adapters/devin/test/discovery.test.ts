import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessInspectionSchema } from "@codexhost/shared-contracts";
import { DevinAdapter } from "../src/adapter.js";
import { DevinTransport } from "../src/transport.js";
import { listDevinSessions } from "../src/sessions.js";

vi.mock("../src/command.js", () => ({
  devinInvocation: () => ({
    command: process.execPath,
    arguments: [fileURLToPath(new URL("./fixtures/discovery-acp.mjs", import.meta.url))],
    windowsVerbatimArguments: false,
  }),
}));

type Request = { pid: number; method: string; params?: { cursor?: string } };
let root: string;
let log: string;
const adapters: DevinAdapter[] = [];
const transports: DevinTransport[] = [];
function adapter(scenario = "normal", timeoutMs = 2_000) {
  const value = new DevinAdapter({
    environment: { DEVIN_DISCOVERY_SCENARIO: scenario, DEVIN_DISCOVERY_LOG: log },
    timeoutMs,
  });
  adapters.push(value);
  return value;
}
async function requests(): Promise<Request[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.trim()
    ? text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Request)
    : [];
}
function exited(pid: number | undefined) {
  if (pid === undefined) throw new Error("No synthetic native process was started");
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devin-discovery-")));
  log = path.join(root, "requests.jsonl");
});
afterEach(async () => {
  await Promise.all([
    ...adapters.splice(0).map((value) => value.close()),
    ...transports.splice(0).map((value) => value.close()),
  ]);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("Devin sessionless availability", () => {
  it("checks status without creating/loading a Session or prompting, and caches by cwd", async () => {
    const value = adapter();
    const inspection = await value.inspect({ cwd: root, purpose: "availability" });
    expect(harnessInspectionSchema.safeParse(inspection).success).toBe(true);
    expect(inspection).toMatchObject({
      status: "ready",
      catalog: { models: [], thinkingOptions: [] },
    });
    const first = await requests();
    expect(first.map(({ method }) => method)).toEqual(["initialize", "session/list"]);
    expect(exited(first[0]?.pid)).toBe(true);
    await value.inspect({ cwd: root, purpose: "availability" });
    expect(await requests()).toEqual(first);
    await value.inspect({ cwd: root, purpose: "availability", refresh: true });
    expect((await requests()).map(({ method }) => method)).toEqual([
      "initialize",
      "session/list",
      "initialize",
      "session/list",
    ]);
    await value.inspect({ cwd: process.cwd(), purpose: "availability" });
    expect((await requests()).filter(({ method }) => method === "initialize")).toHaveLength(3);
  });

  it("does not reuse status-only results as the selected Harness catalog", async () => {
    const value = adapter();
    await value.inspect({ purpose: "availability" });
    const inspection = await value.inspect();
    expect(
      inspection.status === "ready" && inspection.catalog.models.map(({ label }) => label),
    ).toEqual(["A"]);
    await value.inspect();
    expect((await requests()).map(({ method }) => method)).toEqual([
      "initialize",
      "session/list",
      "initialize",
      "session/new",
    ]);
  });

  it("invalidates a completed full catalog after an explicit status refresh", async () => {
    const value = adapter();
    await value.inspect();
    await value.inspect({ purpose: "availability", refresh: true });
    await value.inspect();
    expect((await requests()).filter(({ method }) => method === "session/new")).toHaveLength(2);
  });

  it("deduplicates concurrent status checks and reports native authentication errors", async () => {
    const value = adapter("auth-error");
    const results = await Promise.all([
      value.inspect({ purpose: "availability" }),
      value.inspect({ purpose: "availability" }),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({
        status: "unavailable",
        error: { code: "authenticationRequired" },
      });
      expect(harnessInspectionSchema.safeParse(result).success).toBe(true);
    }
    expect((await requests()).map(({ method }) => method)).toEqual(["initialize", "session/list"]);
  });
});

describe("Devin import query lifetime", () => {
  it.each(["list", "resolve", "availability"] as const)(
    "bounds a stalled %s query and waits for process cleanup",
    async (operation) => {
      const value = adapter("stalled-list", 300);
      const result = await (operation === "list"
        ? value.sessionImport.listCandidates()
        : operation === "resolve"
          ? value.sessionImport.resolveCandidate("older")
          : value.inspect({ purpose: "availability" }));
      if ("ok" in result)
        expect(result).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining("timed out") },
        });
      else
        expect(result).toMatchObject({
          status: "unavailable",
          error: { message: expect.stringContaining("timed out") },
        });
      const calls = await requests();
      expect(calls.some(({ method }) => method === "session/list")).toBe(true);
      expect(exited(calls[0]?.pid)).toBe(true);
    },
  );

  it.each(["stalled-initialize", "stalled-list"])(
    "adapter close cancels %s, releases its process, and refuses further reads",
    async (scenario) => {
      const value = adapter(scenario, 10_000);
      const pending = value.sessionImport.listCandidates();
      const method = scenario === "stalled-initialize" ? "initialize" : "session/list";
      await vi.waitFor(async () =>
        expect((await requests()).some((request) => request.method === method)).toBe(true),
      );
      const calls = await requests();
      const closing = value.close();
      expect(value.close()).toBe(closing);
      await closing;
      expect(await pending).toMatchObject({ ok: false, error: { code: "invalidState" } });
      expect(exited(calls[0]?.pid)).toBe(true);
      expect(await value.sessionImport.listCandidates()).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
      expect(await value.sessionImport.resolveCandidate("older")).toMatchObject({
        ok: false,
        error: { code: "invalidState" },
      });
      expect(await requests()).toEqual(calls);
    },
  );

  it("closes a pending availability check without waiting for its RPC timeout", async () => {
    const value = adapter("stalled-list", 10_000);
    const pending = value.inspect({ purpose: "availability" });
    await vi.waitFor(async () =>
      expect((await requests()).some(({ method }) => method === "session/list")).toBe(true),
    );
    await value.close();
    expect(await pending).toMatchObject({ status: "unavailable", error: { code: "invalidState" } });
    expect(exited((await requests())[0]?.pid)).toBe(true);
  });
});

describe("Devin paginated native discovery", () => {
  it("lists and resolves older Sessions, and uses every page for cwd verification", async () => {
    const value = adapter();
    const listed = await value.sessionImport.listCandidates();
    expect(listed.ok && listed.value.map(({ nativeSessionId }) => nativeSessionId)).toEqual([
      "newer",
      "older",
    ]);
    const resolved = await value.sessionImport.resolveCandidate("older");
    expect(resolved).toMatchObject({
      ok: true,
      value: { nativeRef: { nativeSessionId: "older", harnessId: "devin" } },
    });
    expect(await value.sessionImport.resolveCandidate("missing")).toMatchObject({
      ok: false,
      error: { code: "sessionNotFound" },
    });
    const transport = new DevinTransport({
      cwd: root,
      environment: { DEVIN_DISCOVERY_LOG: log },
      timeoutMs: 2_000,
    });
    transports.push(transport);
    await transport.probe();
    transport.sessionId = "older";
    await expect(transport.verifyCwd(root)).resolves.toBeUndefined();
    await expect(transport.verifyCwd("/wrong-cwd")).rejects.toThrow("cwd does not match");
    expect(
      (await requests())
        .filter(({ method }) => method === "session/list")
        .map(({ params }) => params),
    ).toEqual(Array.from({ length: 5 }, () => [{}, { cursor: "page2" }]).flat());
  });

  it.each(["repeated-cursor", "page-error"])(
    "rejects %s rather than returning a partial list or a false absence",
    async (scenario) => {
      const value = adapter(scenario);
      expect(await value.sessionImport.listCandidates()).toMatchObject({
        ok: false,
        error: { code: "protocolError" },
      });
      expect(await value.sessionImport.resolveCandidate("missing")).toMatchObject({
        ok: false,
        error: { code: "protocolError" },
      });
      expect((await requests()).filter(({ method }) => method === "session/list")).toHaveLength(4);
    },
  );

  it("rejects duplicate IDs and malformed cursors without looping", async () => {
    const session = { sessionId: "a", cwd: root };
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [session], nextCursor: "more" })
      .mockResolvedValueOnce({ sessions: [session] });
    await expect(listDevinSessions({ listSessions })).rejects.toThrow("duplicate Session IDs");
    for (const nextCursor of ["", 7]) {
      await expect(
        listDevinSessions({
          listSessions: vi.fn().mockResolvedValue({ sessions: [], nextCursor }),
        }),
      ).rejects.toThrow("invalid or repeated cursor");
    }
  });
});
