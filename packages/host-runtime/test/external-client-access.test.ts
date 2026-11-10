import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import {
  ExternalAccessSupervisor,
  readAccessStatus,
  writeAccessSettings,
} from "../src/external-client-access.js";
import { startExternalClientServer } from "../src/external-client-server.js";
import { ExternalClientRegistry, type ClientNetwork } from "../src/external-clients.js";
import {
  createTailscaleControl,
  parseFunnelStatus,
  parseTailscaleStatus,
  type TailscaleControl,
} from "../src/tailscale.js";

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "mac-pro.tail0292a9.ts.net.", TailscaleIPs: ["100.101.1.2", "fd7a:115c::1"] },
});

describe("Tailscale control", () => {
  it("reads the IPv4 address and DNS name, and reports why it is unavailable", () => {
    expect(parseTailscaleStatus(STATUS)).toEqual({
      running: true,
      address: "100.101.1.2",
      dnsName: "mac-pro.tail0292a9.ts.net",
    });
    expect(parseTailscaleStatus('{"BackendState":"Stopped"}')).toEqual({
      running: false,
      reason: "Tailscale is Stopped",
    });
  });

  it("finds codexhost's Funnel path only", () => {
    const text = JSON.stringify({
      Web: {
        "mac-pro.ts.net:443": {
          Handlers: {
            "/other": { Proxy: "http://127.0.0.1:9" },
            "/codexhost": { Proxy: "http://127.0.0.1:5000" },
            "/.well-known/oauth-protected-resource/codexhost/mcp": {
              Proxy: "http://127.0.0.1:5000/.well-known/oauth-protected-resource",
            },
            "/.well-known/oauth-authorization-server/codexhost": {
              Proxy: "http://127.0.0.1:5000/.well-known/oauth-authorization-server",
            },
          },
        },
      },
    });
    expect(parseFunnelStatus(text)).toEqual({
      target: "http://127.0.0.1:5000",
      complete: true,
    });
    expect(
      parseFunnelStatus(
        '{"Web":{"h:443":{"Handlers":{"/codexhost":{"Proxy":"http://127.0.0.1:5000"}}}}}',
      ),
    ).toEqual({
      target: "http://127.0.0.1:5000",
      complete: false,
    });
    expect(parseFunnelStatus("")).toEqual({});
    expect(parseFunnelStatus('{"Web":{"h:443":{"Handlers":{"/other":{"Proxy":"x"}}}}}')).toEqual(
      {},
    );
  });

  it("adds and removes only its own path", async () => {
    const run = vi.fn(async () => "");
    const control = createTailscaleControl({}, run);
    await control.setFunnel("http://127.0.0.1:5000");
    await control.clearFunnel();
    expect(run.mock.calls).toEqual([
      [["funnel", "--bg", "--set-path=/codexhost", "http://127.0.0.1:5000"]],
      [
        [
          "funnel",
          "--bg",
          "--set-path=/.well-known/oauth-protected-resource/codexhost/mcp",
          "http://127.0.0.1:5000/.well-known/oauth-protected-resource",
        ],
      ],
      [
        [
          "funnel",
          "--bg",
          "--set-path=/.well-known/oauth-authorization-server/codexhost",
          "http://127.0.0.1:5000/.well-known/oauth-authorization-server",
        ],
      ],
      [["funnel", "--set-path=/codexhost", "off"]],
      [["funnel", "--set-path=/.well-known/oauth-protected-resource/codexhost/mcp", "off"]],
      [["funnel", "--set-path=/.well-known/oauth-authorization-server/codexhost", "off"]],
    ]);
    const failing = createTailscaleControl({}, async () => {
      throw new Error("tailscale: not found");
    });
    await expect(failing.state()).resolves.toMatchObject({
      running: false,
      reason: expect.stringContaining("not found"),
    });
  });
});

describe("external access supervisor", () => {
  let directory: string;
  let registry: ExternalClientRegistry;
  let token: string;
  let tailscale: TailscaleControl & { mapping: string | undefined; address: string | undefined };
  let supervisor: ExternalAccessSupervisor | undefined;
  const settingsPath = () => path.join(directory, "access.json");
  const statusPath = () => path.join(directory, "status.json");

  function fakeTailscale(): typeof tailscale {
    const fake = {
      mapping: undefined as string | undefined,
      address: "127.0.0.1" as string | undefined,
      state: vi.fn(async () =>
        fake.address
          ? { running: true, address: fake.address, dnsName: "mac-pro.tail.ts.net" }
          : { running: false, reason: "Tailscale is Stopped" },
      ),
      funnel: vi.fn(async () => (fake.mapping ? { target: fake.mapping } : {})),
      setFunnel: vi.fn(async (target: string) => {
        fake.mapping = target;
      }),
      clearFunnel: vi.fn(async () => {
        fake.mapping = undefined;
      }),
    };
    return fake;
  }

  function create(): ExternalAccessSupervisor {
    supervisor = new ExternalAccessSupervisor({
      settingsPath: settingsPath(),
      statusPath: statusPath(),
      tailscale,
      port: 0,
      start: (options: { network: ClientNetwork; host: string; port: number }) =>
        startExternalClientServer({
          ...options,
          clients: registry,
          route: async (call) => ({ client: call.client, network: call.network }),
        }),
    });
    return supervisor;
  }

  const call = (endpoint: string) =>
    fetch(new URL("v1/harness/list", `${endpoint}/`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-access-supervisor-"));
    registry = new ExternalClientRegistry(path.join(directory, "clients.json"));
    ({ token } = await registry.add("bot", { networks: ["local", "tailnet", "public"] }));
    tailscale = fakeTailscale();
  });
  afterEach(async () => {
    await supervisor?.close();
    supervisor = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  it("does nothing, not even asking Tailscale, while both switches are off", async () => {
    await create().reconcile();
    expect(tailscale.state).not.toHaveBeenCalled();
    expect(tailscale.funnel).not.toHaveBeenCalled();
    await expect(readAccessStatus(statusPath())).resolves.toMatchObject({
      tailnet: { state: "off" },
      public: { state: "off" },
    });
  });

  it("serves the tailnet address as the tailnet network and rebinds when it changes", async () => {
    await writeAccessSettings(settingsPath(), { tailnet: true, public: false });
    await create().reconcile();
    const first = (await readAccessStatus(statusPath()))?.tailnet;
    expect(first).toMatchObject({
      state: "on",
      endpoint: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/u),
    });
    await expect((await call(first?.endpoint ?? "")).json()).resolves.toEqual({
      client: "bot",
      network: "tailnet",
    });

    tailscale.address = "::1";
    await supervisor?.reconcile();
    const second = (await readAccessStatus(statusPath()))?.tailnet;
    expect(second?.endpoint).toMatch(/^http:\/\/\[::1\]:/u);
    await expect(call(first?.endpoint ?? "")).rejects.toThrow();

    tailscale.address = undefined;
    await supervisor?.reconcile();
    await expect(readAccessStatus(statusPath())).resolves.toMatchObject({
      tailnet: { state: "unavailable", reason: "Tailscale is Stopped" },
    });
  });

  it("opens the public listener behind codexhost's Funnel path and removes it when turned off", async () => {
    await writeAccessSettings(settingsPath(), { tailnet: false, public: true });
    await create().reconcile();
    const status = (await readAccessStatus(statusPath()))?.public;
    expect(status).toEqual({
      state: "on",
      endpoint: "https://mac-pro.tail.ts.net/codexhost",
      mcpUrl: "https://mac-pro.tail.ts.net/codexhost/mcp",
    });
    expect(tailscale.setFunnel).toHaveBeenCalledOnce();
    const target = tailscale.mapping ?? "";
    await expect((await call(target)).json()).resolves.toEqual({
      client: "bot",
      network: "public",
    });

    // An unchanged mapping is not rewritten.
    await supervisor?.reconcile();
    expect(tailscale.setFunnel).toHaveBeenCalledOnce();

    await writeAccessSettings(settingsPath(), { tailnet: false, public: false });
    await supervisor?.reconcile();
    expect(tailscale.clearFunnel).toHaveBeenCalledOnce();
    await expect(call(target)).rejects.toThrow();
  });

  it("never replaces a Funnel path that points somewhere else", async () => {
    tailscale.mapping = "http://192.168.1.5:8080";
    await writeAccessSettings(settingsPath(), { tailnet: false, public: true });
    await create().reconcile();
    expect(tailscale.setFunnel).not.toHaveBeenCalled();
    await expect(readAccessStatus(statusPath())).resolves.toMatchObject({
      public: { state: "unavailable", reason: expect.stringContaining("already mapped") },
    });
  });

  it("removes a mapping left by a previous Runtime once public access is off", async () => {
    await writeAccessSettings(settingsPath(), { tailnet: false, public: true });
    await create().reconcile();
    await supervisor?.close();
    await writeAccessSettings(settingsPath(), { tailnet: false, public: false });
    await create().reconcile();
    expect(tailscale.clearFunnel).toHaveBeenCalledOnce();
    expect(tailscale.mapping).toBeUndefined();
  });

  it("switches access from the CLI", async () => {
    const output = new PassThrough();
    await expect(
      runDelegationCli({
        arguments: ["client", "access", "--tailnet", "on"],
        environment: { CODEXHOST_DATA_DIR: directory },
        output,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(String(output.read()))).toMatchObject({
      settings: { tailnet: true, public: false },
      status: null,
      note: expect.stringContaining("30 seconds"),
    });
  });
});
