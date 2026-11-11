import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/bridge.js";
import { TraeCnAdapter } from "../src/adapter.js";
import { discoverBridges, sameDirectory } from "../src/discovery.js";
import type { Endpoint } from "../src/protocol.js";

const { startServer } = createRequire(import.meta.url)("../assets/companion/server.cjs");

async function setup(discoveryDirectory?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trae-cn-client-"));
  const appRoot =
    process.platform === "darwin"
      ? path.join(directory, "installation", "Trae CN.app", "Contents", "Resources", "app")
      : path.join(directory, "installation", "resources", "app");
  const workspace = path.join(directory, "workspace");
  const discovery = discoveryDirectory ?? path.join(directory, "discovery");
  await mkdir(appRoot, { recursive: true });
  await mkdir(workspace);
  await writeFile(
    path.join(appRoot, "product.json"),
    JSON.stringify({ applicationName: "trae-cn" }),
  );
  const service = {
    application: {
      name: "Trae CN",
      version: "fixture",
      root: appRoot,
      executable:
        process.platform === "darwin"
          ? path.join(directory, "installation", "Trae CN.app", "Contents", "MacOS", "Trae CN")
          : path.join(directory, "installation", "Trae CN.exe"),
    },
    workspaceFolders: [workspace],
    inspect: vi.fn(async () => ({
      application: service.application,
      workspaceFolders: [workspace],
      agentType: "builder_v3",
      models: [{ id: "seed", label: "Seed", provider: "native", multimodal: false }],
    })),
    call: vi.fn(async () => ({ sessionId: "session" })),
    subscribe: vi.fn(),
  };
  const bridge: { endpoint: Endpoint; endpointFile: string; close(): Promise<void> } =
    await startServer(service, discovery);
  const options = { cwd: workspace, environment: { CODEXHOST_TRAE_CN_BRIDGE_DIR: discovery } };
  return {
    directory,
    service,
    bridge,
    options,
    async close() {
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("TRAE CN desktop bridge client", () => {
  it("discovers only the selected workspace and installation without starting native sessions", async () => {
    const test = await setup();
    try {
      expect(await discoverBridges(test.options)).toHaveLength(1);
      expect(await discoverBridges({ ...test.options, cwd: test.directory })).toEqual([]);
      expect(await discoverBridges({ ...test.options, app: test.directory })).toEqual([]);
      expect(
        await discoverBridges({ ...test.options, app: test.service.application.executable }),
      ).toHaveLength(1);
      const { client, inspection } = await BridgeClient.connect(test.options);
      try {
        expect(inspection.models).toEqual([
          { id: "seed", label: "Seed", provider: "native", multimodal: false },
        ]);
        expect(test.service.call).not.toHaveBeenCalled();
        expect(test.service.subscribe).not.toHaveBeenCalled();
      } finally {
        client.close();
      }
    } finally {
      await test.close();
    }
  });

  it("inspects a sole Bridge from another workspace but still rejects opening that workspace", async () => {
    const test = await setup();
    const adapter = new TraeCnAdapter({ environment: test.options.environment });
    try {
      for (const input of [{}, { cwd: test.directory }]) {
        expect(await adapter.inspect(input)).toMatchObject({
          status: "ready",
          catalog: { models: [{ label: "Seed" }] },
        });
      }
      expect(await adapter.open({ kind: "create", cwd: test.directory })).toMatchObject({
        ok: false,
        error: {
          code: "configurationRequired",
          message: "Open this workspace in TRAE CN with the CodexHost Companion enabled",
        },
      });
      expect(test.service.call).not.toHaveBeenCalled();
      expect(test.service.subscribe).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
      await test.close();
    }
  });

  it("prefers a matching workspace for inspection, otherwise retaining discovery order", async () => {
    const first = await setup();
    const second = await setup(first.options.environment.CODEXHOST_TRAE_CN_BRIDGE_DIR);
    const adapter = new TraeCnAdapter({ environment: first.options.environment });
    try {
      const endpoints = await discoverBridges(first.options, false);
      expect(endpoints).toHaveLength(2);
      const last = endpoints.at(-1);
      if (!last) throw new Error("Missing fixture Bridge");
      const preferred = last.port === first.bridge.endpoint.port ? first : second;
      const fallback = preferred === first ? second : first;
      expect(await adapter.inspect({ cwd: preferred.options.cwd })).toMatchObject({
        status: "ready",
      });
      expect(preferred.service.inspect).toHaveBeenCalledOnce();
      expect(fallback.service.inspect).not.toHaveBeenCalled();
      preferred.service.inspect.mockClear();
      expect(await adapter.inspect({ cwd: first.directory })).toMatchObject({ status: "ready" });
      expect(fallback.service.inspect).toHaveBeenCalledOnce();
      expect(preferred.service.inspect).not.toHaveBeenCalled();
      expect(first.service.call).not.toHaveBeenCalled();
      expect(second.service.call).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
      await second.close();
      await first.close();
    }
  });

  it("keeps the connected workspace recheck on Session paths only", async () => {
    const test = await setup();
    const adapter = new TraeCnAdapter({ environment: test.options.environment });
    try {
      test.service.inspect.mockResolvedValue({
        ...(await test.service.inspect()),
        workspaceFolders: [test.directory],
      });
      expect(await adapter.inspect({ cwd: test.options.cwd })).toMatchObject({ status: "ready" });
      expect(await adapter.open({ kind: "create", cwd: test.options.cwd })).toMatchObject({
        ok: false,
        error: { code: "configurationRequired", message: "The TRAE CN workspace changed" },
      });
      expect(test.service.call).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
      await test.close();
    }
  });

  it("ignores invalid metadata and a different product without deleting either", async () => {
    const test = await setup();
    try {
      await writeFile(test.bridge.endpointFile, "{");
      expect(await discoverBridges(test.options)).toEqual([]);
      expect(await readFile(test.bridge.endpointFile, "utf8")).toBe("{");
      await writeFile(test.bridge.endpointFile, JSON.stringify(test.bridge.endpoint), {
        mode: 0o600,
      });
      await writeFile(
        path.join(test.service.application.root, "product.json"),
        JSON.stringify({ applicationName: "trae" }),
      );
      expect(await discoverBridges(test.options)).toEqual([]);
    } finally {
      await test.close();
    }
  });

  it("does not retry native writes after an uncertain bridge failure", async () => {
    const test = await setup();
    test.service.call.mockRejectedValue(new Error("Native receipt unavailable"));
    const client = new BridgeClient(test.bridge.endpoint);
    try {
      await expect(client.call("start", { sessionId: "session" })).rejects.toMatchObject({
        code: "nativeFailure",
      });
      expect(test.service.call).toHaveBeenCalledOnce();
    } finally {
      client.close();
      await test.close();
    }
  });

  it("receives events sent before subscribe resolves and preserves their order", async () => {
    const test = await setup();
    const nativeCancel = vi.fn();
    test.service.subscribe.mockImplementation(async (_input, listener) => {
      listener.data({ event: "plan_item", payload: { summary: "你好🌏" } });
      listener.data({ event: "done", payload: { status: "completed" } });
      listener.end();
      return nativeCancel;
    });
    const client = new BridgeClient(test.bridge.endpoint);
    const events: unknown[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        void client
          .subscribe(
            { sessionId: "session" },
            { event: (event) => events.push(event), error: reject, end: resolve },
          )
          .catch(reject);
      });
      expect(events).toEqual([
        { event: "plan_item", payload: { summary: "你好🌏" } },
        { event: "done", payload: { status: "completed" } },
      ]);
      expect(nativeCancel).toHaveBeenCalledOnce();
    } finally {
      client.close();
      await test.close();
    }
  });

  it("closing an observer releases only the subscription, without cancelling a native turn", async () => {
    const test = await setup();
    const nativeCancel = vi.fn();
    test.service.subscribe.mockResolvedValue(nativeCancel);
    const client = new BridgeClient(test.bridge.endpoint);
    const listener = { event: vi.fn(), error: vi.fn(), end: vi.fn() };
    try {
      const cancel = await client.subscribe({ sessionId: "session" }, listener);
      cancel();
      await vi.waitFor(() => expect(nativeCancel).toHaveBeenCalledOnce());
      expect(test.service.call).not.toHaveBeenCalled();
      expect(listener.end).not.toHaveBeenCalled();
      expect(listener.error).not.toHaveBeenCalled();
    } finally {
      client.close();
      await test.close();
    }
  });

  it("rejects an instance nonce mismatch", async () => {
    const test = await setup();
    const client = new BridgeClient({ ...test.bridge.endpoint, instanceId: "stale" });
    try {
      await expect(client.inspect()).rejects.toMatchObject({ code: "protocolError" });
    } finally {
      client.close();
      await test.close();
    }
  });

  it("normalizes Windows directory case and separators without matching a parent", () => {
    expect(sameDirectory("C:\\Work\\Project\\", "c:/work/project", "win32")).toBe(true);
    expect(sameDirectory("C:\\Work", "C:\\Work\\Project", "win32")).toBe(false);
  });
});

describe("TRAE CN NDJSON stream framing", () => {
  it.each(["split-utf8", "premature-eof"])(
    "handles %s without fabricating native completion",
    async (mode) => {
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        const body = Buffer.from(
          JSON.stringify({ type: "event", value: { event: "plan_item", payload: "你好🌏" } }) +
            "\n",
        );
        const split = body.indexOf(Buffer.from("🌏")) + 1;
        response.write(body.subarray(0, split));
        setImmediate(() => {
          response.write(body.subarray(split));
          response.end(mode === "split-utf8" ? '{"type":"end"}\n' : "");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const client = new BridgeClient({ port: address.port, token: "a".repeat(64) } as Endpoint);
      const events: unknown[] = [];
      const outcome = await new Promise<unknown>((resolve, reject) => {
        void client
          .subscribe(
            { sessionId: "session" },
            { event: (event) => events.push(event), end: () => resolve("end"), error: resolve },
          )
          .catch(reject);
      });
      try {
        expect(events).toEqual([{ event: "plan_item", payload: "你好🌏" }]);
        if (mode === "split-utf8") expect(outcome).toBe("end");
        else
          expect(outcome).toMatchObject({
            code: "protocolError",
            message: "TRAE CN stream closed without a terminal frame",
          });
      } finally {
        client.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
