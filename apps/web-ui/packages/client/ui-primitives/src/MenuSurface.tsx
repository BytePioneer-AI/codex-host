/** Shared menu material and the macOS backing that lets Chromium blur transparent windows. */
import {
  forwardRef,
  useId,
  useLayoutEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import css from "./MenuSurface.module.css";

/** Menu containers preserve native div props and refs. */
export interface MenuSurfaceProps extends ComponentPropsWithoutRef<"div"> {
  /** Match the shared compact menu's smaller outer radius. */
  compact?: boolean;
  /** Surface material: translucent (default blur) or solid (crisp opaque without backdrop blur). */
  material?: "translucent" | "solid";
}

/**
 * Paint a menu and, on macOS, an opaque backing behind the page content within its bounds.
 * CSS anchors keep each backing aligned during placement, resizing, and nested-menu movement.
 * @param props - Div content and placement, compact geometry, and surface material.
 * @param ref - The visible menu div, excluding the non-interactive backing.
 * @returns Menu content plus a backing portal removed with the menu.
 */
export const MenuSurface = forwardRef<HTMLDivElement, MenuSurfaceProps>(function MenuSurface(
  { compact = false, material = "translucent", className, style, children, ...props },
  ref,
) {
  const id = useId();
  const backingRef = useRef<HTMLDivElement>(null);
  const translucent = material === "translucent";
  useLayoutEffect(() => {
    if (!translucent || backingRef.current === null) return;
    // Nested React portals can insert the backing before its anchor. CSS anchor
    // positioning requires the anchor to precede the positioned element.
    document.body.appendChild(backingRef.current);
  }, [translucent]);
  const anchorStyle: (CSSProperties & { "--dsh-menu-anchor"?: string }) | undefined = translucent
    ? { "--dsh-menu-anchor": `--dsh-menu-${id.replaceAll(":", "")}` }
    : undefined;
  return (
    <>
      <div
        {...props}
        ref={ref}
        data-menu-material={material}
        className={clsx(css.surface, compact && css.compact, !translucent && css.solid, className)}
        style={anchorStyle === undefined ? style : { ...style, ...anchorStyle }}
      >
        <div aria-hidden="true" className={css.material} />
        {children}
      </div>
      {translucent &&
        createPortal(
          <div
            ref={backingRef}
            aria-hidden="true"
            data-menu-backing=""
            className={clsx(css.backing, compact && css.compact)}
            style={{ ...anchorStyle, visibility: style?.visibility }}
          />,
          document.body,
        )}
    </>
  );
});
