import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  parseModelCatalogFromHelp,
  resolveModelCatalogFromCli,
  staticModelCatalog,
} from "../src/model-catalog.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    this.emit("close", null, "SIGTERM");
    return true;
  }
}

const HELP = `--model <model> Currently supported: (gpt-5.6-luna, glm-5.3-flash-ioa)`;

describe("CodeBuddy model catalog", () => {
  it("includes a default Model when parsing CLI help", () => {
    const catalog = parseModelCatalogFromHelp(HELP);

    expect(catalog?.defaultModel).toEqual({ id: "gpt-5.6-luna" });
  });

  it("uses the CodeBuddy configured Model as the catalog default", async () => {
    const spawn = (command: string, args: readonly string[]) => {
      if (command !== "codebuddy") throw new Error(`Unexpected executable: ${command}`);
      const child = new FakeChild();
      queueMicrotask(() => {
        if (args[0] === "--help") child.stdout.write(`${HELP}\n`);
        if (args[0] === "config") child.stdout.write("glm-5.3-flash-ioa\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    };

    const catalog = await resolveModelCatalogFromCli("codebuddy", "/tmp", {
      timeoutMs: 1_000,
      fallback: null,
      spawn: spawn as never,
    });

    expect(catalog.defaultModel).toEqual({ id: "glm-5.3-flash-ioa" });
    expect(catalog.models.map(({ ref }) => ref.id)).toContain("glm-5.3-flash-ioa");
  });

  it("keeps a usable default when the CLI help fallback is used", () => {
    const catalog = staticModelCatalog();

    expect(catalog.defaultModel).toEqual(catalog.models[0]?.ref);
  });
});
