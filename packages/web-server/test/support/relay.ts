import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import type { TestContext } from "node:test";
import { createRelay, type RelayOptions } from "@codexhost/remote-relay";
import { DataDir } from "../../src/store.ts";

export const certPath = fileURLToPath(new URL("../fixtures/relay/cert.pem", import.meta.url));
export const keyPath = fileURLToPath(new URL("../fixtures/relay/key.pem", import.meta.url));
export const credentials = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
setDefaultCACertificates([...getCACertificates("default"), credentials.cert.toString()]);

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), "condition did not become true");
}
export function relayData(t: TestContext): DataDir {
  const data = new DataDir(mkdtempSync(join(tmpdir(), "web-relay-")));
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  return data;
}
export async function startRelay(
  t: TestContext,
  heartbeatInterval = 25,
  options: Partial<RelayOptions> = {},
) {
  const relay = createRelay({
    domain: "relay.test",
    controlHost: "localhost",
    cert: certPath,
    key: keyPath,
    heartbeatInterval,
    ...options,
  });
  relay.server.listen(0, "::");
  await once(relay.server, "listening");
  t.after(async () => {
    if (relay.server.listening) await relay.close();
  });
  return { ...relay, port: (relay.server.address() as { port: number }).port };
}
