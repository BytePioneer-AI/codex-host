import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessInstallationParamsSchema,
  harnessInstallationStateSchema,
  type HarnessInstallationState,
} from "@codexhost/shared-contracts";

export class HarnessInstallationError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "HarnessInstallationError";
  }
}

/** Public plugin capability only. The Renderer cannot supply commands, URLs or paths. */
export async function handleHarnessInstallation(
  params: unknown,
  adapters: ReadonlyMap<string, HarnessAdapter>,
): Promise<HarnessInstallationState> {
  const parsed = harnessInstallationParamsSchema.safeParse(params);
  if (!parsed.success)
    throw new HarnessInstallationError(-32602, "Invalid Harness installation request");
  const adapter = adapters.get(parsed.data.harnessId);
  if (!adapter?.installation)
    throw new HarnessInstallationError(
      -32078,
      "Harness version management is unavailable on this Host",
    );
  try {
    return harnessInstallationStateSchema.parse(await adapter.installation(parsed.data.action));
  } catch {
    // Native output may include credentials or paths. Never forward an arbitrary plugin exception.
    throw new HarnessInstallationError(
      -32077,
      parsed.data.action === "update"
        ? "Harness update failed or its new version could not be confirmed. Check the native installation and check for updates again."
        : "Could not check Harness versions. Check the native installation and retry.",
    );
  }
}
