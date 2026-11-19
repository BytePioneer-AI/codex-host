/** Right-Sidebar tab action that hands a previewed file to the Host desktop. */
import { useState } from "react";
import { IconShareOutlineRegular, MenuItemButton } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { TEXTPREVIEW_KIND } from "./definition.ts";

/** Host file-opening behavior supplied by the document-preview plugin. */
export interface OpenOriginalFileInjected {
  readonly openExternal: (path: string) => Promise<void>;
}

type OpenOriginalFileMenuItemProps = PropsRuntime<"sidebar.right.tab.menu.item"> &
  PropsLocale<"sidebarDocumentPreview"> &
  InjectFace<OpenOriginalFileInjected>;

/** Open a file tab's original file in the Host operating system's default application. */
export function OpenOriginalFileMenuItem({
  tab,
  dismiss,
  useResource,
  openExternal,
  t,
}: OpenOriginalFileMenuItemProps) {
  const resource = useResource<"file">(tab.contentId);
  const [state, setState] = useState<"idle" | "opening" | "failed">("idle");
  const path = resource.value?.absolutePath;
  if (tab.kind !== TEXTPREVIEW_KIND || path === undefined) return null;

  return (
    <MenuItemButton
      icon={<IconShareOutlineRegular />}
      separatorBefore
      disabled={state === "opening"}
      onSelect={() => {
        setState("opening");
        void openExternal(path).then(
          () => {
            dismiss();
          },
          () => {
            setState("failed");
          },
        );
      }}
    >
      {t(
        state === "opening"
          ? "originalFile.opening"
          : state === "failed"
            ? "originalFile.openFailed"
            : "originalFile.open",
      )}
    </MenuItemButton>
  );
}
