import contractExamples from './annotation-contract-examples.json';
import { describe, expect, it } from 'vitest';
import { reduceAnnotations, endAnnotationExecution, type PlotAnnotation, type AnnotationState } from './annotation-registry';
import { observationSegments, visibleAnnotationBoxes } from './annotation-projection';
const key = (sequence: string) => ({ run_namespace: 'run', source_id: 's', acquisition_id: 'a', source_epoch: 'e', sequence });
const a = (revision = '1', id = '9007199254740993'): PlotAnnotation => ({ annotation_id: id, revision, label: 'Region A', geometry: { kind: 'rectangle', x_min: 100, x_max: 200 }, x_axis: { kind: 'frequency', unit: 'Hz' }, y_axis: { kind: 'observation', first: key('9007199254740993'), last: key('9007199254740998') }, style: { state: 'ACTIVE' } });
const common = { payload_format: 'plot-annotations-json-v1', scope: { run_namespace: 'run', producer_instance: 'p' }, stream_epoch: 'epoch', retention: { max_items: 10000, max_bytes: 33554432, evicted_items: '0', dropped_updates: '0' } };
const snapshot = (items: PlotAnnotation[] = []) => ({ ...common, message: 'snapshot', cursor: '0', items, tombstones: [] });
const delta = (s: AnnotationState, events: unknown[]) => ({ ...common, message: 'delta', cursor: String(BigInt(s.cursor) + 1n), base_cursor: s.cursor, events, evicted_ids: [] });
const upsert = (value: PlotAnnotation) => ({ operation: 'upsert', value });
describe('retained annotations', () => {
  it('replaces complete values, preserves uint64, counts late and duplicate updates', () => {
    let s = reduceAnnotations(undefined, snapshot([a('9007199254740993')]));
    s = reduceAnnotations(s, delta(s, [upsert(a('9007199254740994')), upsert(a('9007199254740993')), upsert(a('9007199254740994'))]));
    expect(s.items.size).toBe(1); expect(s.late).toBe(1); expect(s.duplicates).toBe(1); expect([...s.items.values()][0].revision).toBe('9007199254740994');
    const conflicting = { ...a('9007199254740994'), label: 'Conflict' };
    expect(() => reduceAnnotations(s, delta(s, [upsert(conflicting)]))).toThrow(/Conflicting/);
    expect([...s.items.values()][0].label).toBe('Region A');
  });
  it('deletes with tombstones, prevents resurrection, clears at publication boundary', () => {
    let s = reduceAnnotations(undefined, snapshot([a()]));
    s = reduceAnnotations(s, delta(s, [{ operation: 'delete', annotation_id: a().annotation_id, revision: '2' }]));
    s = reduceAnnotations(s, delta(s, [upsert(a())]));expect(s.items.size).toBe(0);expect(s.tombstones.size).toBe(1);
    expect(() => reduceAnnotations(s, delta(s, [upsert(a('2'))]))).toThrow();
    s = reduceAnnotations(s, delta(s, [upsert(a('3')), { operation: 'clear' }]));expect(s.items.size + s.tombstones.size).toBe(0);
  });
  it('reconstructs snapshots, resets epochs, rejects missing deltas and old scopes', () => {
    const s = reduceAnnotations(undefined, snapshot([a()]));
    expect(() => reduceAnnotations(s, { ...delta(s, []), base_cursor: '99' })).toThrow();
    expect(() => reduceAnnotations(s, { ...delta(s, []), stream_epoch: 'old' })).toThrow();
    expect(() => reduceAnnotations(s, { ...delta(s, []), scope: { ...common.scope, producer_instance: 'other' } })).toThrow();
    expect(reduceAnnotations(s, { ...snapshot(), stream_epoch: 'new' }).items.size).toBe(0);
    expect(reduceAnnotations(undefined, snapshot([a()])).items).toEqual(s.items);
  });
  it('rejects invalid geometry, axes, namespace and oversized revisions', () => {
    for (const bad of [ { ...a(), revision: '18446744073709551616' }, { ...a(), revision: 9007199254740992 }, { ...a(), x_axis: { kind: 'frequency', unit: 'kHz' } }, { ...a(), geometry: { kind: 'range', x_min: 5, x_max: 1 } }, { ...a(), y_axis: undefined }, { ...a(), geometry: { kind: 'point', x: Infinity } }, { ...a(), y_axis: { kind: 'observation', first: key('10'), last: key('9') } } ]) expect(() => reduceAnnotations(undefined, snapshot([bad as PlotAnnotation]))).toThrow();
  });
  it('retains early annotations, clips rows and splits missing observations exactly', () => {
    const s = reduceAnnotations(undefined, snapshot([a()])), item = { key: 'opaque', annotation: [...s.items.values()][0] };
    expect(observationSegments(item.annotation, [])).toEqual([]);
    const rows = ['9007199254740998', '9007199254740997', '9007199254740995', '9007199254740994'].map(key);
    expect(observationSegments(item.annotation, rows)).toEqual([[0, 1], [2, 3]]);
    expect(observationSegments(item.annotation, rows.slice(2))).toEqual([[0, 1]]);
    const boxes = visibleAnnotationBoxes([item], 400, 200, hz => (hz - 50) * 2, rows, row => row * 50);
    expect(boxes).toHaveLength(2);expect(boxes[0]).toMatchObject({ x: 100, width: 200, y: 0, height: 100, broken: true });
    const zoom = visibleAnnotationBoxes([item], 400, 200, hz => (hz - 100) * 4, rows, row => row * 100 - 100);
    expect(zoom[0]).toMatchObject({ x: 0, width: 400, y: 0, height: 100 });
    expect(visibleAnnotationBoxes([item], 400, 200, hz => hz, rows.map(k => ({ ...k, source_epoch: 'different' })), row => row)).toHaveLength(0);
  });
  it('keeps producer revisions and lifecycle state on incomplete graph stop', () => {
    const s = endAnnotationExecution(reduceAnnotations(undefined, snapshot([a()])));
    expect(s.executionEnded).toBe(true);expect(s.finalizationStatus).toBe('unavailable');expect([...s.items.values()][0]).toEqual(a());
    expect(() => reduceAnnotations(s, delta(s, []))).toThrow();
    expect(reduceAnnotations(undefined, { ...snapshot(), scope: { run_namespace: 'new-run', producer_instance: 'p' }, stream_epoch: 'new' }).items.size).toBe(0);
  });
  it('bounds retention and reports eviction independently of producer delete', () => {
    const s = reduceAnnotations(undefined, snapshot([a()]));
    const t = { ...delta(s, []), evicted_ids: [a().annotation_id], retention: { ...common.retention, evicted_items: '1' } };
    const next = reduceAnnotations(s, t);expect(next.items.size).toBe(0);expect(next.tombstones.size).toBe(0);
    expect(() => reduceAnnotations(s, { ...t, evicted_ids: ['absent'] })).toThrow();
    expect(() => reduceAnnotations(undefined, { ...snapshot([a(), a('1', 'b')]), retention: { ...common.retention, max_items: 1 } })).toThrow();
  });
  it('qualifies 3014 creations / 16185 lifecycle updates with bounded unique rectangles', () => {
    let s = reduceAnnotations(undefined, snapshot());const begin = performance.now();
    // Match native transport: each update is an independent publication, independent of measurement frames.
    for (let offset = 0; offset < 16185; offset += 1) {
      const events = Array.from({ length: Math.min(1, 16185 - offset) }, (_, j) => {
        const i = offset + j;return upsert({ ...a(String(i + 1), String(9007199254740993n + BigInt(i % 3014))), style: { state: i >= 13171 ? 'CLOSED' : 'ACTIVE' } });
      });
      s = reduceAnnotations(s, delta(s, events));
    }
    const elapsed = performance.now() - begin;
    expect(s.items.size).toBe(3014);expect([...s.items.values()].filter(v => v.style?.state === 'CLOSED')).toHaveLength(3014);
    console.log(JSON.stringify({ updates: 16185, creations: 3014, retained: s.items.size, milliseconds: elapsed, updatesPerSecond: 16185 * 1000 / elapsed, heap: (globalThis as unknown as { process?: { memoryUsage(): { heapUsed: number } } }).process?.memoryUsage().heapUsed }));
  });
});

it('accepts all approved stream annotation examples and their ordered lifecycle', () => {
  for (const e of contractExamples) if (e.payload.message === 'snapshot') expect(reduceAnnotations(undefined, e.payload)).toBeDefined();
  let s: AnnotationState | undefined;
  for (const name of ['annotation-empty', 'annotation-before-row', 'annotation-coasting', 'annotation-delete-clear']) s = reduceAnnotations(s, contractExamples.find(e => e.name === name)!.payload);
  expect(s!.items.size).toBe(0);
});

it('projects the approved physical-frequency point with explicit compatible power units', () => {
  const point = contractExamples.find(e => e.name === 'annotation-point-range')!.payload.items![0] as PlotAnnotation;
  const items = [{ key: 'point', annotation: point }];
  expect(visibleAnnotationBoxes(items, 400, 200, () => 100)).toHaveLength(0);
  const boxes = visibleAnnotationBoxes(items, 400, 200, () => 100, undefined, undefined, [], (value, unit) => unit === 'dBm' ? -value : undefined);
  expect(boxes[0]).toMatchObject({ x: 97, y: 77, width: 6, height: 6 });
});

// SigMF sample coordinates must survive browser reduction without Number conversion.
describe('SigMF annotation content', () => {
  it('retains exact sample coordinates and core fields', () => {
    const item = { ...a(), y_axis: { kind: 'sample', recording_id: 'recording-A', start: '9007199254740993', count: '4096' },
      sigmf: { 'core:sample_start': '9007199254740993', 'core:sample_count': '4096', 'core:label': 'Signal', 'example:confidence': 0.75 } };
    const s = reduceAnnotations(undefined, { ...snapshot(), items: [item] });
    expect([...s.items.values()][0]).toEqual(item);
  });
});
