/**
 * Dashboard theme system — single source of truth for all visual styling.
 *
 * All chart instances and widget CSS derive from this module.
 * No widget writes a color, font size, or border directly.
 *
 * Architecture:
 *   CSS variables (--bg, --text, etc.)  →  readThemeValues()
 *   ThemeValues  →  buildEChartsTheme()  →  echarts.registerTheme()
 *   Signal severity  →  SEVERITY_COLORS  (fixed, not customizable)
 *   Node/graph/kind colors  →  getSeriesColor()  (deterministic from PALETTE)
 *   Theme changes  →  watchThemeChanges()  →  re-register + update all charts
 */

import * as echarts from "echarts/core";
import type { EChartsCoreOption } from "echarts/core";
import { BarChart, LineChart, PieChart, HeatmapChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DatasetComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart, LineChart, PieChart, HeatmapChart,
  GridComponent, TooltipComponent, LegendComponent, DatasetComponent,
  CanvasRenderer,
]);

export { echarts };

/**
 * Earth-tone palette — identical to colors.ts used for canvas nodes.
 * Chart series colors must come from this list so charts and canvas
 * represent the same entity type with the same color.
 */
export const PALETTE = [
  "#d4a27f",
  "#c17856",
  "#b07a5e",
  "#d4956b",
  "#a67c5a",
  "#cc9e7c",
  "#c4866a",
  "#cb8e6c",
  "#b8956e",
  "#a88a70",
  "#d9b08c",
  "#c4a882",
  "#e8b898",
  "#b5927a",
  "#a8886e",
  "#d1a990",
] as const;

/**
 * Severity semantic colors — fixed to match the .sv-sev-bg-* classes
 * already in style.css. Same values referenced by CSS variables --sev-*.
 * Not customizable — severity color is brand identity.
 */
export const SEVERITY_COLORS: Record<string, string> = {
  critical: "#c9463d",
  high: "#c47a3a",
  medium: "#b5a036",
  low: "",  // resolved at runtime from --text-dim
};

/**
 * Pre-defined color scheme names users can specify in dashboard.json.
 * All draw from PALETTE — no raw hex in user config.
 */
export type ColorSchemeName = "default" | "warm-1" | "warm-2" | "monochrome";

const COLOR_SCHEMES: Record<ColorSchemeName, string[]> = {
  "default":    [...PALETTE],
  "warm-1":     PALETTE.slice(0, 6) as unknown as string[],
  "warm-2":     [PALETTE[0], PALETTE[2], PALETTE[4], PALETTE[6], PALETTE[8], PALETTE[10]] as unknown as string[],
  "monochrome": ["#d4d4d4", "#a3a3a3", "#737373", "#525252", "#e5e5e5", "#8a8a8a"],
};

export function getColorScheme(name?: ColorSchemeName): string[] {
  return COLOR_SCHEMES[name ?? "default"];
}

// Deterministic color by name — same algorithm as colors.ts
const colorCache = new Map<string, string>();
export function getSeriesColor(name: string): string {
  const cached = colorCache.get(name);
  if (cached) return cached;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  const color = PALETTE[Math.abs(hash) % PALETTE.length];
  colorCache.set(name, color);
  return color;
}

/**
 * Build a color array for a set of categories.
 * When context is "severity", maps to SEVERITY_COLORS.
 * Otherwise uses deterministic palette assignment via getSeriesColor.
 */
export function buildSeriesColors(
  categories: string[],
  context: "severity" | "graphName" | "kind" | "nodeType" | "auto",
  scheme?: ColorSchemeName,
): string[] {
  if (context === "severity") {
    const dimColor = getThemeValues().textDim;
    return categories.map((c) => SEVERITY_COLORS[c.toLowerCase()] || dimColor);
  }
  if (scheme && scheme !== "default") {
    const palette = getColorScheme(scheme);
    return categories.map((_, i) => palette[i % palette.length]);
  }
  return categories.map((c) => getSeriesColor(c));
}

export interface ThemeValues {
  bg: string;
  bgSurface: string;
  bgElevated: string;
  bgInset: string;
  bgHover: string;
  bgActive: string;
  border: string;
  text: string;
  textStrong: string;
  textMuted: string;
  textDim: string;
  accent: string;
  accentHover: string;
  shadow: string;
  isDark: boolean;
}

export function readThemeValues(): ThemeValues {
  const s = getComputedStyle(document.documentElement);
  const get = (v: string) => s.getPropertyValue(v).trim();
  const isDark = document.documentElement.dataset.theme !== "light";
  return {
    bg:          get("--bg"),
    bgSurface:   get("--bg-surface"),
    bgElevated:  get("--bg-elevated"),
    bgInset:     get("--bg-inset"),
    bgHover:     get("--bg-hover"),
    bgActive:    get("--bg-active"),
    border:      get("--border"),
    text:        get("--text"),
    textStrong:  get("--text-strong"),
    textMuted:   get("--text-muted"),
    textDim:     get("--text-dim"),
    accent:      get("--accent"),
    accentHover: get("--accent-hover"),
    shadow:      get("--shadow"),
    isDark,
  };
}

const ECHARTS_THEME_NAME = "backpack";

export function buildEChartsTheme(v: ThemeValues): object {
  const axisCommon = {
    axisLine:  { lineStyle: { color: v.border } },
    axisTick:  { lineStyle: { color: v.border } },
    axisLabel: { color: v.textMuted, fontSize: 11, fontFamily: "system-ui, -apple-system, sans-serif" },
    splitLine: { lineStyle: { color: v.border, type: "dashed" as const } },
  };
  return {
    color: [...PALETTE],
    backgroundColor: "transparent",
    textStyle: { fontFamily: "system-ui, -apple-system, sans-serif", color: v.text, fontSize: 12 },
    title: {
      textStyle: { color: v.textMuted, fontSize: 11, fontWeight: "500", fontFamily: "system-ui, -apple-system, sans-serif" },
      subtextStyle: { color: v.textDim, fontSize: 11 },
    },
    legend: {
      textStyle: { color: v.textMuted, fontSize: 11, fontFamily: "system-ui, -apple-system, sans-serif" },
      inactiveColor: v.textDim,
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
    },
    tooltip: {
      backgroundColor: v.bgElevated,
      borderColor: v.border,
      borderWidth: 1,
      textStyle: { color: v.text, fontSize: 12, fontFamily: "system-ui, -apple-system, sans-serif" },
      extraCssText: `box-shadow: 0 2px 8px ${v.shadow}; border-radius: 6px;`,
    },
    categoryAxis: axisCommon,
    valueAxis: {
      axisLine:  { lineStyle: { color: "transparent" } },
      axisTick:  { show: false },
      axisLabel: { color: v.textMuted, fontSize: 11, fontFamily: "system-ui, -apple-system, sans-serif" },
      splitLine: { lineStyle: { color: v.border, type: "dashed" as const } },
    },
    timeAxis: axisCommon,
    bar: {
      itemStyle: { borderRadius: [2, 2, 0, 0] },
    },
    line: {
      smooth: 0.3,
      lineStyle: { width: 1.5 },
      symbolSize: 4,
      symbol: "circle",
    },
    pie: {
      label: {
        color: v.text,
        fontSize: 11,
        fontFamily: "system-ui, -apple-system, sans-serif",
      },
      labelLine: { lineStyle: { color: v.textDim } },
      itemStyle: { borderColor: v.bgSurface, borderWidth: 2 },
    },
    heatmap: {
      itemStyle: { borderColor: v.bg, borderWidth: 1 },
    },
  };
}

let registered = false;

export function ensureThemeRegistered(): void {
  const v = readThemeValues();
  echarts.registerTheme(ECHARTS_THEME_NAME, buildEChartsTheme(v));
  registered = true;
}

export function getThemeName(): string {
  return ECHARTS_THEME_NAME;
}

// Update all active charts when theme changes
const activeCharts = new Set<echarts.ECharts>();

export function trackChart(chart: echarts.ECharts): () => void {
  activeCharts.add(chart);
  return () => activeCharts.delete(chart);
}

export function getThemeValues(): ThemeValues {
  return readThemeValues();
}

function applyThemeToAll(): void {
  const v = readThemeValues();
  const themeOption = buildEChartsTheme(v);
  echarts.registerTheme(ECHARTS_THEME_NAME, themeOption);
  for (const chart of activeCharts) {
    if (!chart.isDisposed()) {
      chart.setOption({ textStyle: { color: v.text } });
    }
  }
}

let themeWatcher: MutationObserver | null = null;

export function startThemeWatcher(): void {
  if (themeWatcher) return;
  themeWatcher = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "data-theme") {
        applyThemeToAll();
        break;
      }
    }
  });
  themeWatcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

export function stopThemeWatcher(): void {
  themeWatcher?.disconnect();
  themeWatcher = null;
}

/**
 * Create a chart instance with the backpack theme applied.
 * Use this instead of echarts.init() in all widget code.
 */
export function createChart(container: HTMLElement): echarts.ECharts {
  if (!registered) ensureThemeRegistered();
  const chart = echarts.init(container, ECHARTS_THEME_NAME, { renderer: "canvas" });
  const untrack = trackChart(chart);
  chart.on("finished", () => {});
  const origDispose = chart.dispose.bind(chart);
  chart.dispose = () => { untrack(); origDispose(); };
  return chart;
}

/**
 * Severity bar color helper — maps severity labels to their CSS-variable-backed colors.
 * Call with the list of severity labels that will appear on the chart axis.
 */
export function severityBarColors(severities: string[]): string[] {
  const dimColor = readThemeValues().textDim;
  return severities.map((s) => SEVERITY_COLORS[s.toLowerCase()] || dimColor);
}

/**
 * Returns ECharts option fragment that applies to all charts.
 * Merge this into every chart setOption call.
 */
export function baseChartOption(): EChartsCoreOption {
  const v = readThemeValues();
  return {
    backgroundColor: "transparent",
    animation: true,
    animationDuration: 300,
    animationEasing: "cubicOut",
    grid: {
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
      containLabel: true,
    },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "line",
        lineStyle: { color: v.accent, opacity: 0.4 },
      },
      confine: true,
    },
  };
}
