import { describe, expect, it, vi } from "vitest";
import { stopDevelopment } from "./stop.mjs";
import {
  identifyStopTarget,
  listUserProcesses,
  stopProcess,
  waitForExit,
} from "./stop-processes.mjs";

const candidate = (pid, command, parentPid = 1) => ({ pid, parentPid, created: "start", command });
const supervisor = candidate(
  100,
  "/release/bin/codexhost web-service serve --node /node --web-runtime /release/app/web-server.mjs --data /data --ready-file /data/ready",
);
const web = candidate(
  101,
  "/node --disable-warning=UNDICI-EHPA /release/app/web-server.mjs --background --ready-file /data/web-service-node-ready.json --ch-data /data",
  100,
);
const json = async (file) =>
  file.endsWith("/app/codexhost-distribution.json")
    ? { schemaVersion: 1, distribution: "installer" }
    : null;
const identify = (process) => identifyStopTarget(process, { json });

describe("development stop", () => {
  it("recognizes background Web entrypoints and the exact native supervisor command", async () => {
    expect(await identify(supervisor)).toMatchObject({ kind: "web-supervisor" });
    expect(await identify(web)).toMatchObject({
      kind: "web",
      entry: "/release/app/web-server.mjs",
    });
    for (const distribution of ["installer", "npm"]) {
      expect(
        await identifyStopTarget(
          candidate(
            102,
            '"C:\\Program Files\\nodejs\\node.exe" "C:\\release\\app\\web-server.mjs" --background',
          ),
          {
            json: async (file) =>
              file.endsWith("codexhost-distribution.json")
                ? { schemaVersion: 1, distribution }
                : null,
          },
        ),
      ).toMatchObject({ kind: "web" });
    }
    expect(
      await identify(
        candidate(100, '"C:\\release\\bin\\codexhost.exe" web-service serve --data "C:\\data"'),
      ),
    ).toMatchObject({ kind: "web-supervisor" });
    expect(await identifyStopTarget(web, { json: async () => null })).toBeNull();
    for (const command of [
      "/release/bin/codexhost web-service stop --data /data",
      "/release/bin/codexhost web-service ensure --data /data",
      "/release/bin/codexhost web --background",
      "/release/bin/codexhost host serve --data /data",
      "/node other.js --entry /release/app/web-server.mjs",
      "/node /release/app/web-server.mjs.bak --background",
      "/python /release/bin/codexhost web-service serve --data /data",
      "/node /release/bin/codexhost web-service serve --data /data",
    ])
      expect(await identify(candidate(200, command))).toBeNull();
  });

  it("stops the Web supervisor and child before Host and waits for native Host cleanup", async () => {
    const hostSupervisor = candidate(200, "/release/bin/codexhost host serve --data /data");
    const host = candidate(201, "/node /release/app/host-runtime.mjs --codexhost-shared-host", 200);
    const console = candidate(300, "/node /release/app/console-server.mjs serve");
    let processes = [console, host, web, hostSupervisor, supervisor];
    const calls = [];
    const list = async () => processes;
    await stopDevelopment({
      arguments_: [],
      list,
      identify,
      log: () => {},
      stop: async (target) => {
        calls.push(target.kind);
        await stopProcess(target, {
          list,
          platform: "darwin",
          signal: (pid) => {
            processes = processes.filter((process) => process.pid !== pid);
          },
        });
      },
      wait: async (target) => {
        expect(target).toBe(hostSupervisor);
        calls.push("wait-host-supervisor");
        processes = processes.filter((process) => process.pid !== target.pid);
        await waitForExit(target, { list });
      },
    });
    expect(calls).toEqual([
      "web-supervisor",
      "web",
      "shared-host",
      "wait-host-supervisor",
      "console",
    ]);
    expect(processes).toEqual([]);
  });

  it("stops a supervisor during backoff even when no Web child is present", async () => {
    let processes = [supervisor];
    const stop = vi.fn(async () => {
      processes = [];
    });
    await stopDevelopment({
      arguments_: [],
      list: async () => processes,
      identify,
      stop,
      log: () => {},
    });
    expect(stop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: "web-supervisor" }),
      expect.anything(),
    );
  });

  it("rejects an unverified Host supervisor before stopping any target", async () => {
    const stop = vi.fn();
    await expect(
      stopDevelopment({
        arguments_: [],
        list: async () => [
          supervisor,
          web,
          candidate(201, "/node /release/app/host-runtime.mjs --codexhost-shared-host", 999),
        ],
        identify,
        stop,
        log: () => {},
      }),
    ).rejects.toThrow("Cannot verify the supervisor");
    expect(stop).not.toHaveBeenCalled();
  });

  it("rechecks background process identity before signalling and waits for exit", async () => {
    for (const replacement of [
      { ...supervisor, created: "new" },
      { ...web, command: "/node other.js" },
    ]) {
      const signal = vi.fn();
      await stopProcess(replacement.pid === supervisor.pid ? supervisor : web, {
        list: async () => [replacement],
        platform: "darwin",
        signal,
      });
      expect(signal).not.toHaveBeenCalled();
    }
    const signal = vi.fn();
    await expect(
      stopProcess(supervisor, {
        list: async () => [supervisor],
        platform: "darwin",
        signal,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("did not exit");
    expect(signal).toHaveBeenCalledExactlyOnceWith(supervisor.pid);
  });

  it("uses the verified Windows process tree and tolerates its child already exiting", async () => {
    let processes = [supervisor, web];
    const run = vi.fn(async () => {
      processes = [];
    });
    const list = async () => processes;
    await stopProcess(supervisor, { list, platform: "win32", run });
    await stopProcess(web, { list, platform: "win32", run });
    expect(run).toHaveBeenCalledExactlyOnceWith("taskkill.exe", ["/PID", "100", "/T", "/F"]);
    const enumerate = vi.fn(async () => ({ stdout: JSON.stringify([supervisor, web]) }));
    expect(await listUserProcesses({ platform: "win32", run: enumerate })).toEqual([
      supervisor,
      web,
    ]);
    expect(enumerate.mock.calls[0][1].at(-1)).toContain("GetOwnerSid");
    expect(enumerate.mock.calls[0][1].at(-1)).toContain("Name = 'codexhost.exe'");
  });

  it("reports services that remain rather than claiming completion", async () => {
    await expect(
      stopDevelopment({
        arguments_: [],
        list: async () => [supervisor],
        identify,
        stop: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow("Managed services are still running");
  });

  it("shows help without enumerating or stopping services", async () => {
    const list = vi.fn();
    const log = vi.fn();
    await stopDevelopment({ arguments_: ["--help"], list, log });
    expect(list).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain("background Web");
  });
});
