import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { NetworkInterfaceInfo } from "node:os";
import { it } from "node:test";

import { networkAccessUrls, reachableNetworkUrls } from "../src/network-urls.ts";
import { fakeTailscale } from "./support/tailscale.ts";

function ipv4(address: string, internal = false): NetworkInterfaceInfo[] {
  return [{ address, internal, family: "IPv4", netmask: "", mac: "", cidr: null }];
}

const MACHINE = {
  lo0: ipv4("127.0.0.1", true),
  bridge100: ipv4("192.168.139.3"),
  en0: ipv4("10.11.26.162"),
  docker0: ipv4("172.17.0.1"),
  "vEthernet (WSL)": ipv4("172.24.0.1"),
  "vEthernet (External)": ipv4("192.168.1.8"),
  utun7: ipv4("100.89.178.38"),
};

it("orders addresses by how likely another device can reach them", () => {
  assert.deepEqual(networkAccessUrls("0.0.0.0", 4400, MACHINE), [
    { kind: "tailscale", url: "http://100.89.178.38:4400/" },
    { kind: "lan", url: "http://10.11.26.162:4400/" },
    { kind: "lan", url: "http://192.168.1.8:4400/" },
    { kind: "virtual", url: "http://192.168.139.3:4400/" },
    { kind: "virtual", url: "http://172.17.0.1:4400/" },
    { kind: "virtual", url: "http://172.24.0.1:4400/" },
  ]);
});

it("rejects invalid public URLs before initializing Web or Host state", async (t) => {
  const cli = fakeTailscale(t);
  const home = mkdtempSync(join(tmpdir(), "codexhost-public-url-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const value of [
    "not a URL",
    "ftp://code.example.com",
    "https://example.com/codex",
    "https://example.com/?q=1",
    "https://example.com/#token=x",
    "https://user:pass@example.com",
  ]) {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "src/main.ts", "--public-url", value],
        { cwd: resolve(import.meta.dirname, ".."), env: { ...cli.environment, HOME: home } },
      ),
      /--public-url:/u,
    );
  }
});

it("offers no address when listening only on this computer", () => {
  assert.deepEqual(networkAccessUrls("127.0.0.1", 4400, MACHINE), []);
});

it("treats an explicitly chosen address as reachable", () => {
  assert.deepEqual(networkAccessUrls("192.168.139.3", 4400, MACHINE), [
    { kind: "lan", url: "http://192.168.139.3:4400/" },
  ]);
});

it("prints virtual addresses only when nothing else is available", () => {
  const virtual = { kind: "virtual" as const, url: "http://192.168.139.3:4400/" };
  const lan = { kind: "lan" as const, url: "http://10.11.26.162:4400/" };
  assert.deepEqual(reachableNetworkUrls([lan, virtual]), [lan]);
  assert.deepEqual(reachableNetworkUrls([virtual]), [virtual]);
});
