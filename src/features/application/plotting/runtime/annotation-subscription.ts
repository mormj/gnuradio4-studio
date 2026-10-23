import { awaitTerminalCursor } from './terminal-stream-cursor';
import { createJsonWebSocketSubscription } from './json-websocket-runtime';
import { endAnnotationExecution, reduceAnnotations, type AnnotationState } from './annotation-registry';

type Listener = (state: AnnotationState | undefined, status: string) => void;
type Entry = { state?: AnnotationState; status: string; listeners: Set<Listener>; stop?: () => void; needsSnapshot: boolean; sessionId?: string; ended?: boolean; retry?: () => void };
const streams = new Map<string, Entry>();
// Ended caches are bounded separately from each producer's retained set.
function prune() {
  const idle = [...streams].filter(([, e]) => !e.listeners.size && !e.stop);
  for (const [key] of idle.slice(0, Math.max(0, idle.length - 8))) streams.delete(key);
}
export function subscribeAnnotations(endpoint: string, listener: Listener, sessionId?: string): () => void {
  let e = streams.get(endpoint);
  if (!e) { e = { status: 'Connecting annotations', listeners: new Set(), needsSnapshot: true, sessionId }; streams.set(endpoint, e); }
  const entry = e;
  entry.listeners.add(listener);
  const notify = () => entry.listeners.forEach(l => l(entry.state, entry.status));
  const connect = () => {
    if (entry.ended || entry.state?.executionEnded) return;
    entry.needsSnapshot = true;
    entry.stop = createJsonWebSocketSubscription({ endpoint, maxMessageBytes: 128 * 1024 * 1024, resyncOnError: true,
      onMessage: payload => {
        try {
          if (entry.needsSnapshot && (payload as { message?: string })?.message !== 'snapshot') throw new Error('Expected annotation snapshot');
          const oldState = entry.state;
          entry.state = reduceAnnotations(entry.needsSnapshot ? undefined : entry.state, payload);
          if (selected && oldState) {
            const [run, id] = JSON.parse(selected) as [string, string];
            if (run === oldState.scope.run_namespace && oldState.items.has(id) && (entry.state.scope.run_namespace !== run || !entry.state.items.has(id))) selectAnnotation(undefined);
          }
          entry.needsSnapshot = false;
          entry.status = `${entry.state.items.size} annotations · evicted ${entry.state.retention.evicted_items} · rejected ${entry.state.retention.dropped_updates}`;
          notify();
        } catch (error) { entry.needsSnapshot = true; entry.status = 'Stale annotations · resynchronizing'; if (entry.state) entry.state = { ...entry.state, incomplete: true }; notify(); throw error; }
      },
      onConnectionState: (state, message) => { if (state !== 'open') { entry.needsSnapshot = true; entry.status = `Stale annotations · ${message ?? state}`; notify(); } },
    });
  };
  entry.retry = () => { entry.stop?.(); entry.stop = undefined; connect(); };
  if (!entry.stop && !entry.ended && !entry.state?.executionEnded) connect();
  listener(entry.state, entry.status);
  return () => { entry.listeners.delete(listener); if (!entry.listeners.size) { entry.stop?.(); entry.stop = undefined; prune(); } };
}
export function endSessionAnnotations(sessionId: string, complete = true): void {
  for (const e of streams.values()) if (e.sessionId === sessionId) {
    e.ended = true; e.stop?.(); e.stop = undefined;
    if (e.state) e.state = endAnnotationExecution(e.state);
    if(!complete && e.state)e.state={...e.state,incomplete:true};
    e.status = complete?'Execution ended · finalization unavailable':'Execution ended · stream reconciliation incomplete · finalization unavailable';
    e.listeners.forEach(l => l(e.state, e.status));
  }
  prune();
}
// Selection is presentation state; no runtime commands. Composite IDs remain opaque.
let selected: string | undefined;
const selections = new Set<(id?: string) => void>();
export function selectAnnotation(id?: string) { selected = id; selections.forEach(l => l(id)); }
export function subscribeAnnotationSelection(listener: (id?: string) => void) { selections.add(listener); listener(selected); return () => { selections.delete(listener); }; }

export function retryAnnotations(endpoint: string): void { streams.get(endpoint)?.retry?.(); }

export const awaitAnnotationsCursor = (endpoint: string, cursor: string) => awaitTerminalCursor(streams.get(endpoint), cursor);
