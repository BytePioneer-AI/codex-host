import type { HTMLAttributes } from "react";

type MarkdownMenuLink = { readonly href: string } & (
  | { readonly kind: "file"; readonly path: string; readonly line?: number }
  | { readonly kind: "web" }
);

export type MarkdownLinkMenuTarget = MarkdownMenuLink & {
  readonly trigger: HTMLElement;
  readonly position: DOMRect;
};

export function linkContextMenuProps(
  onContextMenu: ((target: MarkdownLinkMenuTarget) => void) | undefined,
  link: MarkdownMenuLink,
): Pick<HTMLAttributes<HTMLElement>, "aria-haspopup" | "onContextMenu" | "onKeyDown"> {
  if (onContextMenu === undefined) return {};
  return {
    "aria-haspopup": "menu",
    onContextMenu(event) {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu({
        ...link,
        trigger: event.currentTarget,
        position: new DOMRect(event.clientX, event.clientY, 0, 0),
      });
    },
    onKeyDown(event) {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      onContextMenu({
        ...link,
        trigger: event.currentTarget,
        position: event.currentTarget.getBoundingClientRect(),
      });
    },
  };
}
