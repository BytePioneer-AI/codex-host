import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import {
  createInstallationManager,
  installationVersion,
  runInstallationCommand,
} from "@codexhost/harness-discovery";
import { TraeCliAdapter } from "./adapter.js";
import { resolveTraeExecutable } from "./command.js";

export function createHarnessAdapter(context: HarnessPluginContext) {
  const environment = { ...context.environment };
  const installation = createInstallationManager({
    async check() {
      const version = await runInstallationCommand(
        resolveTraeExecutable(environment),
        ["--version"],
        environment,
      );
      const match = /traecli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/iu.exec(version);
      if (!match) throw new Error("TRAE CLI returned an unsupported version response");
      // update check has no stable machine-readable response. Keep native update manual.
      return {
        currentVersion: installationVersion(match[1]),
        latestVersion: "unknown",
        latestVersionKind: "unknown" as const,
        updateAvailable: false,
        canUpdate: false,
        notice: {
          en: "Run traecli update to update the native CLI. Account access is managed by TRAE.",
          "zh-CN": "运行 traecli update 更新原生 CLI；使用权限由 TRAE 账号决定。",
        },
      };
    },
    async update() {
      throw new Error("Use traecli update in a terminal");
    },
  });
  return Object.assign(new TraeCliAdapter({ environment }), { installation });
}
