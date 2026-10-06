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

const installing = new WeakMap<HarnessAdapter, Promise<HarnessInstallationState>>();

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
  const install = adapter.install?.bind(adapter);
  const installation = adapter.installation.bind(adapter);
  if (parsed.data.action === "install" && !install)
    throw new HarnessInstallationError(
      -32078,
      "Automatic installation is unavailable on this Host. Use the official installation guide.",
    );
  try {
    const pending = installing.get(adapter);
    if (pending) return await pending;
    if (parsed.data.action === "install") {
      const operation = (async () => {
        // Never overwrite an existing or merely unauthenticated installation.
        const inspection = await adapter.inspect({ refresh: true });
        if (inspection.status !== "notInstalled")
          throw new Error("Harness is already installed or its state is uncertain");
        if (!install) throw new Error("Installation capability unavailable");
        await install();
        return harnessInstallationStateSchema.parse(await installation("check"));
      })();
      installing.set(adapter, operation);
      try {
        return await operation;
      } finally {
        installing.delete(adapter);
      }
    }
    return harnessInstallationStateSchema.parse(await adapter.installation(parsed.data.action));
  } catch {
    // Native output may include credentials or paths. Never forward an arbitrary plugin exception.
    throw new HarnessInstallationError(
      -32077,
      parsed.data.action === "install"
        ? "Harness installation failed or its CLI version could not be confirmed. Check network access, prerequisites and installation permissions in the official guide, then diagnose the connection before retrying."
        : parsed.data.action === "update"
          ? "Harness update failed or its new version could not be confirmed. Check the native installation and check for updates again."
          : "Could not check Harness versions. Check the native installation and retry.",
    );
  }
}
