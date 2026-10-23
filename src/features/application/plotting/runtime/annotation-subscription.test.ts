import { expect, it, vi } from 'vitest';
const connections = vi.hoisted(() => [] as { options: { onMessage: (p: unknown) => void; onConnectionState: (s: string) => void }; stop: ReturnType<typeof vi.fn> }[]);
vi.mock('./json-websocket-runtime', () => ({ createJsonWebSocketSubscription: (options: typeof connections[number]['options']) => { const c = { options, stop: vi.fn() }; connections.push(c); return c.stop; } }));
import { subscribeAnnotations, endSessionAnnotations, retryAnnotations } from './annotation-subscription';
const snapshot = { payload_format: 'plot-annotations-json-v1', scope: { run_namespace: 'run', producer_instance: 'p' }, stream_epoch: 'e', cursor: '0', message: 'snapshot', items: [], tombstones: [], retention: { max_items: 10000, max_bytes: 33554432, evicted_items: '0', dropped_updates: '0' } };
it('shares one network stream across plots and preserves independent subscriber lifecycles', () => {
  connections.length = 0;
  const one = vi.fn(), two = vi.fn();
  const stop1 = subscribeAnnotations('ws://shared', one, 'session'), stop2 = subscribeAnnotations('ws://shared', two, 'session');
  expect(connections).toHaveLength(1);connections[0].options.onMessage(snapshot);
  expect(one.mock.lastCall?.[0]).toEqual(two.mock.lastCall?.[0]);
  stop1();expect(connections[0].stop).not.toHaveBeenCalled();
  const { items: _items, tombstones: _dead, ...envelope } = snapshot;
  connections[0].options.onMessage({ ...envelope, message: 'delta', cursor: '1', base_cursor: '0', events: [], evicted_ids: [] });
  expect(two.mock.lastCall?.[0].cursor).toBe('1');retryAnnotations('ws://shared');expect(connections).toHaveLength(2);expect(connections[0].stop).toHaveBeenCalledOnce();connections[1].options.onMessage(snapshot);stop2();expect(connections[1].stop).toHaveBeenCalledOnce();
});
it('separates sources, reconstructs reconnect snapshots and keeps incomplete stop cache', () => {
  connections.length = 0;
  const listener = vi.fn();const stop = subscribeAnnotations('ws://a', listener, 'ended-session');
  const stopB = subscribeAnnotations('ws://b', vi.fn(), 'other-session');expect(connections).toHaveLength(2);
  connections[0].options.onMessage(snapshot);connections[0].options.onConnectionState('reconnecting');
  expect(() => connections[0].options.onMessage({ ...snapshot, message: 'delta' })).toThrow();
  connections[0].options.onMessage({ ...snapshot, stream_epoch: 'new', cursor: '50' });expect(listener.mock.lastCall?.[0].epoch).toBe('new');
  endSessionAnnotations('ended-session');expect(listener.mock.lastCall?.[0].executionEnded).toBe(true);expect(listener.mock.lastCall?.[0].finalizationStatus).toBe('unavailable');
  expect(connections[0].stop).toHaveBeenCalled();expect(connections[1].stop).not.toHaveBeenCalled();stop();stopB();
});
