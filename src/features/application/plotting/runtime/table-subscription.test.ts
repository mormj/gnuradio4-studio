import { expect, it, vi } from 'vitest';
const connections = vi.hoisted(() => [] as { options: { onMessage: (p: unknown) => void; onConnectionState: (s: string) => void }; stop: ReturnType<typeof vi.fn> }[]);
vi.mock('./json-websocket-runtime', () => ({ createJsonWebSocketSubscription: (options: typeof connections[number]['options']) => { const c = { options, stop: vi.fn() }; connections.push(c); return c.stop; } }));
import { subscribeTables, endSessionTables, retryTables } from './table-subscription';
const snapshot = { payload_format: 'table-updates-json-v1', scope: { run_namespace: 'run', producer_instance: 'p' }, stream_epoch: 'e', cursor: '0', message: 'snapshot', columns: [], rows: [], tombstones: [], retention: { max_items: 10000, max_bytes: 33554432, evicted_items: '0', dropped_updates: '0' } };
it('shares one network stream across plots and preserves independent subscriber lifecycles', () => {
  connections.length = 0;
  const one = vi.fn(), two = vi.fn();
  const stop1 = subscribeTables('ws://shared', one, 'session'), stop2 = subscribeTables('ws://shared', two, 'session');
  expect(connections).toHaveLength(1);connections[0].options.onMessage(snapshot);
  expect(one.mock.lastCall?.[0]).toEqual(two.mock.lastCall?.[0]);
  stop1();expect(connections[0].stop).not.toHaveBeenCalled();
  const { columns: _columns, rows: _rows, tombstones: _dead, ...envelope } = snapshot;
  connections[0].options.onMessage({ ...envelope, message: 'delta', cursor: '1', base_cursor: '0', events: [], evicted_ids: [] });
  expect(two.mock.lastCall?.[0].cursor).toBe('1');retryTables('ws://shared');expect(connections).toHaveLength(2);expect(connections[0].stop).toHaveBeenCalledOnce();connections[1].options.onMessage(snapshot);stop2();expect(connections[1].stop).not.toHaveBeenCalled();connections[1].options.onMessage({ ...snapshot, cursor: '2' });const again = vi.fn();subscribeTables('ws://shared', again, 'session')();expect(again.mock.lastCall?.[0].cursor).toBe('2');endSessionTables('session');expect(connections[1].stop).toHaveBeenCalledOnce();
});
it('separates sources, reconstructs reconnect snapshots and keeps incomplete stop cache', () => {
  connections.length = 0;
  const listener = vi.fn();const stop = subscribeTables('ws://a', listener, 'ended-session');
  const stopB = subscribeTables('ws://b', vi.fn(), 'other-session');expect(connections).toHaveLength(2);
  connections[0].options.onMessage(snapshot);connections[0].options.onConnectionState('reconnecting');
  expect(() => connections[0].options.onMessage({ ...snapshot, message: 'delta' })).toThrow();
  connections[0].options.onMessage({ ...snapshot, stream_epoch: 'new', cursor: '50' });expect(listener.mock.lastCall?.[0].epoch).toBe('new');
  endSessionTables('ended-session');expect(listener.mock.lastCall?.[0].executionEnded).toBe(true);expect(listener.mock.lastCall?.[0].finalizationStatus).toBe('unavailable');
  expect(connections[0].stop).toHaveBeenCalled();expect(connections[1].stop).not.toHaveBeenCalled();stop();stopB();
});
