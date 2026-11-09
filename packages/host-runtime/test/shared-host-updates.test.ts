import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { discoverHostClientChannel, HostClientChannel } from "@codexhost/desktop-control";
import { runSharedHostService } from "../src/shared-host-service.js";
import { connectLocalSharedHost } from "../src/local-shared-host.js";
import { ModelPriceCatalog } from "../src/model-prices.js";

const updates = vi.hoisted(() => {
  const status = {
    version: "1.2.3",
    installation: "npm",
    phase: "prepared",
    updatedAt: 1,
    error: null,
  };
  const coordinator = {
    check: vi.fn(async () => ({
      currentVersion: "1.2.2",
      installation: "npm",
      latestVersion: "1.2.3",
      updateAvailable: true,
      installationAvailable: true,
      releaseNotes: null,
      releaseNotesUrl: null,
      status: null,
      error: null,
    })),
    start: vi.fn(async () => ({ status })),
    status: vi.fn(async () => ({ status })),
  };
  return { coordinator, create: vi.fn(() => coordinator) };
});
vi.mock("../src/update-coordinator.js", () => ({ createHostUpdateCoordinator: updates.create }));
vi.mock("../src/delegation-skill.js", () => ({ installDelegationSkills: async () => [] }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("serves Web, Console and Desktop updates through one service coordinator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-shared-updates-"));
  vi.spyOn(ModelPriceCatalog.prototype, "start").mockResolvedValue();
  const runtime = path.join(root, "app", "host-runtime.mjs");
  const environment = {
    CODEXHOST_DATA_DIR: root,
    CODEX_HOME: path.join(root, "codex-home"),
    CODEXHOST_HOST_RUNTIME_PATH: runtime,
    CODEXHOST_LAUNCHER_PID: String(process.ppid),
    CODEXHOST_UPDATE_SERVICE: "1",
  };
  const ready = path.join(root, "ready");
  const running = runSharedHostService(
    ["--data", root, "--ready-file", ready],
    environment,
    import.meta.url,
  );
  void running.catch(() => undefined);
  let web: HostClientChannel | undefined;
  let desktop: Awaited<ReturnType<typeof connectLocalSharedHost>> | undefined;
  try {
    await vi.waitFor(async () => expect(await readFile(ready, "utf8")).toBe("ready\n"));
    const directory = path.join(root, "client-hosts");
    const descriptor = await discoverHostClientChannel(directory);
    if (!descriptor) throw new Error("Missing shared Host endpoint");
    web = new HostClientChannel(directory, descriptor);
    await web.start();
    await expect(web.request("codexhost/update/check", {})).resolves.toMatchObject({
      installationAvailable: true,
    });
    desktop = await connectLocalSharedHost({
      launcher: path.join(root, "launcher"),
      runtime,
      dataDirectory: root,
    });
    await expect(desktop.request("codexhost/update/start", {})).resolves.toMatchObject({
      result: { status: { phase: "prepared" } },
    });
    const consoleDescriptor = JSON.parse(
      await readFile(path.join(root, "console", "hosts", `host-${process.pid}.json`), "utf8"),
    );
    const response = await fetch(`http://127.0.0.1:${consoleDescriptor.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${consoleDescriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "codexhost/update/status", params: {} }),
    });
    expect(await response.json()).toMatchObject({ result: { status: { phase: "prepared" } } });
    desktop.close();
    desktop = undefined;
    await expect(web.request("codexhost/update/status", {})).resolves.toMatchObject({
      status: { phase: "prepared" },
    });
    expect(updates.create).toHaveBeenCalledOnce();
    expect(updates.coordinator.start).toHaveBeenCalledOnce();
    expect(updates.coordinator.status).toHaveBeenCalledTimes(2);
  } finally {
    desktop?.close();
    web?.close();
    await runSharedHostService(["--data", root, "--stop"], {}, import.meta.url);
    await running;
    await rm(root, { recursive: true, force: true });
  }
});
