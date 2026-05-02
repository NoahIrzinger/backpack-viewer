import type { Signal } from "backpack-ontology";
import type { LearningGraphSummary } from "backpack-ontology";
import type { WidgetSpec, StatCardConfig, SignalCardsConfig, BarChartConfig, PieChartConfig, StackedBarConfig, LineChartConfig, TableConfig } from "./signals-spec.js";
import { resolveQuery, filterSignals, sortSignals } from "./signals-query-engine.js";
import { createChart, baseChartOption, buildSeriesColors, SEVERITY_COLORS, getThemeValues } from "./dashboard-theme.js";
import type { ECharts } from "echarts/core";
import { renderSignalCard } from "./signal-renderers.js";

export interface SignalsBridge {
  focusNodes(nodeIds: string[], hops?: number): void;
  dismissSignal(signalId: string): Promise<void>;
  reloadSignals(): Promise<void>;
  panToNode(nodeId: string): void;
}

export interface WidgetContext {
  signals: Signal[];
  graphSummaries: LearningGraphSummary[];
  bridge: SignalsBridge;
}

export type SignalsWidgetTeardown = () => void;

function makeWidgetShell(spec: WidgetSpec): HTMLElement {
  const el = document.createElement("div");
  el.className = "sv-widget";
  el.dataset.widgetId = spec.id;
  el.dataset.widgetType = spec.type;

  const header = document.createElement("div");
  header.className = "sv-widget-header";
  const title = document.createElement("span");
  title.className = "sv-widget-title";
  title.textContent = spec.title;
  header.appendChild(title);
  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "sv-widget-body";
  el.appendChild(body);

  return el;
}

function getBody(el: HTMLElement): HTMLElement {
  return el.querySelector(".sv-widget-body") as HTMLElement;
}

function getHeader(el: HTMLElement): HTMLElement {
  return el.querySelector(".sv-widget-header") as HTMLElement;
}

// ─── Stat Card ───────────────────────────────────────────────────────────────

function mountStatCard(el: HTMLElement, spec: WidgetSpec, ctx: WidgetContext): SignalsWidgetTeardown {
  const cfg = spec.config as StatCardConfig;
  const body = getBody(el);
  body.className = "sv-widget-body sv-stat-body";

  const result = resolveQuery(cfg.query, ctx.signals, ctx.graphSummaries) as { value: number; label: string };

  const numEl = document.createElement("div");
  numEl.className = "sv-stat-number";
  numEl.textContent = String(result.value);

  const subtitleEl = document.createElement("div");
  subtitleEl.className = "sv-stat-subtitle";
  subtitleEl.textContent = cfg.query.source === "signals" && (cfg.query as { filter?: { severity?: string[] } }).filter?.severity?.length
    ? ((cfg.query as { filter: { severity: string[] } }).filter.severity.join(" + "))
    : cfg.query.source === "graphs" ? "in active backpack" : "";

  body.appendChild(numEl);
  body.appendChild(subtitleEl);

  const accentMap: Record<string, string> = {
    accent: "var(--sv-stat-accent)",
    high: "var(--sv-stat-high)",
    medium: "var(--sv-stat-medium)",
    critical: "var(--sv-stat-critical)",
    neutral: "var(--sv-stat-neutral)",
  };
  el.style.borderLeftColor = accentMap[cfg.accentColor ?? "neutral"] ?? "var(--sv-stat-neutral)";

  return () => {};
}

// ─── Signal Cards ─────────────────────────────────────────────────────────────

function mountSignalCards(el: HTMLElement, spec: WidgetSpec, ctx: WidgetContext): SignalsWidgetTeardown {
  const cfg = spec.config as SignalCardsConfig;
  const body = getBody(el);
  body.className = "sv-widget-body sv-signals-body";
  const header = getHeader(el);

  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = "sv-signals-search";
  searchInput.placeholder = "Filter…";
  header.appendChild(searchInput);

  const list = document.createElement("div");
  list.className = "sv-signals-list";
  body.appendChild(list);

  const selectedIds = new Set<string>();

  function render(search?: string) {
    let visible = filterSignals(ctx.signals, cfg.filter, search);
    visible = sortSignals(visible, cfg.sortBy);
    if (cfg.limit) visible = visible.slice(0, cfg.limit);

    list.replaceChildren();

    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sv-signals-empty";
      empty.textContent = ctx.signals.length === 0
        ? "No signals detected. Run backpack_signal_detect via MCP to scan."
        : "No signals match the current filter.";
      list.appendChild(empty);
      return;
    }

    for (const signal of visible) {
      const cardEl = renderSignalCard(signal, {
        isSelected: (id) => selectedIds.has(id),
        onToggleSelect: (id) => {
          if (selectedIds.has(id)) selectedIds.delete(id);
          else selectedIds.add(id);
          if (selectedIds.size > 0 && signal.evidenceNodeIds.length > 0) {
            ctx.bridge.focusNodes(signal.evidenceNodeIds, 2);
          }
        },
        onDismiss: (id) => {
          if (cfg.showDismiss) {
            ctx.bridge.dismissSignal(id).then(() => ctx.bridge.reloadSignals()).catch(() => {});
          }
        },
        onDismissPanel: () => {},
      });

      cardEl.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".signal-dismiss-btn, .signal-card-checkbox")) return;
        if (signal.evidenceNodeIds.length > 0) {
          ctx.bridge.focusNodes(signal.evidenceNodeIds, 2);
        }
      });

      list.appendChild(cardEl);
    }
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => render(searchInput.value), 150);
  });

  render();

  return () => clearTimeout(searchTimer);
}

// ─── Bar Chart ────────────────────────────────────────────────────────────────

function mountBarChart(el: HTMLElement, spec: WidgetSpec, ctx: WidgetContext): SignalsWidgetTeardown {
  const cfg = spec.config as BarChartConfig;
  const body = getBody(el);
  body.className = "sv-widget-body sv-chart-body";

  let chart: ECharts | null = null;

  function render() {
    const result = resolveQuery(cfg.query, ctx.signals, ctx.graphSummaries) as { labels: string[]; series: { name: string; data: number[]; color?: string }[]; _perItemColors?: string[] };
    if (!result.labels?.length) {
      body.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "sv-chart-empty";
      empty.textContent = "No data";
      body.appendChild(empty);
      return;
    }

    if (!chart) chart = createChart(body);

    const v = getThemeValues();
    const isHorizontal = cfg.horizontal !== false;
    const colors = result._perItemColors ?? buildSeriesColors(result.labels, cfg.query.source === "signals" ? "kind" : "auto", cfg.colorScheme);

    chart.setOption({
      ...baseChartOption(),
      grid: { left: isHorizontal ? 100 : 8, right: 8, top: 8, bottom: isHorizontal ? 8 : 28, containLabel: false },
      xAxis: isHorizontal
        ? { type: "value", axisLabel: { color: v.textMuted, fontSize: 10 }, splitLine: { lineStyle: { color: v.border, type: "dashed" } } }
        : { type: "category", data: result.labels, axisLabel: { color: v.textMuted, fontSize: 10, rotate: result.labels.length > 5 ? 30 : 0, interval: 0 } },
      yAxis: isHorizontal
        ? { type: "category", data: result.labels, axisLabel: { color: v.textMuted, fontSize: 10, width: 90, overflow: "truncate" } }
        : { type: "value", axisLabel: { color: v.textMuted, fontSize: 10 }, splitLine: { lineStyle: { color: v.border, type: "dashed" } } },
      series: [{
        type: "bar",
        data: result.series[0].data.map((v, i) => ({
          value: v,
          itemStyle: { color: colors[i] ?? colors[0] },
        })),
        barMaxWidth: 24,
        itemStyle: { borderRadius: isHorizontal ? [0, 2, 2, 0] : [2, 2, 0, 0] },
        label: { show: false },
      }],
    }, true);
  }

  render();

  const ro = new ResizeObserver(() => chart?.resize());
  ro.observe(body);

  return () => { chart?.dispose(); ro.disconnect(); };
}

// ─── Pie / Donut Chart ────────────────────────────────────────────────────────

function mountPieChart(el: HTMLElement, spec: WidgetSpec, ctx: WidgetContext): SignalsWidgetTeardown {
  const cfg = spec.config as PieChartConfig;
  const body = getBody(el);
  body.className = "sv-widget-body sv-chart-body";

  let chart: ECharts | null = null;

  function render() {
    const result = resolveQuery(cfg.query, ctx.signals, ctx.graphSummaries) as { labels: string[]; series: { data: number[] }[]; _perItemColors?: string[] };
    if (!result.labels?.length) return;

    if (!chart) chart = createChart(body);

    const v = getThemeValues();
    const isGroupBySeverity = (cfg.query as { groupBy?: string }).groupBy === "severity";
    const colors = result._perItemColors
      ?? buildSeriesColors(result.labels, isGroupBySeverity ? "severity" : "auto", cfg.colorScheme);

    const pieData = result.labels.map((label, i) => ({
      name: label,
      value: result.series[0].data[i] ?? 0,
      itemStyle: { color: colors[i] ?? colors[0] },
    }));

    chart.setOption({
      backgroundColor: "transparent",
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)", backgroundColor: v.bgElevated, borderColor: v.border, textStyle: { color: v.text, fontSize: 12 } },
      legend: {
        orient: "vertical",
        right: 0,
        top: "middle",
        textStyle: { color: v.textMuted, fontSize: 10 },
        icon: "circle",
        itemWidth: 6,
        itemHeight: 6,
        formatter: (name: string) => name.replace(/_/g, " "),
      },
      series: [{
        type: "pie",
        radius: cfg.donut ? ["45%", "72%"] : "72%",
        center: ["40%", "50%"],
        data: pieData,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderColor: v.bgSurface, borderWidth: 2 },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(0,0,0,0.2)" } },
      }],
    }, true);
  }

  render();
  const ro = new ResizeObserver(() => chart?.resize());
  ro.observe(body);

  return () => { chart?.dispose(); ro.disconnect(); };
}

// ─── Stacked Bar ──────────────────────────────────────────────────────────────

function mountStackedBar(el: HTMLElement, spec: WidgetSpec, ctx: WidgetContext): SignalsWidgetTeardown {
  const cfg = spec.config as StackedBarConfig;
  const body = getBody(el);
  body.className = "sv-widget-body sv-chart-body";

  let chart: ECharts | null = null;

  function render() {
    const result = resolveQuery(cfg.query, ctx.signals, ctx.graphSummaries) as { labels: string[]; series: { name: string; data: number[]; color?: string }[] };
    if (!result.labels?.length || !result.series?.length) return;

    if (!chart) chart = createChart(body);

    const v = getThemeValues();

    chart.setOption({
      ...baseChartOption(),
      grid: { left: 8, right: 8, top: 8, bottom: 32, containLabel: true },
      xAxis: { type: "category", data: result.labels, axisLabel: { color: v.textMuted, fontSize: 10, rotate: result.labels.length > 4 ? 30 : 0 } },
      yAxis: { type: "value", axisLabel: { color: v.textMuted, fontSize: 10 }, splitLine: { lineStyle: { color: v.border, type: "dashed" } } },
      legend: { bottom: 0, textStyle: { color: v.textMuted, fontSize: 10 }, icon: "circle", itemWidth: 6, itemHeight: 6 },
      series: result.series.map((s) => ({
        name: s.name,
        type: "bar",
        stack: "total",
        data: s.data,
        itemStyle: { color: s.color ?? buildSeriesColors([s.name], "nodeType", cfg.colorScheme)[0] },
        barMaxWidth: 32,
      })),
    }, true);
  }

  render();
  const ro = new ResizeObserver(() => chart?.resize());
  ro.observe(body);

  return () => { chart?.dispose(); ro.disconnect(); };
}

// ─── Line Chart ──────────────────────────────────────────────────────────────

function mountLineChart(el: HTMLElement, spec: WidgetSpec, ctx: WidgetContext): SignalsWidgetTeardown {
  const cfg = spec.config as LineChartConfig;
  const body = getBody(el);
  body.className = "sv-widget-body sv-chart-body";

  let chart: ECharts | null = null;

  function render() {
    const result = resolveQuery(cfg.query, ctx.signals, ctx.graphSummaries) as { labels: string[]; series: { name: string; data: number[] }[]; _perItemColors?: string[] };
    if (!result.labels?.length) return;
    if (!chart) chart = createChart(body);

    const v = getThemeValues();
    const colors = buildSeriesColors(result.labels, "auto", cfg.colorScheme);

    chart.setOption({
      ...baseChartOption(),
      grid: { left: 8, right: 8, top: 8, bottom: 28, containLabel: true },
      xAxis: { type: "category", data: result.labels, axisLabel: { color: v.textMuted, fontSize: 10, rotate: result.labels.length > 6 ? 30 : 0 } },
      yAxis: { type: "value", axisLabel: { color: v.textMuted, fontSize: 10 }, splitLine: { lineStyle: { color: v.border, type: "dashed" } } },
      series: result.series.map((s, i) => ({
        name: s.name,
        type: "line",
        data: s.data,
        smooth: cfg.smooth !== false ? 0.3 : false,
        lineStyle: { color: colors[i % colors.length], width: 2 },
        itemStyle: { color: colors[i % colors.length] },
        areaStyle: result.series.length === 1 ? { color: colors[0], opacity: 0.08 } : undefined,
        symbol: "circle",
        symbolSize: 5,
      })),
    }, true);
  }

  render();
  const ro = new ResizeObserver(() => chart?.resize());
  ro.observe(body);
  return () => { chart?.dispose(); ro.disconnect(); };
}

// ─── Table ────────────────────────────────────────────────────────────────────

function mountTable(el: HTMLElement, spec: WidgetSpec, ctx: WidgetContext): SignalsWidgetTeardown {
  const cfg = spec.config as TableConfig;
  const body = getBody(el);
  body.className = "sv-widget-body sv-table-body";

  const result = resolveQuery(cfg.query, ctx.signals, ctx.graphSummaries);
  if (!("labels" in result) || !result.labels?.length) {
    const empty = document.createElement("div");
    empty.className = "sv-chart-empty";
    empty.textContent = "No data";
    body.appendChild(empty);
    return () => {};
  }

  const colNames = cfg.columns ?? ["label", ...result.series.map((s) => s.name)];
  const rowCount = Math.min(result.labels.length, cfg.limit ?? 50);

  const wrap = document.createElement("div");
  wrap.className = "sv-table-wrap";

  const table = document.createElement("table");
  table.className = "sv-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const col of colNames) {
    const th = document.createElement("th");
    th.textContent = col.charAt(0).toUpperCase() + col.slice(1);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");
  for (let i = 0; i < rowCount; i++) {
    const tr = document.createElement("tr");
    const labelCell = document.createElement("td");
    labelCell.textContent = result.labels[i];
    tr.appendChild(labelCell);
    for (const s of result.series) {
      const td = document.createElement("td");
      td.textContent = String(s.data[i] ?? 0);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  wrap.appendChild(table);
  body.appendChild(wrap);
  return () => {};
}

// ─── Registry + mount dispatcher ─────────────────────────────────────────────

export function mountWidget(
  container: HTMLElement,
  spec: WidgetSpec,
  ctx: WidgetContext,
): SignalsWidgetTeardown {
  const el = makeWidgetShell(spec);

  // Apply grid position via CSSOM property assignments
  el.style.gridColumn = `${spec.position.col} / span ${spec.position.colSpan}`;
  el.style.gridRow = `${spec.position.row} / span ${spec.position.rowSpan}`;

  container.appendChild(el);

  let teardown: SignalsWidgetTeardown;
  switch (spec.type) {
    case "stat-card":    teardown = mountStatCard(el, spec, ctx); break;
    case "signal-cards": teardown = mountSignalCards(el, spec, ctx); break;
    case "bar-chart":   teardown = mountBarChart(el, spec, ctx); break;
    case "pie-chart":   teardown = mountPieChart(el, spec, ctx); break;
    case "stacked-bar":  teardown = mountStackedBar(el, spec, ctx); break;
    case "line-chart":   teardown = mountLineChart(el, spec, ctx); break;
    case "table":        teardown = mountTable(el, spec, ctx); break;
    default:
      getBody(el).textContent = `Unknown widget type: ${spec.type}`;
      teardown = () => {};
  }

  return () => { teardown(); el.remove(); };
}
