import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  isGlibcLoaderFailure,
  JS_ENTRYPOINT_MARKER,
  renderRemoteHostJsEntrypoint,
} from "../src/remote-host-js-entrypoint.js";

describe("remote Host Node entrypoint", () => {
  it("detects a dynamic loader glibc failure", () => {
    expect(
      isGlibcLoaderFailure(
        "/home/pengqlu/.codexhost/remote/bin/codex: /lib64/libc.so.6: version `GLIBC_2.29' not found",
      ),
    ).toBe(true);
    expect(isGlibcLoaderFailure("codexhost remote: CODEXHOST_STOCK_CODEX_PATH is required")).toBe(
      false,
    );
  });

  it.skipIf(process.platform === "win32")("self-checks listener classification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-js-entrypoint-"));
    const wrapperPath = path.join(root, "codex");
    try {
      await writeFile(wrapperPath, renderRemoteHostJsEntrypoint(process.execPath), {
        encoding: "utf8",
        mode: 0o700,
      });
      await chmod(wrapperPath, 0o700);
      const result = spawnSync(process.execPath, [wrapperPath], {
        encoding: "utf8",
        env: { ...process.env, CODEXHOST_JS_ENTRYPOINT_SELFTEST: "1" },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("ok\n");
      expect(await readFile(wrapperPath, "utf8")).toContain(JS_ENTRYPOINT_MARKER);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("forwards proxy invocations to stock Codex", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-js-proxy-"));
    const wrapperPath = path.join(root, "codex");
    const stockPath = path.join(root, "stock-codex");
    const recordPath = path.join(root, "args.json");
    try {
      await writeFile(
        stockPath,
        [
          "#!/usr/bin/env node",
          "require('fs').writeFileSync(process.env.RECORD_PATH, JSON.stringify(process.argv.slice(2)))",
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o700 },
      );
      await chmod(stockPath, 0o700);
      await writeFile(wrapperPath, renderRemoteHostJsEntrypoint(process.execPath), {
        encoding: "utf8",
        mode: 0o700,
      });
      await chmod(wrapperPath, 0o700);
      const result = spawnSync(wrapperPath, ["app-server", "proxy"], {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEXHOST_STOCK_CODEX_PATH: stockPath,
          RECORD_PATH: recordPath,
        },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(["app-server", "proxy"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
