// @vitest-environment jsdom
import type {
  UpdateCheckResult,
  UpdateStatus,
  UpdateStatusResult,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RendererRequestTransportError } from "../../src/renderer-request-sender.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import {
  createDefaultRendererSettingsPages,
  type RendererUpdateClient,
} from "../../src/settings/pages.js";
import { RENDERER_UPDATE_STATUS_WAIT_MS } from "../../src/settings/update-status-poll.js";

const messages = rendererSettingsMessages("en");
const cleanups: (() => void)[] = [];
const status = (phase: UpdateStatus["phase"]): UpdateStatus => ({
  version: "1.2.3",
  installation: "npm",
  phase,
  updatedAt: 1_700_000_000,
  error: phase === "failed" ? "Installation did not complete" : null,
});
const check = (currentStatus: UpdateStatus | null = null): UpdateCheckResult => ({
  currentVersion: "1.2.2",
  installation: "npm",
  latestVersion: "1.2.3",
  updateAvailable: true,
  installationAvailable: true,
  releaseNotes: null,
  releaseNotesUrl: null,
  status: currentStatus,
  error: null,
});
const makeClient = () => ({
  checkUpdate: vi.fn(async () => check()),
  startUpdate: vi.fn(async () => ({ status: status("prepared") })),
  readUpdateStatus: vi.fn<() => Promise<UpdateStatusResult>>(),
});

async function mount(client: RendererUpdateClient) {
  const page = createDefaultRendererSettingsPages(messages, () => client).find(
    ({ id }) => id === "updates",
  );
  if (!page) throw new Error("Updates page is not registered");
  const content = document.createElement("main");
  document.body.append(content);
  const scope = new RendererSettingsPageScope();
  const cleanup = page.mount({
    content,
    signal: scope.signal,
    runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
  });
  const dispose = () => {
    scope.dispose();
    cleanup?.();
  };
  cleanups.push(dispose);
  await vi.advanceTimersByTimeAsync(0);
  const panel = content.querySelector<HTMLElement>(".settings-update-panel");
  if (!panel) throw new Error("Updates panel is missing");
  return {
    content,
    panel,
    dispose,
    async start() {
      const button = panel.querySelector("button");
      if (!button) throw new Error("Update button is missing");
      button.click();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Updates service reconnection", () => {
  it.each(["succeeded", "failed"] as const)(
    "reads the real %s result after connection errors without restarting the update",
    async (terminalPhase) => {
      const client = makeClient();
      client.readUpdateStatus
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockRejectedValueOnce(new Error("HTTP 503"))
        .mockResolvedValueOnce({ status: null })
        .mockResolvedValueOnce({ status: status("restarting") })
        .mockResolvedValueOnce({ status: status(terminalPhase) });
      const view = await mount(client);
      await view.start();
      for (let attempt = 0; attempt < 3; attempt++) {
        await vi.advanceTimersByTimeAsync(750);
        expect(view.panel.dataset.updateState).toBe("pending");
        expect(view.panel.textContent).toContain(messages.updateReconnecting);
        expect(view.panel.querySelector("button")).toBeNull();
      }
      await vi.advanceTimersByTimeAsync(750);
      expect(view.panel.dataset.updateState).toBe("restarting");
      await vi.advanceTimersByTimeAsync(750);
      expect(view.panel.dataset.updateState).toBe(terminalPhase);
      expect(view.panel.textContent).toContain(
        terminalPhase === "succeeded" ? messages.updateSucceeded : "Installation did not complete",
      );
      if (terminalPhase === "succeeded") {
        const version = view.content.querySelector(".settings-update-metadata__item strong");
        expect(version?.textContent).toBe("v1.2.3");
        expect(view.content.querySelector(".settings-update-metadata__value--newer")).toBeNull();
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.readUpdateStatus).toHaveBeenCalledTimes(5);
      expect(client.startUpdate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("resumes an already active update on page opening and reads its result after a restart", async () => {
    const client = makeClient();
    client.checkUpdate.mockResolvedValue(check(status("installing")));
    client.readUpdateStatus
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ status: status("succeeded") });
    const view = await mount(client);
    expect(view.panel.dataset.updateState).toBe("installing");
    await vi.advanceTimersByTimeAsync(750);
    expect(view.panel.textContent).toContain(messages.updateReconnecting);
    await vi.advanceTimersByTimeAsync(750);
    expect(view.panel.dataset.updateState).toBe("succeeded");
    expect(client.startUpdate).not.toHaveBeenCalled();
  });

  it.each(["disconnected", "hung", "missing"] as const)(
    "bounds total waiting when status reads are %s without claiming installation failed",
    async (failure) => {
      const client = makeClient();
      const pending = Promise.withResolvers<UpdateStatusResult>();
      if (failure === "hung") client.readUpdateStatus.mockReturnValue(pending.promise);
      else if (failure === "missing") client.readUpdateStatus.mockResolvedValue({ status: null });
      else client.readUpdateStatus.mockRejectedValue(new TypeError("Failed to fetch"));
      const view = await mount(client);
      await view.start();
      await vi.advanceTimersByTimeAsync(RENDERER_UPDATE_STATUS_WAIT_MS);
      expect(view.panel.dataset.updateState).toBe("unavailable");
      expect(view.panel.textContent).toContain(messages.updateResultUnavailable);
      expect(view.content.textContent).not.toContain(messages.updateManualFallbackDescription);
      expect(view.panel.querySelector("button")).toBeNull();
      const attempts = client.readUpdateStatus.mock.calls.length;
      pending.resolve({ status: status("succeeded") });
      await vi.advanceTimersByTimeAsync(RENDERER_UPDATE_STATUS_WAIT_MS);
      expect(view.panel.dataset.updateState).toBe("unavailable");
      expect(client.readUpdateStatus).toHaveBeenCalledTimes(attempts);
      expect(client.startUpdate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stops pending reads and timers when the page closes", async () => {
    const pending = Promise.withResolvers<UpdateStatusResult>();
    const client = makeClient();
    client.readUpdateStatus.mockReturnValue(pending.promise);
    const view = await mount(client);
    await view.start();
    await vi.advanceTimersByTimeAsync(750);
    expect(client.readUpdateStatus).toHaveBeenCalledOnce();
    view.dispose();
    pending.resolve({ status: status("succeeded") });
    await vi.advanceTimersByTimeAsync(RENDERER_UPDATE_STATUS_WAIT_MS);
    expect(view.panel.dataset.updateState).toBe("prepared");
    expect(client.readUpdateStatus).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers a lost start response through status reads without sending another start", async () => {
    const client = makeClient();
    client.startUpdate.mockRejectedValue(
      new RendererRequestTransportError(new TypeError("Failed to fetch")),
    );
    client.readUpdateStatus
      .mockRejectedValueOnce(new RendererRequestTransportError(new TypeError("Failed to fetch")))
      .mockResolvedValueOnce({ status: status("restarting") })
      .mockResolvedValueOnce({ status: status("succeeded") });
    const view = await mount(client);
    await view.start();
    expect(view.panel.dataset.updateState).toBe("pending");
    expect(view.panel.textContent).toContain(messages.updateReconnecting);
    await vi.advanceTimersByTimeAsync(2_250);
    expect(view.panel.dataset.updateState).toBe("succeeded");
    expect(client.startUpdate).toHaveBeenCalledOnce();
    expect(client.readUpdateStatus).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["succeeded", "failed"] as const)(
    "ignores the previous %s result while recovering an unknown start outcome",
    async (previousPhase) => {
      const client = makeClient();
      const previous = status(previousPhase);
      const finished = { ...previous, updatedAt: previous.updatedAt + 1 };
      client.checkUpdate.mockResolvedValue(check(previous));
      client.startUpdate.mockRejectedValue(
        new RendererRequestTransportError(new TypeError("Failed to fetch")),
      );
      client.readUpdateStatus
        .mockResolvedValueOnce({ status: previous })
        .mockResolvedValueOnce({ status: previous })
        .mockResolvedValueOnce({ status: finished });
      const view = await mount(client);
      await view.start();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(view.panel.dataset.updateState).toBe("pending");
      expect(view.panel.textContent).toContain(messages.updateReconnecting);
      await vi.advanceTimersByTimeAsync(750);
      expect(view.panel.dataset.updateState).toBe(previousPhase);
      expect(client.startUpdate).toHaveBeenCalledOnce();
      expect(client.readUpdateStatus).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("accepts an authoritative start response even when it matches a previous terminal status", async () => {
    const client = makeClient();
    const previous = status("failed");
    client.checkUpdate.mockResolvedValue(check(previous));
    client.startUpdate.mockResolvedValue({ status: previous });
    const view = await mount(client);
    await view.start();
    expect(view.panel.dataset.updateState).toBe("failed");
    expect(view.panel.textContent).toContain(previous.error);
    expect(client.startUpdate).toHaveBeenCalledOnce();
    expect(client.readUpdateStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an explicit start rejection immediate without polling or resubmitting", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeClient();
    client.startUpdate.mockRejectedValue(
      Object.assign(new Error("Update is unavailable"), { code: -32000 }),
    );
    const view = await mount(client);
    await view.start();
    expect(view.panel.textContent).toContain(messages.updateServiceUnavailable);
    await vi.advanceTimersByTimeAsync(RENDERER_UPDATE_STATUS_WAIT_MS);
    expect(client.readUpdateStatus).not.toHaveBeenCalled();
    expect(client.startUpdate).toHaveBeenCalledOnce();
  });

  it("keeps an ordinary update check failure immediate without starting recovery polls", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeClient();
    client.checkUpdate.mockRejectedValue(new TypeError("Failed to fetch"));
    const view = await mount(client);
    expect(view.panel.textContent).toContain(messages.updateServiceUnavailable);
    await vi.advanceTimersByTimeAsync(RENDERER_UPDATE_STATUS_WAIT_MS);
    expect(client.readUpdateStatus).not.toHaveBeenCalled();
    expect(client.startUpdate).not.toHaveBeenCalled();
  });
});
