import {
  USAGE_STATISTICS_METHOD,
  USAGE_STATISTICS_RANGES,
  harnessPluginListResultSchema,
  usageStatisticsResultSchema,
  type UsageStatisticsParams,
  type UsageStatisticsRange,
  type UsageStatisticsResult,
  type UsageStatisticsSession,
} from "@codexhost/shared-contracts";

import { h } from "../dom.js";
import { usageModelLabel } from "../usage/model-labels.js";
import { costWithCredits } from "../usage/credits.js";
import type { ConsoleMessages } from "../messages.js";
import { createModelPricesDialog } from "../model-prices.js";
import { createRendererSettingsIcon } from "../../settings/icons.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "../../settings/core.js";
import {
  OTHERS_COLOR,
  SERIES_COLORS,
  hourlyChart,
  trendChart,
  type Bucket,
  type ChartPointer,
  type Series,
} from "../usage/charts.js";
import {
  ComboBox,
  dataTable,
  download,
  focusKey,
  rebuildKeepingFocus,
  segmented,
  type Column,
  type TableState,
} from "../usage/controls.js";
import {
  MEASURES,
  addTotals,
  allUnpriced,
  asDate,
  baseName,
  cacheHitRate,
  cost,
  count,
  datesBetween,
  emptyTotals,
  fill,
  inputWithoutCache,
  isoDate,
  measured,
  percent,
  projectNames,
  tokenCount,
  tokensWithoutCache,
  unmetered,
  type Measure,
  type Totals,
} from "../usage/format.js";

type HostRequest = (method: string, params: unknown) => Promise<unknown>;
type Granularity = "day" | "week" | "month";

/** Console Host method that names the installed Harness plugins. */
const HARNESS_PLUGIN_LIST_METHOD = "codexhost/harness/plugins/list";
const POLL_MS = 2_000;
/** Filter key of the requests whose record names no Model or project; never a real value. */
const UNKNOWN = "\u0000unknown";
const OTHERS = "\u0000others";
/** Per-viewer view state: range, measure, filters and refresh survive leaving the page. */
const VIEW_STORAGE_KEY = "codexhost.console.usageStatistics.view.v2";
const AUTO_REFRESH_CHOICES = [0, 30_000, 60_000, 300_000] as const;
const TABLE_LIMIT = 6;
const SESSION_LIMIT = 10;

interface View {
  range: UsageStatisticsRange;
  measure: Measure;
  granularity: Granularity | null;
  harness: string;
  model: string;
  project: string;
  autoRefreshMs: number;
}

function readView(): Partial<View> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return {};
    const view = value as Record<string, unknown>;
    const text = (name: string): string | undefined =>
      typeof view[name] === "string" ? (view[name] as string) : undefined;
    const range = text("range") as UsageStatisticsRange | undefined;
    const measure = text("measure") as Measure | undefined;
    const granularity = text("granularity");
    const harness = text("harness");
    const model = text("model");
    const project = text("project");
    const auto = Number(view.autoRefreshMs);
    return {
      ...(range && USAGE_STATISTICS_RANGES.includes(range) ? { range } : {}),
      ...(measure && MEASURES.includes(measure) ? { measure } : {}),
      ...(granularity === "day" || granularity === "week" || granularity === "month"
        ? { granularity }
        : {}),
      ...(harness !== undefined ? { harness } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(project !== undefined ? { project } : {}),
      ...((AUTO_REFRESH_CHOICES as readonly number[]).includes(auto)
        ? { autoRefreshMs: auto }
        : {}),
    };
  } catch {
    return {};
  }
}

function writeView(view: View): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage may be unavailable; the view then starts from defaults next time.
  }
}

/** Filter key to request value: "" is every value, UNKNOWN is the requests naming none. */
function filterValue(key: string): string | null | undefined {
  return key === "" ? undefined : key === UNKNOWN ? null : key;
}

function keyOf(value: string | null): string {
  return value ?? UNKNOWN;
}

/** The totals kept under `key`, created empty on first use. */
function slot<K>(map: Map<K, Totals>, key: K): Totals {
  let totals = map.get(key);
  if (!totals) {
    totals = emptyTotals();
    map.set(key, totals);
  }
  return totals;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The Monday on or before `date`. */
function weekStart(date: string): string {
  const day = asDate(date);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return isoDate(day);
}

/**
 * Machine-wide usage of the local Host: every native session of the Harnesses that expose local
 * usage, at the public price by Model ID. The Host aggregates for the chosen range and filters;
 * the page renders the facets, lets any row, legend entry or day narrow the view, and keeps its
 * controls, focus and hover across refreshes. Tokens are shown as input
 * without cache reads and writes, with the cache on its own.
 */
export function createUsageStatisticsPage(
  consoleMessages: ConsoleMessages,
  request: HostRequest,
): RendererSettingsPageDefinition {
  const messages = consoleMessages.usageStatistics;
  return Object.freeze({
    id: "usage-statistics",
    label: messages.label,
    icon: "dashboard" as const,
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const locale = document.documentElement.lang || "en";
      const saved = readView();
      const view: View = {
        range: saved.range ?? "30d",
        measure: saved.measure ?? "cost",
        granularity: saved.granularity ?? null,
        harness: saved.harness ?? "",
        model: saved.model ?? "",
        project: saved.project ?? "",
        autoRefreshMs: saved.autoRefreshMs ?? 0,
      };
      let date: string | null = null;
      let unpricedOnly = false;
      let result: UsageStatisticsResult | null = null;
      let error: string | null = null;
      let loadedAt = 0;
      let poll: number | undefined;
      const tables: Record<"harness" | "model" | "project" | "sessions", TableState> = {
        harness: { sort: "share", descending: true, expanded: false },
        model: { sort: "share", descending: true, expanded: false },
        project: { sort: "share", descending: true, expanded: false },
        sessions: { sort: "measure", descending: true, expanded: false },
      };
      const pointer: ChartPointer = { index: -1, x: 0 };
      const names = new Map<string, string>();
      let copiedSession: string | null = null;

      const save = (): void => writeView(view);
      const harnessName = (id: string): string => names.get(id) ?? id;
      const modelName = (key: string, harness = view.harness): string =>
        key === UNKNOWN
          ? messages.unknownModel
          : usageModelLabel(key, result?.modelLabels, harness);
      let projectLabel = new Map<string, string>();
      const projectName = (key: string): string =>
        key === UNKNOWN ? messages.unknownProject : (projectLabel.get(key) ?? baseName(key));
      const measureLabel = (measure: Measure): string =>
        measure === "cost" ? messages.cost : messages.tokens;
      const dateFormat = (options: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat(locale, options);
      const shortDate = dateFormat({ month: "short", day: "numeric" });
      const longDate = dateFormat({
        year: "numeric",
        month: "short",
        day: "numeric",
        weekday: "short",
      });
      const monthShort = dateFormat({ month: "short" });
      const monthLong = dateFormat({ year: "numeric", month: "long" });
      const dateTime = dateFormat({
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const prices = createModelPricesDialog(
        document,
        consoleMessages,
        request,
        context.signal,
        load,
      );

      // --- Persistent header and filter bar ----------------------------------------------------
      const updated = h(document, "span", { className: "console-muted console-usage-updated" });
      const refresh = h(
        document,
        "button",
        {
          type: "button",
          className: "console-usage-icon-button",
          title: messages.refresh,
          "aria-label": messages.refresh,
        },
        createRendererSettingsIcon("refresh", 16),
      );
      refresh.addEventListener("click", () => load());
      const auto = new ComboBox(document, {
        label: messages.autoRefresh,
        searchLabel: messages.search,
        emptyLabel: messages.noMatches,
        signal: context.signal,
        searchable: false,
        display: (option) => `${messages.autoRefresh} · ${option.label}`,
        onChange: (key) => {
          view.autoRefreshMs = Number(key) || 0;
          save();
          schedule();
          autoOptions();
        },
      });
      // "" is off, so the button is highlighted only while refreshing on its own.
      const autoOptions = (): void =>
        auto.update(
          AUTO_REFRESH_CHOICES.map((choice) => ({
            key: choice === 0 ? "" : String(choice),
            label:
              choice === 0
                ? messages.autoOff
                : choice < 60_000
                  ? fill(messages.everySeconds, { count: choice / 1_000 })
                  : fill(messages.everyMinutes, { count: choice / 60_000 }),
          })),
          view.autoRefreshMs === 0 ? "" : String(view.autoRefreshMs),
        );
      autoOptions();
      const exportButton = h(
        document,
        "button",
        { type: "button", className: "settings-command-button settings-command-button--secondary" },
        messages.exportCsv,
      );
      exportButton.addEventListener("click", () => exportCsv());
      const header = h(
        document,
        "div",
        { className: "console-usage-header" },
        h(document, "h1", { className: "settings-section-label" }, messages.label),
        h(
          document,
          "div",
          { className: "console-usage-toolbar" },
          updated,
          refresh,
          auto.element,
          exportButton,
        ),
      );

      const modelCombo = new ComboBox(document, {
        label: messages.filterModel,
        searchLabel: messages.search,
        emptyLabel: messages.noMatches,
        signal: context.signal,
        onChange: (key) => {
          view.model = key;
          changed();
        },
      });
      const projectCombo = new ComboBox(document, {
        label: messages.filterProject,
        searchLabel: messages.search,
        emptyLabel: messages.noMatches,
        signal: context.signal,
        onChange: (key) => {
          view.project = key;
          changed();
        },
      });
      const rangeSlot = h(document, "div", { className: "console-usage-slot" });
      const harnessSlot = h(document, "div", { className: "console-usage-slot" });
      const chipSlot = h(document, "div", { className: "console-usage-slot console-usage-chips" });
      const filters = h(
        document,
        "div",
        { className: "console-usage-filters" },
        rangeSlot,
        harnessSlot,
        modelCombo.element,
        projectCombo.element,
        chipSlot,
      );
      const notices = h(document, "div", { className: "console-usage-notices" });
      const body = h(document, "div", { className: "console-usage" });

      /** A filter changed: the Host aggregates again. */
      function changed(): void {
        save();
        load();
      }

      function toggleFilter(field: "harness" | "model" | "project", key: string): void {
        view[field] = view[field] === key ? "" : key;
        changed();
      }

      function selectDate(next: string | null): void {
        date = next;
        load();
      }

      function updatedText(): void {
        if (!loadedAt) {
          updated.textContent = "";
          return;
        }
        const seconds = Math.max(0, Math.round((Date.now() - loadedAt) / 1_000));
        updated.textContent = fill(messages.updated, {
          time:
            seconds < 5
              ? messages.justNow
              : seconds < 60
                ? fill(messages.secondsAgo, { count: seconds })
                : fill(messages.minutesAgo, { count: Math.floor(seconds / 60) }),
        });
      }
      const clock = window.setInterval(updatedText, 5_000);

      // --- Rendering -----------------------------------------------------------------------------
      function render(): void {
        rebuildKeepingFocus(rangeSlot, [
          segmented(
            document,
            messages.label,
            USAGE_STATISTICS_RANGES.map((value) => ({ value, label: messages.ranges[value] })),
            view.range,
            (value) => {
              view.range = value;
              changed();
            },
            "range",
          ),
        ]);
        updatedText();
        if (!result) {
          rebuildKeepingFocus(harnessSlot, []);
          rebuildKeepingFocus(chipSlot, []);
          modelCombo.element.hidden = true;
          projectCombo.element.hidden = true;
          notices.replaceChildren();
          body.replaceChildren(
            h(
              document,
              "p",
              { className: "console-muted", role: error ? "alert" : "status" },
              error ?? messages.loading,
            ),
          );
          return;
        }
        const data = result;
        projectLabel = projectNames(
          data.options.projects.filter((project): project is string => project !== null),
        );
        renderFilters(data);
        renderNotices(data);
        if (data.totals.requests === 0) {
          rebuildKeepingFocus(body, [
            // While the first read runs, no usage yet is not "no usage".
            data.reading.complete
              ? h(document, "p", { className: "console-muted" }, messages.empty)
              : h(document, "span", {}),
          ]);
          return;
        }
        rebuildKeepingFocus(body, [
          tiles(data),
          // One day has one column: the hourly panel shows that day instead.
          data.range === "today" ? null : trendPanel(data),
          h(
            document,
            "div",
            { className: "console-usage-grid" },
            harnessPanel(data),
            modelPanel(data),
            projectPanel(data),
            hourlyPanel(data),
          ),
          sessionsPanel(data),
        ]);
      }

      function renderFilters(data: UsageStatisticsResult): void {
        const harnesses = [...data.options.harnesses];
        if (view.harness && !harnesses.includes(view.harness)) harnesses.push(view.harness);
        rebuildKeepingFocus(harnessSlot, [
          segmented(
            document,
            messages.harness,
            [
              { value: "", label: messages.allHarnesses },
              ...harnesses.map((id) => ({ value: id, label: harnessName(id) })),
            ],
            view.harness,
            (value) => {
              view.harness = value;
              changed();
            },
            "harness",
          ),
        ]);
        const modelKeys = data.options.models.map(keyOf);
        if (view.model && !modelKeys.includes(view.model)) modelKeys.unshift(view.model);
        modelCombo.element.hidden = false;
        modelCombo.update(
          [
            { key: "", label: messages.allModels },
            ...modelKeys.map((key) => ({ key, label: modelName(key) })),
          ],
          view.model,
        );
        const projectKeys = data.options.projects.map(keyOf);
        if (view.project && !projectKeys.includes(view.project)) projectKeys.unshift(view.project);
        projectCombo.element.hidden = false;
        projectCombo.update(
          [
            { key: "", label: messages.allProjects },
            ...projectKeys.map((key) => ({
              key,
              label: projectName(key),
              ...(key === UNKNOWN ? {} : { detail: key }),
            })),
          ],
          view.project,
        );
        const chips: Node[] = [];
        if (date) {
          const chip = focusKey(
            h(
              document,
              "button",
              { type: "button", className: "console-usage-chip", title: messages.clearDay },
              longDate.format(asDate(date)),
              h(document, "span", { "aria-hidden": "true" }, " ✕"),
            ),
            "chip:date",
          );
          chip.addEventListener("click", () => selectDate(null));
          chips.push(chip);
        }
        if (view.harness || view.model || view.project || date) {
          const clear = focusKey(
            h(
              document,
              "button",
              { type: "button", className: "console-usage-link" },
              messages.clearFilters,
            ),
            "chip:clear",
          );
          clear.addEventListener("click", () => {
            view.harness = "";
            view.model = "";
            view.project = "";
            date = null;
            changed();
          });
          chips.push(clear);
        }
        rebuildKeepingFocus(chipSlot, chips);
      }

      function renderNotices(data: UsageStatisticsResult): void {
        notices.replaceChildren(
          ...(data.reading.complete
            ? []
            : [
                h(
                  document,
                  "p",
                  { className: "console-muted", role: "status" },
                  data.reading.sources > 0
                    ? fill(messages.reading, {
                        read: data.reading.read,
                        sources: data.reading.sources,
                      })
                    : messages.readingStart,
                ),
              ]),
          ...data.failures.map((failure) =>
            h(
              document,
              "div",
              { className: "console-notice", role: "alert" },
              createRendererSettingsIcon("alert", 16),
              h(
                document,
                "span",
                {},
                fill(messages.failed, {
                  harness: harnessName(failure.harness),
                  message: failure.message,
                }),
              ),
            ),
          ),
        );
      }

      /** Three figures, each a label and one number: cost, tokens without cache, cache hits. */
      function tiles(data: UsageStatisticsResult): HTMLElement {
        const totals = data.totals;
        const tile = (key: string, label: string, value: string): HTMLElement =>
          h(
            document,
            "div",
            { className: "console-usage-tile", "data-tile": key },
            h(document, "span", { className: "console-usage-tile__label" }, label),
            h(document, "strong", {}, value),
          );
        return h(
          document,
          "div",
          { className: "console-usage-tiles" },
          tile("cost", messages.cost, cost(totals)),
          tile("tokens", messages.tokenUsage, count(tokensWithoutCache(totals))),
          tile("cache", messages.cacheHitRate, cacheHitRate(totals)),
        );
      }

      function trendPanel(data: UsageStatisticsResult): HTMLElement {
        const first = data.from ?? data.daily[0]?.date ?? data.to;
        const dates = datesBetween(first, data.to);
        const granularity: Granularity =
          view.granularity ??
          (dates.length <= 120 ? "day" : dates.length <= 730 ? "week" : "month");
        // Series: the largest Harnesses by the measure over the range, the rest as "Others".
        const byHarness = new Map<string, Totals>();
        for (const row of data.daily) addTotals(slot(byHarness, row.harness), row);
        const ranked = [...byHarness]
          .sort(
            ([, left], [, right]) =>
              measured(right, view.measure) - measured(left, view.measure) ||
              tokensWithoutCache(right) - tokensWithoutCache(left),
          )
          .map(([id]) => id);
        const stacked = ranked.length > 1;
        const named =
          ranked.length > SERIES_COLORS.length ? ranked.slice(0, SERIES_COLORS.length - 1) : ranked;
        const seriesOf = (harness: string): string =>
          !stacked ? "all" : named.includes(harness) ? harness : OTHERS;
        const series: Series[] = stacked
          ? [
              ...named.map((id, index) => ({
                key: id,
                label: harnessName(id),
                color: SERIES_COLORS[index] ?? OTHERS_COLOR,
              })),
              ...(ranked.length > named.length
                ? [{ key: OTHERS, label: messages.others, color: OTHERS_COLOR }]
                : []),
            ]
          : [
              {
                key: "all",
                label: ranked[0] ? harnessName(ranked[0]) : "",
                color: SERIES_COLORS[0] ?? OTHERS_COLOR,
              },
            ];

        const bucketKey = (day: string): string =>
          granularity === "day"
            ? day
            : granularity === "week"
              ? weekStart(day)
              : `${day.slice(0, 7)}-01`;
        const buckets = new Map<string, Bucket>();
        for (const day of dates) {
          const key = bucketKey(day);
          if (buckets.has(key)) continue;
          const start = asDate(key);
          let short = shortDate.format(start);
          let long = longDate.format(start);
          if (granularity === "week") {
            const end = asDate(key);
            end.setDate(end.getDate() + 6);
            long = `${shortDate.format(start)} – ${shortDate.format(end)}`;
          } else if (granularity === "month") {
            short = monthShort.format(start);
            long = monthLong.format(start);
          }
          buckets.set(key, { key, short, long, totals: emptyTotals(), series: new Map() });
        }
        for (const row of data.daily) {
          const bucket = buckets.get(bucketKey(row.date));
          if (!bucket) continue;
          addTotals(bucket.totals, row);
          addTotals(slot(bucket.series, seriesOf(row.harness)), row);
        }
        const controls = h(
          document,
          "div",
          { className: "console-usage-panel-controls" },
          segmented(
            document,
            messages.trend,
            MEASURES.map((value) => ({ value, label: measureLabel(value) })),
            view.measure,
            (value) => {
              view.measure = value;
              save();
              render();
            },
            "measure",
          ),
          dates.length > 14
            ? segmented(
                document,
                messages.trend,
                (["day", "week", "month"] as const).map((value) => ({
                  value,
                  label: messages.granularity[value],
                })),
                granularity,
                (value) => {
                  view.granularity = value;
                  pointer.index = -1;
                  save();
                  render();
                },
                "granularity",
              )
            : null,
        );
        return h(
          document,
          "section",
          { className: "console-panel" },
          h(
            document,
            "div",
            { className: "console-panel__header" },
            h(document, "h2", { className: "console-panel__title" }, messages.trend),
            controls,
          ),
          trendChart(document, {
            key: "trend",
            buckets: [...buckets.values()],
            series,
            measure: view.measure,
            labels: {
              cost: messages.cost,
              tokens: messages.tokens,
              hint: messages.chartHint,
            },
            selected: granularity === "day" ? date : null,
            ...(granularity === "day" && dates.length > 1 ? { onSelect: selectDate } : {}),
            ...(stacked
              ? {
                  onSeries: (key: string) => {
                    if (key !== OTHERS) toggleFilter("harness", key);
                  },
                }
              : {}),
            pointer,
          }),
        );
      }

      function share(totals: Totals, whole: number): Node | string {
        if (unmetered(totals)) return "—";
        if (view.measure === "cost" && allUnpriced(totals)) {
          return h(
            document,
            "span",
            { className: "console-badge is-warn" },
            messages.unpricedBadge,
          );
        }
        if (!(whole > 0)) return "—";
        const value = measured(totals, view.measure) / whole;
        const bar = h(document, "span", { className: "console-usage-share__fill" });
        bar.style.width = `${Math.max(value * 100, value > 0 ? 1.5 : 0)}%`;
        return h(
          document,
          "span",
          { className: "console-usage-share" },
          h(
            document,
            "span",
            { className: "console-usage-share__track", "aria-hidden": "true" },
            bar,
          ),
          h(document, "span", { className: "console-usage-share__value" }, percent(value)),
        );
      }

      /** Columns shared by the Harness, model and project tables. */
      function creditCost(
        row: Totals,
        credits: UsageStatisticsResult["credits"],
        harness = result?.filters.harness ?? null,
      ): HTMLElement {
        const value = costWithCredits(row, credits, {
          locale,
          harnessName,
          unpriced: messages.unpricedBadge,
          harness,
        });
        return h(
          document,
          "span",
          {
            className: "console-usage-cost",
            title:
              value.reportedRequests > 0
                ? `${messages.nativeCreditsNote}\n${messages.creditsCoverage}: ${value.reportedRequests} / ${row.requests}`
                : undefined,
          },
          value.primary === null
            ? null
            : h(document, "span", { className: "console-usage-cost__primary" }, value.primary),
          ...value.credits.map(({ label, amount }) =>
            h(
              document,
              "span",
              {
                className: `console-usage-cost__credit${value.primary !== null ? " is-secondary" : ""}`,
              },
              label === null
                ? null
                : h(
                    document,
                    "span",
                    { className: "console-usage-cost__source", title: label },
                    label,
                  ),
              h(document, "span", { className: "console-usage-cost__amount" }, amount),
            ),
          ),
        );
      }

      function figureColumns<Row extends Totals>(
        whole: number,
        costCell: (row: Row) => string | HTMLElement = cost,
      ): Column<Row>[] {
        return [
          {
            key: "share",
            label: messages.share,
            title: fill(messages.sortBy, { name: measureLabel(view.measure) }),
            className: "console-usage-table__share",
            sort: (row) => measured(row, view.measure),
            cell: (row) => share(row, whole),
          },
          {
            key: "requests",
            label: messages.requests,
            sort: (row) => row.requests,
            cell: (row) => count(row.requests),
          },
          {
            key: "input",
            label: messages.input,
            title: messages.tokensNote,
            sort: inputWithoutCache,
            cell: (row) => tokenCount(row, inputWithoutCache(row)),
          },
          {
            key: "cacheRead",
            label: messages.cacheRead,
            sort: (row) => row.cachedInputTokens,
            cell: (row) => tokenCount(row, row.cachedInputTokens),
          },
          {
            key: "output",
            label: messages.output,
            sort: (row) => row.outputTokens,
            cell: (row) => tokenCount(row, row.outputTokens),
          },
          {
            key: "hit",
            label: messages.cacheHit,
            sort: (row) =>
              row.cacheKnownInputTokens > 0
                ? row.cachedInputTokens / row.cacheKnownInputTokens
                : -1,
            cell: (row) => cacheHitRate(row),
          },
          {
            key: "cost",
            label: messages.cost,
            sort: (row) => (allUnpriced(row) ? -1 : row.costUsd),
            cell: costCell,
          },
        ];
      }

      function rowFilter(
        field: "harness" | "model" | "project",
        key: string,
        label: string,
        detail?: string,
      ): HTMLElement {
        const selected = view[field] === key;
        const button = focusKey(
          h(
            document,
            "button",
            {
              type: "button",
              className: "console-usage-row-filter",
              "aria-pressed": selected ? "true" : "false",
              title: selected
                ? messages.clearFilter
                : `${fill(messages.filterBy, { name: label })}${detail ? `\n${detail}` : ""}`,
            },
            label,
          ),
          `${field}:row:${key}`,
        );
        button.addEventListener("click", () => toggleFilter(field, key));
        return button;
      }

      function panel(
        title: string,
        content: Node,
        extra: Node | null = null,
        wide = false,
      ): HTMLElement {
        return h(
          document,
          "section",
          {
            className: wide
              ? "console-panel console-usage-panel is-wide"
              : "console-panel console-usage-panel",
          },
          h(
            document,
            "div",
            { className: "console-panel__header" },
            h(document, "h2", { className: "console-panel__title" }, title),
            extra,
          ),
          content,
        );
      }

      function tableOf<Row extends Totals>(
        key: "harness" | "model" | "project",
        rows: Row[],
        name: Column<Row>,
        selected: (row: Row) => boolean,
        costCell?: (row: Row) => string | HTMLElement,
      ): HTMLElement {
        const whole = rows.reduce((total, row) => total + measured(row, view.measure), 0);
        return dataTable(document, {
          key,
          columns: [name, ...figureColumns<Row>(whole, costCell)],
          rows,
          state: tables[key],
          limit: TABLE_LIMIT,
          sortLabel: (label) => fill(messages.sortBy, { name: label }),
          moreLabel: (hidden) => fill(messages.showMore, { count: hidden }),
          lessLabel: messages.showLess,
          onState: (state) => {
            tables[key] = state;
            render();
          },
          rowClass: (row) => (selected(row) ? "is-selected" : undefined),
        });
      }

      function harnessPanel(data: UsageStatisticsResult): HTMLElement {
        return panel(
          messages.byHarness,
          tableOf(
            "harness",
            data.byHarness,
            {
              key: "name",
              label: messages.harness,
              sort: (row) => harnessName(row.harness),
              cell: (row) => rowFilter("harness", row.harness, harnessName(row.harness)),
            },
            (row) => view.harness === row.harness,
            (row) =>
              creditCost(
                row,
                data.credits?.filter((entry) => entry.harness === row.harness),
                row.harness,
              ),
          ),
        );
      }

      function modelPanel(data: UsageStatisticsResult): HTMLElement {
        const anyUnpriced = data.byModel.some((row) => row.unpricedRequests > 0);
        if (!anyUnpriced) unpricedOnly = false;
        const rows = unpricedOnly
          ? data.byModel.filter((row) => row.unpricedRequests > 0)
          : data.byModel;
        const toggle = anyUnpriced
          ? focusKey(
              h(
                document,
                "button",
                {
                  type: "button",
                  className: "console-usage-chip",
                  "aria-pressed": unpricedOnly ? "true" : "false",
                },
                messages.unpricedOnly,
              ),
              "model:unpriced",
            )
          : null;
        toggle?.addEventListener("click", () => {
          unpricedOnly = !unpricedOnly;
          render();
        });
        return panel(
          messages.byModel,
          tableOf(
            "model",
            rows,
            {
              key: "name",
              label: messages.model,
              sort: (row) => modelName(keyOf(row.model)),
              cell: (row) => {
                const key = keyOf(row.model);
                const cell = h(
                  document,
                  "span",
                  { className: "console-usage-name", title: row.model ?? messages.unknownModel },
                  rowFilter("model", key, modelName(key)),
                );
                if (row.model === null && row.unpricedRequests === 0) return cell;
                // Priced by what the Harness recorded (Grok): there is no price here to set or
                // edit, and a set price would replace every recorded cost.
                if (row.harnessPricedRequests > 0) return cell;
                // No token counts at all (Qoder): a price would have nothing to multiply.
                if (unmetered(row)) return cell;
                const actions = h(document, "span", { className: "console-usage-unpriced" });
                if (row.unpricedRequests > 0) {
                  actions.append(
                    h(
                      document,
                      "span",
                      { className: "console-badge is-warn" },
                      fill(messages.unpriced, { count: count(row.unpricedRequests) }),
                    ),
                  );
                }
                if (row.model !== null) {
                  const model = row.model;
                  const edit = focusKey(
                    h(
                      document,
                      "button",
                      { type: "button", className: "console-link" },
                      row.unpricedRequests > 0 ? messages.setPrice : messages.editPrice,
                    ),
                    `model:price:${model}`,
                  );
                  edit.addEventListener("click", () => prices.edit(model));
                  actions.append(edit);
                }
                cell.append(actions);
                return cell;
              },
            },
            (row) => view.model === keyOf(row.model),
            (row) =>
              creditCost(
                row,
                data.credits?.filter((entry) => entry.model === row.model),
              ),
          ),
          toggle,
        );
      }

      function projectPanel(data: UsageStatisticsResult): HTMLElement {
        return panel(
          messages.byProject,
          tableOf(
            "project",
            data.byProject,
            {
              key: "name",
              label: messages.project,
              sort: (row) => projectName(keyOf(row.project)),
              cell: (row) => {
                const key = keyOf(row.project);
                return rowFilter("project", key, projectName(key), row.project ?? undefined);
              },
            },
            (row) => view.project === keyOf(row.project),
          ),
        );
      }

      function hourlyPanel(data: UsageStatisticsResult): HTMLElement {
        const singleDay = data.filters.date !== null || data.range === "today";
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return panel(
          singleDay ? messages.hourlyDay : messages.hourly,
          hourlyChart(document, {
            cells: data.hourly.map((cell) => ({
              weekday: cell.weekday,
              hour: cell.hour,
              totals: cell,
            })),
            measure: view.measure,
            singleDay,
            locale,
            weekStartsOnMonday: !locale.startsWith("en"),
            labels: { cost: messages.cost, tokens: messages.tokens },
          }),
          h(document, "span", { className: "console-muted console-usage-zone" }, zone),
        );
      }

      function sessionsPanel(data: UsageStatisticsResult): HTMLElement {
        const columns: Column<UsageStatisticsSession>[] = [
          {
            key: "session",
            label: messages.session,
            cell: (row) => {
              const project = keyOf(row.project);
              const id = `${row.harness}:${row.sessionId}`;
              const copy = focusKey(
                h(
                  document,
                  "button",
                  {
                    type: "button",
                    className: "console-usage-link console-usage-copy",
                    title: `${messages.copyId}: ${row.sessionId}`,
                  },
                  copiedSession === id ? messages.copied : row.sessionId.slice(0, 8),
                ),
                `sessions:copy:${id}`,
              );
              copy.addEventListener("click", () => {
                void navigator.clipboard
                  ?.writeText(row.sessionId)
                  .then(() => {
                    copiedSession = id;
                    render();
                  })
                  .catch(() => undefined);
              });
              return h(
                document,
                "span",
                { className: "console-usage-name" },
                rowFilter("project", project, projectName(project), row.project ?? undefined),
                copy,
              );
            },
          },
          {
            key: "harness",
            label: messages.harness,
            sort: (row) => harnessName(row.harness),
            cell: (row) => harnessName(row.harness),
          },
          {
            key: "model",
            label: messages.model,
            cell: (row) =>
              row.models.length === 0
                ? messages.unknownModel
                : row.models.length === 1
                  ? modelName(row.models[0] ?? "", row.harness)
                  : `${modelName(row.models[0] ?? "", row.harness)} +${row.models.length - 1}`,
          },
          {
            key: "last",
            label: messages.lastActive,
            sort: (row) => row.lastAtMs,
            cell: (row) => dateTime.format(new Date(row.lastAtMs)),
          },
          {
            key: "measure",
            label: measureLabel(view.measure),
            sort: (row) =>
              view.measure === "cost" && allUnpriced(row) ? -1 : measured(row, view.measure),
            cell: (row) =>
              view.measure === "cost" ? cost(row) : tokenCount(row, measured(row, view.measure)),
          },
          ...(view.measure === "tokens"
            ? []
            : [
                {
                  key: "tokens",
                  label: messages.tokens,
                  title: messages.tokensNote,
                  sort: tokensWithoutCache,
                  cell: (row: UsageStatisticsSession) => tokenCount(row, tokensWithoutCache(row)),
                },
              ]),
          ...(view.measure === "cost"
            ? []
            : [
                {
                  key: "cost",
                  label: messages.cost,
                  sort: (row: UsageStatisticsSession) => (allUnpriced(row) ? -1 : row.costUsd),
                  cell: (row: UsageStatisticsSession) => cost(row),
                },
              ]),
        ];
        return panel(
          messages.topSessions,
          data.sessions.length === 0
            ? h(document, "p", { className: "console-muted" }, messages.empty)
            : dataTable(document, {
                key: "sessions",
                columns,
                rows: data.sessions,
                state: tables.sessions,
                limit: SESSION_LIMIT,
                sortLabel: (label) => fill(messages.sortBy, { name: label }),
                moreLabel: (hidden) => fill(messages.showMore, { count: hidden }),
                lessLabel: messages.showLess,
                onState: (state) => {
                  tables.sessions = state;
                  render();
                },
              }),
          null,
          true,
        );
      }

      function exportCsv(): void {
        if (!result) return;
        const lines = [
          [
            "date",
            "harness",
            "requests",
            "input_without_cache",
            "cache_read",
            "cache_write",
            "output",
            "reasoning",
            "cost_usd",
            "unpriced_requests",
          ].join(","),
        ];
        for (const row of result.daily) {
          lines.push(
            [
              row.date,
              harnessName(row.harness),
              row.requests,
              inputWithoutCache(row),
              row.cachedInputTokens,
              row.cacheWriteInputTokens,
              row.outputTokens,
              row.reasoningOutputTokens,
              row.costUsd.toFixed(6),
              row.unpricedRequests,
            ]
              .map(csvCell)
              .join(","),
          );
        }
        download(
          document,
          `codexhost-usage-${result.range}-${result.to}.csv`,
          `${lines.join("\n")}\n`,
          "text/csv;charset=utf-8",
        );
      }

      // --- Loading -------------------------------------------------------------------------------
      function params(): UsageStatisticsParams {
        const model = filterValue(view.model);
        const project = filterValue(view.project);
        return {
          range: view.range,
          ...(view.harness ? { harness: view.harness } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(project !== undefined ? { project } : {}),
          ...(date ? { date } : {}),
        };
      }

      function schedule(): void {
        window.clearTimeout(poll);
        if (context.signal.aborted) return;
        // Keep asking while the first read is under way; the Host answers from what it has.
        if (result && !result.reading.complete) poll = window.setTimeout(load, POLL_MS);
        else if (view.autoRefreshMs > 0) poll = window.setTimeout(load, view.autoRefreshMs);
      }

      function load(): void {
        window.clearTimeout(poll);
        const requested = params();
        void context.runLatest(() => request(USAGE_STATISTICS_METHOD, requested), {
          success(value) {
            const parsed = usageStatisticsResultSchema.safeParse(value);
            if (parsed.success) {
              result = parsed.data;
              error = null;
              loadedAt = Date.now();
              // A day the Host ignored (outside the new range) is no longer selected.
              date = parsed.data.filters.date;
            } else {
              // An older Host still answers in the previous shape.
              result = null;
              error = messages.restartHost;
            }
            render();
            schedule();
          },
          failure(failure) {
            error = failure instanceof Error ? failure.message : String(failure);
            result = null;
            render();
            schedule();
          },
        });
      }

      context.content.replaceChildren(header, prices.element, filters, notices, body);
      render();
      void request(HARNESS_PLUGIN_LIST_METHOD, {})
        .then((value) => {
          for (const plugin of harnessPluginListResultSchema.parse(value).plugins) {
            names.set(plugin.id, plugin.name);
          }
          if (!context.signal.aborted) render();
        })
        .catch(() => undefined);
      load();
      return () => {
        window.clearTimeout(poll);
        window.clearInterval(clock);
      };
    },
  });
}
