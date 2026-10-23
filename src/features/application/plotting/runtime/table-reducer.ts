import { z } from 'zod';
import { annotationU64 as tableU64, canonicalAnnotation as canonicalTable } from './annotation-registry';
const text = z.string().min(1).max(512);
const signed = z.string().regex(/^-?(0|[1-9][0-9]{0,18})$/).refine(s => s !== '-0' && BigInt(s) >= -9223372036854775808n && BigInt(s) <= 9223372036854775807n);
const column = z.object({ key: text, label: text, type: z.enum(['string', 'uint64', 'int64', 'float64', 'boolean']), nullable: z.boolean(), unit: text.optional() }).strict();
export type TableColumn = z.infer<typeof column>;
const value = z.object({ row_id: text, revision: tableU64, annotation_id: text.optional(), terminal: z.boolean().optional(), values: z.record(z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])).refine(v => Object.keys(v).length <= 64) }).strict();
export type TableRow = z.infer<typeof value>;
function validateValues(row: TableRow, columns: TableColumn[]): void {
  if (Object.keys(row.values).length !== columns.length) throw new TableResyncRequired('Complete row required');
  for (const c of columns) {
    const v = row.values[c.key];
    const valid = v === null ? c.nullable : c.type === 'uint64' ? tableU64.safeParse(v).success : c.type === 'int64' ? signed.safeParse(v).success : c.type === 'float64' ? typeof v === 'number' && Number.isFinite(v) : typeof v === c.type;
    if (!valid) throw new TableResyncRequired('Column type mismatch: ' + c.key);
  }
}
const tombstone = z.object({ id: text, revision: tableU64 }).strict();
const event = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('upsert'), value }).strict(),
  z.object({ operation: z.literal('delete'), row_id: text, revision: tableU64 }).strict(),
  z.object({ operation: z.literal('clear') }).strict(),
]);
const common = { payload_format: z.literal('table-updates-json-v1'), scope: z.object({ run_namespace: text, producer_instance: text }).strict(),
  stream_epoch: text, cursor: tableU64,
  retention: z.object({ max_items: z.number().int().min(1).max(100000), max_bytes: z.number().int().min(1024).max(128 * 1024 * 1024), evicted_items: tableU64, dropped_updates: tableU64 }).strict(),
};
const wire = z.discriminatedUnion('message', [
  z.object({ ...common, message: z.literal('snapshot'), columns: z.array(column).max(64), rows: z.array(value).max(100000), tombstones: z.array(tombstone).max(100000) }).strict(),
  z.object({ ...common, message: z.literal('delta'), base_cursor: tableU64, events: z.array(event).max(8192), evicted_ids: z.array(text).max(100000) }).strict(),
]);
export type TableState = {
  scope: z.infer<typeof common.scope>; epoch: string; cursor: string;
  items: Map<string, TableRow>; tombstones: Map<string, string>;
  columns: TableColumn[]; retainedBytes: number; retention: z.infer<typeof common.retention>; late: number; duplicates: number;
  executionEnded?: boolean; finalizationStatus?: 'unavailable'; incomplete?: boolean;
};
export class TableResyncRequired extends Error {}
const itemBytes = (a: TableRow) => canonicalTable(a).length * 2 + a.row_id.length * 2 + 192;
const deadBytes = (id: string) => id.length * 2 + 192;
const fail = (s: string): never => { throw new TableResyncRequired(s); };
// Atomic reducer: every message is applied before the painting cadence, including during pause.
export function reduceTables(previous: TableState | undefined, payload: unknown): TableState {
  const parsed = wire.safeParse(payload);
  if (!parsed.success) return fail('Invalid table transaction');
  const t = parsed.data, snapshot = t.message === 'snapshot';
  if (!snapshot && (!previous || previous.executionEnded || previous.epoch !== t.stream_epoch || previous.cursor !== t.base_cursor || BigInt(t.cursor) <= BigInt(t.base_cursor) || canonicalTable(previous.scope) !== canonicalTable(t.scope))) return fail('Table cursor, scope or epoch mismatch');
  if (snapshot && previous && previous.epoch === t.stream_epoch && BigInt(t.cursor) < BigInt(previous.cursor)) return fail('Regressed snapshot');
  const s: TableState = { columns: snapshot ? t.columns : previous!.columns, scope: t.scope, epoch: t.stream_epoch, cursor: t.cursor, retention: t.retention,
    items: snapshot ? new Map() : new Map(previous!.items), tombstones: snapshot ? new Map() : new Map(previous!.tombstones),
    retainedBytes: snapshot ? canonicalTable(t.columns).length * 2 + 128 : previous!.retainedBytes, late: snapshot ? 0 : previous!.late, duplicates: snapshot ? 0 : previous!.duplicates };
  const columns = snapshot ? t.columns : previous!.columns;
  if (new Set(columns.map(c => c.key)).size !== columns.length) fail('Duplicate column key');
  if (snapshot && previous?.epoch === t.stream_epoch && canonicalTable(columns) !== canonicalTable(previous.columns)) fail('Schema change requires a fresh epoch');
  s.columns = columns;
  const checkRun = (a: TableRow) => validateValues(a, columns);
  if (snapshot) {
    for (const a of t.rows) { checkRun(a); if (s.items.has(a.row_id)) fail('Duplicate snapshot ID'); s.items.set(a.row_id, a); s.retainedBytes += itemBytes(a); }
    for (const d of t.tombstones) { if (s.items.has(d.id) || s.tombstones.has(d.id)) fail('Duplicate tombstone ID'); s.tombstones.set(d.id, d.revision); s.retainedBytes += deadBytes(d.id); }
  } else {
    if (BigInt(t.retention.evicted_items) < BigInt(previous!.retention.evicted_items) || BigInt(t.retention.dropped_updates) < BigInt(previous!.retention.dropped_updates)) fail('Regressed counters');
    for (const e of t.events) {
      if (e.operation === 'clear') { s.items.clear(); s.tombstones.clear(); s.retainedBytes = canonicalTable(s.columns).length * 2 + 128; continue; }
      const a = e.operation === 'upsert' ? e.value : undefined;
      if (a) checkRun(a);
      const id = a ? a.row_id : (e as { row_id: string }).row_id;
      const revision = a ? a.revision : (e as { revision: string }).revision;
      const old = s.items.get(id), dead = s.tombstones.get(id), oldRevision = old?.revision ?? dead;
      if (oldRevision !== undefined) {
        if (BigInt(revision) < BigInt(oldRevision)) { s.late++; continue; }
        if (revision === oldRevision) {
          if (a ? !old || canonicalTable(a) !== canonicalTable(old) : dead === undefined) fail('Conflicting equal table revision');
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
  if (s.items.size + s.tombstones.size > t.retention.max_items || s.retainedBytes > t.retention.max_bytes) fail('Table retention exceeded');
  return s;
}
export function endTableExecution(s: TableState): TableState {
  return { ...s, executionEnded: true, finalizationStatus: 'unavailable' };
}
