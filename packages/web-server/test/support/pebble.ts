import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import https, { Agent, get } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type { TestContext } from "node:test";
import { connectRelay } from "../../src/remote-relay/client.ts";
import { relayIdentity } from "../../src/remote-relay/identity.ts";
import { RelayTls } from "../../src/remote-relay/tls.ts";
import { RequestTrust } from "../../src/request-trust.ts";
import { relayData, startRelay, until } from "./relay.ts";
import { defined } from "./defined.ts";

export function environment(t: TestContext, values: Record<string, string>): void {
  const previous = { ...process.env };
  Object.assign(process.env, values);
  t.after(() => {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = previous[key];
    }
  });
}

export function httpsText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      let text = "";
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => resolve(text));
      response.on("error", reject);
    }).on("error", reject);
  });
}

export async function pebble(t: TestContext, reuse: 0 | 100) {
  const directory = process.env.CODEXHOST_TEST_PEBBLE_DIR;
  assert.ok(
    directory,
    "CODEXHOST_TEST_PEBBLE_DIR must contain Pebble binaries and test certificates",
  );
  // Node's native env-proxy agent snapshots the parent environment at startup.
  const agent = https.globalAgent;
  https.globalAgent = new Agent({ keepAlive: true });
  t.after(() => {
    https.globalAgent.destroy();
    https.globalAgent = agent;
  });
  const cas = getCACertificates("default");
  setDefaultCACertificates([...cas, readFileSync(join(directory, "pebble.minica.pem"), "utf8")]);
  t.after(() => setDefaultCACertificates(cas));
  environment(t, {
    HTTPS_PROXY: "",
    https_proxy: "",
    ALL_PROXY: "",
    all_proxy: "",
    NO_PROXY: "",
    no_proxy: "",
  });
  const relay = await startRelay(t);
  const data = relayData(t);
  const identity = relayIdentity(data);
  const hostname = `${identity.id}.relay.test`;
  const tls = new RelayTls(
    createServer((_req, res) => res.end("phone")),
    new RequestTrust(undefined),
  );
  let registered = false;
  const disconnect = connectRelay({
    host: `localhost:${relay.port}`,
    identity,
    connecting: () => {
      registered = false;
    },
    registered: () => {
      registered = true;
    },
    stopped: () => {
      registered = false;
    },
    tcp: (stream, headers) => tls.accept(stream, headers, hostname),
  });
  t.after(disconnect);
  await until(() => registered);
  async function child(binary: string, args: string[], env: Record<string, string>, ready: string) {
    const process = spawn(join(defined(directory), binary), args, {
      env: { ...globalThis.process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    process.stdout.on("data", (chunk) => {
      output += chunk;
    });
    process.stderr.on("data", (chunk) => {
      output += chunk;
    });
    t.after(async () => {
      if (process.exitCode === null && process.signalCode === null) {
        const exited = once(process, "exit");
        process.kill("SIGTERM");
        await exited;
      }
    });
    try {
      await until(() => output.includes(ready), 10_000);
    } catch (error) {
      throw new Error(output, { cause: error });
    }
  }
  await child(
    "pebble-challtestsrv",
    [
      "-dnsserver",
      "127.0.0.1:4490",
      "-management",
      "127.0.0.1:4491",
      "-defaultIPv4",
      "127.0.0.1",
      "-defaultIPv6",
      "",
      "-http01",
      "",
      "-https01",
      "",
      "-tlsalpn01",
      "",
      "-doh",
      "",
    ],
    {},
    "Starting management server",
  );
  const config = data.path("pebble.json");
  writeFileSync(
    config,
    JSON.stringify({
      pebble: {
        listenAddress: "127.0.0.1:4492",
        managementListenAddress: "127.0.0.1:4493",
        certificate: join(directory, "cert.pem"),
        privateKey: join(directory, "key.pem"),
        httpPort: 4494,
        tlsPort: relay.port,
      },
    }),
  );
  await child(
    "pebble",
    ["-config", config, "-dnsserver", "127.0.0.1:4490"],
    {
      PEBBLE_VA_NOSLEEP: "1",
      PEBBLE_VA_ALWAYS_VALID: "0",
      PEBBLE_AUTHZREUSE: String(reuse),
    },
    "ACME directory available",
  );
  return {
    data,
    tls,
    relay,
    identity,
    hostname,
    disconnect,
    directory: "https://localhost:4492/dir",
    root: await httpsText("https://localhost:4493/roots/0"),
  };
}

export async function httpProxy(t: TestContext) {
  const proxy = createServer((_req, res) => res.writeHead(500).end());
  const targets: string[] = [];
  const sockets = new Set<Duplex>();
  proxy.on("connect", (request, socket, head) => {
    targets.push(defined(request.url));
    const [host, port] = defined(request.url).split(":");
    assert.equal(host, "localhost");
    assert.equal(port, "4492");
    const upstream = connect({ host, port: Number(port) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket);
    sockets.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  environment(t, { HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` });
  return targets;
}
