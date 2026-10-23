import { buildApiUrl } from '../src/lib/api/client';

// Synthetic integration uses production bindings, reducers and both plot adapters.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlotPanel } from '../src/features/application/plotting/components/plot-panel';
import { resolveCurrentSessionStudioBindingView } from '../src/features/runtime-session/model/runtime-binding-resolution';
import { endSessionAnnotations } from '../src/features/application/plotting/runtime/annotation-subscription';


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
import { TablePanel } from '../src/features/application/plotting/components/table-panel';
import { endSessionTables } from '../src/features/application/plotting/runtime/table-subscription';
import { selectAnnotation } from '../src/features/application/plotting/runtime/annotation-subscription';
import { reduceTables } from '../src/features/application/plotting/runtime/table-reducer';
const tableBinding = bind('gr::studio::StudioTableSink<float64>', 'tables0', 'websocket');
const stressId = new URLSearchParams(location.search).get('stress');
const stressSession = stressId ? await (await fetch(`/api/sessions/${stressId}`)).json() : undefined;
const stressStream = stressSession?.streams.find((s: { payload_format: string }) => s.payload_format === 'table-updates-json-v1');
Object.assign(window, { streamReduce: reduceTables, streamSelect: selectAnnotation });
function Demo() {
 const [state, setState] = useState<'running' | 'stopped'>('running');
 const [stress, setStress] = useState(false), [hidden, setHidden] = useState(false);
 Object.assign(window, { streamStress: setStress, streamHidden: setHidden });
 return <main style={{height:'100vh',background:'#020617',padding:12,display:'grid',gridTemplateRows:'28px minmax(0, .8fr) minmax(0, 1fr) minmax(0, 1fr)',gap:8}}>
 <div className="text-xs text-cyan-100">Typed persistent table · independent annotation/table timing · unknown RF time
 <button id="stop-execution" onClick={async()=>{await fetch(`/api/sessions/${id}/stop`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});endSessionAnnotations(id);endSessionTables(id);setState('stopped');}}>Stop execution</button></div>
 <section id="spectrum" style={{minHeight:0}}><PlotPanel spec={spectrum} binding={spectrumBinding} annotationBindings={bindings} executionState={state}/></section>
 <section id="waterfall" style={{minHeight:0}}><PlotPanel spec={waterfall} binding={waterfallBinding} annotationBindings={bindings} executionState={state}/></section>
 <section id="table" style={{minHeight:0,display:hidden?'none':undefined}}><TablePanel binding={tableBinding} sessionId={id}/></section>
 {stress && stressStream ? <div id="stress" style={{position:'fixed',inset:20,background:'#020617',zIndex:100}}><TablePanel binding={{status:'configured',transport:'websocket',endpoint:buildApiUrl(stressStream.path)}} sessionId={stressId!}/></div>:null}
 </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Demo/></React.StrictMode>);
