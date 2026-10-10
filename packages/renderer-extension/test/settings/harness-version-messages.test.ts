import { describe, expect, it } from "vitest";
import {
  harnessInstallationStateSchema,
  type HarnessInstallationState,
} from "@codexhost/shared-contracts";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import {
  harnessVersionLabel,
  harnessVersionNote,
} from "../../src/settings/harness-version-messages.js";

const state: HarnessInstallationState = {
  currentVersion: "0.21.5+5355.g357f51c.dirty @ 357f51c4",
  latestVersion: "Tracking branch (new commits)",
  latestVersionKind: "tracking-branch",
  updateAvailable: true,
  canUpdate: false,
  messageCode: "hermes-manual-update",
  message: "Use the native updater manually.",
};

describe("Harness version localization", () => {
  it("preserves structured hints through the public schema", () => {
    expect(harnessInstallationStateSchema.parse(state)).toEqual(state);
    expect(
      harnessInstallationStateSchema.safeParse({ ...state, latestVersionKind: "invalid" }).success,
    ).toBe(false);
  });

  it("localizes Hermes hints without changing version identities", () => {
    const zh = rendererSettingsMessages("zh-CN").harnessVersion;
    const en = rendererSettingsMessages("en").harnessVersion;
    expect(harnessVersionLabel(state, zh)).toBe("跟踪分支（有新提交）");
    expect(harnessVersionLabel(state, en)).toBe("Tracking branch (new commits)");
    expect(harnessVersionNote(state, zh)).toContain("源码目录无未提交修改");
    expect(harnessVersionNote(state, zh)).not.toContain("Use the native updater");
    expect(harnessVersionNote(state, en)).toContain("clean source checkout");
    expect(
      harnessVersionLabel(
        { ...state, latestVersion: "0.22.0-rc.1", latestVersionKind: undefined },
        zh,
      ),
    ).toBe("0.22.0-rc.1");
  });

  it("localizes legacy sentinels and does not display untranslated plugin diagnostics", () => {
    const zh = rendererSettingsMessages("zh-CN").harnessVersion;
    expect(harnessVersionLabel({ ...state, latestVersionKind: undefined }, zh)).toBe(
      "跟踪分支（有新提交）",
    );
    expect(
      harnessVersionLabel({ ...state, latestVersionKind: undefined, latestVersion: "Unknown" }, zh),
    ).toBe("未知");
    expect(harnessVersionLabel(undefined, zh)).toBe("—");
    for (const messageCode of [undefined, "future-plugin-note", "toString", "__proto__"])
      expect(harnessVersionNote({ ...state, messageCode }, zh)).toBeUndefined();
  });

  it("provides the same diagnostic codes in both languages for every migrated Adapter", () => {
    const en = rendererSettingsMessages("en").harnessVersion;
    const zh = rendererSettingsMessages("zh-CN").harnessVersion;
    expect(Object.keys(zh.notes)).toEqual(Object.keys(en.notes));
    for (const messageCode of Object.keys(en.notes)) {
      expect(harnessVersionNote({ ...state, messageCode }, zh)).toMatch(/[\u4e00-\u9fff]/u);
      expect(harnessVersionNote({ ...state, messageCode }, en)).not.toMatch(/[\u4e00-\u9fff]/u);
    }
  });
});
