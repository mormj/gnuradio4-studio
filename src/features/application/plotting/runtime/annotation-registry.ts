import { z } from 'zod';
import type { WaterfallRowKey } from './dataset-waterfall-frame';
const text = z.string().min(1).max(512);
export const annotationU64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(s => BigInt(s) <= 18446744073709551615n);
const i64 = z.string().regex(/^-?(0|[1-9][0-9]{0,18})$/).refine(s => s !== '-0' && BigInt(s) >= -9223372036854775808n && BigInt(s) <= 9223372036854775807n);
const key = z.object({ run_namespace: text, source_id: text, acquisition_id: text, source_epoch: text, sequence: annotationU64 }).strict();
export const observationPartition = (k: WaterfallRowKey) => JSON.stringify([k.run_namespace, k.source_id, k.acquisition_id, k.source_epoch]);
const sigmfIndex = annotationU64.refine(s => BigInt(s) <= 9223372036854775807n);
const yAxis = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sample'), recording_id: text, start: sigmfIndex, count: sigmfIndex.optional() }).strict(),
  z.object({ kind: z.literal('observation'), first: key, last: key }).strict(),
  z.object({ kind: z.literal('numeric'), min: z.number().finite(), max: z.number().finite(), unit: text }).strict(),
  z.object({ kind: z.literal('qualified_time'), first_unix_ns: i64, last_unix_ns: i64, provenance: text }).strict(),
]);
const geometry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), x: z.number().finite(), y: z.number().finite().optional() }).strict(),
  z.object({ kind: z.literal('range'), x_min: z.number().finite(), x_max: z.number().finite() }).strict(),
  z.object({ kind: z.literal('rectangle'), x_min: z.number().finite(), x_max: z.number().finite() }).strict(),
]);
// Match the bounded native SigMF extension tree. Exact integer fields arrive
// as decimal strings; extension metadata is retained without interpreting it.
function boundedSigmf(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 4096;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = Object.entries(value);
  return fields.length <= 32 && fields.every(([key, field]) => key.length <= 512 && boundedSigmf(field, depth + 1));
}
const value = z.object({ annotation_id: text, revision: annotationU64, geometry,
  x_axis: z.object({ kind: z.enum(['frequency', 'numeric']), unit: text }).strict(),
  y_axis: yAxis.optional(), label: z.string().max(256),
  style: z.object({ terminal: z.boolean().optional(), state: text.optional(), color: text.optional(), line: z.enum(['solid', 'dashed']).optional(), opacity: z.number().finite().min(0).max(1).optional() }).strict().optional(),
  sigmf: z.record(z.unknown()).refine(v => boundedSigmf(v)).optional(),
  metadata: z.record(z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])).refine(m => Object.keys(m).length <= 32 && Object.keys(m).every(k => k.length <= 512)).optional(),
}).strict().superRefine((a, ctx) => {
  const g = a.geometry, y = a.y_axis;
  const invalid = (g.kind !== 'point' && g.x_min > g.x_max) || (g.kind === 'rectangle' && !y) ||
    (a.x_axis.kind === 'frequency' && a.x_axis.unit !== 'Hz') ||
    (g.kind === 'point' && g.y !== undefined && !y) ||
    (y?.kind === 'sample' && y.count !== undefined && BigInt(y.count) > 0n && BigInt(y.start) + BigInt(y.count) - 1n > 9223372036854775807n) ||
    (y?.kind === 'numeric' && y.min > y.max) ||
    (y?.kind === 'qualified_time' && (['unknown', 'device_unzoned'].includes(y.provenance) || BigInt(y.first_unix_ns) > BigInt(y.last_unix_ns))) ||
    (y?.kind === 'observation' && ((g.kind !== 'rectangle' && g.kind !== 'range') || a.x_axis.kind !== 'frequency' || observationPartition(y.first) !== observationPartition(y.last) || BigInt(y.first.sequence) > BigInt(y.last.sequence)));
  if (invalid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid annotation geometry/coordinates' });
});
export type PlotAnnotation = z.infer<typeof value>;
const tombstone = z.object({ id: text, revision: annotationU64 }).strict();
const event = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('upsert'), value }).strict(),
  z.object({ operation: z.literal('delete'), annotation_id: text, revision: annotationU64 }).strict(),
  z.object({ operation: z.literal('clear') }).strict(),
]);
const common = { payload_format: z.literal('plot-annotations-json-v1'), scope: z.object({ run_namespace: text, producer_instance: text }).strict(),
  stream_epoch: text, cursor: annotationU64,
  retention: z.object({ max_items: z.number().int().min(1).max(100000), max_bytes: z.number().int().min(1024).max(128 * 1024 * 1024), evicted_items: annotationU64, dropped_updates: annotationU64, capacity_evicted_items: annotationU64.optional() }).strict(),
};
const wire = z.discriminatedUnion('message', [
  z.object({ ...common, message: z.literal('snapshot'), items: z.array(value).max(100000), tombstones: z.array(tombstone).max(100000) }).strict(),
  z.object({ ...common, message: z.literal('delta'), base_cursor: annotationU64, events: z.array(event).max(8192), evicted_ids: z.array(text).max(100000) }).strict(),
]);
export type AnnotationState = {
  scope: z.infer<typeof common.scope>; epoch: string; cursor: string;
  items: Map<string, PlotAnnotation>; tombstones: Map<string, string>;
  retainedBytes: number; retention: z.infer<typeof common.retention>; late: number; duplicates: number;
  executionEnded?: boolean; finalizationStatus?: 'unavailable'; incomplete?: boolean;
};
export class AnnotationResyncRequired extends Error {}
const itemBytes = (a: PlotAnnotation) => canonicalAnnotation(a).length * 2 + a.annotation_id.length * 2 + 192;
const deadBytes = (id: string) => id.length * 2 + 192;
const fail = (s: string): never => { throw new AnnotationResyncRequired(s); };
export function canonicalAnnotation(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAnnotation).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalAnnotation(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
// Atomic reducer: every message is applied before the painting cadence, including during pause.
export function reduceAnnotations(previous: AnnotationState | undefined, payload: unknown): AnnotationState {
  const parsed = wire.safeParse(payload);
  if (!parsed.success) return fail('Invalid annotation transaction');
  const t = parsed.data, snapshot = t.message === 'snapshot';
  if (!snapshot && (!previous || previous.executionEnded || previous.epoch !== t.stream_epoch || previous.cursor !== t.base_cursor || BigInt(t.cursor) <= BigInt(t.base_cursor) || canonicalAnnotation(previous.scope) !== canonicalAnnotation(t.scope))) return fail('Annotation cursor, scope or epoch mismatch');
  if (snapshot && previous && previous.epoch === t.stream_epoch && BigInt(t.cursor) < BigInt(previous.cursor)) return fail('Regressed snapshot');
  const s: AnnotationState = { scope: t.scope, epoch: t.stream_epoch, cursor: t.cursor, retention: t.retention,
    items: snapshot ? new Map() : new Map(previous!.items), tombstones: snapshot ? new Map() : new Map(previous!.tombstones),
    retainedBytes: snapshot ? 0 : previous!.retainedBytes, late: snapshot ? 0 : previous!.late, duplicates: snapshot ? 0 : previous!.duplicates };
  const checkRun = (a: PlotAnnotation) => { if (a.y_axis?.kind === 'observation' && a.y_axis.first.run_namespace !== t.scope.run_namespace) fail('Annotation run mismatch'); };
  if (snapshot) {
    for (const a of t.items) { checkRun(a); if (s.items.has(a.annotation_id)) fail('Duplicate snapshot ID'); s.items.set(a.annotation_id, a); s.retainedBytes += itemBytes(a); }
    for (const d of t.tombstones) { if (s.items.has(d.id) || s.tombstones.has(d.id)) fail('Duplicate tombstone ID'); s.tombstones.set(d.id, d.revision); s.retainedBytes += deadBytes(d.id); }
  } else {
    if (BigInt(t.retention.capacity_evicted_items ?? '0') < BigInt(previous!.retention.capacity_evicted_items ?? '0')) fail('Regressed annotation capacity evictions');
    if (BigInt(t.retention.evicted_items) < BigInt(previous!.retention.evicted_items) || BigInt(t.retention.dropped_updates) < BigInt(previous!.retention.dropped_updates)) fail('Regressed counters');
    for (const e of t.events) {
      if (e.operation === 'clear') { s.items.clear(); s.tombstones.clear(); s.retainedBytes = 0; continue; }
      const a = e.operation === 'upsert' ? e.value : undefined;
      if (a) checkRun(a);
      const id = a ? a.annotation_id : (e as { annotation_id: string }).annotation_id;
      const revision = a ? a.revision : (e as { revision: string }).revision;
      const old = s.items.get(id), dead = s.tombstones.get(id), oldRevision = old?.revision ?? dead;
      if (oldRevision !== undefined) {
        if (BigInt(revision) < BigInt(oldRevision)) { s.late++; continue; }
        if (revision === oldRevision) {
          if (a ? !old || canonicalAnnotation(a) !== canonicalAnnotation(old) : dead === undefined) fail('Conflicting equal annotation revision');
          s.duplicates++; continue;
        }
      }
      if (old) s.retainedBytes -= itemBytes(old);
      if (dead !== undefined) s.retainedBytes -= deadBytes(id);
      if (a) { s.items.set(id, a); s.tombstones.delete(id); s.retainedBytes += itemBytes(a); }
      else { s.items.delete(id); s.tombstones.set(id, revision); s.retainedBytes += deadBytes(id); }
    }
    const removed = new Set<string>();
    for (const id of t.evicted_ids) {
      if (removed.has(id) || !s.items.has(id) || s.tombstones.has(id)) fail('Invalid eviction; tombstone pruning requires snapshot epoch');
      removed.add(id); s.retainedBytes -= itemBytes(s.items.get(id)!); s.items.delete(id);
    }
    if (BigInt(t.retention.evicted_items) - BigInt(previous!.retention.evicted_items) !== BigInt(removed.size)) fail('Eviction count mismatch');
  }
  if (BigInt(t.retention.capacity_evicted_items ?? '0') > BigInt(t.retention.evicted_items)) fail('Invalid annotation capacity evictions');
  if (s.items.size + s.tombstones.size > t.retention.max_items || s.retainedBytes > t.retention.max_bytes) fail('Annotation retention exceeded');
  return s;
}
export function endAnnotationExecution(s: AnnotationState): AnnotationState {
  return { ...s, executionEnded: true, finalizationStatus: 'unavailable' };
}
