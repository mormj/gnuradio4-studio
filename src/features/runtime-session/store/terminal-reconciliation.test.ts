import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../../lib/api/sessionsApi', () => ({
  createSession: vi.fn(), deleteSession: vi.fn(), getSession: vi.fn(),
  listSessions: vi.fn(), restartSession: vi.fn(), startSession: vi.fn(), stopSession: vi.fn(),
}));
vi.mock('../../../lib/api/block-settings', () => ({ getBlockSettings: vi.fn() }));
vi.mock('../../application/plotting/runtime/dataset-waterfall-subscription', () => ({
  awaitDatasetWaterfallCursor: vi.fn(), endDatasetWaterfall: vi.fn(),
}));
vi.mock('../../application/plotting/runtime/annotation-subscription', () => ({
  awaitAnnotationsCursor: vi.fn(), endSessionAnnotations: vi.fn(),
}));
vi.mock('../../application/plotting/runtime/table-subscription', () => ({
  awaitTablesCursor: vi.fn(), endSessionTables: vi.fn(),
}));

import { getSession, listSessions, restartSession, stopSession, type SessionRecord } from '../../../lib/api/sessionsApi';
import { getBlockSettings } from '../../../lib/api/block-settings';
import { awaitDatasetWaterfallCursor, endDatasetWaterfall } from '../../application/plotting/runtime/dataset-waterfall-subscription';
import { endSessionAnnotations } from '../../application/plotting/runtime/annotation-subscription';
import { endSessionTables } from '../../application/plotting/runtime/table-subscription';
import { useRuntimeSessionStore as store } from './runtimeSessionStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const old: SessionRecord = {
  id: 'session', name: 'waterfall', state: 'running', executionId: 'session:1',
  lastError: null, createdAt: 'now', updatedAt: 'now',
  streams: [{
    id: 'waterfall', blockInstanceName: 'sink', transport: 'websocket', ready: true,
    payloadFormat: 'dataset-waterfall-json-v1', path: '/sessions/session/streams/waterfall/ws',
  }],
};
const fresh: SessionRecord = { ...old, executionId: 'session:2' };
const terminal: SessionRecord = { ...old, state: 'stopped', completionReason: 'completed' };
const finalSettings = { __gr4cp_terminal: { execution_id: old.executionId! }, publication_cursor: '7' };

beforeEach(() => {
  vi.resetAllMocks();
  store.setState({ activeTabId: null, contextsByTabId: {}, sessions: [] });
  store.getState().ensureTabContext('tab');
  vi.mocked(getSession).mockResolvedValue(old);
  vi.mocked(listSessions).mockResolvedValue([old]);
  vi.mocked(getBlockSettings).mockResolvedValue(finalSettings);
  vi.mocked(awaitDatasetWaterfallCursor).mockResolvedValue(true);
});

it.each(['settings', 'cursor'] as const)('a restart supersedes terminal cleanup waiting for %s', async waitAt => {
  await store.getState().linkSessionToTab('tab', old.id);
  const settings = deferred<Awaited<ReturnType<typeof getBlockSettings>>>();
  const cursor = deferred<boolean>();
  vi.mocked(getBlockSettings).mockReturnValueOnce(settings.promise);
  if (waitAt === 'cursor') vi.mocked(awaitDatasetWaterfallCursor).mockReturnValueOnce(cursor.promise);
  vi.mocked(getSession).mockResolvedValueOnce(terminal);
  const poll = store.getState().pollSessionForTab('tab');
  await vi.waitFor(() => expect(getBlockSettings).toHaveBeenCalledOnce());
  if (waitAt === 'cursor') {
    settings.resolve(finalSettings);
    await vi.waitFor(() => expect(awaitDatasetWaterfallCursor).toHaveBeenCalledOnce());
  }

  vi.mocked(restartSession).mockResolvedValue(fresh);
  vi.mocked(getSession).mockResolvedValue(fresh);
  vi.mocked(listSessions).mockResolvedValue([fresh]);
  await store.getState().restartSessionForTab('tab');
  settings.resolve(finalSettings);
  cursor.resolve(true);
  await poll;

  expect(store.getState().contextsByTabId.tab.session?.executionId).toBe(fresh.executionId);
  expect(endDatasetWaterfall).not.toHaveBeenCalled();
  expect(endSessionAnnotations).not.toHaveBeenCalled();
  expect(endSessionTables).not.toHaveBeenCalled();
});

it('a restart also supersedes terminal cleanup for an unlinked session', async () => {
  store.setState({ sessions: [old] });
  const settings = deferred<Awaited<ReturnType<typeof getBlockSettings>>>();
  vi.mocked(getBlockSettings).mockReturnValueOnce(settings.promise);
  vi.mocked(stopSession).mockResolvedValue(terminal);
  const stop = store.getState().stopSessionById(old.id);
  await vi.waitFor(() => expect(getBlockSettings).toHaveBeenCalledOnce());
  vi.mocked(restartSession).mockResolvedValue(fresh);
  vi.mocked(listSessions).mockResolvedValue([fresh]);
  await store.getState().restartSessionById(old.id);
  settings.resolve(finalSettings);
  await stop;
  expect(endDatasetWaterfall).not.toHaveBeenCalled();
  expect(endSessionAnnotations).not.toHaveBeenCalled();
  expect(endSessionTables).not.toHaveBeenCalled();
});

it('finishes the current terminal execution after its publication cursor drains', async () => {
  await store.getState().linkSessionToTab('tab', old.id);
  vi.mocked(getSession).mockResolvedValueOnce(terminal);
  await store.getState().pollSessionForTab('tab');
  expect(endDatasetWaterfall).toHaveBeenCalledOnce();
  expect(endDatasetWaterfall).toHaveBeenCalledWith(expect.stringContaining('/sessions/session/streams/waterfall/ws'), true);
  expect(store.getState().contextsByTabId.tab.session?.state).toBe('stopped');
});
