import { awaitTerminalCursor } from './terminal-stream-cursor';
import { createJsonWebSocketSubscription } from './json-websocket-runtime';
import { endTableExecution, reduceTables, type TableState } from './table-reducer';

type Listener = (state: TableState | undefined, status: string) => void;
type Entry = { state?: TableState; status: string; listeners: Set<Listener>; stop?: () => void; needsSnapshot: boolean; sessionId?: string; ended?: boolean; retry?: () => void };
const streams = new Map<string, Entry>();
// Ended caches are bounded separately from each producer's retained set.
function prune() {
  const idle = [...streams].filter(([, e]) => !e.listeners.size);
  for (const [key] of idle.slice(0, Math.max(0, idle.length - 8))) { const e = streams.get(key); e?.stop?.(); streams.delete(key); }
}
export function subscribeTables(endpoint: string, listener: Listener, sessionId?: string): () => void {
  let e = streams.get(endpoint);
  if (!e) { e = { status: 'Connecting tables', listeners: new Set(), needsSnapshot: true, sessionId }; streams.set(endpoint, e); }
  const entry = e;
  entry.listeners.add(listener);
  const notify = () => entry.listeners.forEach(l => l(entry.state, entry.status));
  const connect = () => {
    if (entry.ended || entry.state?.executionEnded) return;
    entry.needsSnapshot = true;
    entry.stop = createJsonWebSocketSubscription({ endpoint, maxMessageBytes: 128 * 1024 * 1024, resyncOnError: true,
      onMessage: payload => {
        try {
          if (entry.needsSnapshot && (payload as { message?: string })?.message !== 'snapshot') throw new Error('Expected table snapshot');
          entry.state = reduceTables(entry.needsSnapshot ? undefined : entry.state, payload);
          entry.needsSnapshot = false;
          entry.status = `${entry.state.items.size} rows · evicted ${entry.state.retention.evicted_items} · rejected ${entry.state.retention.dropped_updates}`;
          notify();
        } catch (error) { entry.needsSnapshot = true; entry.status = 'Stale tables · resynchronizing'; if (entry.state) entry.state = { ...entry.state, incomplete: true }; notify(); throw error; }
      },
      onConnectionState: (state, message) => { if (state !== 'open') { entry.needsSnapshot = true; entry.status = `Stale tables · ${message ?? state}`; notify(); } },
    });
  };
  entry.retry = () => { entry.stop?.(); entry.stop = undefined; connect(); };
  if (!entry.stop && !entry.ended && !entry.state?.executionEnded) connect();
  listener(entry.state, entry.status);
  return () => { entry.listeners.delete(listener); if (!entry.listeners.size) { prune(); } };
}
export function endSessionTables(sessionId: string, complete = true): void {
  for (const e of streams.values()) if (e.sessionId === sessionId) {
    e.ended = true; e.stop?.(); e.stop = undefined;
    if (e.state) e.state = endTableExecution(e.state);
    if(!complete && e.state)e.state={...e.state,incomplete:true};
    e.status = complete?'Execution ended · finalization unavailable':'Execution ended · stream reconciliation incomplete · finalization unavailable';
    e.listeners.forEach(l => l(e.state, e.status));
  }
  prune();
}
export function retryTables(endpoint: string): void { streams.get(endpoint)?.retry?.(); }

export const awaitTablesCursor = (endpoint: string, cursor: string) => awaitTerminalCursor(streams.get(endpoint), cursor);
