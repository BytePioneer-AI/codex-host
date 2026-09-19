import { z } from "zod";
import { environmentValue } from "@codexhost/harness-discovery";
import type { ZcodeConnection } from "./connection.js";
import { record, text, settingsSchema, snapshotSchema, workspaceSchema } from "./protocol.js";
import { ZcodeError } from "./errors.js";
import { sameWorkspaceDirectory } from "./workspace-directory.js";

const presentationSchema = z.object({
  workspace: workspaceSchema,
  mode: settingsSchema.shape.mode.shape.current,
});

/** Newer runtimes own their process-wide Provider registry, not a Host-supplied workspace registry. */
export async function readProcessWorkspace(
  transport: ZcodeConnection,
  workspace: z.infer<typeof workspaceSchema>,
) {
  if (environmentValue(transport.options.environment, "CODEXHOST_ZCODE_CONFIG")?.trim()) {
    throw new ZcodeError(
      "unsupported",
      "This ZCode runtime does not support workspace Provider registry overrides. Configure Providers in ZCode's native provider_config.json instead of CODEXHOST_ZCODE_CONFIG.",
    );
  }
  const presentation = presentationSchema.parse(
    await transport.request("workspace/readPresentation", { workspace }),
  );
  if (!sameWorkspaceDirectory(presentation.workspace.workspacePath, workspace.workspacePath))
    throw new ZcodeError("protocolError", "ZCode returned a different workspace");

  // readPresentation deliberately has no Model Catalog. Obtain it from a native,
  // deferred, prompt-free Session; never fabricate models from account/config files.
  const raw = record(
    await transport.request("session/create", {
      workspace: presentation.workspace,
      mode: presentation.mode,
      persistence: "deferred",
      titleGenerationEnabled: false,
      mcpServers: [],
    }),
  );
  const sessionId = text(record(raw.session).sessionId);
  if (!sessionId) throw new ZcodeError("protocolError", "ZCode catalog Session has no identity");
  try {
    const snapshot = snapshotSchema.parse(raw);
    if (!sameWorkspaceDirectory(snapshot.session.workspace.workspacePath, workspace.workspacePath))
      throw new ZcodeError(
        "protocolError",
        "ZCode catalog Session belongs to a different workspace",
      );
    if (snapshot.messages.length || snapshot.projection.currentTurnId)
      throw new ZcodeError("protocolError", "ZCode catalog Session is not empty");
    return {
      workspace: snapshot.session.workspace,
      settings: snapshot.settings,
      registryScope: "process" as const,
    };
  } finally {
    // Do not hide cleanup failure and claim the inspection succeeded. The caller
    // also owns the transport and will terminate it on failure.
    const result = record(
      await transport.request("session/close", { sessionId, expectedPersistence: "deferred" }),
    );
    if (result.closed !== true)
      throw new ZcodeError("protocolError", "ZCode did not close the catalog Session");
  }
}
