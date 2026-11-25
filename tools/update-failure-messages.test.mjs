import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

import { rendererSettingsMessages } from "../packages/renderer-extension/src/settings/localization.ts";
import {
  describeUpdateFailure,
  UPDATE_FAILURE_CHINESE,
} from "../packages/renderer-extension/src/settings/update-failure-messages.ts";

const repository = path.resolve(import.meta.dirname, "..");
/** Every place that words a failure the update page can show. */
const SOURCES = [
  "crates/updater/src/main.rs",
  "crates/updater/src/handoff.rs",
  "crates/updater/src/services.rs",
  "crates/updater/src/install.rs",
  "crates/updater/src/npm.rs",
  "crates/updater/src/restart.rs",
  "packages/update-manager/src/updater-ready.ts",
  "packages/update-manager/src/npm-registry.ts",
  "packages/host-runtime/src/update-coordinator.ts",
];
/** Built from a template in install.rs rather than written out. */
const TEMPLATED = new Map([["npm update failed with", "{label} failed with"]]);

// The page translates failures by their English wording, because the processes that report
// them have no locale. Rewording one must therefore update its translation as well.
it("translates only update failures that the code still produces", async () => {
  const code = (
    await Promise.all(SOURCES.map((source) => readFile(path.join(repository, source), "utf8")))
  ).join("\n");
  const stale = [
    ...Object.keys(UPDATE_FAILURE_CHINESE),
    "; service recovery succeeded",
    "; service recovery failed",
  ].filter((message) => !code.includes(TEMPLATED.get(message) ?? message));
  expect(stale).toEqual([]);
});

it.each([
  [
    "zh-CN",
    "codexhost services did not become ready after restart; service recovery succeeded",
    "新版本已安装，但服务未能在 2 分钟内以新版本就绪。已恢复为更新前的版本，可继续使用。",
  ],
  [
    "zh-CN",
    "Error: npm update failed with exit status: 1; service recovery failed: codexhost restart exited with exit status: 2",
    "npm 安装失败，请检查网络和全局 npm 目录的写入权限。更新前的版本也未能重新启动，请按下方说明手动更新。",
  ],
  ["zh-CN", "unexpected Updater output", "更新失败。"],
  [
    "en",
    "codexhost services did not become ready after restart; service recovery succeeded",
    "Update failed. The previous version was restarted and is still available.",
  ],
])("summarises a %s update failure", (locale, error, expected) => {
  expect(describeUpdateFailure(error, rendererSettingsMessages(locale))).toBe(expected);
});
