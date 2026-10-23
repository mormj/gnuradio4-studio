import { describe, it, expect } from 'vitest';
import { reduceDatasetWaterfall, datasetWaterfallImage, frameKeyId } from './dataset-waterfall-frame';
import { lookupStudioKnownBlockBinding } from '../../../graph-editor/runtime/known-block-bindings';
import { isDescriptorBasedBindingFamily } from '../../../graph-editor/runtime/studio-managed-runtime-authoring';

function row(n = 421, seq = '9007199254740993') {
  return { frame_key: { run_namespace: 'run', source_id: 'synthetic', acquisition_id: 'task', source_epoch: 'run', sequence: seq }, grid_id: 'grid', power: Array.from({length:n}, (_,i) => -100 + i % 21), timestamp: {unix_ns: null, provenance: 'device_unzoned', raw_text: '2026-10-20T12:34:56'}, validity: 'schema_valid', coverage: 'reported_bin_vector', discontinuities: [] as string[] };
}
function snapshot(n = 421) {
  return { payload_format: 'dataset-waterfall-json-v1', scope: {run_namespace:'run',producer_instance:'sink'}, stream_epoch:'epoch',cursor:'1',message:'snapshot', retention:{max_items:256,max_bytes:67108864,evicted_items:'0',dropped_updates:'0'}, grids:[{grid_id:'grid',coordinates:Array.from({length:n},(_,i)=>902000000.1234567 + i * 0.125),axis:'frequency',unit:'Hz',coordinate_model:'uniform_inclusive_actual_endpoints',power_unit:'dBm'}], rows:[row(n)] };
}
function delta(seq = '9007199254740994') {
  return { ...snapshot(), grids: undefined, message:'delta',base_cursor:'1',cursor:'2',rows:[row(421,seq)],evicted_frame_keys:[] as ReturnType<typeof row>['frame_key'][] };
}
function cleanDelta(seq?: string) { const {grids: _grids, ...d} = delta(seq); void _grids; return d; }

describe('dataset waterfall transactions', () => {
  for (const n of [421,4096,6817,8192]) it(`preserves all ${n} points, exact coordinates, power and row identity`, () => {
    const input=snapshot(n), state=reduceDatasetWaterfall(undefined,input), image=datasetWaterfallImage(state);
    expect(Array.from(image.xAxis!)).toEqual(input.grids[0].coordinates);
    expect(Array.from(image.values)).toEqual(input.rows[0].power);
    expect(image.rowKeys![0].sequence).toBe('9007199254740993');
    expect(image.rowTimestamps![0].unix_ns).toBeNull();expect(image.timeSpan).toBeUndefined();expect(image.observationAxis).toBe(true);
    expect(image.rowTimestamps![0].raw_text).toBe('2026-10-20T12:34:56');
  });
  it('replaces empty and reconnect snapshots, including a new epoch with lower cursor', () => {
    const input=snapshot();input.grids=[];input.rows=[];input.cursor='0';
    const empty=reduceDatasetWaterfall(undefined,input);expect(empty.rows).toHaveLength(0);
    const state=reduceDatasetWaterfall(empty,snapshot());
    input.stream_epoch='new';expect(reduceDatasetWaterfall(state,input).rows).toHaveLength(0);
  });
  it('reduces every delta before painting, including while the view is paused', () => {
    let state=reduceDatasetWaterfall(undefined,snapshot());
    for(let i=0;i<20;i++) { const d=cleanDelta(String(9007199254740994n+BigInt(i)));d.base_cursor=state.cursor;d.cursor=String(BigInt(state.cursor)+1n);state=reduceDatasetWaterfall(state,d); }
    const image=datasetWaterfallImage(state);expect(image.height).toBe(21);expect(image.rowKeys![0].sequence).toBe('9007199254741013');
    expect(new Set(image.rowKeys!.map(frameKeyId)).size).toBe(21);
  });
  it('applies explicit evictions and reports gaps without adding fabricated rows', () => {
    const initial=reduceDatasetWaterfall(undefined,snapshot());const d=cleanDelta('9007199254740995');
    d.rows[0].discontinuities=['source_sequence_gap'];d.evicted_frame_keys=[initial.rows[0].frame_key];d.retention.evicted_items='1';
    expect(reduceDatasetWaterfall(initial,d).rows).toHaveLength(1);
  });
  it('requires a snapshot after epoch, base, scope or partition mismatch', () => {
    const initial=reduceDatasetWaterfall(undefined,snapshot());
    for (const mutate of [(d:ReturnType<typeof cleanDelta>)=>{d.base_cursor='0';},(d:ReturnType<typeof cleanDelta>)=>{d.stream_epoch='new';},(d:ReturnType<typeof cleanDelta>)=>{d.rows[0].frame_key.acquisition_id='new';}]) {
      const d=cleanDelta();mutate(d);expect(()=>reduceDatasetWaterfall(initial,d)).toThrow();expect(initial.rows).toHaveLength(1);
    }
    expect(()=>reduceDatasetWaterfall(undefined,cleanDelta())).toThrow();
  });
  it('rejects invalid shape, nonfinite values, bad units, irregular grids and inexact identifiers atomically', () => {
    const mutations:((p:ReturnType<typeof snapshot>)=>void)[]=[p=>{p.rows[0].power.pop();},p=>{p.rows[0].power[0]=NaN;},p=>{p.grids[0].coordinates[0]=Infinity;},p=>{p.grids[0].unit='kHz';},p=>{p.grids[0].coordinates[2]+=0.01;},p=>{p.rows[0].frame_key.sequence='01';},p=>{p.rows[0].frame_key.sequence='18446744073709551616';},p=>{p.rows.push(p.rows[0]);}];
    for (const mutate of mutations) { const p=snapshot();mutate(p);expect(()=>reduceDatasetWaterfall(undefined,p)).toThrow(); }
  });
  it('rejects duplicates, conflicts, unreported sequence gaps, and nonexistent evictions', () => {
    const initial=reduceDatasetWaterfall(undefined,snapshot());
    for(const seq of ['9007199254740993','9007199254740992','9007199254740995'])expect(()=>reduceDatasetWaterfall(initial,cleanDelta(seq))).toThrow();
    const d=cleanDelta();d.evicted_frame_keys=[row(421,'1').frame_key];expect(()=>reduceDatasetWaterfall(initial,d)).toThrow();
  });
  it('uses exact reflected binding and managed descriptors', () => {
    const id='gr::studio::StudioDataSetWaterfallSink<float64>';
    expect(lookupStudioKnownBlockBinding(id)?.payloadFormat).toBe('dataset-waterfall-json-v1');expect(isDescriptorBasedBindingFamily(id)).toBe(true);
    expect(lookupStudioKnownBlockBinding('gr::studio::StudioDataSetWaterfallSink<float32>')).toBeNull();
  });
});


describe('annotations carried by the waterfall data interface', () => {
  function annotationSnapshot() {
    const first = row().frame_key;
    return { payload_format: 'plot-annotations-json-v1', message: 'snapshot',
      scope: { run_namespace: 'run', producer_instance: 'any-native-producer' }, stream_epoch: 'annotations-epoch', cursor: '1',
      retention: { max_items: 10000, max_bytes: 16777216, evicted_items: '0', dropped_updates: '0' }, tombstones: [],
      items: [{ annotation_id: 'source-supplied-id', revision: '9007199254740993', label: 'Sender label',
        geometry: { kind: 'rectangle', x_min: 902000010, x_max: 902000020 }, x_axis: { kind: 'frequency', unit: 'Hz' },
        y_axis: { kind: 'observation', first, last: first } }],
    };
  }
  it('renders sender-supplied content from one connection without pane annotationSources', () => {
    const state = reduceDatasetWaterfall(undefined, { ...snapshot(), annotations: annotationSnapshot() });
    const image = datasetWaterfallImage(state);
    expect(image.annotations).toHaveLength(1);
    expect(image.annotations![0].annotation.label).toBe('Sender label');
    expect(image.annotations![0].annotation.revision).toBe('9007199254740993');
  });
  it('applies annotation-only updates atomically and retains them across measurement deltas', () => {
    const initial = reduceDatasetWaterfall(undefined, { ...snapshot(), annotations: annotationSnapshot() });
    const deletion = { ...annotationSnapshot(), message: 'delta', base_cursor: '1', cursor: '2',
      events: [{ operation: 'delete', annotation_id: 'source-supplied-id', revision: '9007199254740994' }], evicted_ids: [] };
    const { items: _items, tombstones: _tombstones, ...deltaAnnotations } = deletion;void _items;void _tombstones;
    const state = reduceDatasetWaterfall(initial, { ...cleanDelta(), rows: [], annotations: deltaAnnotations });
    expect(state.rows).toHaveLength(1);expect(state.annotations!.items.size).toBe(0);
    expect(initial.annotations!.items.size).toBe(1);
    const after = reduceDatasetWaterfall(state, { ...cleanDelta(), base_cursor: '2', cursor: '3' });
    expect(after.annotations!.cursor).toBe('2');
    expect(() => reduceDatasetWaterfall(initial, { ...cleanDelta(), annotations: { ...deltaAnnotations, base_cursor: '999' } })).toThrow();
    expect(initial.rows).toHaveLength(1);expect(initial.annotations!.items.size).toBe(1);
  });
  it('restores both histories on reconnect and clears overlays when a new snapshot omits them', () => {
    const first = reduceDatasetWaterfall(undefined, { ...snapshot(), annotations: annotationSnapshot() });
    const restored = reduceDatasetWaterfall(first, { ...snapshot(), annotations: annotationSnapshot() });
    expect(restored.annotations!.items.size).toBe(1);
    expect(reduceDatasetWaterfall(restored, snapshot()).annotations).toBeUndefined();
  });
});


describe('waterfall annotation capacity diagnostics', () => {
  it('preserves exact loss counters from the producer data interface', () => {
    const state = reduceDatasetWaterfall(undefined, { ...snapshot(), annotations: {
      payload_format: 'plot-annotations-json-v1', message: 'snapshot', scope: {run_namespace:'run',producer_instance:'annotations'},
      stream_epoch:'annotations', cursor:'1', items:[], tombstones:[],
      retention:{max_items:10000,max_bytes:67108864,evicted_items:'9007199254740993',dropped_updates:'0',capacity_evicted_items:'9007199254740993'},
    }});
    expect(datasetWaterfallImage(state).annotationCapacityEvictions).toBe('9007199254740993');
    const invalid = { payload_format:'plot-annotations-json-v1',message:'delta',scope:state.annotations!.scope,
      stream_epoch:'annotations',base_cursor:'1',cursor:'2',events:[],evicted_ids:[],
      retention:{...state.annotations!.retention,capacity_evicted_items:'9007199254740992'}};
    expect(() => reduceDatasetWaterfall(state,{...cleanDelta(),rows:[],annotations:invalid})).toThrow();
    invalid.retention.capacity_evicted_items='9007199254740994';
    expect(() => reduceDatasetWaterfall(state,{...cleanDelta(),rows:[],annotations:invalid})).toThrow();
  });
  it('supports legacy annotation streams without the optional capacity counter', () => {
    expect(datasetWaterfallImage(reduceDatasetWaterfall(undefined,snapshot())).annotationCapacityEvictions).toBe('0');
  });
});
