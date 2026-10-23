import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/api/sessionsApi', () => ({
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  restartSession: vi.fn(),
  startSession: vi.fn(),
  stopSession: vi.fn(),
}));

import { ApiClientError } from '../../../lib/api/client';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  startSession,
  stopSession,
} from '../../../lib/api/sessionsApi';
import { useRuntimeSessionStore } from './runtimeSessionStore';
import { buildCurrentSessionGraphSubmission } from '../../runtime-submission/model/current-graph-submission';
import * as annotationLifecycle from '../../application/plotting/runtime/annotation-subscription';
import * as tableLifecycle from '../../application/plotting/runtime/table-subscription';

function graphDocument(name: string) {
  return {
    format: 'gr4-studio.graph' as const,
    version: 1 as const,
    metadata: { name },
    graph: {
      nodes: [],
      edges: [],
    },
  };
}

function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetStore() {
  useRuntimeSessionStore.setState({
    activeTabId: null,
    contextsByTabId: {},
    sessions: [],
  });
  useRuntimeSessionStore.getState().ensureTabContext('tab-1');
  useRuntimeSessionStore.getState().setActiveTab('tab-1');
}

function setupDefaultMocks() {
  vi.mocked(listSessions).mockResolvedValue([]);
  vi.mocked(getSession).mockResolvedValue({
    id: 'session-1',
    name: 'demo',
    state: 'running',
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    lastError: null,
  });
}

describe('runtimeSessionStore (sessions-only model)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    setupDefaultMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('ensureTabContext is idempotent for an existing tab context', () => {
    const firstContext = useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    useRuntimeSessionStore.getState().ensureTabContext('tab-1');
    const secondContext = useRuntimeSessionStore.getState().contextsByTabId['tab-1'];

    expect(secondContext).toBe(firstContext);
    expect(Object.keys(useRuntimeSessionStore.getState().contextsByTabId)).toEqual(['tab-1']);
  });

  it('runTab creates and starts a new session for first submission', async () => {
    vi.mocked(createSession).mockResolvedValue({
      id: 'session-1',
      name: 'demo',
      state: 'stopped',
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:00:00.000Z',
      lastError: null,
    });
    vi.mocked(startSession).mockResolvedValue({
      id: 'session-1',
      name: 'demo',
      state: 'running',
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:00:01.000Z',
      lastError: null,
    });

    await useRuntimeSessionStore.getState().runTab('tab-1', graphDocument('Null graph'));

    const context = useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startSession)).toHaveBeenCalledTimes(1);
    expect(context.sessionId).toBe('session-1');
    expect(context.session?.state).toBe('running');
    expect(context.lastSubmittedHash).toBeTruthy();

    const view = useRuntimeSessionStore.getState().getTabRuntimeView('tab-1', 'irrelevant-content');
    expect(view.executionState).toBe('running');
  });

  it('accepts a finite execution that completes before the first start poll', async () => {
    const session={id:'finite-one',name:'finite',state:'stopped' as const,createdAt:'2026-10-21',updatedAt:'2026-10-21',lastError:null};
    vi.mocked(createSession).mockResolvedValue(session);
    const completed={...session,executionId:'finite-one:1',completionReason:'completed'};
    vi.mocked(startSession).mockResolvedValue(completed);vi.mocked(getSession).mockResolvedValue(completed);
    const result=await useRuntimeSessionStore.getState().runTab('tab-1',graphDocument('One frame'));
    expect(result.ok).toBe(true);expect(useRuntimeSessionStore.getState().contextsByTabId['tab-1'].session?.state).toBe('stopped');
    expect(useRuntimeSessionStore.getState().contextsByTabId['tab-1'].lastActionStatus).toBe('success');
    expect(vi.mocked(startSession)).toHaveBeenCalledTimes(1);
  });

  it('rerun unchanged graph reuses linked session and skips createSession', async () => {
    vi.mocked(createSession).mockResolvedValue({
      id: 'session-1',
      name: 'demo',
      state: 'stopped',
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:00:00.000Z',
      lastError: null,
    });
    vi.mocked(startSession).mockResolvedValue({
      id: 'session-1',
      name: 'demo',
      state: 'running',
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:00:01.000Z',
      lastError: null,
    });

    await useRuntimeSessionStore.getState().runTab('tab-1', graphDocument('same graph'));
    vi.mocked(createSession).mockClear();

    await useRuntimeSessionStore.getState().runTab('tab-1', graphDocument('same graph'));

    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    expect(vi.mocked(startSession)).toHaveBeenCalledTimes(1);
  });

  it('rerun changed graph creates replacement session', async () => {
    vi.mocked(createSession)
      .mockResolvedValueOnce({
        id: 'session-1',
        name: 'demo',
        state: 'stopped',
        createdAt: '2026-03-20T00:00:00.000Z',
        updatedAt: '2026-03-20T00:00:00.000Z',
        lastError: null,
      })
      .mockResolvedValueOnce({
        id: 'session-2',
        name: 'demo',
        state: 'stopped',
        createdAt: '2026-03-20T00:00:02.000Z',
        updatedAt: '2026-03-20T00:00:02.000Z',
        lastError: null,
      });

    vi.mocked(startSession)
      .mockResolvedValueOnce({
        id: 'session-1',
        name: 'demo',
        state: 'running',
        createdAt: '2026-03-20T00:00:00.000Z',
        updatedAt: '2026-03-20T00:00:01.000Z',
        lastError: null,
      })
      .mockResolvedValueOnce({
        id: 'session-2',
        name: 'demo',
        state: 'running',
        createdAt: '2026-03-20T00:00:02.000Z',
        updatedAt: '2026-03-20T00:00:03.000Z',
        lastError: null,
      });
    vi.mocked(getSession)
      .mockResolvedValueOnce({
        id: 'session-1',
        name: 'demo',
        state: 'running',
        createdAt: '2026-03-20T00:00:00.000Z',
        updatedAt: '2026-03-20T00:00:01.000Z',
        lastError: null,
      })
      .mockResolvedValueOnce({
        id: 'session-2',
        name: 'demo',
        state: 'running',
        createdAt: '2026-03-20T00:00:02.000Z',
        updatedAt: '2026-03-20T00:00:03.000Z',
        lastError: null,
      });

    await useRuntimeSessionStore.getState().runTab('tab-1', graphDocument('graph-v1'));
    await useRuntimeSessionStore.getState().runTab('tab-1', graphDocument('graph-v2'));

    const context = useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(2);
    expect(context.sessionId).toBe('session-2');
    expect(vi.mocked(deleteSession)).toHaveBeenCalledWith('session-1');
  });

  it('rerun unchanged graph replaces a linked error session with a fresh session', async () => {
    useRuntimeSessionStore.setState((state) => ({
      contextsByTabId: {
        ...state.contextsByTabId,
        'tab-1': {
          ...state.contextsByTabId['tab-1'],
          sessionId: 'session-bad',
          lastSubmittedHash: '667ef470',
          graphSubmissionUpdatedAt: '2026-03-20T00:00:00.000Z',
          session: {
            id: 'session-bad',
            name: 'demo',
            state: 'error',
            createdAt: '2026-03-20T00:00:00.000Z',
            updatedAt: '2026-03-20T00:00:01.000Z',
            lastError: 'Request failed: 400 Bad Request',
          },
        },
      },
    }));

    vi.mocked(createSession).mockResolvedValue({
      id: 'session-fresh',
      name: 'demo',
      state: 'stopped',
      createdAt: '2026-03-20T00:00:02.000Z',
      updatedAt: '2026-03-20T00:00:02.000Z',
      lastError: null,
    });
    vi.mocked(startSession).mockResolvedValue({
      id: 'session-fresh',
      name: 'demo',
      state: 'running',
      createdAt: '2026-03-20T00:00:02.000Z',
      updatedAt: '2026-03-20T00:00:03.000Z',
      lastError: null,
    });
    vi.mocked(getSession).mockResolvedValue({
      id: 'session-fresh',
      name: 'demo',
      state: 'running',
      createdAt: '2026-03-20T00:00:02.000Z',
      updatedAt: '2026-03-20T00:00:03.000Z',
      lastError: null,
    });

    await useRuntimeSessionStore.getState().runTab('tab-1', graphDocument('same graph'));

    const context = useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startSession)).toHaveBeenCalledWith('session-fresh');
    expect(context.sessionId).toBe('session-fresh');
    expect(vi.mocked(deleteSession)).toHaveBeenCalledWith('session-bad');
  });

  it('replacement run keeps old linked session if replacement start fails', async () => {
    vi.mocked(createSession).mockResolvedValue({
      id: 'session-2',
      name: 'demo',
      state: 'stopped',
      createdAt: '2026-03-20T00:00:02.000Z',
      updatedAt: '2026-03-20T00:00:02.000Z',
      lastError: null,
    });

    vi.mocked(startSession).mockRejectedValue(new Error('start failed'));

    useRuntimeSessionStore.setState((state) => ({
      contextsByTabId: {
        ...state.contextsByTabId,
        'tab-1': {
          ...state.contextsByTabId['tab-1'],
          sessionId: 'session-1',
          lastSubmittedHash: 'old-hash',
          graphSubmissionUpdatedAt: '2026-03-20T00:00:00.000Z',
          session: {
            id: 'session-1',
            name: 'demo',
            state: 'stopped',
            createdAt: '2026-03-20T00:00:00.000Z',
            updatedAt: '2026-03-20T00:00:00.000Z',
            lastError: null,
          },
        },
      },
    }));

    await useRuntimeSessionStore.getState().runTab('tab-1', graphDocument('graph-v2'));

    const context = useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    expect(context.sessionId).toBe('session-1');
    expect(context.session?.id).toBe('session-1');
    expect(vi.mocked(deleteSession)).not.toHaveBeenCalled();
  });

  it('stopSessionForTab converges to stopped', async () => {
    useRuntimeSessionStore.setState((state) => ({
      contextsByTabId: {
        ...state.contextsByTabId,
        'tab-1': {
          ...state.contextsByTabId['tab-1'],
          sessionId: 'session-1',
          session: {
            id: 'session-1',
            name: 'demo',
            state: 'running',
            createdAt: '2026-03-20T00:00:00.000Z',
            updatedAt: '2026-03-20T00:00:00.000Z',
            lastError: null,
          },
        },
      },
    }));

    vi.mocked(stopSession).mockResolvedValue({
      id: 'session-1',
      name: 'demo',
      state: 'stopped',
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:00:04.000Z',
      lastError: null,
    });
    vi.mocked(getSession).mockResolvedValue({
      id: 'session-1',
      name: 'demo',
      state: 'stopped',
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:00:04.000Z',
      lastError: null,
    });

    await useRuntimeSessionStore.getState().stopSessionForTab('tab-1');

    const context = useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    expect(context.session?.state).toBe('stopped');
    expect(context.busy).toBe(false);
  });

  it('keeps running subscriptions until Stop and terminal cursor reconciliation finish', () => {
    useRuntimeSessionStore.setState((state) => ({
      contextsByTabId: {
        ...state.contextsByTabId,
        'tab-1': {
          ...state.contextsByTabId['tab-1'],
          sessionId: 'session-1',
          session: {
            id: 'session-1',
            name: 'demo',
            state: 'running',
            createdAt: '2026-03-20T00:00:00.000Z',
            updatedAt: '2026-03-20T00:00:00.000Z',
            lastError: null,
          },
          lastAction: 'stop',
          lastActionStatus: 'running',
          busy: true,
        },
      },
    }));

    const view = useRuntimeSessionStore.getState().getTabRuntimeView('tab-1');
    expect(view.executionState).toBe('running');
    expect(view.operationState).toBe('stopping-session');
  });

  it('reports stopped execution state while delete is in progress', () => {
    useRuntimeSessionStore.setState((state) => ({
      contextsByTabId: {
        ...state.contextsByTabId,
        'tab-1': {
          ...state.contextsByTabId['tab-1'],
          sessionId: 'session-1',
          session: {
            id: 'session-1',
            name: 'demo',
            state: 'running',
            createdAt: '2026-03-20T00:00:00.000Z',
            updatedAt: '2026-03-20T00:00:00.000Z',
            lastError: null,
          },
          lastAction: 'delete',
          lastActionStatus: 'running',
          busy: true,
        },
      },
    }));

    const view = useRuntimeSessionStore.getState().getTabRuntimeView('tab-1');
    expect(view.executionState).toBe('stopped');
  });

  it('stale async completion from older run action is ignored', async () => {
    const firstCreate = defer<{
      id: string;
      name: string;
      state: 'stopped';
      createdAt: string;
      updatedAt: string;
      lastError: null;
    }>();

    vi.mocked(createSession)
      .mockImplementationOnce(() => firstCreate.promise)
      .mockResolvedValueOnce({
        id: 'session-new',
        name: 'demo',
        state: 'stopped',
        createdAt: '2026-03-20T00:00:03.000Z',
        updatedAt: '2026-03-20T00:00:03.000Z',
        lastError: null,
      });

    vi.mocked(startSession).mockResolvedValue({
      id: 'session-new',
      name: 'demo',
      state: 'running',
      createdAt: '2026-03-20T00:00:03.000Z',
      updatedAt: '2026-03-20T00:00:04.000Z',
      lastError: null,
    });
    vi.mocked(getSession).mockResolvedValue({
      id: 'session-new',
      name: 'demo',
      state: 'running',
      createdAt: '2026-03-20T00:00:03.000Z',
      updatedAt: '2026-03-20T00:00:04.000Z',
      lastError: null,
    });

    const firstRun = useRuntimeSessionStore.getState().runTab('tab-1', graphDocument('graph-v1'));
    const secondRun = useRuntimeSessionStore.getState().runTab('tab-1', graphDocument('graph-v2'));

    firstCreate.resolve({
      id: 'session-old',
      name: 'demo',
      state: 'stopped',
      createdAt: '2026-03-20T00:00:01.000Z',
      updatedAt: '2026-03-20T00:00:01.000Z',
      lastError: null,
    });

    await Promise.all([firstRun, secondRun]);

    const context = useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    expect(context.sessionId).toBe('session-new');
    expect(context.session?.state).toBe('running');
  });

  it('ends retained stream caches when polling observes natural completion', async () => {
    const annotations=vi.spyOn(annotationLifecycle,'endSessionAnnotations');
    const tables=vi.spyOn(tableLifecycle,'endSessionTables');
    await useRuntimeSessionStore.getState().linkSessionToTab('tab-1','session-1');
    vi.mocked(getSession).mockResolvedValue({id:'session-1',name:'finite',state:'stopped',createdAt:'2026-10-21',updatedAt:'2026-10-21',lastError:null});
    await useRuntimeSessionStore.getState().refreshSessionStateForTab('tab-1');
    expect(annotations).toHaveBeenCalledWith('session-1',true);expect(tables).toHaveBeenCalledWith('session-1',true);
    expect(useRuntimeSessionStore.getState().contextsByTabId['tab-1'].session?.state).toBe('stopped');
    annotations.mockRestore();tables.mockRestore();
  });

  it('passive polling records finite completion without superseding user actions', async () => {
    await useRuntimeSessionStore.getState().linkSessionToTab('tab-1','session-1');
    const before=useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    vi.mocked(getSession).mockResolvedValue({...before.session!,state:'stopped'});
    await useRuntimeSessionStore.getState().pollSessionForTab('tab-1');
    const ended=useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    expect(ended.session?.state).toBe('stopped');expect(ended.lastAction).toBe(before.lastAction);expect(ended.busy).toBe(false);
  });

  it('ignores a passive poll result after Stop starts', async () => {
    await useRuntimeSessionStore.getState().linkSessionToTab('tab-1','session-1');
    const session=useRuntimeSessionStore.getState().contextsByTabId['tab-1'].session!;
    const poll=defer<typeof session>();vi.mocked(getSession).mockReturnValueOnce(poll.promise);
    const pending=useRuntimeSessionStore.getState().pollSessionForTab('tab-1');
    vi.mocked(stopSession).mockResolvedValue({...session,state:'stopped'});vi.mocked(getSession).mockResolvedValue({...session,state:'stopped'});
    await useRuntimeSessionStore.getState().stopSessionForTab('tab-1');
    poll.resolve({...session,state:'running'});await pending;
    expect(useRuntimeSessionStore.getState().contextsByTabId['tab-1'].session?.state).toBe('stopped');
  });

  it('refreshSessionStateForTab unlinks missing session on 404', async () => {
    useRuntimeSessionStore.setState((state) => ({
      contextsByTabId: {
        ...state.contextsByTabId,
        'tab-1': {
          ...state.contextsByTabId['tab-1'],
          sessionId: 'missing-session',
          lastSubmittedHash: 'abc123',
          graphSubmissionUpdatedAt: '2026-03-20T00:00:00.000Z',
          session: {
            id: 'missing-session',
            name: 'demo',
            state: 'stopped',
            createdAt: '2026-03-20T00:00:00.000Z',
            updatedAt: '2026-03-20T00:00:00.000Z',
            lastError: null,
          },
        },
      },
    }));

    vi.mocked(getSession).mockRejectedValue(
      new ApiClientError('missing', 'HTTP', 404, 'not found', 'not_found'),
    );

    await useRuntimeSessionStore.getState().refreshSessionStateForTab('tab-1');

    const context = useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    expect(context.sessionId).toBeNull();
    expect(context.session).toBeNull();
    expect(context.lastSubmittedHash).toBeNull();
    expect(context.graphSubmissionUpdatedAt).toBeNull();
  });

  it('deleteSessionForTab clears linked session', async () => {
    useRuntimeSessionStore.setState((state) => ({
      contextsByTabId: {
        ...state.contextsByTabId,
        'tab-1': {
          ...state.contextsByTabId['tab-1'],
          sessionId: 'session-1',
          lastSubmittedHash: 'abc123',
          graphSubmissionUpdatedAt: '2026-03-20T00:00:00.000Z',
          session: {
            id: 'session-1',
            name: 'demo',
            state: 'stopped',
            createdAt: '2026-03-20T00:00:00.000Z',
            updatedAt: '2026-03-20T00:00:00.000Z',
            lastError: null,
          },
        },
      },
    }));

    vi.mocked(deleteSession).mockResolvedValue({ deleted: true });

    await useRuntimeSessionStore.getState().deleteSessionForTab('tab-1');

    const context = useRuntimeSessionStore.getState().contextsByTabId['tab-1'];
    expect(context.sessionId).toBeNull();
    expect(context.session).toBeNull();
    expect(context.lastSubmittedHash).toBeNull();
    expect(context.graphSubmissionUpdatedAt).toBeNull();
  });

  it('unlinked tab does not stay in ready state from old submission hash', () => {
    useRuntimeSessionStore.setState((state) => ({
      contextsByTabId: {
        ...state.contextsByTabId,
        'tab-1': {
          ...state.contextsByTabId['tab-1'],
          lastSubmittedHash: 'abc123',
          graphSubmissionUpdatedAt: '2026-03-20T00:00:00.000Z',
        },
      },
    }));

    const view = useRuntimeSessionStore.getState().getTabRuntimeView('tab-1', 'graph-content');
    expect(view.executionState).toBe('idle');
    expect(view.graphSubmissionState).toBe('none');
    expect(view.runIntent).toBe('create-session');
  });
});

it.each([
  'gr::studio::StudioDataSetWaterfallSink<float64>',
  'gr::studio::StudioAnnotationSink<float64>',
  'gr::studio::StudioTableSink<float64>',
])('keeps unchanged %s submissions current after Run', async blockType => {
  vi.clearAllMocks();
  resetStore();
  const document = {
    ...graphDocument('retained'),
    graph: {
      nodes: [{ id: 'sink', blockType, position: { x: 0, y: 0 }, parameters: {} }],
      edges: [],
    },
  };
  const session = {
    id: 'retained-session', name: 'retained', state: 'running' as const,
    createdAt: 'now', updatedAt: 'now', lastError: null,
  };
  vi.mocked(createSession).mockResolvedValue({ ...session, state: 'stopped' });
  vi.mocked(startSession).mockResolvedValue(session);
  vi.mocked(getSession).mockResolvedValue(session);
  vi.mocked(listSessions).mockResolvedValue([session]);
  const before = buildCurrentSessionGraphSubmission(document);
  expect((await useRuntimeSessionStore.getState().runTab('tab-1', document)).ok).toBe(true);
  const after = buildCurrentSessionGraphSubmission(document);
  expect(after).toEqual(before);
  const view = useRuntimeSessionStore.getState().getTabRuntimeView('tab-1', after.content);
  expect(view.graphDriftState).toBe('in-sync');
  expect(view.graphSubmissionState).toBe('current');
  expect(vi.mocked(createSession).mock.calls[0][0].grc).toMatch(/run_namespace: [^\n]+/);
  document.graph.nodes[0].parameters = { window_size: { kind: 'literal', value: 128 } } as typeof document.graph.nodes[0]['parameters'];
  const edited = buildCurrentSessionGraphSubmission(document);
  expect(useRuntimeSessionStore.getState().getTabRuntimeView('tab-1', edited.content).graphDriftState).toBe('out-of-sync');
});

it('annotation restart creates a fresh exported execution and never invokes raw restart', async () => {
  vi.clearAllMocks();resetStore();
  const document = { ...graphDocument('annotations'), graph: { nodes: [{ id: 'annotations0', blockType: 'gr::studio::StudioAnnotationSink<float64>', position: { x: 0, y: 0 }, parameters: { transport: { kind: 'literal' as const, value: 'websocket' } } }], edges: [] } };
  let serial = 0;
  const records = new Map<string, Awaited<ReturnType<typeof getSession>>>();
  vi.mocked(listSessions).mockResolvedValue([]);
  vi.mocked(createSession).mockImplementation(async () => {
    const session = { id: `annotation-session-${++serial}`, name: 'annotations', state: 'stopped' as const, createdAt: '2026-10-20', updatedAt: '2026-10-20', lastError: null };
    records.set(session.id, session);return session;
  });
  vi.mocked(startSession).mockImplementation(async id => { const s = { ...records.get(id)!, state: 'running' as const };records.set(id, s);return s; });
  vi.mocked(stopSession).mockImplementation(async id => { const s = { ...records.get(id)!, state: 'stopped' as const };records.set(id, s);return s; });
  vi.mocked(getSession).mockImplementation(async id => records.get(id)!);
  vi.mocked(deleteSession).mockResolvedValue({ deleted: true });
  const first = await useRuntimeSessionStore.getState().runTab('tab-1', document);expect(first.ok).toBe(true);
  await useRuntimeSessionStore.getState().restartSessionForTab('tab-1');
  expect(createSession).toHaveBeenCalledTimes(2);expect(stopSession).toHaveBeenCalledWith('annotation-session-1');expect(deleteSession).toHaveBeenCalledWith('annotation-session-1');
  const submissions = vi.mocked(createSession).mock.calls.map(([request]) => request.grc);
  const namespaces = submissions.map(s => s.match(/run_namespace: ([^\n]+)/)?.[1]);
  expect(namespaces[0]).toBeTruthy();expect(namespaces[1]).not.toBe(namespaces[0]);
  expect(useRuntimeSessionStore.getState().contextsByTabId['tab-1'].sessionId).toBe('annotation-session-2');
});

it('table restart creates a fresh exported execution and never invokes raw restart', async () => {
  vi.clearAllMocks();resetStore();
  const document = { ...graphDocument('tables'), graph: { nodes: [{ id: 'tables0', blockType: 'gr::studio::StudioTableSink<float64>', position: { x: 0, y: 0 }, parameters: { transport: { kind: 'literal' as const, value: 'websocket' } } }], edges: [] } };
  let serial = 0;
  const records = new Map<string, Awaited<ReturnType<typeof getSession>>>();
  vi.mocked(listSessions).mockResolvedValue([]);
  vi.mocked(createSession).mockImplementation(async () => {
    const session = { id: `table-session-${++serial}`, name: 'tables', state: 'stopped' as const, createdAt: '2026-10-20', updatedAt: '2026-10-20', lastError: null };
    records.set(session.id, session);return session;
  });
  vi.mocked(startSession).mockImplementation(async id => { const s = { ...records.get(id)!, state: 'running' as const };records.set(id, s);return s; });
  vi.mocked(stopSession).mockImplementation(async id => { const s = { ...records.get(id)!, state: 'stopped' as const };records.set(id, s);return s; });
  vi.mocked(getSession).mockImplementation(async id => records.get(id)!);
  vi.mocked(deleteSession).mockResolvedValue({ deleted: true });
  const first = await useRuntimeSessionStore.getState().runTab('tab-1', document);expect(first.ok).toBe(true);
  await useRuntimeSessionStore.getState().restartSessionForTab('tab-1');
  expect(createSession).toHaveBeenCalledTimes(2);expect(stopSession).toHaveBeenCalledWith('table-session-1');expect(deleteSession).toHaveBeenCalledWith('table-session-1');
  const submissions = vi.mocked(createSession).mock.calls.map(([request]) => request.grc);
  const namespaces = submissions.map(s => s.match(/run_namespace: ([^\n]+)/)?.[1]);
  expect(namespaces[0]).toBeTruthy();expect(namespaces[1]).not.toBe(namespaces[0]);
  expect(useRuntimeSessionStore.getState().contextsByTabId['tab-1'].sessionId).toBe('table-session-2');
});
