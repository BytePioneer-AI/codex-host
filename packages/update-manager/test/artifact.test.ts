import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { downloadArtifact } from "../src/artifact.js";

test("download transport cancels a stalled real response with the caller budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-abort-"));
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.write("partial body");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  try {
    // Loopback exercises transport cancellation only, not production HTTPS trust.
    await expect(
      downloadArtifact(
        { url: `http://127.0.0.1:${address.port}/stalled`, sha256: "ab".repeat(32) },
        path.join(root, "partial"),
        undefined,
        { signal: AbortSignal.timeout(50) },
      ),
    ).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
