import { h } from "../dom.js";

/**
 * Elements that survive a re-render carry `data-focus-key`; after the content is rebuilt, focus
 * returns to the element with the key that had it, so polling never steals the keyboard.
 */
export function focusKey<T extends HTMLElement>(element: T, key: string): T {
  element.dataset.focusKey = key;
  return element;
}

/** The focused element in the tree `node` lives in; the console renders inside a shadow root. */
function activeElementOf(node: Node): Element | null {
  const root = node.getRootNode() as Document | ShadowRoot;
  return root.activeElement ?? null;
}

export function rebuildKeepingFocus(container: HTMLElement, children: Array<Node | null>): void {
  const active = activeElementOf(container);
  const key =
    active instanceof HTMLElement && container.contains(active) ? active.dataset.focusKey : null;
  container.replaceChildren(...children.filter((child): child is Node => child !== null));
  if (!key) return;
  const next = [...container.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
    (element) => element.dataset.focusKey === key,
  );
  next?.focus({ preventScroll: true });
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

/** A row of toggle buttons where exactly one is pressed. */
export function segmented<T extends string>(
  document: Document,
  label: string,
  options: readonly SegmentOption<T>[],
  value: T,
  onChange: (value: T) => void,
  key: string,
): HTMLElement {
  return h(
    document,
    "div",
    { className: "console-usage-segmented", role: "group", "aria-label": label },
    ...options.map((option) => {
      const item = h(
        document,
        "button",
        {
          type: "button",
          className: "console-usage-segment",
          "aria-pressed": option.value === value ? "true" : "false",
          title: option.title,
        },
        option.label,
      );
      item.addEventListener("click", () => {
        if (option.value !== value) onChange(option.value);
      });
      return focusKey(item, `${key}:${option.value}`);
    }),
  );
}

export interface ComboOption {
  /** Opaque key; the caller maps it back to its value. */
  key: string;
  label: string;
  /** Shown under the label, such as a full path. */
  detail?: string;
}

/**
 * A button that opens a filterable list. The instance is kept across renders: `update` swaps
 * its options and value without closing an open list or losing what was typed.
 */
export class ComboBox {
  readonly element: HTMLElement;
  readonly #document: Document;
  readonly #button: HTMLButtonElement;
  readonly #popup: HTMLElement;
  readonly #search: HTMLInputElement;
  readonly #list: HTMLElement;
  readonly #onChange: (key: string) => void;
  readonly #searchLabel: string;
  readonly #emptyLabel: string;
  readonly #searchable: boolean;
  readonly #display: ((option: ComboOption) => string) | undefined;
  /** What carries keyboard focus while open: the search field, or the list itself. */
  readonly #keys: HTMLElement;
  #options: ComboOption[] = [];
  #value = "";
  #active = 0;
  #visible: ComboOption[] = [];
  static #ids = 0;

  constructor(
    document: Document,
    options: {
      label: string;
      searchLabel: string;
      emptyLabel: string;
      onChange: (key: string) => void;
      signal: AbortSignal;
      /** A short fixed list needs no search field; keys then go to the list. */
      searchable?: boolean;
      /** The button's text for the chosen option; its label by default. */
      display?: (option: ComboOption) => string;
    },
  ) {
    this.#document = document;
    this.#onChange = options.onChange;
    this.#searchLabel = options.searchLabel;
    this.#emptyLabel = options.emptyLabel;
    this.#searchable = options.searchable ?? true;
    this.#display = options.display;
    const id = `console-usage-combo-${++ComboBox.#ids}`;
    this.#button = h(document, "button", {
      type: "button",
      className: "console-usage-combo__button",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-label": options.label,
    });
    this.#search = h(document, "input", {
      type: "search",
      className: "console-usage-combo__search",
      placeholder: this.#searchLabel,
      "aria-label": this.#searchLabel,
      "aria-controls": `${id}-list`,
      autocomplete: "off",
    });
    this.#list = h(document, "ul", {
      className: "console-usage-combo__list",
      role: "listbox",
      id: `${id}-list`,
      "aria-label": options.label,
      tabindex: this.#searchable ? undefined : "-1",
    });
    this.#keys = this.#searchable ? this.#search : this.#list;
    this.#popup = h(
      document,
      "div",
      {
        className: this.#searchable
          ? "console-usage-combo__popup"
          : "console-usage-combo__popup is-menu",
        hidden: true,
      },
      this.#searchable ? this.#search : null,
      this.#list,
    );
    this.element = h(
      document,
      "div",
      { className: "console-usage-combo" },
      this.#button,
      this.#popup,
    );
    this.#button.addEventListener("click", () => (this.#popup.hidden ? this.open() : this.close()));
    this.#search.addEventListener("input", () => {
      this.#active = 0;
      this.#renderList();
    });
    this.#keys.addEventListener("keydown", (event) => this.#key(event));
    this.#button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && this.#popup.hidden) {
        event.preventDefault();
        this.open();
      }
    });
    document.addEventListener(
      "pointerdown",
      (event) => {
        // Inside a shadow root the event target is retargeted to the host; the path is not.
        if (!this.#popup.hidden && !event.composedPath().includes(this.element)) this.close(false);
      },
      { signal: options.signal },
    );
  }

  update(options: ComboOption[], value: string): void {
    this.#options = options;
    this.#value = value;
    const current = options.find((option) => option.key === value);
    const shown = current ?? options[0];
    this.#button.textContent = shown ? (this.#display?.(shown) ?? shown.label) : "";
    this.#button.title = current?.detail ?? "";
    this.#button.classList.toggle("is-filtered", value !== "");
    if (!this.#popup.hidden) this.#renderList();
  }

  open(): void {
    this.#popup.hidden = false;
    this.#button.setAttribute("aria-expanded", "true");
    this.#search.value = "";
    this.#active = Math.max(
      0,
      this.#options.findIndex((option) => option.key === this.#value),
    );
    this.#renderList();
    this.#keys.focus();
  }

  close(restoreFocus = true): void {
    if (this.#popup.hidden) return;
    this.#popup.hidden = true;
    this.#button.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.#button.focus();
  }

  #choose(option: ComboOption | undefined): void {
    if (!option) return;
    this.close();
    if (option.key !== this.#value) this.#onChange(option.key);
  }

  #key(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.#active = Math.min(Math.max(this.#active + step, 0), this.#visible.length - 1);
      this.#renderList();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.#choose(this.#visible[this.#active]);
    }
  }

  #renderList(): void {
    const query = this.#search.value.trim().toLocaleLowerCase();
    this.#visible = this.#options.filter(
      (option) =>
        !query ||
        option.label.toLocaleLowerCase().includes(query) ||
        option.detail?.toLocaleLowerCase().includes(query),
    );
    this.#active = Math.min(this.#active, Math.max(0, this.#visible.length - 1));
    if (this.#visible.length === 0) {
      this.#list.replaceChildren(
        h(this.#document, "li", { className: "console-usage-combo__empty" }, this.#emptyLabel),
      );
      this.#keys.removeAttribute("aria-activedescendant");
      return;
    }
    const id = this.#list.id;
    this.#list.replaceChildren(
      ...this.#visible.map((option, index) => {
        const item = h(
          this.#document,
          "li",
          {
            id: `${id}-${index}`,
            role: "option",
            className: index === this.#active ? "is-active" : undefined,
            "aria-selected": option.key === this.#value ? "true" : "false",
          },
          h(this.#document, "span", {}, option.label),
          option.detail
            ? h(this.#document, "small", { className: "console-muted" }, option.detail)
            : null,
        );
        item.addEventListener("pointerdown", (event) => event.preventDefault());
        item.addEventListener("click", () => this.#choose(option));
        return item;
      }),
    );
    this.#keys.setAttribute("aria-activedescendant", `${id}-${this.#active}`);
    this.#list.children[this.#active]?.scrollIntoView({ block: "nearest" });
  }
}

export interface Column<Row> {
  key: string;
  label: string;
  /** Sort value; columns without one are not sortable. */
  sort?: (row: Row) => number | string;
  cell: (row: Row) => Node | string;
  className?: string;
  title?: string;
}

export interface TableState {
  sort: string;
  descending: boolean;
  expanded: boolean;
}

/**
 * A table with sortable headers that shows its first `limit` rows and folds the rest behind a
 * "N more" button. Its state lives with the caller, so a re-render keeps it.
 */
export function dataTable<Row>(
  document: Document,
  options: {
    key: string;
    columns: Column<Row>[];
    rows: Row[];
    state: TableState;
    limit: number;
    sortLabel: (name: string) => string;
    moreLabel: (count: number) => string;
    lessLabel: string;
    onState: (state: TableState) => void;
    rowClass?: (row: Row) => string | undefined;
  },
): HTMLElement {
  const { columns, state } = options;
  const sortColumn = columns.find((column) => column.key === state.sort && column.sort);
  const rows = sortColumn?.sort
    ? [...options.rows].sort((left, right) => {
        const a = sortColumn.sort?.(left) ?? 0;
        const b = sortColumn.sort?.(right) ?? 0;
        const order =
          typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a).localeCompare(String(b));
        return state.descending ? -order : order;
      })
    : options.rows;
  const shown = state.expanded ? rows : rows.slice(0, options.limit);
  const hidden = rows.length - shown.length;
  const header = h(
    document,
    "tr",
    {},
    ...columns.map((column) => {
      if (!column.sort) {
        return h(
          document,
          "th",
          { scope: "col", className: column.className, title: column.title },
          column.label,
        );
      }
      const active = column.key === state.sort;
      const sort = h(
        document,
        "button",
        {
          type: "button",
          className: "console-usage-sort",
          title: column.title ?? options.sortLabel(column.label),
        },
        column.label,
        h(
          document,
          "span",
          { className: "console-usage-sort__mark", "aria-hidden": "true" },
          active ? (state.descending ? "↓" : "↑") : "↕",
        ),
      );
      sort.addEventListener("click", () =>
        options.onState({
          ...state,
          sort: column.key,
          descending: active ? !state.descending : true,
        }),
      );
      return h(
        document,
        "th",
        {
          scope: "col",
          className: column.className,
          "aria-sort": active ? (state.descending ? "descending" : "ascending") : undefined,
        },
        focusKey(sort, `${options.key}:sort:${column.key}`),
      );
    }),
  );
  const table = h(
    document,
    "table",
    { className: "console-usage-table" },
    h(document, "thead", {}, header),
    h(
      document,
      "tbody",
      {},
      ...shown.map((row) =>
        h(
          document,
          "tr",
          { className: options.rowClass?.(row) },
          ...columns.map((column, index) =>
            h(
              document,
              index === 0 ? "th" : "td",
              { scope: index === 0 ? "row" : undefined, className: column.className },
              column.cell(row),
            ),
          ),
        ),
      ),
    ),
  );
  const toggle =
    hidden > 0 || state.expanded
      ? focusKey(
          h(
            document,
            "button",
            { type: "button", className: "console-usage-more" },
            state.expanded ? options.lessLabel : options.moreLabel(hidden),
          ),
          `${options.key}:more`,
        )
      : null;
  toggle?.addEventListener("click", () => options.onState({ ...state, expanded: !state.expanded }));
  return h(
    document,
    "div",
    { className: "console-usage-table-wrap" },
    h(document, "div", { className: "console-usage-table-scroll" }, table),
    rows.length > options.limit ? toggle : null,
  );
}

/** A tooltip card positioned beside a point inside `wrapper`, flipping to stay inside it. */
export function tooltipCard(document: Document, wrapper: HTMLElement) {
  const card = h(document, "div", { className: "console-usage-tooltip", hidden: true });
  wrapper.append(card);
  return {
    show(children: Node[], x: number, y = 0): void {
      card.replaceChildren(...children);
      card.hidden = false;
      const box = wrapper.getBoundingClientRect();
      const gap = 14;
      const left =
        box.width - x - gap >= card.offsetWidth ? x + gap : Math.max(0, x - gap - card.offsetWidth);
      card.style.left = `${left}px`;
      card.style.top = `${Math.max(0, Math.min(y, box.height - card.offsetHeight))}px`;
    },
    hide(): void {
      card.hidden = true;
    },
  };
}

export function tooltipLine(
  document: Document,
  label: string,
  value: string,
  options: { strong?: boolean; swatch?: string } = {},
): HTMLElement {
  const name = h(document, "span", { className: "console-usage-tooltip__name" });
  if (options.swatch) {
    const swatch = h(document, "i", { className: "console-usage-swatch", "aria-hidden": "true" });
    swatch.style.background = options.swatch;
    name.append(swatch);
  }
  name.append(label);
  return h(
    document,
    "div",
    {
      className: options.strong
        ? "console-usage-tooltip__row is-strong"
        : "console-usage-tooltip__row",
    },
    name,
    h(document, "span", {}, value),
  );
}

/** Saves `text` as a file the viewer downloads. */
export function download(document: Document, name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h(document, "a", { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
