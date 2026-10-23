import { observationPartition, type PlotAnnotation } from './annotation-registry';
import type { WaterfallRowKey } from './dataset-waterfall-frame';
export type AnnotationOverlayItem = { key: string; annotation: PlotAnnotation; executionEnded?: boolean };
export type AnnotationBox = { key: string; item: AnnotationOverlayItem; x: number; y: number; width: number; height: number; broken?: boolean };
type IndexedObservation = { partition: string; sequence: bigint; index: number };
const indexObservations = (rows: readonly WaterfallRowKey[]): IndexedObservation[] => rows.map((row,index) => ({partition:observationPartition(row),sequence:BigInt(row.sequence),index}));
// Split at missing observations; draw only supported retained rows, never fill inferred RF time.
function indexedObservationSegments(a: PlotAnnotation, rows: readonly IndexedObservation[]): number[][] {
  const axis = a.y_axis;
  if (axis?.kind !== 'observation') return [];
  const run=observationPartition(axis.first),first=BigInt(axis.first.sequence),last=BigInt(axis.last.sequence);
  const runs: number[][] = [];
  let previous: bigint | undefined;
  for(const row of rows) {
    if(row.partition!==run || row.sequence<first || row.sequence>last){previous=undefined;continue;}
    if(previous===undefined || (previous-row.sequence!==1n && row.sequence-previous!==1n))runs.push([]);
    runs[runs.length-1].push(row.index);previous=row.sequence;
  }
  return runs;
}
export function observationSegments(a: PlotAnnotation, rows: readonly WaterfallRowKey[]): number[][] {
  return indexedObservationSegments(a,indexObservations(rows));
}
// Geometry is supplied by the producer; opaque metadata cannot override it.
export function frequencyBounds(a: PlotAnnotation): [number, number] {
  return a.geometry.kind === 'point' ? [a.geometry.x, a.geometry.x] : [a.geometry.x_min, a.geometry.x_max];
}
export function visibleAnnotationBoxes(items: readonly AnnotationOverlayItem[], width: number, height: number, x: (hz: number) => number,
  rows?: readonly WaterfallRowKey[], y?: (rowBoundary: number) => number, hiddenStates: readonly string[] = [], numericY?: (value: number, unit: string) => number | undefined): AnnotationBox[] {
  const boxes: AnnotationBox[] = [];
  const observations=rows?indexObservations(rows):undefined;
  for (const item of items) {
    const a = item.annotation;
    if (a.x_axis.kind !== 'frequency' || a.x_axis.unit !== 'Hz' || hiddenStates.includes(a.style?.state ?? '')) continue;
    const [low, high] = frequencyBounds(a), left = x(low), right = x(high);
    if (right < 0 || left > width) continue;
    const segments = observations ? indexedObservationSegments(a, observations) : [[0]];
    // XY deliberately projects observation envelopes onto frequency; unsupported time axes do not guess.
    if (!rows && a.y_axis?.kind === 'qualified_time') continue;
    segments.forEach((segment, i) => {
      let top = y ? y(segment[0]) : 0, bottom = y ? y(segment[segment.length - 1] + 1) : height;
      let x1 = left, x2 = right;
      if (!rows && a.y_axis?.kind === 'numeric') {
        const axis = a.y_axis, g = a.geometry;
        const upper = numericY?.(g.kind === 'point' && g.y !== undefined ? g.y : axis.max, axis.unit);
        const lower = numericY?.(g.kind === 'point' && g.y !== undefined ? g.y : axis.min, axis.unit);
        if (upper === undefined || lower === undefined) return; // Never guess incompatible y units.
        top = Math.min(upper, lower); bottom = Math.max(upper, lower);
        if (g.kind === 'point') { top -= 3; bottom += 3; x1 -= 3; x2 += 3; }
      }
      if (bottom < 0 || top > height) return;
      boxes.push({ key: `${item.key}:${i}`, item, x: Math.max(0, x1), y: Math.max(0, top), width: Math.max(2, Math.min(width, x2) - Math.max(0, x1)), height: Math.max(1, Math.min(height, bottom) - Math.max(0, top)), broken: segments.length > 1 });
    });
  }
  return boxes;
}
