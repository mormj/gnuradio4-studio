// Bin midpoint cells; extrapolated outer half cells are a rendering convention.
// These transforms operate on original float64 coordinates and display row indices.
export type WaterfallViewport = { left: number; right: number; top: number; bottom: number };
export const fullWaterfallViewport: WaterfallViewport = { left: 0, right: 1, top: 0, bottom: 1 };
export function frequencyEdges(x: readonly number[]): [number, number] {
  if (!x.length) return [0, 1];
  return x.length === 1 ? [x[0] - 0.5, x[0] + 0.5] : [x[0] - (x[1] - x[0]) / 2, x[x.length - 1] + (x[x.length - 1] - x[x.length - 2]) / 2];
}
export function frequencyToPixel(hz: number, x: readonly number[], width: number, view = fullWaterfallViewport): number {
  const [a, b] = frequencyEdges(x);
  return (((hz - a) / (b - a) - view.left) / (view.right - view.left)) * width;
}
export function pixelToFrequency(pixel: number, x: readonly number[], width: number, view = fullWaterfallViewport): number {
  const [a, b] = frequencyEdges(x);
  return a + (view.left + pixel / width * (view.right - view.left)) * (b - a);
}
export function frequencyColumn(hz: number, x: readonly number[]): number {
  let low = 0, high = x.length - 1;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (hz > (x[mid] + x[mid + 1]) / 2) low = mid + 1; else high = mid; }
  return low;
}
export function observationToPixel(row: number, count: number, height: number, view = fullWaterfallViewport): number {
  return ((row + 0.5) / count - view.top) / (view.bottom - view.top) * height;
}
export function pixelToObservation(pixel: number, count: number, height: number, view = fullWaterfallViewport): number {
  return Math.min(count - 1, Math.max(0, Math.floor((view.top + pixel / height * (view.bottom - view.top)) * count)));
}
export function moveWaterfallViewport(v: WaterfallViewport, dx: number, dy: number, scale = 1): WaterfallViewport {
  const w = Math.max(0.00001, Math.min(1, (v.right - v.left) * scale));
  const h = Math.max(0.00001, Math.min(1, (v.bottom - v.top) * scale));
  const left = Math.max(0, Math.min(1 - w, (v.left + v.right - w) / 2 + dx));
  const top = Math.max(0, Math.min(1 - h, (v.top + v.bottom - h) / 2 + dy));
  return { left, right: left + w, top, bottom: top + h };
}
