import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acme from "acme-client";
import { afterEach, expect, it, vi } from "vitest";
import { createRelay } from "../src/index.js";
import { acmeServer, signCertificate } from "./acme-server.js";
import { certPath, collect, fakeAgent, keyPath, phone } from "./helpers.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

async function fixture(hostname = "relay.example.test") {
  const data = mkdtempSync(join(tmpdir(), "relay-acme-"));
  cleanups.push(() => rmSync(data, { recursive: true, force: true }));
  writeFileSync(join(data, "test-ext.cnf"), `subjectAltName=DNS:${hostname}\n`);
  let port = 0;
  const ca = await acmeServer(data, hostname, () => port);
  cleanups.push(() => ca.close());
  vi.stubEnv("CODEXHOST_RELAY_ACME_DIRECTORY", ca.directory);
  const start = async (controlHost?: string) => {
    const relay = createRelay({
      domain: "example.test",
      dataDir: data,
      ...(controlHost ? { controlHost } : {}),
      onRequest: (_request, response) => {
        response.end("ready");
      },
    });
    cleanups.push(async () => {
      if (relay.server.listening) await relay.close();
    });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    port = (relay.server.address() as { port: number }).port;
    return relay;
  };
  const ready = async () => {
    await vi.waitFor(() =>
      expect(existsSync(join(data, "certificate.pem")), String(ca.probeError)).toBe(true),
    );
  };
  return {
    data,
    ca,
    start,
    ready,
    get port() {
      return port;
    },
  };
}

it.skipIf(process.platform === "win32").each([undefined, "control.example.test"])(
  "issues through local ACME with default or explicit control host %s and reuses disk state",
  async (controlHost) => {
    const hostname = controlHost ?? "relay.example.test";
    const f = await fixture(hostname);
    const relay = await f.start(controlHost);
    await f.ready();
    expect(f.ca.validations).toBe(1);
    expect(f.ca.orders).toBe(1);
    const client = phone(hostname, undefined, f.port);
    await once(client, "secureConnect");
    expect(client.getPeerCertificate().subjectaltname).toBe(`DNS:${hostname}`);
    const result = collect(client);
    client.write(`GET / HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    expect((await result).toString()).toContain("ready");
    client.destroy();
    const account = readFileSync(join(f.data, "acme-account.pem"));
    const key = readFileSync(join(f.data, "certificate-key.pem"));
    for (const file of ["acme-account.pem", "certificate-key.pem", "certificate.pem"])
      expect(statSync(join(f.data, file)).mode & 0o777).toBe(0o600);
    await relay.close();
    await f.start(controlHost);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.ca.orders).toBe(1);
    expect(readFileSync(join(f.data, "acme-account.pem"))).toEqual(account);
    expect(readFileSync(join(f.data, "certificate-key.pem"))).toEqual(key);
  },
);

it("renews at two-thirds of validity without disconnecting existing controls", async () => {
  const f = await fixture();
  const key = await acme.crypto.createPrivateEcdsaKey();
  const [, csr] = await acme.crypto.createCsr({ altNames: ["relay.example.test"] }, key);
  writeFileSync(join(f.data, "certificate-key.pem"), key);
  const old = signCertificate(f.data, csr, 3);
  writeFileSync(join(f.data, "certificate.pem"), old);
  const interval = vi.spyOn(globalThis, "setInterval");
  const relay = await f.start();
  const agent = await fakeAgent({ port: f.port, controlHost: "relay.example.test" });
  await agent.registered;
  expect(f.ca.orders).toBe(0);
  const certificate = new X509Certificate(old);
  const from = Date.parse(certificate.validFrom);
  const renewal = from + ((Date.parse(certificate.validTo) - from) * 2) / 3;
  const now = vi.spyOn(Date, "now").mockReturnValue(renewal - 1);
  const check = interval.mock.calls.find((call) => call[1] === 15 * 60_000)?.[0];
  if (typeof check !== "function") throw new Error("Missing certificate check");
  check();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.ca.orders).toBe(0);
  now.mockReturnValue(renewal);
  check();
  await vi.waitFor(() =>
    expect(readFileSync(join(f.data, "certificate.pem"), "utf8")).not.toBe(old),
  );
  expect(f.ca.orders).toBe(1);
  expect(f.ca.validations).toBe(1);
  expect(agent.ws.readyState).toBe(1);
  const client = phone("relay.example.test", undefined, f.port);
  await once(client, "secureConnect");
  expect(client.getPeerCertificate().fingerprint256).not.toBe(certificate.fingerprint256);
  client.destroy();
  await relay.close();
});

it("keeps the old certificate after a failed renewal and rejects new controls at expiry", async () => {
  const f = await fixture();
  const key = await acme.crypto.createPrivateEcdsaKey();
  const [, csr] = await acme.crypto.createCsr({ altNames: ["relay.example.test"] }, key);
  writeFileSync(join(f.data, "certificate-key.pem"), key);
  const old = signCertificate(f.data, csr, 3);
  writeFileSync(join(f.data, "certificate.pem"), old);
  f.ca.fail();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const interval = vi.spyOn(globalThis, "setInterval");
  await f.start();
  const certificate = new X509Certificate(old);
  const from = Date.parse(certificate.validFrom);
  const until = Date.parse(certificate.validTo);
  const now = vi.spyOn(Date, "now").mockReturnValue(from + ((until - from) * 2) / 3);
  const check = interval.mock.calls.find((call) => call[1] === 15 * 60_000)?.[0];
  if (typeof check !== "function") throw new Error("Missing certificate check");
  check();
  await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
  expect(readFileSync(join(f.data, "certificate.pem"), "utf8")).toBe(old);
  const client = phone("relay.example.test", undefined, f.port);
  await once(client, "secureConnect");
  expect(client.getPeerCertificate().fingerprint256).toBe(certificate.fingerprint256);
  client.destroy();
  now.mockReturnValue(until);
  const expired = phone("relay.example.test", undefined, f.port);
  let connected = false;
  expired.on("secureConnect", () => {
    connected = true;
  });
  await new Promise<void>((resolve) => expired.once("close", () => resolve()));
  expect(connected).toBe(false);
});

it("retries a failed issuance on the next 15-minute check", async () => {
  const f = await fixture();
  f.ca.fail();
  const failure = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await f.start();
  await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(1));
  expect(f.ca.orders).toBe(1);
  vi.advanceTimersByTime(15 * 60_000 - 1);
  expect(f.ca.orders).toBe(1);
  vi.advanceTimersByTime(1);
  await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(2));
  expect(f.ca.orders).toBe(2);
});

it("retries immediately after restarting a failed issuance", async () => {
  const f = await fixture();
  f.ca.fail();
  const failure = vi.spyOn(console, "error").mockImplementation(() => {});
  const relay = await f.start();
  await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(1));
  expect(f.ca.orders).toBe(1);
  const account = readFileSync(join(f.data, "acme-account.pem"));
  await relay.close();
  await f.start();
  await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(2));
  expect(f.ca.orders).toBe(2);
  expect(readFileSync(join(f.data, "acme-account.pem"))).toEqual(account);
  expect(existsSync(join(f.data, "certificate.pem"))).toBe(false);
  expect(existsSync(join(f.data, "certificate-state.json"))).toBe(false);
});

it("uses supplied certificates without making an ACME request or creating data", async () => {
  const f = await fixture();
  const relay = createRelay({
    domain: "example.test",
    cert: certPath,
    key: keyPath,
    dataDir: join(f.data, "unused"),
  });
  cleanups.push(() => relay.close());
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const port = (relay.server.address() as { port: number }).port;
  const client = phone("relay.example.test", undefined, port);
  await once(client, "secureConnect");
  client.destroy();
  expect(f.ca.orders).toBe(0);
  expect(existsSync(join(f.data, "unused"))).toBe(false);
});

it("requires --cert and --key together", () => {
  expect(() => createRelay({ domain: "example.test", cert: certPath })).toThrow(
    "provided together",
  );
  expect(() => createRelay({ domain: "example.test", key: keyPath })).toThrow("provided together");
});
