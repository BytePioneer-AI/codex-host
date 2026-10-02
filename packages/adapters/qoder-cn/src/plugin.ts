import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import {
  createHarnessAdapter as createQoderAdapter,
  type QoderAdapter,
} from "@codexhost/adapter-qoder";

export function createHarnessAdapter(context: HarnessPluginContext): QoderAdapter {
  return createQoderAdapter(context, "cn");
}
