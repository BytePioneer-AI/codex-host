/**
 * Trigger candidate menu: renders the InputTriggerService menu store into the
 * conversation.input.overlay anchor. Closed state renders null (the overlay
 * slot stays mounted); groups render in roster order under localized sticky
 * headings. A pending group keeps showing the items it already had (the reducer
 * retains them across a query refinement) and falls back to two skeleton
 * rows only while it has none; pointer picks route back through
 * the service (combobox pattern — focus never leaves the textarea, so rows
 * are mousedown-handled and the highlight is exposed via
 * aria-activedescendant on the listbox). A row reads title, then the
 * command-name alias when the title differs beyond letter case or a leading
 * slash (a localized title) and the source allows it, then the description right-aligned.
 * A source publishing crumbs gets a breadcrumb
 * header pinned above the scrolling list.
 */
import {
  MenuGroup,
  MenuSurface,
  observeStickyMenuGroups,
} from "@deepseek-ai/dsh-client-ui-primitives";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import clsx from "clsx";
import {
  IconChevronRightOutlineRegular,
  ReferenceIconRegular,
  useAnchoredMaxHeight,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./MenuView.module.css";
import type { MenuViewInjected } from "./slots.ts";
import type { MenuKey } from "./locales.ts";

/** Full menu props: injected face + the locale seat. */
export type MenuViewProps = MenuViewInjected & PropsLocale<"slash.menu">;

/** Height cap that fits the two headings and eight built-in command rows. */
const MAX_HEIGHT = 400;

/**
 * Viewport top margin: the conversation header's 76px block (title row plus
 * view tabs, ui-conversation) plus 8px of air, so a tall list stops below the
 * header instead of sliding under it.
 */
const TOP_MARGIN = 84;

/** DOM id of one option row (the aria-activedescendant target). */
function optionId(source: string, index: number): string {
  return `dsh-slash-option-${source}-${index}`;
}

/**
 * Render the candidate menu overlay entry.
 * @param props - injected face (the menu store and the pick route); `t` rides the standard locale seat.
 * @returns the dropdown while open; null while closed.
 */
export function MenuView({ menu, headers, onPick, onCrumb, onHover, onDismiss, t }: MenuViewProps) {
  const state = useSyncExternalStore(
    (fn) => menu.subscribe(fn),
    () => menu.getSnapshot(),
  );
  const crumbs = useSyncExternalStore(
    (fn) => headers.subscribe(fn),
    () => headers.getSnapshot(),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [hasOverflowBelow, setHasOverflowBelow] = useState(false);
  // The list is bottom-anchored above the composer; clamp the design cap to
  // the space above it, re-measured on every store update (the anchor moves
  // when the composer grows).
  const maxHeight = useAnchoredMaxHeight(listRef, MAX_HEIGHT, state, TOP_MARGIN);
  const updateOverflowHint = useCallback(() => {
    const viewport = viewportRef.current;
    setHasOverflowBelow(
      viewport !== null && viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1,
    );
  }, []);
  useLayoutEffect(() => {
    updateOverflowHint();
  }, [state, maxHeight, updateOverflowHint]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    return observeStickyMenuGroups(viewport);
  }, [state.open, state.groups]);
  const highlight = state.open ? state.highlight : null;
  // Focus stays in the textarea (combobox pattern), so the browser never
  // scrolls the active option into view on keyboard moves — do it here.
  useEffect(() => {
    if (highlight === null) return;
    document
      .getElementById(optionId(highlight.source, highlight.index))
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);
  // Dismiss on pointer outside the menu AND outside the composer card
  // (clicking the textarea or bottom bar must not close the menu).
  useEffect(() => {
    if (!state.open) return;
    const onPointerDown = (ev: PointerEvent): void => {
      if (!(ev.target instanceof Node)) return;
      if (listRef.current?.contains(ev.target)) return;
      const composerCard = listRef.current?.closest("[data-composer-card]");
      if (composerCard?.contains(ev.target)) return;
      onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [state.open, onDismiss]);
  if (!state.open) return null;
  return (
    // The listbox role sits on the scrolling viewport, not this shell: a
    // breadcrumb header is not an option, and a listbox may not carry one.
    <MenuSurface
      ref={listRef}
      className={css.menu}
      style={{ maxHeight }}
      data-trigger-menu=""
      data-overflow-below={hasOverflowBelow || undefined}
    >
      {state.groups.map((group) => {
        const trail = crumbs.get(group.source);
        return trail === undefined ? null : (
          <nav key={group.source} className={css.crumbs} aria-label={t("crumbs.aria")}>
            {trail.map((crumb, index) => (
              <Fragment key={`${String(index)}-${crumb.value}`}>
                {index > 0 && (
                  <span className={css.crumbSeparator} aria-hidden>
                    <IconChevronRightOutlineRegular />
                  </span>
                )}
                <button
                  type="button"
                  className={clsx(css.crumb, crumb.current === true && css.crumbCurrent)}
                  aria-current={crumb.current === true ? "location" : undefined}
                  disabled={crumb.current === true}
                  // mousedown, not click: the composer keeps focus, same as a row.
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    onCrumb(group.source, index);
                  }}
                >
                  {crumb.label}
                </button>
              </Fragment>
            ))}
          </nav>
        );
      })}
      <div
        ref={viewportRef}
        className={css.viewport}
        role="listbox"
        aria-label={t("suggestions.aria")}
        aria-activedescendant={
          highlight !== null ? optionId(highlight.source, highlight.index) : undefined
        }
        onScroll={updateOverflowHint}
      >
        {state.groups.flatMap((group) => {
          if (group.status === "ready" && group.items.length === 0) return [];
          const sectioned = group.items.some((item) => item.section !== undefined);
          // Unknown source names are returned verbatim by the locale lookup.
          const sourceTitle =
            group.showGroupTitle === false || sectioned ? undefined : t(group.source as MenuKey);
          const sections: Array<{ label: string | undefined; start: number; end: number }> = [];
          for (const [index, item] of group.items.entries()) {
            const label = sectioned ? item.section : sourceTitle;
            const previous = sections.at(-1);
            if (previous && previous.label === label) previous.end = index + 1;
            else sections.push({ label, start: index, end: index + 1 });
          }
          if (sections.length === 0) sections.push({ label: sourceTitle, start: 0, end: 0 });
          return sections.map(({ label, start, end }) => {
            const rows =
              group.status === "pending" && group.items.length === 0 ? (
                <div role="status" aria-label={t("loading")} data-source={group.source}>
                  <div className={css.skeletonRow}>
                    <span className={css.skeletonBar} style={{ width: "32%" }} />
                  </div>
                  <div className={css.skeletonRow}>
                    <span className={css.skeletonBar} style={{ width: "48%" }} />
                  </div>
                </div>
              ) : (
                group.items.slice(start, end).map((item, offset) => {
                  const index = start + offset;
                  const active =
                    highlight !== null &&
                    highlight.source === group.source &&
                    highlight.index === index;
                  return (
                    <button
                      key={optionId(group.source, index)}
                      id={optionId(group.source, index)}
                      type="button"
                      role="option"
                      aria-selected={active}
                      aria-disabled={item.disabledReason !== undefined || undefined}
                      title={item.disabledReason}
                      className={clsx(css.item, active && css.active)}
                      // mousedown, not click: the textarea keeps focus (combobox
                      // pattern) — preventing default stops the focus steal, and the
                      // pick runs before any blur-driven teardown.
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        onPick(group.source, index);
                      }}
                      // mousemove, not mouseenter: real pointer motion moves the
                      // shared highlight; keyboard scrolling rows under a resting
                      // pointer must not steal it back.
                      onMouseMove={
                        active
                          ? undefined
                          : () => {
                              onHover(group.source, index);
                            }
                      }
                    >
                      {item.icon !== undefined && (
                        <span className={css.itemIcon} aria-hidden>
                          {typeof item.icon === "string" ? (
                            <ReferenceIconRegular kind={item.icon} size={14} />
                          ) : (
                            <item.icon size={14} />
                          )}
                        </span>
                      )}
                      <span className={css.itemName}>{item.label ?? item.name}</span>
                      {item.showAlias !== false &&
                        item.label !== undefined &&
                        item.label.replace(/^\//u, "").toLowerCase() !==
                          item.name.replace(/^\//u, "").toLowerCase() && (
                          <span className={css.itemAlias}>{item.name}</span>
                        )}
                      {(item.disabledReason ?? item.description) !== undefined &&
                        (item.disabledReason ?? item.description) !== (item.label ?? item.name) && (
                          <span className={css.itemDescription}>
                            {item.disabledReason ?? item.description}
                          </span>
                        )}
                      {item.drill === true && (
                        <span className={css.trailing}>
                          {/* Visual hint only: Tab drills the highlighted row (the
                                keyboard twin of the chevron, which owns the aria label). */}
                          <span className={css.drillHintText} aria-hidden>
                            {t("drill.hint")}
                          </span>
                          <kbd className={css.drillHint} aria-hidden>
                            {t("drill.key")}
                          </kbd>
                          <span
                            role="button"
                            aria-label={t("drill.aria")}
                            className={css.drill}
                            // mousedown so the composer keeps focus, same as the row;
                            // stopPropagation keeps the row's settling pick out of it.
                            onMouseDown={(ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              onPick(group.source, index, "drill");
                            }}
                          >
                            <IconChevronRightOutlineRegular size={12} />
                          </span>
                        </span>
                      )}
                    </button>
                  );
                })
              );
            const key = `${group.source}:${start}`;
            return label === undefined ? (
              <Fragment key={key}>{rows}</Fragment>
            ) : (
              <MenuGroup key={key} label={label}>
                {rows}
              </MenuGroup>
            );
          });
        })}
      </div>
    </MenuSurface>
  );
}
