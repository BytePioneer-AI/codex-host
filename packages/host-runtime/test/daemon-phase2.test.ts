import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { daemonDesktopSocketPath } from "../src/daemon-desktop-bridge.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

describe("daemon Desktop phase two", () => {
  it("uses a dedicated private Desktop socket", () => {
    expect(
      daemonDesktopSocketPath({
        CODEX_HOME: path.join(path.sep, "private", "codex-home"),
      }),
    ).toBe(
      path.join(
        path.sep,
        "private",
        "codex-home",
        "app-server-control",
        "codexhost-daemon-desktop.sock",
      ),
    );
  });

  it("enables Official Codex only after the internal Desktop attach", async () => {
    const onRuntimeAttach = vi.fn(async () => undefined);
    const fixture = createFixture({
      externalOnly: true,
      onRuntimeAttach,
    });
    try {
      expect(fixture.spawnOfficial).not.toHaveBeenCalled();
      writeRequest(fixture.desktopInput, {
        id: 91,
        method: "codexhost/runtime/attach",
        params: {
          stockCodexPath: "/synthetic/codex",
          arguments: ["-c", "features.code_mode_host=true", "app-server"],
          defaultAgent: "codex",
        },
      });
      const attached = await fixture.collector.waitFor((message) => requestId(message, 91));
      expect(attached).toMatchObject({ id: 91, result: { attached: true } });
      expect(onRuntimeAttach).toHaveBeenCalledWith({
        stockCodexPath: "/synthetic/codex",
        arguments: ["-c", "features.code_mode_host=true", "app-server"],
        defaultAgent: "codex",
      });
      expect(fixture.spawnOfficial).toHaveBeenCalledOnce();
    } finally {
      await stopFixture(fixture);
    }
  });

  it("rejects malformed attach requests without starting Official Codex", async () => {
    const onRuntimeAttach = vi.fn(async () => undefined);
    const fixture = createFixture({
      externalOnly: true,
      onRuntimeAttach,
    });
    try {
      writeRequest(fixture.desktopInput, {
        id: 92,
        method: "codexhost/runtime/attach",
        params: {
          stockCodexPath: "/synthetic/codex",
          arguments: ["app-server", 3],
          defaultAgent: "codex",
        },
      });
      const reply = await fixture.collector.waitFor((message) => requestId(message, 92));
      expect(reply).toMatchObject({
        id: 92,
        error: { code: -32602, message: "Invalid daemon runtime attach" },
      });
      expect(onRuntimeAttach).not.toHaveBeenCalled();
      expect(fixture.spawnOfficial).not.toHaveBeenCalled();
    } finally {
      await stopFixture(fixture);
    }
  });
});
