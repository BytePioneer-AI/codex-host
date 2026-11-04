import type { HarnessResult, HarnessSessionImportPrepared } from "@codexhost/harness-adapter";
import { nativeSessionRefSchema } from "@codexhost/shared-contracts";
import { codexOpenFailure, isCodexWriterConflict } from "./codex-session-import.js";
import { CodexRpcError } from "./rpc.ts";
import { CodexSession, HARNESS_ID, type CodexSessionOptions } from "./session.ts";

/** Import keeps an available identity and derives only when native resume confirms a writer. */
export async function prepareCodexImport(
  options: CodexSessionOptions & { threadId: string },
): Promise<HarnessResult<HarnessSessionImportPrepared>> {
  const nativeRef = (nativeSessionId: string) =>
    nativeSessionRefSchema.parse({ formatVersion: 1, harnessId: HARNESS_ID, nativeSessionId });
  try {
    const opened = await CodexSession.open(options);
    return opened.ok
      ? { ok: true, value: { nativeRef: nativeRef(options.threadId), session: opened.value } }
      : opened;
  } catch (error) {
    if (!isCodexWriterConflict(error)) return { ok: false, error: codexOpenFailure(error) };
  }
  let dispatched = false;
  let created: string | undefined;
  try {
    const opened = await CodexSession.open({
      ...options,
      importFork: {
        dispatched: () => {
          dispatched = true;
        },
        created: (id) => {
          created = id;
        },
      },
    });
    if (!opened.ok) return opened;
    if (!created) {
      await opened.value.close();
      throw new Error("Codex import did not return its new native identity");
    }
    return {
      ok: true,
      value: { nativeRef: nativeRef(created), session: opened.value },
    };
  } catch (error) {
    if (created) return { ok: true, value: { nativeRef: nativeRef(created) } };
    const rejected =
      error instanceof CodexRpcError &&
      error.method === "thread/fork" &&
      [-32600, -32601, -32602].includes(error.error.code);
    if (dispatched && !rejected)
      throw new Error("Codex import fork outcome is unknown; do not repeat the import", {
        cause: error,
      });
    return { ok: false, error: codexOpenFailure(error) };
  }
}
