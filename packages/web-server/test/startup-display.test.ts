import assert from "node:assert/strict";
import { it } from "node:test";
import { formatWebStartup } from "../src/startup-display.ts";

const localUrl = "http://127.0.0.1:4400/?token=test-token";

it("left-aligns startup output and retains token-bearing URLs without the data directory", () => {
  const output = formatWebStartup({
    localUrl,
    networkUrls: [
      { kind: "tailscale", url: "http://100.89.178.38:4400/?token=test-token" },
      { kind: "lan", url: "http://192.168.1.2:4400/?token=test-token" },
    ],
    qrCode: "██ ██\n█  ██\n",
  });
  assert.equal(output.split("\n")[0], `codexhost web: ${localUrl}`);
  assert.ok(output.includes("\nNetwork access\n"));
  assert.ok(output.includes("\nTailscale:     http://100.89.178.38:4400/?token=test-token"));
  assert.ok(output.includes("\nLAN:           http://192.168.1.2:4400/?token=test-token"));
  assert.equal(output.includes("Data directory"), false);
  for (const line of output.split("\n").filter(Boolean)) {
    assert.equal(/^\s/u.test(line), false, `Unexpected indentation: ${line}`);
    if (line.includes("http://")) assert.equal(line.indexOf("http://"), 15);
  }
  assert.ok(output.includes("Phone access · Tailscale"));
  assert.ok(output.includes("Connect both devices to Tailscale, then scan."));
  assert.ok(output.includes("\n██ ██\n█  ██\n"));
  assert.ok(output.includes("Keep access links and QR codes private."));
});

it("labels a LAN QR code with the same-Wi-Fi requirement", () => {
  const output = formatWebStartup({
    localUrl,
    networkUrls: [{ kind: "lan", url: "http://192.168.1.2:4400/" }],
    qrCode: "QR",
  });
  assert.ok(output.includes("Phone access · LAN"));
  assert.ok(output.includes("same Wi-Fi"));
  assert.equal(output.includes("Tailscale"), false);
});

it("omits the scanner section without a rendered QR code or network address", () => {
  for (const networkUrls of [[], [{ kind: "lan" as const, url: "http://192.168.1.2:4400/" }]]) {
    const output = formatWebStartup({ localUrl, networkUrls });
    assert.equal(output.includes("Phone access"), false);
    assert.equal(output.includes("Data directory"), false);
  }
});
