/** Workspace path completion for the composer's @ menu. */
import type { TranslateNS } from "@deepseek-ai/dsh-client-locale/client";
import type {
  InputTriggerCandidate,
  InputTriggerSource,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import { formatFileMention } from "@deepseek-ai/dsh-file-reference/grammar";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type { ClientRemote } from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "./locales.ts";

/**
 * Complete paths through the Host's bounded workspace search.
 * @param remote - workspace listing transport.
 * @param hasWorkspace - whether the session or draft has selected a workspace.
 * @param t - file UI translations.
 * @returns an @ source with path-only insertion and directory descent.
 */
export function fileMentionSource(
  remote: Pick<ClientRemote, "fileReferences">,
  hasWorkspace: (id: SessionId) => boolean,
  t: TranslateNS<"sidebarFiles">,
): InputTriggerSource {
  const notice = (message: string): InputTriggerCandidate => ({
    name: message,
    disabledReason: message,
    section: t("guide.title"),
  });
  return {
    trigger: "@",
    aliases: ["#"],
    name: "workspace-file",
    order: 30,
    showGroupTitle: false,
    async candidates({ sessionId }, { query, quoted, signal }) {
      if (!hasWorkspace(sessionId)) return query ? [] : [notice(t("noWorkspace"))];
      signal.throwIfAborted();
      const result = await remote.fileReferences.list(sessionId, query, signal);
      signal.throwIfAborted();
      if (!result.ok) return [notice(t("error.unavailable", { message: result.error.message }))];
      const rows: InputTriggerCandidate[] = [];
      for (const entry of result.value) {
        const path = entry.path;
        const mention = formatFileMention({ path, kind: entry.kind }, quoted ?? false);
        if (mention === undefined) continue;
        rows.push({
          name: path,
          label: entry.kind === "directory" ? `${path}/` : path,
          showAlias: false,
          icon: entry.kind === "directory" ? "folder" : "file",
          value: mention,
          drill: entry.kind === "directory",
          section: t("guide.title"),
        });
      }
      if (rows.length === 0) rows.push(notice(t("mention.noMatches")));
      return rows;
    },
    onPick({ candidate, action, trigger }) {
      if (candidate.value === undefined || candidate.disabledReason !== undefined) return;
      if (action === "drill")
        return {
          text: `${trigger === "#" ? "#" : "@"}${candidate.value.slice(1)}`,
          continue: true,
        };
      const closeQuote = candidate.drill && candidate.value.startsWith('@"') ? '"' : "";
      return { text: `${candidate.value}${closeQuote} ` };
    },
  };
}
