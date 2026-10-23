import { endAnnotationExecution } from './annotation-registry';
import { awaitTerminalCursor } from './terminal-stream-cursor';
import { createJsonWebSocketSubscription } from './json-websocket-runtime';
import { reduceDatasetWaterfall, type DatasetWaterfallState, WaterfallResyncRequired } from './dataset-waterfall-frame';

type Listener = (state: DatasetWaterfallState | undefined, status: string) => void;
type Entry = { state?: DatasetWaterfallState; status: string; listeners: Set<Listener>; stop?: () => void; needsSnapshot: boolean; retry?: () => void; ended?: boolean };
// One reducer/subscription per managed execution endpoint, shared by plot views.
const streams = new Map<string, Entry>();
export function subscribeDatasetWaterfall(endpoint: string, listener: Listener): () => void {
  let entry = streams.get(endpoint);
  if (!entry) {
    entry = { status: 'Connecting dataset waterfall', listeners: new Set(), needsSnapshot: true };
    streams.set(endpoint, entry);
  }
  const e = entry;
  e.listeners.add(listener);
  const notify = () => e.listeners.forEach(l => l(e.state, e.status));
  const connect = () => {
    if(e.ended)return;
    e.needsSnapshot = true;
    e.stop = createJsonWebSocketSubscription({ endpoint, maxMessageBytes: 128 * 1024 * 1024, resyncOnError: true,
      onMessage: payload => {
        try {
          if (e.needsSnapshot && (payload as { message?: string })?.message !== 'snapshot') throw new WaterfallResyncRequired('Expected initial snapshot');
          e.state = reduceDatasetWaterfall(e.needsSnapshot ? undefined : e.state, payload);
          e.needsSnapshot = false;
          e.status = `Observation sequence · evicted ${e.state.retention.evicted_items} · rejected ${e.state.retention.dropped_updates}`;
          notify();
        } catch (error) { e.needsSnapshot = true; e.status = 'Stale dataset waterfall; resynchronizing'; notify(); throw error; }
      },
      onConnectionState: (state, message) => {
        if (state !== 'open') { e.needsSnapshot = true; e.status = `Stale dataset waterfall · ${message ?? state}`; notify(); }
      },
    });
  };
  e.retry = () => { e.stop?.(); e.stop = undefined; connect(); };
  if (!e.stop) connect();
  listener(e.state, e.status);
  return () => {
    e.listeners.delete(listener);
    if (!e.listeners.size) { e.stop?.(); e.stop = undefined; streams.delete(endpoint); }
  };
}

export function retryDatasetWaterfall(endpoint: string): void { streams.get(endpoint)?.retry?.(); }

export const awaitDatasetWaterfallCursor = (endpoint: string, cursor: string) => awaitTerminalCursor(streams.get(endpoint), cursor);

export function endDatasetWaterfall(endpoint: string, complete: boolean): void {
  const e=streams.get(endpoint);if(!e)return;
  e.ended=true;e.stop?.();e.stop=undefined;
  if(e.state?.annotations)e.state={...e.state,annotations:endAnnotationExecution(e.state.annotations)};
  e.status=complete?'Execution ended · stream reconciled':'Execution ended · stream reconciliation incomplete';
  e.listeners.forEach(l=>l(e.state,e.status));
}
