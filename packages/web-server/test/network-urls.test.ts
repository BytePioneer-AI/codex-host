import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { it } from "node:test";

import { networkAccessUrls, reachableNetworkUrls } from "../src/network-urls.ts";

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
