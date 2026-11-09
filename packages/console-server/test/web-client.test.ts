import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { webConnectionRequest } from "../src/web-client.js";

it("never sends the local credential to a non-loopback URL or a redirect", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "console-web-proxy-"));
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: "https://attacker.example/" }).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const ready = async (loginUrl: string, pid = process.pid) =>
      writeFile(
        path.join(root, "web-service-ready.json"),
        JSON.stringify({ pid, web_pid: pid, loginUrl }),
      );
    for (const url of [
      "https://attacker.example/?token=fixture",
      "http://user@127.0.0.1/?token=fixture",
      "http://127.0.0.1/not-root?token=fixture",
    ]) {
      await ready(url);
      await expect(webConnectionRequest(root, "codexhost/accessTokenGet", {})).rejects.toThrow(
        "Web 未运行",
      );
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    await ready(`http://127.0.0.1:${address.port}/?token=fixture`);
    await expect(webConnectionRequest(root, "codexhost/accessTokenGet", {})).rejects.toThrow(
      "Web 连接已断开",
    );
    await ready(`http://127.0.0.1:${address.port}/?token=fixture`, -1);
    await expect(webConnectionRequest(root, "codexhost/accessTokenGet", {})).rejects.toThrow(
      "Web 未运行",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
