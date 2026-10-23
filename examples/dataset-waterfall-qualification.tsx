// Deterministic browser qualification harness using the production managed binding and plot panel.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PlotPanel } from '../src/features/application/plotting/components/plot-panel';
import { resolveCurrentSessionStudioBindingView } from '../src/features/runtime-session/model/runtime-binding-resolution';
import type { SessionRecord } from '../src/lib/api/sessionsApi';
import '../src/styles/index.css';

const id = new URLSearchParams(location.search).get('session');
const raw = await (await fetch(`/api/sessions/${id}`)).json();
const session: SessionRecord = { id:raw.id,name:raw.name,state:raw.state,createdAt:raw.created_at,updatedAt:raw.updated_at,lastError:raw.last_error,
  streams:raw.streams.map((s:Record<string,unknown>)=>({id:s.id,blockInstanceName:s.block_instance_name,transport:s.transport,payloadFormat:s.payload_format,path:s.path,ready:s.ready})) };
const binding = resolveCurrentSessionStudioBindingView({ blockTypeId:'gr::studio::StudioDataSetWaterfallSink<float64>',nodeInstanceId:'waterfall0',parameterValues:{transport:'websocket'},session });
const spec = { panelId:'qualification',kind:'waterfall' as const,source:{sinkId:'waterfall0',payloadFormat:'dataset-waterfall-json-v1' as const},view:{kind:'waterfall' as const,title:'Dataset waterfall · synthetic 6817 bins',xMode:'frequency' as const,streaming:true} };
createRoot(document.getElementById('root')!).render(<React.StrictMode><main style={{height:'100vh',width:'100vw',padding:20,background:'#020617'}}><PlotPanel spec={spec} binding={binding} executionState="running" /></main></React.StrictMode>);
