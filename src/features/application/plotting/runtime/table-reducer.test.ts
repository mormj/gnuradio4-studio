import { describe, expect, it } from 'vitest';
import { reduceTables, type TableState } from './table-reducer';
import { queryTable, formatTableValue } from './table-query';
import { selectAnnotation, subscribeAnnotationSelection } from './annotation-subscription';
export const columns = [
  { key: 'id', label: 'Identity', type: 'uint64', nullable: false },
  { key: 'signed', label: 'Signed', type: 'int64', nullable: false },
  { key: 'frequency', label: 'Frequency', type: 'float64', nullable: false, unit: 'Hz' },
  { key: 'power', label: 'Power', type: 'float64', nullable: false, unit: 'dBm' },
  { key: 'state', label: 'State', type: 'string', nullable: false },
  { key: 'flag', label: 'Flag', type: 'boolean', nullable: false },
  { key: 'reason', label: 'Reason', type: 'string', nullable: true },
];
export const row = (id = '9007199254740993', revision = '1') => ({ row_id: id, annotation_id: id, revision, values: { id, signed: '-9223372036854775808', frequency: 902000140.1234567, power: -41.25, state: 'created', flag: false, reason: null } });
export const snapshot = () => ({ payload_format: 'table-updates-json-v1', scope: { run_namespace: 'run', producer_instance: 'tables' }, stream_epoch: 'epoch', cursor: '0', message: 'snapshot', columns, rows: [row()], tombstones: [], retention: { max_items: 10000, max_bytes: 33554432, evicted_items: '0', dropped_updates: '0' } });
export const delta = (s: TableState, events: unknown[], evicted_ids: string[] = []) => ({ payload_format: 'table-updates-json-v1', scope: s.scope, stream_epoch: s.epoch, cursor: String(BigInt(s.cursor) + 1n), base_cursor: s.cursor, message: 'delta', events, evicted_ids, retention: { ...s.retention, evicted_items: String(BigInt(s.retention.evicted_items) + BigInt(evicted_ids.length)) } });
it('upserts complete typed rows, retains exact extrema and stable IDs, detects duplicate/stale/conflicting revisions', () => {
  let s = reduceTables(undefined, snapshot());
  for (const revision of ['2', '3', '4', '5', '18446744073709551615']) s = reduceTables(s, delta(s, [{ operation: 'upsert', value: row(undefined, revision) }]));
  expect(s.items.size).toBe(1); expect([...s.items.values()][0].values.signed).toBe('-9223372036854775808');
  s = reduceTables(s, delta(s, [{ operation: 'upsert', value: row(undefined, '18446744073709551615') }])); expect(s.duplicates).toBe(1);
  s = reduceTables(s, delta(s, [{ operation: 'upsert', value: row(undefined, '2') }])); expect(s.late).toBe(1);
  const conflict = row(undefined, '18446744073709551615'); conflict.values.flag = true;
  expect(() => reduceTables(s, delta(s, [{ operation: 'upsert', value: conflict }]))).toThrow('Conflicting');
});
it('handles delete tombstones, late resurrection, clear, explicit eviction and fresh schema snapshots atomically', () => {
  let s = reduceTables(undefined, snapshot());
  s = reduceTables(s, delta(s, [{ operation: 'delete', row_id: row().row_id, revision: '2' }]));expect(s.tombstones.size).toBe(1);
  s = reduceTables(s, delta(s, [{ operation: 'upsert', value: row() }]));expect(s.items.size).toBe(0);
  s = reduceTables(s, delta(s, [{ operation: 'upsert', value: row(undefined, '3') }]));
  s = reduceTables(s, delta(s, [], [row().row_id])); expect(s.items.size).toBe(0);expect(s.retention.evicted_items).toBe('1');
  expect(() => reduceTables(s, delta(s, [], ['absent']))).toThrow();
  s = reduceTables(s, { ...snapshot(), stream_epoch: 'fresh', rows: [] });expect(s.items.size).toBe(0);expect(s.columns).toHaveLength(7);
  expect(() => reduceTables(s, { ...snapshot(), stream_epoch: 'fresh', columns: [] })).toThrow('Schema');
  s = reduceTables(s, { ...snapshot(), stream_epoch: 'schema2', columns: [], rows: [] }); expect(s.columns).toEqual([]);
  s = reduceTables(s, delta(s, [{ operation: 'clear' }]));expect(s.items.size).toBe(0);
});
it('rejects invalid values, missing/unknown columns, unsafe integers, malformed envelopes and cursor gaps', () => {
  for (const mutate of [
    (r: ReturnType<typeof row>) => { Object.assign(r.values, { id: 9007199254740992 }); },
    (r: ReturnType<typeof row>) => { r.values.id = '18446744073709551616'; },
    (r: ReturnType<typeof row>) => { r.values.id = '01'; },
    (r: ReturnType<typeof row>) => { r.values.signed = '-9223372036854775809'; },
    (r: ReturnType<typeof row>) => { r.values.signed = '-0'; },
    (r: ReturnType<typeof row>) => { Object.assign(r.values, { flag: 'false' }); },
    (r: ReturnType<typeof row>) => { Object.assign(r.values, { frequency: null }); },
    (r: ReturnType<typeof row>) => { Object.assign(r.values, { unknown: true }); },
  ]) { const r = row(); mutate(r); expect(() => reduceTables(undefined, { ...snapshot(), rows: [r] })).toThrow(); }
  const s = reduceTables(undefined, snapshot());const t = delta(s, []);
  for (const bad of [{ ...t, base_cursor: '99' }, { ...t, stream_epoch: 'wrong' }, { ...t, scope: { ...t.scope, run_namespace: 'other' } }, { ...snapshot(), rows: [row(), row()] }, { ...snapshot(), surprise: true }, { ...t, evicted_ids: [row().row_id], retention: t.retention }]) expect(() => reduceTables(s, bad)).toThrow();
  expect(s.items.size).toBe(1);
});
it('sorts integers numerically, filters without deleting retained rows and formats frequency/power separately', () => {
  const s = reduceTables(undefined, { ...snapshot(), rows: [row('9'), row('18446744073709551615'), row('9007199254740993'), row('10')] });
  expect(queryTable(s, '', 'id').map(r => r.row_id)).toEqual(['9', '10', '9007199254740993', '18446744073709551615']);
  expect(queryTable(s, '9007199254740993', 'id')).toHaveLength(1);expect(s.items.size).toBe(4);
  expect(formatTableValue(902000140.1234567, s.columns[2])).toBe('902.00014 MHz');
  expect(formatTableValue(-41.25, s.columns[3])).toBe('-41.25 dBm');
  expect(formatTableValue('18446744073709551615', s.columns[0])).toBe('18446744073709551615');
});
it('keeps pending selection across independent annotation/table timing with exact run identity', () => {
  let selected: string | undefined;const stop = subscribeAnnotationSelection(s => { selected = s; });
  const key = JSON.stringify(['run', row().annotation_id]);selectAnnotation(key);
  let s = reduceTables(undefined, { ...snapshot(), rows: [] });expect(s.items.size).toBe(0);expect(selected).toBe(key);
  s = reduceTables(s, delta(s, [{ operation: 'upsert', value: row() }]));expect(JSON.stringify([s.scope.run_namespace, [...s.items.values()][0].annotation_id])).toBe(selected);
  expect(JSON.stringify(['other-run', row().annotation_id])).not.toBe(selected);stop();selectAnnotation(undefined);
});
it('processes 3014 unique rows and 16185 incremental lifecycle updates before painting', () => {
  let s = reduceTables(undefined, { ...snapshot(), rows: [] });const begin = performance.now();
  for (let i = 0; i < 16185; i++) { const r = row(String(9007199254740993n + BigInt(i % 3014)), String(i + 1));r.values.state = i >= 13171 ? 'closed' : ['created', 'confirmed', 'updated', 'coasting', 'updated'][i % 5];s = reduceTables(s, delta(s, [{ operation: 'upsert', value: r }])); }
  expect(s.items.size).toBe(3014);expect([...s.items.values()].every(r => r.values.state === 'closed')).toBe(true);
  console.log(JSON.stringify({ tableUpdates: 16185, uniqueRows: s.items.size, milliseconds: performance.now() - begin, retainedBytes: s.retainedBytes, heap: (globalThis as unknown as { process: { memoryUsage: () => { heapUsed: number } } }).process.memoryUsage().heapUsed }));
}, 30000);

it('accepts rows without annotations, independent annotation selection and an annotation whose table counterpart arrives later', () => {
 const plain = { row_id: 'plain', revision: '1', values: row().values };
 const s = reduceTables(undefined, { ...snapshot(), rows: [plain] });expect(s.items.get('plain')?.annotation_id).toBeUndefined();
 const pending = JSON.stringify(['run', 'no-table-row']);selectAnnotation(pending);let selection: string | undefined;const stop = subscribeAnnotationSelection(v => { selection = v; });
 expect(s.items.size).toBe(1);expect(selection).toBe(pending);stop();selectAnnotation(undefined);
});


describe('producer-owned terminal policy', () => {
  it('preserves explicit terminal flags independently of arbitrary table values', () => {
    const payload = {
      payload_format: 'table-updates-json-v1', message: 'snapshot',
      scope: { run_namespace: 'run', producer_instance: 'p' }, stream_epoch: 'e', cursor: '1',
      retention: { max_items: 10, max_bytes: 33554432, evicted_items: '0', dropped_updates: '0' },
      columns: [{ key: 'state', label: 'State', type: 'string', nullable: false }],
      rows: [{ row_id: 'opaque', revision: '1', terminal: false, values: { state: 'CLOSED' } }], tombstones: [],
    };
    expect(reduceTables(undefined, payload).items.get('opaque')).toEqual(payload.rows[0]);
    payload.rows[0].terminal = true;payload.rows[0].values.state = 'anything';
    expect(reduceTables(undefined, payload).items.get('opaque')).toEqual(payload.rows[0]);
    expect(() => reduceTables(undefined, { ...payload, rows: [{ ...payload.rows[0], terminal: 'yes' }] })).toThrow();
  });
});
