import { h } from "../dom.js";
import { focusKey, tooltipCard, tooltipLine } from "./controls.js";
import {
  axisValue,
  emptyTotals,
  formatMeasure,
  measured,
  niceCeiling,
  type Measure,
  type Totals,
} from "./format.js";

const SVG = "http://www.w3.org/2000/svg";

function svg(document: Document, tag: string, attributes: Record<string, string | number>) {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

/** Categorical slots in fixed order (validated light and dark); the last series is "Others". */
export const SERIES_COLORS = [
  "var(--usage-series-1)",
  "var(--usage-series-2)",
  "var(--usage-series-3)",
  "var(--usage-series-4)",
  "var(--usage-series-5)",
];
export const OTHERS_COLOR = "var(--usage-series-other)";

export interface Series {
  key: string;
  label: string;
  color: string;
}

export interface Bucket {
  /** A date for daily buckets, the first date for weeks and months. */
  key: string;
  short: string;
  long: string;
  totals: Totals;
  series: Map<string, Totals>;
}

/** Hover and keyboard position kept across re-renders, so polling does not drop the tooltip. */
export interface ChartPointer {
  index: number;
  x: number;
}

export interface TrendOptions {
  key: string;
  buckets: Bucket[];
  series: Series[];
  measure: Measure;
  labels: Record<"cost" | "tokens" | "requests" | "hint", string>;
  /** Bucket key that is selected, if any; other buckets dim. */
  selected: string | null;
  /** Called with a bucket key to select, or null to clear; absent when buckets cannot be picked. */
  onSelect?: (key: string | null) => void;
  /** Called with a series key when its legend entry is clicked. */
  onSeries?: (key: string) => void;
  pointer: ChartPointer;
}

/**
 * Stacked columns of one measure over time, with round-number gridlines, spaced date ticks, a
 * hover card breaking a column down by series, and keyboard navigation.
 */
export function trendChart(document: Document, options: TrendOptions): HTMLElement {
  const { buckets, series, measure, pointer } = options;
  const width = 720;
  const height = 190;
  const left = 46;
  const top = 8;
  const bottom = 22;
  const plot = width - left;
  const baseY = height - bottom;
  const values = buckets.map((bucket) => measured(bucket.totals, measure));
  const ceiling = niceCeiling(Math.max(0, ...values));
  const slot = plot / Math.max(buckets.length, 1);
  const bar = Math.max(1, Math.min(28, slot * 0.72));
  const chart = svg(document, "svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "console-usage-chart",
    "aria-hidden": "true",
  });

  for (const fraction of [0, 0.5, 1]) {
    const y = baseY - (baseY - top) * fraction;
    chart.append(
      svg(document, "line", {
        x1: left,
        x2: width,
        y1: y,
        y2: y,
        class: fraction === 0 ? "console-usage-chart__axis" : "console-usage-chart__grid",
      }),
    );
    const label = svg(document, "text", {
      x: left - 8,
      y: y + 4,
      "text-anchor": "end",
      class: "console-usage-chart__label",
    });
    label.textContent = axisValue(measure, ceiling * fraction);
    chart.append(label);
  }

  const columns: SVGGElement[] = buckets.map((bucket, index) => {
    const group = svg(document, "g", { class: "console-usage-chart__column" }) as SVGGElement;
    if (options.selected !== null) {
      group.classList.toggle("is-dimmed", bucket.key !== options.selected);
    }
    const x = left + index * slot + (slot - bar) / 2;
    let y = baseY;
    const stack = series
      .map((item) => ({
        item,
        value: measured(bucket.series.get(item.key) ?? emptyTotals(), measure),
      }))
      .filter(({ value }) => value > 0);
    stack.forEach(({ item, value }, position) => {
      const segment = Math.max(
        position === stack.length - 1 ? 2 : 0,
        ((baseY - top) * value) / ceiling,
      );
      if (segment <= 0) return;
      const topY = y - segment;
      const isTop = position === stack.length - 1;
      const radius = isTop ? Math.min(4, bar / 2, segment) : 0;
      // Rounded at the data end only; a thin surface stroke separates stacked segments.
      const path = svg(document, "path", {
        d:
          `M${x},${y}V${topY + radius}Q${x},${topY} ${x + radius},${topY}` +
          `H${x + bar - radius}Q${x + bar},${topY} ${x + bar},${topY + radius}V${y}Z`,
        class: "console-usage-chart__bar",
        fill: item.color,
      });
      group.append(path);
      y = topY;
    });
    chart.append(group);
    return group;
  });

  const step = Math.max(1, Math.ceil(buckets.length / 6));
  const ticks = new Set<number>();
  for (let index = 0; index < buckets.length; index += step) ticks.add(index);
  if (buckets.length > 1) {
    for (const index of ticks) if (buckets.length - 1 - index < step * 0.6) ticks.delete(index);
    ticks.add(buckets.length - 1);
  }
  for (const index of ticks) {
    const bucket = buckets[index];
    if (!bucket) continue;
    const isLast = index === buckets.length - 1 && buckets.length > 1;
    const isFirst = index === 0;
    const label = svg(document, "text", {
      x: isLast ? width : isFirst ? left : left + index * slot + slot / 2,
      y: height - 5,
      "text-anchor": isLast ? "end" : isFirst ? "start" : "middle",
      class: "console-usage-chart__label",
    });
    label.textContent = bucket.short;
    chart.append(label);
  }

  const wrapper = focusKey(
    h(document, "div", {
      className: options.onSelect
        ? "console-usage-chart-wrap is-selectable"
        : "console-usage-chart-wrap",
      tabindex: "0",
      role: "group",
      "aria-label": options.onSelect ? options.labels.hint : (buckets.at(-1)?.long ?? ""),
    }),
    `${options.key}:chart`,
  );
  wrapper.append(chart);
  const tooltip = tooltipCard(document, wrapper);
  const legend =
    series.length > 1
      ? h(
          document,
          "div",
          { className: "console-usage-legend" },
          ...series.map((item) => {
            const swatch = h(document, "i", {
              className: "console-usage-swatch",
              "aria-hidden": "true",
            });
            swatch.style.background = item.color;
            const entry = h(
              document,
              options.onSeries ? "button" : "span",
              {
                className: "console-usage-legend__item",
                type: options.onSeries ? "button" : undefined,
              },
              swatch,
              item.label,
            );
            if (options.onSeries) {
              entry.addEventListener("click", () => options.onSeries?.(item.key));
              focusKey(entry, `${options.key}:legend:${item.key}`);
            }
            return entry;
          }),
        )
      : null;

  const xOf = (index: number): number => {
    const box = chart.getBoundingClientRect();
    const wrap = wrapper.getBoundingClientRect();
    return box.left - wrap.left + ((left + index * slot + slot / 2) * box.width) / width;
  };
  const show = (index: number, x = xOf(index)): void => {
    const bucket = buckets[index];
    if (!bucket) return;
    columns[pointer.index]?.classList.remove("is-active");
    columns[index]?.classList.add("is-active");
    pointer.index = index;
    pointer.x = x;
    const parts = series
      .map((item) => ({ item, totals: bucket.series.get(item.key) }))
      .filter(({ totals }) => totals && measured(totals, measure) > 0)
      .reverse();
    tooltip.show(
      [
        h(document, "div", { className: "console-usage-tooltip__date" }, bucket.long),
        tooltipLine(document, options.labels.cost, formatMeasure("cost", bucket.totals.costUsd), {
          strong: measure === "cost",
        }),
        tooltipLine(
          document,
          options.labels.tokens,
          formatMeasure("tokens", measured(bucket.totals, "tokens")),
          {
            strong: measure === "tokens",
          },
        ),
        tooltipLine(
          document,
          options.labels.requests,
          formatMeasure("requests", bucket.totals.requests),
          {
            strong: measure === "requests",
          },
        ),
        ...(parts.length > 1
          ? [
              h(document, "div", { className: "console-usage-tooltip__divider" }),
              ...parts.map(({ item, totals }) =>
                tooltipLine(
                  document,
                  item.label,
                  formatMeasure(measure, measured(totals ?? emptyTotals(), measure)),
                  { swatch: item.color },
                ),
              ),
            ]
          : []),
      ],
      x,
    );
  };
  const hide = (): void => {
    columns[pointer.index]?.classList.remove("is-active");
    pointer.index = -1;
    tooltip.hide();
  };
  const indexAt = (clientX: number): number => {
    const box = chart.getBoundingClientRect();
    if (box.width <= 0) return -1;
    const x = ((clientX - box.left) * width) / box.width;
    const index = Math.floor((x - left) / slot);
    return x < left || index < 0 || index >= buckets.length ? -1 : index;
  };
  wrapper.addEventListener("pointermove", (event) => {
    const index = indexAt(event.clientX);
    if (index < 0) hide();
    else show(index, event.clientX - wrapper.getBoundingClientRect().left);
  });
  wrapper.addEventListener("pointerleave", hide);
  wrapper.addEventListener("blur", hide);
  wrapper.addEventListener("click", (event) => {
    const index = indexAt(event.clientX);
    const bucket = buckets[index];
    if (!options.onSelect || !bucket) return;
    options.onSelect(bucket.key === options.selected ? null : bucket.key);
  });
  wrapper.addEventListener("keydown", (event) => {
    if (buckets.length === 0) return;
    const current = pointer.index >= 0 ? pointer.index : buckets.length - 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const next = Math.min(
        Math.max(current + (event.key === "ArrowRight" ? 1 : -1), 0),
        buckets.length - 1,
      );
      show(pointer.index >= 0 ? next : current);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      show(event.key === "Home" ? 0 : buckets.length - 1);
    } else if ((event.key === "Enter" || event.key === " ") && options.onSelect) {
      event.preventDefault();
      const bucket = buckets[current];
      if (bucket) options.onSelect(bucket.key === options.selected ? null : bucket.key);
    } else if (event.key === "Escape" && options.onSelect && options.selected !== null) {
      event.preventDefault();
      options.onSelect(null);
    }
  });
  // Rebuilt by a refresh while hovered or focused: show the same column again once laid out.
  if (pointer.index >= 0 && pointer.index < buckets.length) {
    const restore = pointer.index;
    requestAnimationFrame(() => {
      if (wrapper.isConnected) show(restore, pointer.x);
    });
  } else {
    pointer.index = -1;
  }
  return h(document, "div", { className: "console-usage-trend" }, legend, wrapper);
}

export interface HourCell {
  weekday: number;
  hour: number;
  totals: Totals;
}

/**
 * When in the day or week usage happens. One day: 24 columns. Longer: a weekday × hour grid in
 * one sequential hue, light to dark, each cell with its own hover card.
 */
export function hourlyChart(
  document: Document,
  options: {
    cells: HourCell[];
    measure: Measure;
    singleDay: boolean;
    locale: string;
    weekStartsOnMonday: boolean;
    labels: Record<"cost" | "tokens" | "requests", string>;
  },
): HTMLElement {
  const { measure } = options;
  const byHour = new Map<number, Totals>();
  for (const cell of options.cells) {
    const key = options.singleDay ? cell.hour : cell.weekday * 24 + cell.hour;
    const totals = byHour.get(key) ?? emptyTotals();
    for (const field of Object.keys(totals) as Array<keyof Totals>)
      totals[field] += cell.totals[field];
    byHour.set(key, totals);
  }
  const max = Math.max(0, ...[...byHour.values()].map((totals) => measured(totals, measure)));
  const wrapper = h(document, "div", { className: "console-usage-hourly" });
  const tooltip = tooltipCard(document, wrapper);
  const describe = (title: string, totals: Totals): Node[] => [
    h(document, "div", { className: "console-usage-tooltip__date" }, title),
    tooltipLine(document, options.labels.cost, formatMeasure("cost", totals.costUsd), {
      strong: measure === "cost",
    }),
    tooltipLine(
      document,
      options.labels.tokens,
      formatMeasure("tokens", measured(totals, "tokens")),
      {
        strong: measure === "tokens",
      },
    ),
    tooltipLine(document, options.labels.requests, formatMeasure("requests", totals.requests), {
      strong: measure === "requests",
    }),
  ];
  const hourLabel = (hour: number): string => `${String(hour).padStart(2, "0")}:00`;
  const hover = (element: HTMLElement, title: string, totals: Totals): void => {
    element.addEventListener("pointerenter", () => {
      const box = wrapper.getBoundingClientRect();
      const cell = element.getBoundingClientRect();
      tooltip.show(
        describe(title, totals),
        cell.left - box.left + cell.width / 2,
        cell.bottom - box.top + 4,
      );
    });
    element.addEventListener("pointerleave", () => tooltip.hide());
  };

  if (options.singleDay) {
    const ceiling = niceCeiling(max);
    const grid = h(document, "div", { className: "console-usage-hours" });
    for (let hour = 0; hour < 24; hour++) {
      const totals = byHour.get(hour) ?? emptyTotals();
      const value = measured(totals, measure);
      const column = h(document, "div", { className: "console-usage-hours__column" });
      const fill = h(document, "div", { className: "console-usage-hours__bar" });
      fill.style.height = `${value > 0 ? Math.max(3, (value / ceiling) * 100) : 0}%`;
      column.append(fill);
      hover(column, `${hourLabel(hour)} – ${hourLabel((hour + 1) % 24)}`, totals);
      grid.append(column);
    }
    const axis = h(
      document,
      "div",
      { className: "console-usage-hours__axis" },
      ...[0, 6, 12, 18, 23].map((hour) => h(document, "span", {}, hourLabel(hour))),
    );
    wrapper.append(grid, axis);
    return wrapper;
  }

  const weekdayName = new Intl.DateTimeFormat(options.locale, { weekday: "short" });
  // 2026-10-04 is a Sunday; adding the weekday number gives that weekday's name.
  const nameOf = (weekday: number): string =>
    weekdayName.format(new Date(2026, 9, 4 + weekday, 12));
  const order = options.weekStartsOnMonday ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const grid = h(document, "div", { className: "console-usage-heatmap", role: "img" });
  grid.setAttribute("aria-label", options.labels.requests);
  grid.append(h(document, "span", {}));
  for (let hour = 0; hour < 24; hour++) {
    grid.append(
      h(
        document,
        "span",
        { className: "console-usage-heatmap__hour" },
        hour % 3 === 0 ? String(hour) : "",
      ),
    );
  }
  for (const weekday of order) {
    grid.append(h(document, "span", { className: "console-usage-heatmap__day" }, nameOf(weekday)));
    for (let hour = 0; hour < 24; hour++) {
      const totals = byHour.get(weekday * 24 + hour) ?? emptyTotals();
      const value = measured(totals, measure);
      // Five steps of one hue; empty stays on the surface.
      const level = value > 0 && max > 0 ? Math.min(5, Math.ceil((value / max) * 5)) : 0;
      const cell = h(document, "span", {
        className: `console-usage-heatmap__cell is-level-${level}`,
      });
      hover(cell, `${nameOf(weekday)} ${hourLabel(hour)}`, totals);
      grid.append(cell);
    }
  }
  wrapper.append(grid);
  return wrapper;
}
