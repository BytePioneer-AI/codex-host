// @vitest-environment jsdom
import type { MacOsLocalSigningStatus, UpdateCheckResult } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import {
  createDefaultRendererSettingsPages,
  type RendererUpdateClient,
} from "../../src/settings/pages.js";

const messages = rendererSettingsMessages("en");
const cleanups: (() => void)[] = [];

const signingStatus = (
  overrides: Partial<MacOsLocalSigningStatus> = {},
): MacOsLocalSigningStatus => ({
  supported: true,
  enabled: false,
  certificatePresent: false,
  appSignedWithLocalCert: false,
  appPath: "/Applications/codexhost.app",
  certificateName: "CodexHost Local Signer",
  certificateSha1: null,
  ...overrides,
});

const macosCheck = (updateAvailable = true): UpdateCheckResult => ({
  currentVersion: "0.28.2",
  installation: "macos-dmg",
  latestVersion: updateAvailable ? "0.29.0" : "0.28.2",
  updateAvailable,
  installationAvailable: updateAvailable,
  releaseNotes: null,
  releaseNotesUrl: null,
  status: null,
  error: null,
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountUpdates(client: RendererUpdateClient) {
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
  cleanups.push(() => {
    scope.dispose();
    cleanup?.();
  });
  await flush();
  return content;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Updates page macOS local signing controls", () => {
  it("toggles local signing directly without a second confirmation step for macos-dmg installations", async () => {
    const enabledStatus = signingStatus({
      enabled: true,
      certificatePresent: true,
      appSignedWithLocalCert: true,
      certificateSha1: "53DCA7F81873FBB433FB4873628452BC22C7CE73",
    });
    const client: RendererUpdateClient = {
      checkUpdate: vi.fn(async () => macosCheck(true)),
      startUpdate: vi.fn(async () => {
        throw new Error("not used");
      }),
      readUpdateStatus: vi.fn(async () => ({ status: null })),
      getMacOsSigningStatus: vi.fn(async () => signingStatus()),
      setupMacOsSigning: vi.fn(async () => enabledStatus),
      removeMacOsSigning: vi.fn(async () => signingStatus()),
    };

    const content = await mountUpdates(client);
    const card = content.querySelector<HTMLElement>(".settings-macos-signing");
    expect(card?.hidden).toBe(false);
    expect(card?.textContent).toContain(messages.macosSigningTitle);

    const enableButton = card?.querySelector("button");
    expect(enableButton?.textContent).toBe(messages.macosSigningEnableButton);
    enableButton!.click();
    await flush();

    expect(client.setupMacOsSigning).toHaveBeenCalledOnce();
    expect(card?.textContent).toContain(messages.macosSigningStatusEnabled);

    const removeButton = card?.querySelector("button");
    expect(removeButton?.textContent).toBe(messages.macosSigningRemoveButton);
    removeButton!.click();
    await flush();

    expect(client.removeMacOsSigning).toHaveBeenCalledOnce();
    expect(card?.querySelector("button")?.textContent).toBe(messages.macosSigningEnableButton);
  });

  it("hides the local signing card for non-macos-dmg installations", async () => {
    const client: RendererUpdateClient = {
      checkUpdate: vi.fn(async () => ({ ...macosCheck(true), installation: "npm" })),
      startUpdate: vi.fn(async () => {
        throw new Error("not used");
      }),
      readUpdateStatus: vi.fn(async () => ({ status: null })),
      getMacOsSigningStatus: vi.fn(async () => signingStatus()),
    };

    const content = await mountUpdates(client);
    const card = content.querySelector<HTMLElement>(".settings-macos-signing");
    expect(card?.hidden).toBe(true);
    expect(client.getMacOsSigningStatus).not.toHaveBeenCalled();
  });
});
