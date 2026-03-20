/**
 * Deterministic type → color mapping.
 * Uses a Tableau-inspired palette. Hash-based so colors are
 * consistent across page loads without any hardcoded type lists.
 */

const PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
  "#6b9ac4",
  "#d37295",
  "#86bcb6",
  "#d4a6c8",
  "#aec7e8",
  "#ffbe7d",
];

const cache = new Map<string, string>();

export function getColor(type: string): string {
  const cached = cache.get(type);
  if (cached) return cached;

  let hash = 0;
  for (let i = 0; i < type.length; i++) {
    hash = ((hash << 5) - hash + type.charCodeAt(i)) | 0;
  }
  const color = PALETTE[Math.abs(hash) % PALETTE.length];
  cache.set(type, color);
  return color;
}
