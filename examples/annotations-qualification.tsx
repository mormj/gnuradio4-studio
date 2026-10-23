import { buildApiUrl } from '../src/lib/api/client';
import { AnnotationOverlay } from '../src/features/application/plotting/runtime/annotation-overlay';
// Synthetic integration uses production bindings, reducers and both plot adapters.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlotPanel } from '../src/features/application/plotting/components/plot-panel';
import { resolveCurrentSessionStudioBindingView } from '../src/features/runtime-session/model/runtime-binding-resolution';
import { endSessionAnnotations } from '../src/features/application/plotting/runtime/annotation-subscription';
import { reduceAnnotations, type AnnotationState } from '../src/features/application/plotting/runtime/annotation-registry';
import { visibleAnnotationBoxes } from '../src/features/application/plotting/runtime/annotation-projection';
import type { SessionRecord } from '../src/lib/api/sessionsApi';
import type { PlotPanelSpec } from '../src/features/application/plotting/model/types';
import '../src/styles/index.css';
const id = new URLSearchParams(location.search).get('session')!;
const raw = await (await fetch(`/api/sessions/${id}`)).json();
const session: SessionRecord = { id: raw.id, name: raw.name, state: raw.state, createdAt: raw.created_at, updatedAt: raw.updated_at, lastError: raw.last_error,
  streams: raw.streams.map((s: Record<string, unknown>) => ({ id: s.id, blockInstanceName: s.block_instance_name, transport: s.transport, payloadFormat: s.payload_format, path: s.path, ready: s.ready })) };
const annotation = session.streams!.find(s => s.payloadFormat === 'plot-annotations-json-v1')!;
const bindings = [{ sinkId: 'annotations0', endpoint: buildApiUrl(annotation.path), sessionId: id }];
const sources: PlotPanelSpec['annotationSources'] = [{ sinkId: 'annotations0', payloadFormat: 'plot-annotations-json-v1' }];
const bind = (type: string, node: string, transport: string) => resolveCurrentSessionStudioBindingView({ blockTypeId: type, nodeInstanceId: node, parameterValues: { transport, endpoint: 'http://127.0.0.1:18084/snapshot' }, session });
const spectrumBinding = bind('gr::studio::StudioDataSetSink<float64>', 'spectrum0', 'http_poll');
const waterfallBinding = bind('gr::studio::StudioDataSetWaterfallSink<float64>', 'waterfall0', 'websocket');
const spectrum: PlotPanelSpec = { panelId: 'spectrum', kind: 'timeseries', source: { sinkId: 'spectrum0', payloadFormat: 'dataset-xy-json-v1' }, annotationSources: sources, view: { kind: 'timeseries', title: 'Synthetic spectrum', xMode: 'frequency', windowSize: -1 } };
const waterfall: PlotPanelSpec = { panelId: 'waterfall', kind: 'waterfall', source: { sinkId: 'waterfall0', payloadFormat: 'dataset-waterfall-json-v1' }, annotationSources: sources, view: { kind: 'waterfall', title: 'Synthetic observation waterfall', xMode: 'frequency' } };
// Expose only pure production functions for deterministic browser profiling.
Object.assign(window, { streamReduce: reduceAnnotations, streamProject: visibleAnnotationBoxes });
function Demo() {
  const [stressState, setStress] = useState<AnnotationState>();
  Object.assign(window, { streamStress: (payload: unknown) => setStress(payload ? reduceAnnotations(undefined, payload) : undefined), streamStressDelta: (payload: unknown) => setStress(s => reduceAnnotations(s, payload)) });
  const stressItems = stressState ? [...stressState.items.values()].map(a => ({ key: a.annotation_id, annotation: a })) : [];
  const [state, setState] = useState<'running' | 'stopped'>('running');
  return <main style={{ height: '100vh', background: '#020617', padding: 12, display: 'grid', gridTemplateRows: '28px minmax(0, 1fr) minmax(0, 1.3fr)', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 }}>
    <div className="text-xs text-cyan-100">Synthetic annotations: one stream shared across XY and waterfall. Unknown RF time.
      <button id="stop-execution" onClick={async () => { await fetch(`/api/sessions/${id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); endSessionAnnotations(id); setState('stopped'); }}>Stop execution</button>
    </div>
    <section id="spectrum" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}><PlotPanel spec={spectrum} binding={spectrumBinding} annotationBindings={bindings} executionState={state} /></section>
    <section id="waterfall" style={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}><PlotPanel spec={waterfall} binding={waterfallBinding} annotationBindings={bindings} executionState={state} /></section>
    {stressState ? <div id="stress" style={{ position: 'fixed', inset: 20, background: '#020617', zIndex: 100 }}><AnnotationOverlay items={stressItems} retained={stressItems.length} boxes={visibleAnnotationBoxes(stressItems, 1200, 700, hz => (hz - 902000000) / 850 * 1200)} /></div> : null}
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Demo /></React.StrictMode>);
