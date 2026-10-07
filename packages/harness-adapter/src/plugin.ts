import type { HarnessAdapter } from "./text-session.js";
import type { HarnessUsageStatisticsCapability } from "./usage-statistics.js";

/** A capability-only plugin: no session inspection, creation or native process ownership. */
export interface HarnessUsageStatisticsAdapter {
  readonly harnessId: HarnessAdapter["harnessId"];
  readonly usageStatistics: HarnessUsageStatisticsCapability;
  close(): Promise<void>;
}

export interface HarnessUsageStatisticsPluginModule {
  createUsageStatisticsAdapter(
    context: HarnessPluginContext,
  ): HarnessUsageStatisticsAdapter | Promise<HarnessUsageStatisticsAdapter>;
}

export interface HarnessLocalPage {
  show(): Promise<void>;
  close(): Promise<void>;
}

/** Per Host/connection construction context; never contains Host or Renderer internals. */
export interface HarnessPluginContext {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Persisted installation directory or legacy entrypoint; only for plugins declaring launchCommand. */
  readonly launchCommand?: string;
  readonly platform: string;
  readonly managedRemoteHost: boolean;
  readonly brokerDescriptorPath?: string;
  readonly openLocalUrl?: (url: string) => Promise<void>;
  /** Opens a background page in the local Desktop browser; owner must close it. */
  readonly openLocalPage?: (url: string) => Promise<HarnessLocalPage>;
}

/** A loaded module supplies a factory, not a global registration side effect. */
export interface HarnessPluginModule {
  createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter | Promise<HarnessAdapter>;
  /** Optional, best-effort prefetch. The Host does not await completion before serving requests. */
  warmup?(adapter: HarnessAdapter): Promise<void>;
}
