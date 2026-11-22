// @vitest-environment jsdom
import type { RuntimeStatus } from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";
import {
  renderRemoteCard,
  type RemoteConnectionRow,
} from "../../src/settings/remote-connections-card.js";

const local: RuntimeStatus = {
  runningVersion: "1.2.3",
  installedVersion: "1.2.3",
  remote: false,
  restartRequired: false,
  updateSupported: true,
  update: { phase: "idle", targetVersion: null, error: null },
};
const damaged: RuntimeStatus = {
  ...local,
  remote: true,
  installedVersion: null,
  updateSupported: false,
};
function render(row: Partial<RemoteConnectionRow>, version = local.runningVersion) {
  const onAction = vi.fn();
  const card = renderRemoteCard(
    document,
    {
      connection: {
        hostId: "host",
        displayName: "Host",
        sshHost: "host",
        source: "codex-managed",
        autoConnect: true,
        sshAlias: null,
        sshPort: null,
        identity: null,
      },
      remote: null,
      state: "connected",
      installation: "installed",
      probing: false,
      stateError: null,
      remoteIssue: null,
      pending: null,
      notice: null,
      ...row,
    },
    { ...local, runningVersion: version },
    (_zh, en) => en,
    onAction,
  );
  return {
    card,
    upgrade: card.querySelector<HTMLButtonElement>('[data-action="upgrade"]'),
    onAction,
  };
}

it.each([
  { remote: damaged },
  { state: "error" },
  { remoteIssue: { outdated: false, message: "Failed to read status" } },
])("offers an SSH update for a damaged or unresponsive installed service", (row) => {
  const { upgrade, onAction } = render(row);
  expect(upgrade?.textContent).toBe("Update remote service");
  expect(upgrade?.className).toBe("settings-command-button");
  upgrade?.click();
  expect(onAction).toHaveBeenCalledWith("upgrade");
  expect(render(row, "1.2.3-dev").upgrade?.disabled).toBe(true);
});

it.each([
  { remote: { ...damaged, installedVersion: "1.2.3" } },
  { remote: { ...damaged, update: { ...local.update, phase: "installing" as const } } },
  { state: "error", installation: "unknown" as const },
  { state: "connected", installation: "not-installed" as const },
  { state: "connecting" },
])("keeps SSH recovery off healthy, busy, unverified or absent services", (row) => {
  expect(render(row).upgrade).toBeNull();
});

it("keeps the single upgrade action for services that predate version management", () => {
  const { card, upgrade } = render({
    remoteIssue: { outdated: true, message: "Method not found" },
  });
  expect(upgrade?.disabled).toBe(false);
  expect(card.querySelector('[data-action="repair"], [data-action="recheck"]')).toBeNull();
});
