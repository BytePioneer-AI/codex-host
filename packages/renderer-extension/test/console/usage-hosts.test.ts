import { describe, expect, it } from "vitest";

import {
  LOCAL_USAGE_HOST_ID,
  createLatestKeyGuard,
  usageHostOptions,
} from "../../src/console/usage/usage-hosts.js";

describe("usage statistics machine options", () => {
  it("keeps the local machine first and names remote machines by their connection name", () => {
    expect(
      usageHostOptions(
        [
          { hostId: "remote-ssh-codex-managed:fixture", label: "Build machine" },
          { hostId: "remote-ssh-discovered:mac" },
        ],
        "This machine",
        LOCAL_USAGE_HOST_ID,
      ),
    ).toEqual([
      { key: LOCAL_USAGE_HOST_ID, label: "This machine" },
      { key: "remote-ssh-codex-managed:fixture", label: "Build machine" },
      // A machine with no connection name is still selectable under its Host ID.
      { key: "remote-ssh-discovered:mac", label: "remote-ssh-discovered:mac" },
    ]);
  });

  it("does not repeat a Host ID offered twice, including the local one", () => {
    expect(
      usageHostOptions(
        [
          { hostId: LOCAL_USAGE_HOST_ID, label: "local" },
          { hostId: "remote-ssh-codex-managed:fixture", label: "Build machine" },
          { hostId: "remote-ssh-codex-managed:fixture", label: "Build machine again" },
        ],
        "本机",
        LOCAL_USAGE_HOST_ID,
      ),
    ).toEqual([
      { key: LOCAL_USAGE_HOST_ID, label: "本机" },
      { key: "remote-ssh-codex-managed:fixture", label: "Build machine" },
    ]);
  });

  it("keeps a selected machine visible after it stops being offered", () => {
    // The machine is still selected: the page must show which Host its numbers come from.
    expect(usageHostOptions(undefined, "This machine", "remote-ssh-codex-managed:gone")).toEqual([
      { key: LOCAL_USAGE_HOST_ID, label: "This machine" },
      { key: "remote-ssh-codex-managed:gone", label: "remote-ssh-codex-managed:gone" },
    ]);
  });

  it("offers one option when only the local machine exists", () => {
    expect(usageHostOptions([], "This machine", LOCAL_USAGE_HOST_ID)).toEqual([
      { key: LOCAL_USAGE_HOST_ID, label: "This machine" },
    ]);
  });
});

describe("usage statistics per-machine read guard", () => {
  it("publishes only the newest read", () => {
    const guard = createLatestKeyGuard<string>();
    const first = guard.begin("remote-ssh-codex-managed:first");
    const second = guard.begin("remote-ssh-codex-managed:second");
    // A slow response for the earlier machine must not describe the later one.
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("stops publishing once another machine is selected", () => {
    const guard = createLatestKeyGuard<string>();
    const local = guard.begin(LOCAL_USAGE_HOST_ID);
    guard.begin("remote-ssh-codex-managed:fixture");
    expect(local()).toBe(false);
  });

  it("keeps the newest read current when the same machine is read again", () => {
    const guard = createLatestKeyGuard<string>();
    const earlier = guard.begin(LOCAL_USAGE_HOST_ID);
    const later = guard.begin(LOCAL_USAGE_HOST_ID);
    expect(earlier()).toBe(false);
    expect(later()).toBe(true);
  });
});
