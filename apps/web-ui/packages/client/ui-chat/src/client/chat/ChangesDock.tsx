/** Light "N files changed +X -Y" strip above the composer while a Turn runs. */
import { memo } from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { ChangeStat } from "./ChangeStat.tsx";
import { baseName, sumChanges, useTurnFileChanges } from "./turn-file-changes.ts";
import css from "./ChangesDock.module.css";

/**
 * Composer-dock entry: only while the Session runs and the latest Turn changed a file.
 * @param props - Session and Chat hooks plus the Chat locale seat.
 * @returns the strip, or nothing.
 */
export const ChangesDock = memo(function ChangesDock({
  useChat,
  useSession,
  t,
}: PropsRuntime<"conversation.input.dock"> & PropsLocale<"chat">) {
  const running = useSession((s) => s.running);
  const nodeStore = useChat((s) => s.nodes);
  const turn = useChat((s) => s.navigation.items().at(-1)?.turn);
  const files = useTurnFileChanges(nodeStore, running ? turn : undefined);
  if (!running || files.length === 0) return null;
  const { added, removed } = sumChanges(files);
  return (
    <div className={css.root}>
      <div className={css.anchor} tabIndex={0}>
        <ul className={css.list}>
          {files.map((file) => (
            <li key={file.path} className={css.file}>
              <span className={css.path}>{baseName(file.path)}</span>
              <ChangeStat added={file.added} removed={file.removed} />
            </li>
          ))}
        </ul>
        <div className={css.pill} role="status">
          <span>{t("chat.filesChanged", { count: files.length })}</span>
          <ChangeStat added={added} removed={removed} />
        </div>
      </div>
    </div>
  );
});
