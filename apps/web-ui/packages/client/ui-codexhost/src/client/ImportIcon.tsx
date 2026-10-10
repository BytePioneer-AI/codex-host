/** Sidebar entry icon for the import panel. */
import type { ReactNode } from "react";
import { IconDownloadOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";

/**
 * Render the import glyph at the size the sidebar requests.
 * @param props - the sidebar's icon share.
 * @returns the icon element.
 */
export function ImportIcon({ size }: PropsRuntime<"sidebar.panellist">): ReactNode {
  return <IconDownloadOutlineRegular size={size} />;
}
