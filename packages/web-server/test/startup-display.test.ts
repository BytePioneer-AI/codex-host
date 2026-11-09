import assert from "node:assert/strict";
import { it } from "node:test";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { startServer } from "./support/server.ts";
import { fakeTailscale, RUNNING, serveStatus, SERVE_HOST } from "./support/tailscale.ts";
import { formatWebStartup } from "../src/startup-display.ts";

it("left-aligns access details with token-free network addresses", () => {
  const output = formatWebStartup({
    networkUrls: [
      { kind: "tailscale", url: "http://100.89.178.38:4400/" },
      { kind: "lan", url: "http://192.168.1.2:4400/" },
    ],
    qrCode: "██ ██\n█  ██\n",
  });
  assert.equal(output.includes("codexhost web:"), false);
  assert.ok(output.includes("\nNetwork access\n"));
  assert.ok(output.includes("\nTailscale:     http://100.89.178.38:4400/\n"));
  assert.ok(output.includes("\nLAN:           http://192.168.1.2:4400/\n"));
  assert.ok(output.includes("Settings → Connect devices"));
  assert.ok(output.includes("not encrypted"));
  assert.equal(output.includes("Data directory"), false);
  for (const line of output.split("\n").filter(Boolean)) {
    assert.equal(/^\s/u.test(line), false, `Unexpected indentation: ${line}`);
    if (line.includes("http://")) assert.equal(line.indexOf("http://"), 15);
  }
  assert.ok(output.includes("Phone access · Tailscale"));
  assert.ok(output.includes("Connect both devices to Tailscale, then scan."));
  assert.ok(output.includes("\n██ ██\n█  ██\n"));
  assert.ok(output.includes("Keep access links private."));
});

it("labels a LAN QR code with the same-Wi-Fi requirement", () => {
  const output = formatWebStartup({
    networkUrls: [{ kind: "lan", url: "http://192.168.1.2:4400/" }],
    qrCode: "QR",
  });
  assert.ok(output.includes("Phone access · LAN"));
  assert.ok(output.includes("same Wi-Fi"));
  assert.equal(output.includes("Tailscale"), false);
});

it("omits the scanner section without a rendered QR code or network address", () => {
  for (const networkUrls of [[], [{ kind: "lan" as const, url: "http://192.168.1.2:4400/" }]]) {
    const output = formatWebStartup({ networkUrls });
    assert.equal(output.includes("Phone access"), false);
    assert.equal(output.includes("Data directory"), false);
    assert.equal(output.includes("not encrypted"), networkUrls.length > 0);
  }
});

it("prints public, Funnel and Serve labels with the correct phone instructions", () => {
  for (const kind of ["public", "tailscale-funnel", "tailscale-https"] as const) {
    const output = formatWebStartup({
      networkUrls: [{ kind, url: "https://code.example.com/" }],
      qrCode: "QR",
    });
    assert.equal(output.includes("same Wi-Fi"), false);
    assert.equal(output.includes("both devices to Tailscale"), kind === "tailscale-https");
    assert.equal(output.includes("anyone on the Internet"), kind === "tailscale-funnel");
  }
});

it(
  "starts with the unchanged local line before Tailscale times out",
  { timeout: 15_000 },
  async (t) => {
    const cli = fakeTailscale(t);
    cli.set(RUNNING, {}, { delay: 10_000 });
    const printed = Promise.withResolvers<string>();
    const base = await startServer(
      t,
      resolve(import.meta.dirname, ".."),
      ["--import", "tsx", "src/main.ts"],
      ["--public-url", "https://code.example.com", "--token", "startup-test-token"],
      {
        authenticated: true,
        environment: cli.environment,
        onSpawn(child) {
          let output = "";
          child.stdout?.on("data", (chunk) => {
            output += String(chunk);
            if (output.includes("Keep access links private.")) printed.resolve(output);
          });
        },
      },
    );
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/\?token=startup-test-token$/u);
    const started = Date.now();
    const response = await fetch(new URL("/api/auth/status", base), {
      headers: { authorization: "Bearer startup-test-token" },
    });
    assert.equal(response.status, 200);
    assert.ok(Date.now() - started < 2_000, "HTTP does not wait for Tailscale detection");
    const output = await printed.promise;
    assert.equal(output.split("\n")[0], `codexhost web: ${base}`);
    assert.match(output, /Public:\s+https:\/\/code.example.com\//u);
  },
);

it(
  "includes the detected Serve or Funnel address in real startup output",
  { timeout: 15_000 },
  async (t) => {
    const cli = fakeTailscale(t);
    for (const funnel of [false, true]) {
      const reservation = createServer();
      await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((done) => reservation.close(() => done()));
      cli.set(RUNNING, serveStatus(port, funnel));
      const printed = Promise.withResolvers<string>();
      await startServer(
        t,
        resolve(import.meta.dirname, ".."),
        ["--import", "tsx", "src/main.ts"],
        ["--port", String(port)],
        {
          authenticated: true,
          environment: cli.environment,
          onSpawn(child) {
            let output = "";
            child.stdout?.on("data", (chunk) => {
              output += String(chunk);
              if (output.includes("Keep access links private.")) printed.resolve(output);
            });
          },
        },
      );
      const output = await printed.promise;
      assert.ok(output.includes(`https://${SERVE_HOST}/`));
      assert.ok(output.includes(funnel ? "Funnel (public)" : "Tailscale HTTPS"));
    }
  },
);

it("explains when a specific interface leaves the access token unavailable", () => {
  const output = formatWebStartup({
    networkUrls: [{ kind: "lan", url: "http://192.168.1.2:4400/" }],
    localManagementUnavailable: true,
  });
  assert.ok(output.includes("cannot be viewed here"));
});
