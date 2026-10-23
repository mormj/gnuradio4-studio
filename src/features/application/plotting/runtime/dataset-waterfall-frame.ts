import { z } from 'zod';
import { reduceAnnotations, type AnnotationState } from './annotation-registry';
import type { PlotImageFrame } from '../model/types';

const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(s => BigInt(s) <= 18446744073709551615n);
const text = z.string().min(1).max(512);
const key = z.object({ run_namespace: text, source_id: text, acquisition_id: text, source_epoch: text, sequence: u64 }).strict();
const timestamp = z.object({
  unix_ns: z.string().regex(/^-?(0|[1-9][0-9]{0,18})$/).refine(s => s !== '-0' && BigInt(s) >= -9223372036854775808n && BigInt(s) <= 9223372036854775807n).nullable(),
  provenance: text, raw_text: z.string().max(4096),
}).strict();
const grid = z.object({ grid_id: text, coordinates: z.array(z.number().finite()).min(1).max(1048576), axis: z.literal('frequency'), unit: z.literal('Hz'), coordinate_model: text, power_unit: text }).strict();
const row = z.object({ frame_key: key, grid_id: text, power: z.array(z.number().finite()).min(1).max(1048576), timestamp, validity: text, coverage: text, discontinuities: z.array(text).max(16) }).strict();
const common = {
  payload_format: z.literal('dataset-waterfall-json-v1'),
  scope: z.object({ run_namespace: text, producer_instance: text }).strict(),
  stream_epoch: text, cursor: u64,
  retention: z.object({ max_items: z.number().int().min(1).max(100000), max_bytes: z.number().int().min(1024).max(128 * 1024 * 1024), evicted_items: u64, dropped_updates: u64 }).strict(),
  rows: z.array(row).max(2048),
  annotations: z.unknown().optional(),
};
const transaction = z.discriminatedUnion('message', [
  z.object({ ...common, message: z.literal('snapshot'), grids: z.array(grid).max(1) }).strict(),
  z.object({ ...common, message: z.literal('delta'), base_cursor: u64, evicted_frame_keys: z.array(key).max(2048) }).strict(),
]);
export type WaterfallRowKey = z.infer<typeof key>;
export type DatasetWaterfallRow = z.infer<typeof row>;
export type DatasetWaterfallState = {
  epoch: string; cursor: string; scope: z.infer<typeof common.scope>;
  annotations?: AnnotationState;
  grid?: z.infer<typeof grid>; rows: DatasetWaterfallRow[];
  retention: z.infer<typeof common.retention>;
};
export class WaterfallResyncRequired extends Error {}
export const frameKeyId = (k: WaterfallRowKey) => JSON.stringify([k.run_namespace, k.source_id, k.acquisition_id, k.source_epoch, k.sequence]);
const partition = (k: WaterfallRowKey) => JSON.stringify([k.run_namespace, k.source_id, k.acquisition_id, k.source_epoch]);
const fail = (message: string): never => { throw new WaterfallResyncRequired(message); };

// Pure transaction reducer. Validation completes before the previous state can change.
export function reduceDatasetWaterfall(previous: DatasetWaterfallState | undefined, payload: unknown): DatasetWaterfallState {
  const parsed = transaction.safeParse(payload);
  if (!parsed.success) return fail('Invalid dataset waterfall transaction');
  const t = parsed.data;
  const snapshot = t.message === 'snapshot';
  if (!snapshot && (!previous || t.stream_epoch !== previous.epoch || t.base_cursor !== previous.cursor || BigInt(t.cursor) <= BigInt(t.base_cursor) || JSON.stringify(t.scope) !== JSON.stringify(previous.scope))) return fail('Waterfall cursor/epoch mismatch; resynchronizing');
  const g = snapshot ? t.grids[0] : previous!.grid;
  if (snapshot && ((t.rows.length > 0) !== !!g)) return fail('Snapshot grid/row mismatch');
  if (g) {
    const x = g.coordinates;
    const step = x.length > 1 ? (x[x.length - 1] - x[0]) / (x.length - 1) : 0;
    for (let i = 0; i < x.length; i++) {
      if ((i > 0 && x[i] <= x[i - 1]) || Math.abs(x[i] - (x[0] + step * i)) > Math.max(Math.abs(step) * 1e-7, Math.abs(x[i]) * Number.EPSILON * 8)) return fail('Unsupported frequency grid');
    }
  }
  let rows = snapshot ? [] : previous!.rows.slice();
  const lastBeforeEviction = rows[rows.length - 1];
  if (!snapshot) {
    // Evictions are an explicit prefix of the previous history plus appended rows.
    // Applying append before removal also handles a publication batch larger than retention.
    if (BigInt(t.retention.evicted_items) < BigInt(previous!.retention.evicted_items) || BigInt(t.retention.dropped_updates) < BigInt(previous!.retention.dropped_updates)) return fail('Regressed diagnostics');
  }
  const seen = new Set(rows.map(r => frameKeyId(r.frame_key)));
  let last = lastBeforeEviction;
  for (const r of t.rows) {
    if (!g || r.grid_id !== g.grid_id || r.power.length !== g.coordinates.length || r.frame_key.run_namespace !== t.scope.run_namespace) return fail('Invalid row grid or namespace');
    if (r.timestamp.unix_ns !== null && ['unknown', 'device_unzoned'].includes(r.timestamp.provenance)) return fail('Unqualified timestamp');
    if (seen.has(frameKeyId(r.frame_key)) || (last && (partition(last.frame_key) !== partition(r.frame_key) || BigInt(r.frame_key.sequence) <= BigInt(last.frame_key.sequence)))) return fail('Duplicate, conflicting, or unordered row');
    if (last && BigInt(r.frame_key.sequence) - BigInt(last.frame_key.sequence) > 1n && !r.discontinuities.includes('source_sequence_gap')) return fail('Unreported source sequence gap');
    seen.add(frameKeyId(r.frame_key)); rows.push(r); last = r;
  }
  if (!snapshot) {
    for (const k of t.evicted_frame_keys) {
      if (!rows.length || frameKeyId(rows[0].frame_key) !== frameKeyId(k)) return fail('Invalid eviction prefix');
      rows.shift();
    }
    if (BigInt(t.retention.evicted_items) - BigInt(previous!.retention.evicted_items) !== BigInt(t.evicted_frame_keys.length)) return fail('Eviction counter mismatch');
  }
  const bytes = (g?.coordinates.length ?? 0) * 8 + rows.reduce((n, r) => n + r.power.length * 8 + JSON.stringify({ ...r, power: [] }).length * 2, 0);
  const measurementBytes = (g?.coordinates.length ?? 0) * 8 + rows.reduce((n, r) => n + r.power.length * 8, 0);
  if (rows.length > t.retention.max_items || measurementBytes > t.retention.max_bytes || bytes > 128 * 1024 * 1024) return fail('Waterfall retention exceeded');
  const annotations = t.annotations === undefined ? (snapshot ? undefined : previous?.annotations)
    : reduceAnnotations(snapshot ? undefined : previous?.annotations, t.annotations);
  return { annotations, epoch: t.stream_epoch, cursor: t.cursor, scope: t.scope, grid: g, rows, retention: t.retention };
}

export function datasetWaterfallImage(s: DatasetWaterfallState): PlotImageFrame {
  const rows = [...s.rows].reverse();
  const width = s.grid?.coordinates.length ?? 0;
  const values = new Float64Array(width * rows.length);
  rows.forEach((r, i) => values.set(r.power, i * width));
  return { width, height: rows.length, values, xAxis: s.grid ? new Float64Array(s.grid.coordinates) : undefined,
    axisName: 'frequency', axisUnit: 'Hz', signalUnit: s.grid?.power_unit, signalName: 'Spectrum observations',
    rowKeys: rows.map(r => r.frame_key), rowTimestamps: rows.map(r => r.timestamp), rowDiscontinuities: rows.map(r => r.discontinuities),
    annotations: s.annotations ? [...s.annotations.items.values()].map(annotation => ({
      key: JSON.stringify([s.annotations!.scope.run_namespace, annotation.annotation_id]), annotation,
      executionEnded: s.annotations!.executionEnded && annotation.style?.terminal !== true,
    })) : [],
    observationAxis: true, streamEpoch: s.epoch, publicationCursor: s.cursor,
    annotationCapacityEvictions: s.annotations?.retention.capacity_evicted_items ?? '0',
    droppedUpdates: s.retention.dropped_updates, evictedRows: s.retention.evicted_items,
  };
}
