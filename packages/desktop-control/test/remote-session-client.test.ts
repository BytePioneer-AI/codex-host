import { createServer } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  requestRemoteSession,
  remoteSessionDescriptorPaths,
} from "../src/remote-session-client.js";

describe("remote session authenticated Controller client", () => {
  it("rejects oversized wire messages before descriptor access", async () => {
    await expect(
      requestRemoteSession(
        {
          kind: "prompt",
          hostId: "remote-control:a",
          threadId: "t",
          epoch: "e",
          text: "中".repeat(6000),
        },
        "missing-descriptor",
      ),
    ).rejects.toThrow("too large");
  });
  it("fails closed when multiple live descriptors disagree", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-descriptors-"));
    try {
      const paths = [join(directory, "one.json"), join(directory, "two.json")];
      await Promise.all(
        paths.map((path, index) =>
          writeFile(
            path,
            JSON.stringify({
              schema_version: 1,
              launcher_pid: process.pid,
              control_port: index + 1,
              nonce: "1".repeat(32),
            }),
            { mode: 0o600 },
          ),
        ),
      );
      await expect(requestRemoteSession({ kind: "hosts" }, paths)).rejects.toThrow("ambiguous");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("discovers the standard Linux Desktop runtime when Web lacks its XDG environment", () => {
    const paths = remoteSessionDescriptorPaths({}, "linux", "/home/test", 1234);
    expect(paths).toContain(join("/run/user/1234", "codexhost", "desktop-runtime-v1.json"));
    expect(paths).toContain(
      join("/home/test", ".local", "state", "codexhost", "desktop-runtime-v1.json"),
    );
    const explicit = join(tmpdir(), "explicit-descriptor.json");
    expect(
      remoteSessionDescriptorPaths(
        { CODEXHOST_DESKTOP_RUNTIME_DESCRIPTOR: explicit },
        "linux",
        "/home/test",
        1234,
      ),
    ).toEqual([explicit]);
  });
  it.each([false, true])(
    "uses only the owned descriptor and never retries a lost result (%s)",
    async (loseResult) => {
      const directory = await mkdtemp(join(tmpdir(), "remote-controller-"));
      const path = join(directory, "desktop-runtime-v1.json");
      const nonce = "1".repeat(32);
      let requests = 0;
      const server = createServer((socket) => {
        let value = "";
        socket.on("data", (chunk) => {
          value += String(chunk);
          if (!value.includes("\n")) return;
          requests++;
          expect(value.startsWith(`REMOTE ${nonce} `)).toBe(true);
          const request = JSON.parse(value.slice(`REMOTE ${nonce} `.length));
          expect(request).toMatchObject({
            action: "session",
            operation: { hostId: "remote-ssh-discovered:test", threadId: "native" },
          });
          if (loseResult) socket.destroy();
          else socket.end(JSON.stringify({ result: { accepted: true } }) + "\n");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
      try {
        await writeFile(
          path,
          JSON.stringify({
            schema_version: 1,
            launcher_pid: process.pid,
            control_port: address.port,
            nonce,
          }),
          { mode: 0o600 },
        );
        const result = requestRemoteSession(
          {
            kind: "rename",
            hostId: "remote-ssh-discovered:test",
            threadId: "native",
            epoch: "fixture",
            name: "title",
          },
          [join(directory, "missing.json"), path],
        );
        if (loseResult) await expect(result).rejects.toThrow();
        else await expect(result).resolves.toEqual({ accepted: true });
        expect(requests).toBe(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("rejects invalid descriptor versions before opening a socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-controller-"));
    const path = join(directory, "descriptor.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          schema_version: 99,
          launcher_pid: process.pid,
          control_port: 1,
          nonce: "1".repeat(32),
        }),
        { mode: 0o600 },
      );
      await expect(requestRemoteSession({ kind: "hosts" }, path)).rejects.toThrow("invalid");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
