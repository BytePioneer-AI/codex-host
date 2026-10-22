/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Codex-style nested selection: the primary card exposes the current Model
 * and all adapter-owned Thinking levels; opening Model reveals a searchable
 * sibling card without hiding Thinking. On narrow screens the sibling replaces
 * the primary card and provides an explicit back control. The trigger
 * (313:14108's ToggleButton) shows model name + effort in the caption tone.
 * Model catalogs above four entries show search, which retains focus while
 * ↑/↓ cycle the highlighted result; Enter and Tab accept it. Smaller model
 * catalogs and Thinking panes move focus between rows. Escape and Shift+Tab
 * leave the Model sibling first and otherwise close back to the trigger. The
 * Model pane focuses the current model or its search field. Provider headings
 * paint their background only while pinned
 * by scrolling. Clearing a query restores the full list and search focus.
 * Choosing a Model or Thinking level closes the cards and restores trigger
 * focus without a ring, unless the user has already left or reopened the menu.
 * Model names match a case-insensitive ordered subsequence
 * within each provider group, ranked by
 * prefix, alignment score, then catalog order. Returning to the root pane
 * hands focus back to the cell that opened it. Data and submission ride the
 * same per-session ModelDirectory as the /model popup; exact-model reasoning
 * metadata and the selected effort come from the Host rather than a
 * client-owned vocabulary. A rejected selection announces through the shared
 * transient Toast anchored to the composer card; the in-menu strip with
 * Retry remains the catalog-load surface. While the directory's pending
 * selection is unsettled, the trigger shows a spinner in place of its
 * chevron, and each row whose value that selection carries shows one in place
 * of its check mark.
 */
import { MenuSurface } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type FocusEvent,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import type { ModelReasoningEffort, ModelSelection } from "@deepseek-ai/dsh-api-remotes/client";
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseFillRegular,
  IconDataOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  rankByName,
  StateDot,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import type { ModelSelectInjected } from "./slots.ts";
import css from "./ModelSelect.module.css";
import { orderModelProviders } from "./provider-order.ts";
import { isModelRoute } from "./fast-model.ts";

/** The primary Thinking card stays mounted while its Model sibling is open. */
type Pane = "root" | "model";

function modelKey(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path
        d="m10 2.3 2.28 4.62 5.1.74-3.69 3.59.87 5.08L10 13.94l-4.56 2.39.87-5.08-3.69-3.59 5.1-.74L10 2.3Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string;
  effort: string | undefined;
  label: string;
}

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: "hidden", left: 0, top: 0 };

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect({
  locked,
  available,
  directory,
  load,
  select,
  setFavorite,
  t,
}: ModelSelectInjected & { locked: boolean } & PropsLocale<"model">) {
  const state = useSyncExternalStore(
    (fn) => directory.subscribe(fn),
    () => directory.getSnapshot(),
  );
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>("root");
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const [selectionFocus, setSelectionFocus] = useState(false);
  const favorites = useMemo(
    () =>
      new Set(
        Object.entries(state.modelFavorites ?? {}).flatMap(([provider, ids]) =>
          ids.map((id) => modelKey(provider, id)),
        ),
      ),
    [state.modelFavorites],
  );
  const [favoritePending, setFavoritePending] = useState(false);
  const [modelSide, setModelSide] = useState<"left" | "right" | "replace">("left");
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<"load" | "select">("load");
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null);
  const toastSeq = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const modelPanelRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const modelRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  const groups = useMemo(() => orderModelProviders(state.groups), [state.groups]);
  const choices = useMemo(
    () =>
      groups.flatMap((group) =>
        group.models.map((model) => ({
          group,
          model,
          selection: {
            provider: group.id,
            model: model.id,
            ...(model.reasoning?.defaultEffort === undefined
              ? {}
              : { reasoningEffort: model.reasoning.defaultEffort }),
          } satisfies ModelSelection,
        })),
      ),
    [groups],
  );
  const showSearch = choices.length > 4;
  const filteredGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          models: rankByName(group.models, showSearch ? query.trim() : "").toSorted(
            (left, right) =>
              Number(favorites.has(modelKey(group.id, right.id))) -
              Number(favorites.has(modelKey(group.id, left.id))),
          ),
        }))
        .filter((group) => group.models.length > 0),
    [favorites, groups, query, showSearch],
  );
  const visibleModels = useMemo(
    () =>
      filteredGroups.flatMap((group) =>
        group.models.map((model) => ({
          provider: group.id,
          model,
        })),
      ),
    [filteredGroups],
  );
  const currentVisibleIndex = visibleModels.findIndex(
    (row) =>
      row.provider === state.current?.provider && isModelRoute(row.model, state.current.model),
  );
  const activeModelIndex = Math.min(
    highlightedIndex ?? Math.max(0, currentVisibleIndex),
    visibleModels.length - 1,
  );
  const selectedIndex =
    state.current === null
      ? -1
      : choices.findIndex(
          (c) =>
            c.selection.provider === state.current?.provider &&
            isModelRoute(c.model, state.current.model),
        );
  const currentChoice = choices[selectedIndex];
  const reasoning = currentChoice?.model.reasoning;
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
  const effortLabel =
    reasoning === undefined
      ? state.retainedEffort
      : effectiveEffort === undefined
        ? t("effort.providerDefault")
        : (reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ??
          effectiveEffort);
  const effortChoices = useMemo<readonly EffortChoice[]>(
    () =>
      reasoning === undefined
        ? []
        : [
            ...(reasoning.defaultEffort === undefined
              ? [{ key: "provider-default", effort: undefined, label: t("effort.providerDefault") }]
              : []),
            ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
              key: `effort:${effort.id}`,
              effort: effort.id,
              label: effort.name,
            })),
          ],
    [reasoning, t],
  );
  const { pending } = state;
  const busy = pending !== null;

  const reload = (): void => {
    lastActionRef.current = "load";
    load();
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return;
      if (menuRef.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!showSearch) {
      setQuery("");
      setHighlightedIndex(null);
    }
  }, [showSearch]);

  // Opening the sibling focuses its search/current row; backing out restores
  // focus to the Model cell in the primary Thinking card.
  const paneFocus = useRef<"model" | "model-cell" | null>(null);
  const previousShowSearch = useRef(showSearch);
  useEffect(() => {
    const changedSearchMode = previousShowSearch.current !== showSearch;
    previousShowSearch.current = showSearch;
    const intent = paneFocus.current ?? (changedSearchMode && pane === "model" ? "model" : null);
    paneFocus.current = null;
    if (!open || intent === null) return;
    if (intent === "model") {
      if (showSearch) {
        searchRef.current?.focus();
        return;
      }
      const checked = modelPanelRef.current?.querySelector<HTMLElement>(
        '[role="menuitemradio"][aria-checked="true"]:not([disabled])',
      );
      const target = checked ?? modelRefs.current.find((item) => item !== null && !item.disabled);
      (target ?? triggerRef.current)?.focus();
      return;
    }
    const modelCell = itemRefs.current.at(-1);
    (modelCell !== null && modelCell !== undefined && !modelCell.disabled
      ? modelCell
      : triggerRef.current
    )?.focus();
  }, [open, pane, showSearch]);

  useLayoutEffect(() => {
    if (open && pane === "model" && activeModelIndex >= 0) {
      modelRefs.current[activeModelIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [open, pane, activeModelIndex, visibleModels]);

  // Portaled placement (the Menu primitive's portal rules: fixed from the
  // anchor rect, measured before paint, clamped inside the viewport): above
  // the trigger, right edges aligned. Depends on pane and directory state
  // because pane switches and async catalog loads resize the card.
  /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
     that hook only places from the anchor's LEFT edge, while this card aligns
     right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const MARGIN = 12;
      const GAP = 8;
      const lw = menuRef.current?.offsetWidth ?? 0;
      const lh = menuRef.current?.offsetHeight ?? 0;
      const availableHeight = Math.max(0, rect.top - GAP - MARGIN);
      const placedHeight = Math.min(lh, availableHeight);
      let x = rect.right - lw;
      const y = Math.max(MARGIN, rect.top - GAP - placedHeight);
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN);
      const modelWidth = modelPanelRef.current?.offsetWidth ?? 264;
      const leftFits = x - GAP - modelWidth >= MARGIN;
      const rightFits = x + lw + GAP + modelWidth <= window.innerWidth - MARGIN;
      setModelSide(leftFits ? "left" : rightFits ? "right" : "replace");
      const panelMaxHeight = Math.max(
        0,
        Math.min(availableHeight, window.innerHeight - y - MARGIN),
      );
      setMenuPos({
        left: x,
        top: y,
        "--ch-model-menu-max-height": `${String(panelMaxHeight)}px`,
      } as CSSProperties);
    };
    // First run measures the hidden pre-render (same commit as `open`), so
    // the card lands placed before anything paints.
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, pane, state, query]);
  /* jscpd:ignore-end */

  if (!available) return null;

  const show = (): void => {
    setSelectionFocus(false);
    triggerRef.current?.focus();
    setQuery("");
    setHighlightedIndex(null);
    if (state.current === null) paneFocus.current = "model";
    setPane(state.current === null ? "model" : "root");
    setOpen(true);
    reload();
  };

  const changeQuery = (next: string): void => {
    setQuery(next);
    setHighlightedIndex(0);
  };

  const close = (restoreFocus = false): void => {
    setOpen(false);
    setPane("root");
    if (restoreFocus)
      queueMicrotask(() => {
        triggerRef.current?.focus();
      });
  };

  const closeAfterSelection = (): void => {
    setSelectionFocus(true);
    close(true);
  };

  const drill = (): void => {
    setQuery("");
    setHighlightedIndex(null);
    if (pane === "model") {
      if (showSearch) searchRef.current?.focus();
      else
        (
          modelPanelRef.current?.querySelector<HTMLElement>(
            '[role="menuitemradio"][aria-checked="true"]:not([disabled])',
          ) ?? modelRefs.current[0]
        )?.focus();
      return;
    }
    paneFocus.current = "model";
    setPane("model");
  };

  /** Hide the Model sibling and return the keyboard to its primary-card cell. */
  const back = (): void => {
    paneFocus.current = "model-cell";
    setPane("root");
  };

  const moveFocus = (offset: number): void => {
    const inModel =
      pane === "model" &&
      (modelPanelRef.current?.contains(document.activeElement) === true ||
        document.activeElement === searchRef.current);
    const items = (inModel ? modelRefs.current : itemRefs.current).filter((item) => item !== null);
    if (items.length === 0) return;
    const active = items.findIndex((item) => item === document.activeElement);
    // Focus outside the rows (the trigger, which keeps it while the menu
    // opens) enters at the end the step comes from: the first row forward,
    // the last row backward.
    const next =
      active === -1
        ? offset > 0
          ? 0
          : items.length - 1
        : (active + offset + items.length) % items.length;
    items[next]?.focus();
  };

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      // Escape backs out of the Model sibling first, then closes.
      if (pane === "model" && state.current !== null) back();
      else close(true);
      return;
    }
    if (!open) return;
    if (
      pane === "model" &&
      showSearch &&
      modelPanelRef.current?.contains(event.target as Node) === true &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      if (!busy && visibleModels.length > 0) {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setHighlightedIndex(
          (activeModelIndex + direction + visibleModels.length) % visibleModels.length,
        );
        searchRef.current?.focus();
      }
      return;
    }
    if (
      pane === "model" &&
      showSearch &&
      event.target instanceof HTMLInputElement &&
      (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey))
    ) {
      if (event.key === "Tab" && visibleModels.length === 0) return;
      event.preventDefault();
      const highlighted = visibleModels[activeModelIndex];
      if (!busy && highlighted !== undefined)
        choose({ provider: highlighted.provider, model: highlighted.model.id });
      return;
    }
    // Tab settles like Enter and Shift+Tab leaves like Escape, so the menu's
    // keys mean what they mean in the composer. Both are consumed: the card
    // keeps the browser's focus traversal out while it is open.
    if (event.key === "Tab") {
      if (event.shiftKey) {
        event.preventDefault();
        if (pane === "model" && state.current !== null) back();
        else close(true);
        return;
      }
      // Settling activates the row the keyboard is on; with focus still on the
      // trigger, Tab enters the menu at the value in use instead. Any other
      // control inside the card (a retry button) keeps the browser's traversal,
      // so the keystroke stays unconsumed there.
      const focused = document.activeElement;
      const rows = [...itemRefs.current, ...modelRefs.current].filter(
        (item): item is HTMLButtonElement => item !== null,
      );
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault();
        focused.click();
        return;
      }
      if (focused !== triggerRef.current) return;
      event.preventDefault();
      if (pane === "model" && showSearch) {
        setHighlightedIndex(null);
        searchRef.current?.focus();
        return;
      }
      const checked = (
        pane === "model" ? modelPanelRef.current : menuRef.current
      )?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])');
      (checked ?? rows.find((item) => !item.disabled))?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
    }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (
      event.relatedTarget instanceof Node &&
      (rootRef.current?.contains(event.relatedTarget) === true ||
        menuRef.current?.contains(event.relatedTarget) === true)
    )
      return;
    close();
  };

  const settleSelection = (
    result: Awaited<ReturnType<ModelSelectInjected["select"]>>,
    submittedMenu: HTMLDivElement | null,
  ): void => {
    if (result === undefined) return;
    if (result.ok) {
      // A late reply owns only the menu that submitted it, not a subsequent
      // opening or focus the user has moved elsewhere while waiting.
      if (
        submittedMenu !== null &&
        menuRef.current === submittedMenu &&
        (rootRef.current?.contains(document.activeElement) === true ||
          submittedMenu.contains(document.activeElement))
      )
        closeAfterSelection();
      return;
    }
    const { error } = result;
    toastSeq.current += 1;
    setToast({
      seq: toastSeq.current,
      text:
        error.code === "session/writer-held"
          ? t("error.sessionInUse")
          : t("error.action", { message: `${error.code}: ${error.message}` }),
    });
  };

  const submit = (selection: ModelSelection): void => {
    lastActionRef.current = "select";
    // Disabled option rows cannot retain focus while a selection is pending.
    setSelectionFocus(true);
    triggerRef.current?.focus();
    const submittedMenu = menuRef.current;
    void select(selection).then((result) => {
      settleSelection(result, submittedMenu);
    });
  };

  const choose = (selection: ModelSelection): void => {
    // Re-picking the current Model (plain or Fast) keeps the selection unchanged.
    if (
      state.current?.provider === selection.provider &&
      currentChoice?.selection.model === selection.model
    ) {
      closeAfterSelection();
      return;
    }
    submit(selection);
  };

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return;
    if (effectiveEffort === effort) {
      closeAfterSelection();
      return;
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
    submit(selection);
  };

  const toggleFavorite = (provider: string, model: string): void => {
    const key = modelKey(provider, model);
    if (!setFavorite || favoritePending || state.preferencesAvailable === false) return;
    setFavoritePending(true);
    void setFavorite(provider, model, !favorites.has(key))
      .catch((error) =>
        report(
          t("error.action", { message: error instanceof Error ? error.message : String(error) }),
        ),
      )
      .finally(() => setFavoritePending(false));
  };

  const waiting = state.current === null && state.status === "loading";
  const modelLabel = waiting
    ? t("trigger.loading")
    : (currentChoice?.model.name ??
      (state.current === null
        ? t("trigger.fallback")
        : `${state.current.provider}/${state.current.model}`));
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`;
  const triggerAria = waiting
    ? t("trigger.loading")
    : state.current === null
      ? t("trigger.selectAria")
      : effortLabel === undefined
        ? t("trigger.aria", { model: modelLabel })
        : t("trigger.ariaEffort", { model: modelLabel, effort: effortLabel });
  itemRefs.current = [];
  modelRefs.current = [];
  let itemIndex = 0;
  let modelIndex = 0;
  const itemRef = () => {
    const at = itemIndex++;
    return (node: HTMLButtonElement | null) => {
      itemRefs.current[at] = node;
    };
  };
  const modelRef = (at: number) => (node: HTMLButtonElement | null) => {
    modelRefs.current[at] = node;
  };

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // Keep menu chrome and buttons from blurring the menu; inputs retain native focus.
        if (event.target instanceof Element && event.target.closest("input") === null)
          event.preventDefault();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        aria-busy={busy}
        data-selection-focus={selectionFocus ? "" : undefined}
        onBlur={() => {
          setSelectionFocus(false);
        }}
        disabled={locked}
        onClick={() => {
          if (open) {
            close(true);
          } else {
            show();
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        <span className={css.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        {busy ? (
          <StateDot state="ongoing" />
        ) : (
          <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />
        )}
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={`${id}-menu`}
            className={clsx(
              css.menu,
              pane === "model" && css.modelOpen,
              pane === "model" && modelSide === "right" && css.modelRight,
              pane === "model" && modelSide === "replace" && css.modelReplace,
            )}
            style={menuPos ?? MEASURE_STYLE}
            aria-label={t("menu.aria")}
            aria-busy={state.status === "loading" || busy}
          >
            {pane === "model" && (
              <MenuSurface
                ref={modelPanelRef}
                className={clsx(css.panel, css.modelPanel)}
                role="group"
                aria-label={t("menu.model")}
              >
                <div className={css.panelHeader}>
                  <button
                    type="button"
                    className={css.backButton}
                    aria-label={t("menu.back")}
                    onClick={back}
                  >
                    <IconChevronLeftOutlineRegular />
                  </button>
                  <span>{t("menu.model")}</span>
                </div>
                {showSearch && (
                  <div
                    className={css.searchRow}
                    onMouseDown={(event) => {
                      // Search padding belongs to the field, not an outside blur target.
                      if (
                        event.target instanceof Element &&
                        event.target.closest("input, button") === null
                      ) {
                        event.preventDefault();
                        searchRef.current?.focus();
                      }
                    }}
                  >
                    <Input
                      ref={searchRef}
                      className={clsx(css.search, query !== "" && css.searchWithQuery)}
                      type="text"
                      role="searchbox"
                      aria-label={t("search.placeholder")}
                      aria-controls={`${id}-models`}
                      aria-activedescendant={
                        activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`
                      }
                      placeholder={t("search.placeholder")}
                      value={query}
                      readOnly={busy}
                      onChange={(event) => {
                        changeQuery(event.target.value);
                      }}
                    />
                    {query !== "" && (
                      <button
                        type="button"
                        className={css.searchClear}
                        aria-label={t("search.clear")}
                        disabled={busy}
                        onClick={() => {
                          changeQuery("");
                          searchRef.current?.focus();
                        }}
                      >
                        <IconCloseFillRegular />
                      </button>
                    )}
                  </div>
                )}
                {state.status === "loading" && (
                  <div className={css.status}>{t("status.loading")}</div>
                )}
                {state.error !== null && lastActionRef.current === "load" && (
                  <div className={css.error}>
                    <span>{t("error.action", { message: state.error })}</span>
                    <button type="button" className={css.retry} onClick={reload}>
                      {t("action.reload")}
                    </button>
                  </div>
                )}
                {state.failures
                  .filter((failure) => failure.id === state.current?.provider)
                  .map((failure) => (
                    <div className={css.warning} key={failure.id}>
                      <span>
                        {t("warning.groupLoad", {
                          name:
                            failure.id === "deepseek-account"
                              ? t("provider.account")
                              : failure.name,
                          message: failure.message,
                        })}
                      </span>
                      <button type="button" className={css.retry} onClick={reload}>
                        {t("action.reload")}
                      </button>
                    </div>
                  ))}
                <div
                  id={`${id}-models`}
                  className={clsx(css.groups, "scrollable")}
                  role="menu"
                  aria-label={t("menu.model")}
                  hidden={filteredGroups.length === 0}
                >
                  {filteredGroups.map((group) =>
                    group.models.map((model) => {
                      const index = modelIndex++;
                      const selected =
                        state.current?.provider === group.id &&
                        isModelRoute(model, state.current.model);
                      const favorite = favorites.has(modelKey(group.id, model.id));
                      return (
                        <div
                          className={css.modelRow}
                          role="none"
                          key={modelKey(group.id, model.id)}
                        >
                          <button
                            ref={modelRef(index)}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            id={`${id}-model-${index}`}
                            tabIndex={showSearch ? -1 : 0}
                            onFocus={() => {
                              setHighlightedIndex(index);
                            }}
                            data-highlighted={index === activeModelIndex ? "" : undefined}
                            className={clsx(
                              css.option,
                              css.modelOption,
                              selected && css.selected,
                              index === activeModelIndex && css.optionActive,
                            )}
                            onMouseMove={
                              busy || index === activeModelIndex
                                ? undefined
                                : () => {
                                    if (showSearch) setHighlightedIndex(index);
                                    else modelRefs.current[index]?.focus();
                                  }
                            }
                            title={model.name}
                            disabled={busy}
                            onClick={() => {
                              choose({ provider: group.id, model: model.id });
                            }}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.modelName}>{model.name}</span>
                            </span>
                            <span className={css.check}>
                              {pending?.provider === group.id &&
                              isModelRoute(model, pending.model) ? (
                                <StateDot state="ongoing" />
                              ) : selected ? (
                                <IconCheckOutlineRegular />
                              ) : null}
                            </span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className={clsx(css.favorite, favorite && css.favoriteActive)}
                            aria-label={t(favorite ? "favorite.remove" : "favorite.add", {
                              model: model.name,
                            })}
                            aria-pressed={favorite}
                            disabled={
                              busy || favoritePending || state.preferencesAvailable === false
                            }
                            onClick={() => {
                              toggleFavorite(group.id, model.id);
                            }}
                          >
                            <StarIcon filled={favorite} />
                          </button>
                        </div>
                      );
                    }),
                  )}
                </div>
                {state.status === "ready" && filteredGroups.length === 0 && (
                  <div className={css.empty} role="status">
                    {t(choices.length === 0 ? "empty.models" : "search.empty")}
                  </div>
                )}
              </MenuSurface>
            )}

            <MenuSurface
              className={clsx(css.panel, css.thinkingPanel)}
              role="menu"
              aria-label={t("menu.effort")}
            >
              <div className={css.panelHeader}>{t("menu.effort")}</div>
              <div className={css.thinkingOptions}>
                {state.error !== null && lastActionRef.current === "load" && (
                  <div className={css.error}>
                    <span>{t("error.action", { message: state.error })}</span>
                    <button type="button" className={css.retry} onClick={reload}>
                      {t("action.reload")}
                    </button>
                  </div>
                )}
                {effortChoices.length === 0 ? (
                  <div className={css.empty}>{t("empty.efforts")}</div>
                ) : (
                  effortChoices.map((level) => (
                    <button
                      ref={itemRef()}
                      type="button"
                      role="menuitemradio"
                      aria-checked={effectiveEffort === level.effort}
                      className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                      key={level.key}
                      disabled={busy}
                      onClick={() => {
                        chooseEffort(level.effort);
                      }}
                    >
                      <span className={css.optionCopy}>
                        <span className={css.modelName}>{level.label}</span>
                      </span>
                      <span className={css.check}>
                        {pending !== null &&
                        pending.provider === state.current?.provider &&
                        pending.model === state.current.model &&
                        pending.reasoningEffort === level.effort ? (
                          <StateDot state="ongoing" />
                        ) : effectiveEffort === level.effort ? (
                          <IconCheckOutlineRegular />
                        ) : null}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <div className={css.modelCellWrap}>
                <button
                  ref={itemRef()}
                  type="button"
                  role="menuitem"
                  className={css.cell}
                  aria-expanded={pane === "model"}
                  aria-controls={pane === "model" ? `${id}-models` : undefined}
                  onMouseEnter={() => {
                    if (pane === "root") setPane("model");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight") {
                      event.preventDefault();
                      drill();
                    }
                  }}
                  onClick={drill}
                >
                  <span className={css.cellValue}>{modelLabel}</span>
                  <IconChevronRightOutlineRegular className={css.cellChevron} />
                </button>
              </div>
            </MenuSurface>
          </div>,
          document.body,
        )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>("[data-composer-card]") ?? null}
          onDone={() => {
            setToast(null);
          }}
        />
      )}
    </div>
  );
}
