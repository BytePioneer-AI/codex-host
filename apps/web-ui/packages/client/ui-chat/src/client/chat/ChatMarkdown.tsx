import { useCallback, useState } from "react";
import {
  IconBrowseOutlineMedium,
  IconFolderOpenOutlineMedium,
  IconLinkOutlineMedium,
  IconRightUpOutlineMedium,
  LinkIconMedium,
  MarkdownDelegateProvider,
  Menu,
  MenuItemButton,
  Toast,
  writeClipboard,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  MarkdownDelegateProviderProps,
  MarkdownLinkMenuTarget,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { ChatViewSlotProps, OpenFileOptions } from "../contract/slots.ts";
import css from "./ChatMarkdown.module.css";

type ChatMarkdownProps = Omit<MarkdownDelegateProviderProps, "onLinkContextMenu" | "openFile"> & {
  readonly openFile: (path: string, options?: OpenFileOptions) => void;
  readonly openLinkInSidebar?: ChatViewSlotProps["openLinkInSidebar"] | undefined;
  readonly t: ChatViewSlotProps["t"];
};

export function ChatMarkdown({
  children,
  openFile,
  openLinkInSidebar,
  t,
  ...delegate
}: ChatMarkdownProps) {
  const [target, setTarget] = useState<MarkdownLinkMenuTarget | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const closeMenu = useCallback(() => setTarget(null), []);
  const getAnchorRect = useCallback(() => target?.position ?? null, [target]);

  return (
    <>
      <MarkdownDelegateProvider {...delegate} openFile={openFile} onLinkContextMenu={setTarget}>
        {children}
      </MarkdownDelegateProvider>
      <Menu
        anchor={null}
        open={target !== null}
        portal
        compact
        autoFocus
        listClassName={css.linkMenu}
        getAnchorRect={getAnchorRect}
        focusReturnTarget={target?.trigger}
        onClose={closeMenu}
      >
        {target !== null && (
          <>
            {(target.kind === "file" || openLinkInSidebar !== undefined) && (
              <MenuItemButton
                icon={
                  target.kind === "file" ? (
                    <LinkIconMedium kind="document" />
                  ) : (
                    <IconBrowseOutlineMedium />
                  )
                }
                onSelect={() => {
                  closeMenu();
                  if (target.kind === "file") {
                    openFile(
                      target.path,
                      target.line === undefined ? undefined : { line: target.line },
                    );
                  } else {
                    openLinkInSidebar?.(target.href);
                  }
                }}
              >
                {t("linkMenu.openInCodexhost")}
              </MenuItemButton>
            )}
            <MenuItemButton
              icon={<IconLinkOutlineMedium />}
              onSelect={() => {
                closeMenu();
                void writeClipboard(target.href).then((copied) => setCopyFailed(!copied));
              }}
            >
              {t("linkMenu.copy")}
            </MenuItemButton>
            <MenuItemButton
              icon={<IconRightUpOutlineMedium />}
              onSelect={() => {
                closeMenu();
                if (target.kind === "web") {
                  window.open(target.href, "_blank", "noopener,noreferrer");
                } else {
                  openFile(target.path, {
                    external: true,
                    ...(target.line === undefined ? {} : { line: target.line }),
                  });
                }
              }}
            >
              {t(target.kind === "web" ? "linkMenu.openBrowser" : "linkMenu.openFile")}
            </MenuItemButton>
            {target.kind === "file" && (
              <MenuItemButton
                icon={<IconFolderOpenOutlineMedium />}
                onSelect={() => {
                  closeMenu();
                  openFile(target.path, { reveal: true });
                }}
              >
                {t("linkMenu.openFolder")}
              </MenuItemButton>
            )}
          </>
        )}
      </Menu>
      {copyFailed && <Toast text={t("linkMenu.copyFailed")} onDone={() => setCopyFailed(false)} />}
    </>
  );
}
