import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/bridge.js";
import { discoverBridges, sameDirectory } from "../src/discovery.js";
import type { Endpoint } from "../src/protocol.js";

const { startServer } = createRequire(import.meta.url)("../assets/companion/server.cjs");

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trae-cn-client-"));
  const appRoot = path.join(directory, "installation", "resources", "app");
  const workspace = path.join(directory, "workspace");
  const discovery = path.join(directory, "discovery");
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
      executable: path.join(directory, "installation", "Trae CN.exe"),
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
