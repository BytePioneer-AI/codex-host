import type { HostAgentMessageItem } from "@codexhost/harness-adapter";
import { LocalMediaMarkdownStream } from "@codexhost/harness-adapter/local-media-markdown";

/** Display-only state; the projector keeps native text separately for completion validation. */
export function createAgentMedia(text: string, cwd: string): LocalMediaMarkdownStream {
  const media = new LocalMediaMarkdownStream([cwd], undefined, { relativeImagesOnly: true });
  media.append(text);
  return media;
}

/** History uses the same rules and per-Item existence cache as live projection. */
export function projectAgentMessageMedia(
  item: HostAgentMessageItem,
  cwd: string,
): HostAgentMessageItem {
  const media = createAgentMedia(item.text, cwd);
  media.flush();
  return { ...item, text: media.text };
}
