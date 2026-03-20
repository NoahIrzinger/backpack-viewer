/**
 * Deterministic type → color mapping.
 * Earth-tone accent palette on a neutral gray UI.
 * These are the only warm colors in the interface —
 * everything else is grayscale.
 */

const PALETTE = [
  "#d4a27f", // warm tan
  "#c17856", // terracotta
  "#b07a5e", // sienna
  "#d4956b", // burnt amber
  "#a67c5a", // walnut
  "#cc9e7c", // copper
  "#c4866a", // clay
  "#cb8e6c", // apricot
  "#b8956e", // wheat
  "#a88a70", // driftwood
  "#d9b08c", // caramel
  "#c4a882", // sand
  "#e8b898", // peach
  "#b5927a", // dusty rose
  "#a8886e", // muted brown
  "#d1a990", // blush tan
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
