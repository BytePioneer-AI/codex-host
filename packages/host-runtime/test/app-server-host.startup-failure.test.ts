import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MappingStore } from "@codexhost/mapping-store";
import { describe, expect, it } from "vitest";

import { createProductionExternalThreadStore } from "../src/external-thread-repository.js";
import { createFixture } from "./app-server-host-fixture.js";

describe("AppServerHost startup failure", () => {
  it("names the Mapping Store owner and restates the failure as its final diagnostic", async () => {
    const dataDirectory = mkdtempSync(path.join(tmpdir(), "codexhost-startup-failure-"));
    const mappingStoreDirectory = path.join(dataDirectory, "mapping-store");
    const listenerStore = createProductionExternalThreadStore(
      { CODEXHOST_DATA_DIR: dataDirectory },
      "remote app-server listener",
    );
    await listenerStore.initialize();
    const fixture = createFixture({
      mappingStoreDirectory,
      mappingStore: new MappingStore({ directory: mappingStoreDirectory }),
    });
    try {
      await expect(fixture.running).resolves.toBe(1);
      const output: string = fixture.diagnosticOutput.read()?.toString() ?? "";
      const lines = output.split("\n").filter((line) => line.length > 0);
      const owner = new RegExp(
        `Another codexhost process owns Mapping Store at ${mappingStoreDirectory.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\(PID ${process.pid}, remote app-server listener, started [^)]+\\)$`,
        "u",
      );
      expect(lines[0]).toMatch(/^codexhost Host Runtime: Host initialization failed: /u);
      expect(lines[0]).toMatch(owner);
      expect(lines.at(-1)).toMatch(
        /^codexhost Host Runtime: exiting: Host initialization failed: Another codexhost process owns Mapping Store/u,
      );
      expect(lines.at(-1)).toMatch(owner);
    } finally {
      await listenerStore.close();
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
});
