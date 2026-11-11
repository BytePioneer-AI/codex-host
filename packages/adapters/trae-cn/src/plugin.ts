import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { environmentValue } from "@codexhost/harness-discovery";
import { TraeCnAdapter } from "./adapter.js";
import { createTraeCnInstallation } from "./installation.js";

/** Factory construction is cold; Desktop and its Companion retain native process ownership. */
export function createHarnessAdapter(context: HarnessPluginContext) {
  const environment = { ...context.environment };
  const app = context.launchCommand ?? environmentValue(environment, "CODEXHOST_TRAE_CN_APP");
  const options = { environment, ...(app ? { app } : {}) };
  return Object.assign(new TraeCnAdapter(options), {
    installation: createTraeCnInstallation(options),
  });
}
