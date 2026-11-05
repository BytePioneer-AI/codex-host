import type { HarnessSessionImportSourcesResult } from "@codexhost/shared-contracts";
import type { RendererSessionImportClient } from "../renderer-session-import-client.js";
import type { RendererConnectionDiagnostics } from "./connections-page.js";

/** Import capability and installation availability belong to the same Host. */
export async function loadSessionImportSources(
  client: RendererSessionImportClient,
  diagnostics: RendererConnectionDiagnostics | null,
  signal: AbortSignal,
  refresh: boolean,
): Promise<HarnessSessionImportSourcesResult["harnesses"]> {
  const { harnesses } = await client.listSessionImportSources();
  signal.throwIfAborted();
  if (!diagnostics || harnesses.length === 0) return harnesses;

  const hostId = client.hostId ?? "local";
  const readHost = () => diagnostics.snapshot().hosts.find((host) => host.hostId === hostId);
  let host = readHost();
  const incomplete = (): boolean =>
    !host ||
    Boolean(host.directoryError) ||
    harnesses.some(({ harnessId }) => {
      const status = host?.agents.find(({ agent }) => agent === harnessId)?.availability;
      return status === undefined || status === "checking";
    });
  if (refresh || incomplete()) {
    await diagnostics.refresh(hostId);
    signal.throwIfAborted();
    host = readHost();
  }
  if (incomplete()) throw new Error("Harness installation diagnostics are incomplete");

  // Authentication or protocol errors do not prove the native history is absent.
  const missing = new Set(
    host?.agents
      .filter(({ availability }) => availability === "notInstalled")
      .map(({ agent }) => agent),
  );
  return harnesses.filter(({ harnessId }) => !missing.has(harnessId));
}
