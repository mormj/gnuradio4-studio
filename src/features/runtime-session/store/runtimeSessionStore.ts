import { getBlockSettings } from '../../../lib/api/block-settings';
import { buildApiUrl } from '../../../lib/api/client';
import { awaitAnnotationsCursor } from '../../application/plotting/runtime/annotation-subscription';
import { awaitTablesCursor } from '../../application/plotting/runtime/table-subscription';
import { awaitDatasetWaterfallCursor, endDatasetWaterfall } from '../../application/plotting/runtime/dataset-waterfall-subscription';
import { endSessionTables } from '../../application/plotting/runtime/table-subscription';
import { endSessionAnnotations } from '../../application/plotting/runtime/annotation-subscription';
import { create } from 'zustand';
import type { GraphDocument } from '../../graph-document/model/types';
import type { BlockDetails } from '../../../lib/api/block-details';
import { ApiClientError } from '../../../lib/api/client';
import { buildCurrentSessionGraphSubmission } from '../../runtime-submission/model/current-graph-submission';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  restartSession,
  startSession,
  stopSession,
  type SessionRecord,
} from '../../../lib/api/sessionsApi';

type RuntimeActionStatus = 'idle' | 'running' | 'success' | 'error';
export type ExecutionState = 'idle' | 'ready' | 'running' | 'stopped' | 'error';
export type OperationState = 'none' | 'running-graph' | 'stopping-session' | 'restarting-session' | 'refreshing';
export type GraphDriftState = 'in-sync' | 'out-of-sync';
export type GraphSubmissionState = 'none' | 'current' | 'stale';
export type RunIntent = 'none' | 'create-session' | 'replace-session-from-edits' | 'start-linked-session';
export type RunTabResult =
  | {
      ok: true;
      sessionId: string;
      session: SessionRecord;
    }
  | {
      ok: false;
      error: string;
    };

export type TabRuntimeView = {
  executionState: ExecutionState;
  operationState: OperationState;
  graphDriftState: GraphDriftState;
  graphSubmissionState: GraphSubmissionState;
  graphSubmissionUpdatedAt: string | null;
  runIntent: RunIntent;
};

export type RuntimeActivity = {
  timestamp: string;
  action: string;
  message: string;
  level: 'info' | 'error';
};

export type TabExecutionContext = {
  sessionId: string | null;
  session: SessionRecord | null;
  lastSubmittedHash: string | null;
  graphSubmissionUpdatedAt: string | null;
  lastAction: 'create' | 'start' | 'stop' | 'restart' | 'refresh' | 'delete' | null;
  lastActionStatus: RuntimeActionStatus;
  busy: boolean;
  lastError: string | null;
  lastUpdatedAt: string | null;
  sessionRefreshedAt: string | null;
  activity: RuntimeActivity[];
};

type RuntimeSessionState = {
  activeTabId: string | null;
  contextsByTabId: Record<string, TabExecutionContext>;
  sessions: SessionRecord[];
  getTabRuntimeView: (tabId: string, currentSubmissionContent?: string | null, schedulerId?: string | null) => TabRuntimeView;
  ensureTabContext: (tabId: string) => void;
  removeTabContext: (tabId: string) => void;
  setActiveTab: (tabId: string | null) => void;
  runTab: (
    tabId: string,
    document: GraphDocument,
    options?: { blockDetailsByType?: ReadonlyMap<string, BlockDetails> },
  ) => Promise<RunTabResult>;
  stopSessionForTab: (tabId: string) => Promise<void>;
  restartSessionForTab: (tabId: string) => Promise<void>;
  deleteSessionForTab: (tabId: string) => Promise<void>;
  refreshTab: (tabId: string) => Promise<void>;
  refreshSessionStateForTab: (tabId: string) => Promise<void>;
  pollSessionForTab: (tabId: string) => Promise<void>;
  startSessionById: (sessionId: string) => Promise<void>;
  stopSessionById: (sessionId: string) => Promise<void>;
  restartSessionById: (sessionId: string) => Promise<void>;
  deleteSessionById: (sessionId: string) => Promise<void>;
  linkSessionToTab: (tabId: string, sessionId: string) => Promise<void>;
  unlinkSessionFromTab: (tabId: string) => void;
  findTabIdBySessionId: (sessionId: string) => string | null;
  refreshSessionList: () => Promise<void>;
};

function createDefaultContext(): TabExecutionContext {
  return {
    sessionId: null,
    session: null,
    lastSubmittedHash: null,
    graphSubmissionUpdatedAt: null,
    lastAction: null,
    lastActionStatus: 'idle',
    busy: false,
    lastError: null,
    lastUpdatedAt: null,
    sessionRefreshedAt: null,
    activity: [],
  };
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function hashContent(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function hashSubmissionSignature(content: string, schedulerId?: string | null): string {
  return hashContent(`${content}\n__scheduler__:${schedulerId ?? ''}`);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.details ? `${error.message}: ${error.details}` : error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown runtime error';
}

function isMissingSessionError(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === 'HTTP' && error.status === 404;
}

function isRunningState(state: string | undefined): boolean {
  return state === 'running';
}

function isStoppedState(state: string | undefined): boolean {
  return state === 'stopped';
}

function isErrorState(state: string | undefined): boolean {
  return state === 'error';
}

function deriveExecutionState(context: TabExecutionContext): ExecutionState {
  const state = context.session?.state;

  if (context.busy && context.lastActionStatus === 'running') {
    if (context.lastAction === 'delete') {
      return 'stopped';
    }
  }

  if (isRunningState(state)) {
    return 'running';
  }

  if (isErrorState(state) || context.lastActionStatus === 'error') {
    return 'error';
  }

  if (isStoppedState(state)) {
    return 'stopped';
  }

  if (context.sessionId) {
    return 'ready';
  }

  return 'idle';
}

function deriveOperationState(context: TabExecutionContext): OperationState {
  if (!context.busy || context.lastActionStatus !== 'running') {
    return 'none';
  }

  if (context.lastAction === 'stop') {
    return 'stopping-session';
  }
  if (context.lastAction === 'restart') {
    return 'restarting-session';
  }
  if (context.lastAction === 'refresh') {
    return 'refreshing';
  }
  return 'running-graph';
}

function deriveGraphDriftState(
  context: TabExecutionContext,
  currentSubmissionContent?: string | null,
  schedulerId?: string | null,
): GraphDriftState {
  if (!context.sessionId || !context.lastSubmittedHash || !currentSubmissionContent) {
    return 'in-sync';
  }

  return context.lastSubmittedHash === hashSubmissionSignature(currentSubmissionContent, schedulerId) ? 'in-sync' : 'out-of-sync';
}

function deriveGraphSubmissionState(
  context: TabExecutionContext,
  currentSubmissionContent?: string | null,
  schedulerId?: string | null,
): GraphSubmissionState {
  if (!context.sessionId || !context.lastSubmittedHash || !currentSubmissionContent) {
    return 'none';
  }

  return context.lastSubmittedHash === hashSubmissionSignature(currentSubmissionContent, schedulerId) ? 'current' : 'stale';
}

function deriveRunIntent(
  context: TabExecutionContext,
  currentSubmissionContent?: string | null,
  schedulerId?: string | null,
  executionState?: ExecutionState,
): RunIntent {
  if (executionState === 'running') {
    return 'none';
  }

  if (!context.sessionId) {
    return 'create-session';
  }

  const drift = deriveGraphDriftState(context, currentSubmissionContent, schedulerId);
  if (drift === 'out-of-sync') {
    return 'replace-session-from-edits';
  }

  return 'start-linked-session';
}

function pushActivity(context: TabExecutionContext, item: Omit<RuntimeActivity, 'timestamp'>): TabExecutionContext {
  const nextEvent: RuntimeActivity = {
    ...item,
    timestamp: nowIsoString(),
  };

  return {
    ...context,
    activity: [nextEvent, ...context.activity].slice(0, 40),
  };
}

const POLL_INTERVALS_MS = [500, 500, 500, 1000, 1000, 1000, 1000, 1500];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const useRuntimeSessionStore = create<RuntimeSessionState>((set, get) => {
  const annotationRuns = new Map<string, { document: GraphDocument; options?: Parameters<RuntimeSessionState['runTab']>[2] }>();
  const actionVersionBySessionId = new Map<string, number>();
  const beginSessionAction = (sessionId: string) => {
    const version = (actionVersionBySessionId.get(sessionId) ?? 0) + 1;
    actionVersionBySessionId.set(sessionId, version);
    return version;
  };

  const actionVersionByTabId: Record<string, number> = {};

  const patchContext = (tabId: string, updater: (current: TabExecutionContext) => TabExecutionContext) => {
    set((state) => {
      const current = state.contextsByTabId[tabId] ?? createDefaultContext();
      return {
        contextsByTabId: {
          ...state.contextsByTabId,
          [tabId]: updater(current),
        },
      };
    });
  };

  const nextActionVersion = (tabId: string): number => {
    const next = (actionVersionByTabId[tabId] ?? 0) + 1;
    actionVersionByTabId[tabId] = next;
    return next;
  };

  const isCurrentAction = (tabId: string, version: number): boolean => actionVersionByTabId[tabId] === version;

  const patchContextIfCurrent = (
    tabId: string,
    version: number,
    updater: (current: TabExecutionContext) => TabExecutionContext,
  ): boolean => {
    if (!isCurrentAction(tabId, version)) {
      return false;
    }

    patchContext(tabId, updater);
    return true;
  };

  const beginAction = (tabId: string, action: TabExecutionContext['lastAction']): number => {
    const version = nextActionVersion(tabId);
    patchContext(tabId, (current) => ({
      ...current,
      lastAction: action,
      lastActionStatus: 'running',
      busy: true,
      lastError: null,
      lastUpdatedAt: nowIsoString(),
    }));
    return version;
  };

  const completeAction = (
    tabId: string,
    version: number,
    status: RuntimeActionStatus,
    errorMessage?: string | null,
    successMessage?: string,
  ) => {
    patchContextIfCurrent(tabId, version, (current) => {
      const withResult: TabExecutionContext = {
        ...current,
        lastActionStatus: status,
        busy: false,
        lastError: status === 'error' ? errorMessage ?? 'Action failed.' : null,
        lastUpdatedAt: nowIsoString(),
      };

      if (status === 'error') {
        return pushActivity(withResult, {
          action: current.lastAction ?? 'action',
          message: errorMessage ?? 'Action failed.',
          level: 'error',
        });
      }

      if (successMessage) {
        return pushActivity(withResult, {
          action: current.lastAction ?? 'action',
          message: successMessage,
          level: 'info',
        });
      }

      return withResult;
    });
  };

  const clearSessionFromContext = (context: TabExecutionContext, reason?: string): TabExecutionContext => {
    const cleared: TabExecutionContext = {
      ...context,
      sessionId: null,
      session: null,
      lastSubmittedHash: null,
      graphSubmissionUpdatedAt: null,
      sessionRefreshedAt: null,
      busy: false,
      lastUpdatedAt: nowIsoString(),
      lastError: reason ?? context.lastError,
    };

    if (!reason) {
      return cleared;
    }

    return pushActivity(cleared, {
      action: 'refresh',
      message: reason,
      level: 'error',
    });
  };

  const ownsTabExecution = (tabId: string, version: number, sessionId: string, previous: SessionRecord | null | undefined) => () => {
    const context = get().contextsByTabId[tabId];
    return isCurrentAction(tabId, version) && context?.sessionId === sessionId &&
      context.session?.executionId === previous?.executionId;
  };

  const refreshSessionStateWithVersion = async (
    tabId: string,
    sessionId: string,
    version: number,
  ): Promise<SessionRecord | null> => {
    const previous = get().contextsByTabId[tabId]?.session;
    const ownsExecution = ownsTabExecution(tabId, version, sessionId, previous);
    try {
      const session = await getSession(sessionId);
      if (isCurrentAction(tabId, version) && session.state !== 'running' && get().contextsByTabId[tabId]?.session?.state === 'running') {
        await reconcileTerminalStreams(previous, session, ownsExecution);
      }
      if (!patchContextIfCurrent(tabId, version, (current) => ({
        ...current,
        sessionId: session.id,
        session,
        sessionRefreshedAt: nowIsoString(),
        lastUpdatedAt: nowIsoString(),
      }))) {
        return null;
      }

      return session;
    } catch (error) {
      if (!isCurrentAction(tabId, version)) {
        return null;
      }

      if (isMissingSessionError(error)) {
        patchContext(tabId, (current) =>
          clearSessionFromContext(current, 'Linked session no longer exists on backend.'),
        );
        return null;
      }

      throw error;
    }
  };

  const pollSessionStateWithVersion = async (
    tabId: string,
    sessionId: string,
    version: number,
    target: 'running' | 'stopped',
  ): Promise<SessionRecord | null> => {
    for (let index = 0; index < POLL_INTERVALS_MS.length; index += 1) {
      if (!isCurrentAction(tabId, version)) {
        return null;
      }

      const session = await refreshSessionStateWithVersion(tabId, sessionId, version);
      if (!session) {
        return null;
      }

      if (session.state === 'error') {
        return session;
      }

      if (target === 'running' && (session.state === 'running' || (session.state === 'stopped' && session.completionReason === 'completed'))) {
        return session;
      }

      if (target === 'stopped' && session.state === 'stopped') {
        return session;
      }

      if (index < POLL_INTERVALS_MS.length - 1) {
        await wait(POLL_INTERVALS_MS[index]);
      }
    }

    return null;
  };

  return {
    activeTabId: null,
    contextsByTabId: {},
    sessions: [],

    getTabRuntimeView: (tabId, currentSubmissionContent, schedulerId) => {
      const context = get().contextsByTabId[tabId] ?? createDefaultContext();
      const executionState = deriveExecutionState(context);
      return {
        executionState,
        operationState: deriveOperationState(context),
        graphDriftState: deriveGraphDriftState(context, currentSubmissionContent, schedulerId),
        graphSubmissionState: deriveGraphSubmissionState(context, currentSubmissionContent, schedulerId),
        graphSubmissionUpdatedAt: context.graphSubmissionUpdatedAt,
        runIntent: deriveRunIntent(context, currentSubmissionContent, schedulerId, executionState),
      };
    },

    ensureTabContext: (tabId) => {
      set((state) => {
        if (state.contextsByTabId[tabId]) {
          return state;
        }

        return {
          contextsByTabId: {
            ...state.contextsByTabId,
            [tabId]: createDefaultContext(),
          },
        };
      });
    },

    removeTabContext: (tabId) => {
      annotationRuns.delete(tabId);
      delete actionVersionByTabId[tabId];
      set((state) => {
        const next = { ...state.contextsByTabId };
        delete next[tabId];
        return { contextsByTabId: next };
      });
    },

    setActiveTab: (tabId) => {
      set({ activeTabId: tabId });
    },

    runTab: async (tabId, document, options) => {
      const actionVersion = beginAction(tabId, 'start');

      try {
        const hasAnnotations = document.graph.nodes.some(n => (n.blockType === 'gr::studio::StudioAnnotationSink<float64>' || n.blockType === 'gr::studio::StudioTableSink<float64>'));
        if (hasAnnotations) annotationRuns.set(tabId, { document, options });
        else annotationRuns.delete(tabId);
        const submission = buildCurrentSessionGraphSubmission(document, options);
        const schedulerId = document.metadata.schedulerId;
        const submissionHash = hashSubmissionSignature(submission.content, schedulerId);
        const context = get().contextsByTabId[tabId] ?? createDefaultContext();

        const hasSubmissionDrift = context.lastSubmittedHash !== submissionHash;
        const shouldReplaceErroredSession = Boolean(context.sessionId) && context.session?.state === 'error';
        const needsNewSession = !context.sessionId || hasSubmissionDrift || shouldReplaceErroredSession || hasAnnotations;
        const isReplacementRun = Boolean(context.sessionId) && (hasSubmissionDrift || shouldReplaceErroredSession || hasAnnotations);

        let activeSession: SessionRecord | null = context.session;
        let activeSessionId = context.sessionId;
        const previousSessionId = isReplacementRun ? context.sessionId : null;

        if (needsNewSession) {
          if (previousSessionId) endSessionTablesAndAnnotations(previousSessionId);
          // Generate transport scope only for the execution being created. Graph
          // freshness compares the stable authored submission above.
          const executionSubmission = buildCurrentSessionGraphSubmission(document, {
            ...options,
            executionNamespace: crypto.randomUUID(),
          });
          const createdSession = await createSession({
            name: submission.graphName || 'demo',
            grc: executionSubmission.content,
            scheduler_id: schedulerId,
          });
          activeSession = createdSession;
          activeSessionId = createdSession.id;

          if (!isReplacementRun) {
            if (!patchContextIfCurrent(tabId, actionVersion, (current) => {
              let next: TabExecutionContext = {
                ...current,
                sessionId: createdSession.id,
                session: createdSession,
                lastSubmittedHash: submissionHash,
                graphSubmissionUpdatedAt: nowIsoString(),
                sessionRefreshedAt: nowIsoString(),
                lastUpdatedAt: nowIsoString(),
                lastAction: 'create',
              };

              next = pushActivity(next, {
                action: 'create',
                message: `Created session ${createdSession.id}.`,
                level: 'info',
              });

              return next;
            })) {
              return { ok: false, error: 'Run was superseded by a newer runtime action.' };
            }
          }

          await get().refreshSessionList();
        }

        if (!activeSessionId) {
          completeAction(tabId, actionVersion, 'error', 'No session available for run.');
          return { ok: false, error: 'No session available for run.' };
        }

        if (!activeSession) {
          activeSession = await refreshSessionStateWithVersion(tabId, activeSessionId, actionVersion);
          if (!activeSession) {
            completeAction(tabId, actionVersion, 'error', 'Failed to load linked session.');
            return { ok: false, error: 'Failed to load linked session.' };
          }
        }

        if (activeSession.state !== 'running') {
          const started = await startSession(activeSessionId);
          if (!patchContextIfCurrent(tabId, actionVersion, (current) => ({
            ...current,
            sessionId: started.id,
            session: started,
            sessionRefreshedAt: nowIsoString(),
            lastUpdatedAt: nowIsoString(),
            lastAction: 'start',
          }))) {
            return { ok: false, error: 'Run was superseded by a newer runtime action.' };
          }
        }

        const converged = await pollSessionStateWithVersion(tabId, activeSessionId, actionVersion, 'running');
        if (!converged) {
          completeAction(tabId, actionVersion, 'error', 'Session did not converge to running in time.');
          return { ok: false, error: 'Session did not converge to running in time.' };
        }

        if (converged.state === 'error') {
          completeAction(
            tabId,
            actionVersion,
            'error',
            converged.lastError ?? 'Session reached error state while starting.',
          );
          return { ok: false, error: converged.lastError ?? 'Session reached error state while starting.' };
        }

        if (isReplacementRun) {
          if (!patchContextIfCurrent(tabId, actionVersion, (current) => {
            let next: TabExecutionContext = {
              ...current,
              sessionId: converged.id,
              session: converged,
              lastSubmittedHash: submissionHash,
              graphSubmissionUpdatedAt: nowIsoString(),
              sessionRefreshedAt: nowIsoString(),
              lastUpdatedAt: nowIsoString(),
              lastAction: 'create',
              lastError: null,
            };

            next = pushActivity(next, {
              action: 'create',
              message: `Replaced linked session ${previousSessionId} with ${converged.id}.`,
              level: 'info',
            });

            return next;
          })) {
            return { ok: false, error: 'Run was superseded by a newer runtime action.' };
          }
        }

        if (previousSessionId && previousSessionId !== converged.id) {
          try {
            await deleteSession(previousSessionId);
          } catch {
            patchContextIfCurrent(tabId, actionVersion, (current) =>
              pushActivity(current, {
                action: 'delete',
                message: `Replacement session started, but previous session ${previousSessionId} could not be deleted automatically.`,
                level: 'error',
              }),
            );
          }
        }

        await get().refreshSessionList();
        completeAction(tabId, actionVersion, 'success', null, converged.state === 'stopped' ? 'Session completed.' : 'Session running.');
        return { ok: true, sessionId: converged.id, session: converged };
      } catch (error) {
        const message = toErrorMessage(error);
        completeAction(tabId, actionVersion, 'error', message);
        return { ok: false, error: message };
      }
    },

    stopSessionForTab: async (tabId) => {
      const actionVersion = beginAction(tabId, 'stop');
      const sessionId = get().contextsByTabId[tabId]?.sessionId;

      if (!sessionId) {
        completeAction(tabId, actionVersion, 'error', 'No session linked to this tab.');
        return;
      }

      try {
        const previous = get().contextsByTabId[tabId]?.session;
        const ownsExecution = ownsTabExecution(tabId, actionVersion, sessionId, previous);
        const stopped = await stopSession(sessionId);
        await reconcileTerminalStreams(previous, stopped, ownsExecution);
        if (!patchContextIfCurrent(tabId, actionVersion, (current) => ({
          ...current,
          session: stopped,
          sessionRefreshedAt: nowIsoString(),
          lastUpdatedAt: nowIsoString(),
        }))) {
          return;
        }

        const converged = await pollSessionStateWithVersion(tabId, sessionId, actionVersion, 'stopped');
        if (!converged) {
          completeAction(tabId, actionVersion, 'error', 'Session did not converge to stopped in time.');
          return;
        }

        if (converged.state === 'error') {
          completeAction(
            tabId,
            actionVersion,
            'error',
            converged.lastError ?? 'Session reached error state while stopping.',
          );
          return;
        }

        await get().refreshSessionList();
        completeAction(tabId, actionVersion, 'success', null, 'Session stopped.');
      } catch (error) {
        completeAction(tabId, actionVersion, 'error', toErrorMessage(error));
      }
    },

    restartSessionForTab: async (tabId) => {
      const annotationRun = annotationRuns.get(tabId);
      if (annotationRun) {
        await get().stopSessionForTab(tabId);
        const stopped = get().contextsByTabId[tabId];
        if (stopped?.session?.state !== 'stopped') return;
        await get().runTab(tabId, annotationRun.document, annotationRun.options);
        return;
      }
      const actionVersion = beginAction(tabId, 'restart');
      const sessionId = get().contextsByTabId[tabId]?.sessionId;

      if (!sessionId) {
        completeAction(tabId, actionVersion, 'error', 'No session linked to this tab.');
        return;
      }

      try {
        if (get().contextsByTabId[tabId]?.session?.streams?.some(s => ['plot-annotations-json-v1', 'table-updates-json-v1'].includes(s.payloadFormat))) throw new Error('Annotation executions require a fresh graph export; use Run from the graph tab.');
        const restarted = await restartSession(sessionId);
        if (!patchContextIfCurrent(tabId, actionVersion, (current) => ({
          ...current,
          session: restarted,
          sessionRefreshedAt: nowIsoString(),
          lastUpdatedAt: nowIsoString(),
        }))) {
          return;
        }

        const converged = await pollSessionStateWithVersion(tabId, sessionId, actionVersion, 'running');
        if (!converged) {
          completeAction(tabId, actionVersion, 'error', 'Session did not converge to running in time.');
          return;
        }

        if (converged.state === 'error') {
          completeAction(
            tabId,
            actionVersion,
            'error',
            converged.lastError ?? 'Session reached error state while restarting.',
          );
          return;
        }

        await get().refreshSessionList();
        completeAction(tabId, actionVersion, 'success', null, 'Session restarted.');
      } catch (error) {
        completeAction(tabId, actionVersion, 'error', toErrorMessage(error));
      }
    },

    deleteSessionForTab: async (tabId) => {
      const actionVersion = beginAction(tabId, 'delete');
      const sessionId = get().contextsByTabId[tabId]?.sessionId;

      if (!sessionId) {
        completeAction(tabId, actionVersion, 'error', 'No session linked to this tab.');
        return;
      }

      try {
        await deleteSession(sessionId);
        endSessionTablesAndAnnotations(sessionId);

        patchContextIfCurrent(tabId, actionVersion, (current) =>
          pushActivity(
            {
              ...current,
              sessionId: null,
              session: null,
              lastSubmittedHash: null,
              graphSubmissionUpdatedAt: null,
              sessionRefreshedAt: null,
              lastUpdatedAt: nowIsoString(),
              busy: false,
            },
            {
              action: 'delete',
              message: `Deleted session ${sessionId}.`,
              level: 'info',
            },
          ),
        );

        await get().refreshSessionList();
        completeAction(tabId, actionVersion, 'success');
      } catch (error) {
        if (isMissingSessionError(error)) {
          patchContextIfCurrent(tabId, actionVersion, (current) =>
            clearSessionFromContext(current, 'Session already missing on backend.'),
          );
          await get().refreshSessionList();
          completeAction(tabId, actionVersion, 'success');
          return;
        }

        completeAction(tabId, actionVersion, 'error', toErrorMessage(error));
      }
    },

    refreshTab: async (tabId) => {
      await get().refreshSessionStateForTab(tabId);
    },

    pollSessionForTab: async (tabId) => {
      const before=get().contextsByTabId[tabId];
      if(!before?.sessionId || before.busy || before.session?.state!=='running')return;
      const sessionId=before.sessionId, version=actionVersionByTabId[tabId];
      const current=()=>{const c=get().contextsByTabId[tabId];return c?.sessionId===sessionId && !c.busy && actionVersionByTabId[tabId]===version && c.session?.executionId===before.session?.executionId;};
      try {
        const session=await getSession(sessionId);
        if(!current())return;
        if(session.state!=='running')await reconcileTerminalStreams(before.session, session, current);
        if(!current())return;
        patchContext(tabId,c=>({...c,session,sessionRefreshedAt:nowIsoString(),lastError:session.lastError}));
      } catch(error) {
        if(!current())return;
        if(isMissingSessionError(error)){endSessionTablesAndAnnotations(sessionId);patchContext(tabId,c=>clearSessionFromContext(c,'Linked session no longer exists on backend.'));}
        else patchContext(tabId,c=>({...c,lastError:toErrorMessage(error)}));
      }
    },

    refreshSessionStateForTab: async (tabId) => {
      const actionVersion = beginAction(tabId, 'refresh');
      const sessionId = get().contextsByTabId[tabId]?.sessionId;

      if (!sessionId) {
        completeAction(tabId, actionVersion, 'success');
        return;
      }

      try {
        const refreshed = await refreshSessionStateWithVersion(tabId, sessionId, actionVersion);
        if (!refreshed) {
          completeAction(tabId, actionVersion, 'error', 'Unable to refresh linked session.');
          return;
        }

        await get().refreshSessionList();
        completeAction(tabId, actionVersion, 'success', null, 'Session refreshed.');
      } catch (error) {
        completeAction(tabId, actionVersion, 'error', toErrorMessage(error));
      }
    },

    startSessionById: async (sessionId) => {
      beginSessionAction(sessionId);
      const tabId = get().findTabIdBySessionId(sessionId);
      if (tabId) {
        const annotationRun = annotationRuns.get(tabId);
        if (annotationRun) {
          if (get().contextsByTabId[tabId]?.session?.state === 'running') return;
          await get().runTab(tabId, annotationRun.document, annotationRun.options);
          return;
        }
        const actionVersion = beginAction(tabId, 'start');
        try {
          const linked = get().contextsByTabId[tabId]?.session;
          if (linked?.streams?.some(s => ['plot-annotations-json-v1', 'table-updates-json-v1'].includes(s.payloadFormat)) && linked.state !== 'running') throw new Error('Annotation start requires a fresh graph export.');
          const started = await startSession(sessionId);
          if (!patchContextIfCurrent(tabId, actionVersion, (current) => ({
            ...current,
            sessionId: started.id,
            session: started,
            sessionRefreshedAt: nowIsoString(),
            lastUpdatedAt: nowIsoString(),
          }))) {
            return;
          }

          const converged = await pollSessionStateWithVersion(tabId, sessionId, actionVersion, 'running');
          if (!converged) {
            completeAction(tabId, actionVersion, 'error', 'Session did not converge to running in time.');
            return;
          }
          if (converged.state === 'error') {
            completeAction(tabId, actionVersion, 'error', converged.lastError ?? 'Session reached error state.');
            return;
          }

          await get().refreshSessionList();
          completeAction(tabId, actionVersion, 'success', null, 'Session started.');
        } catch (error) {
          completeAction(tabId, actionVersion, 'error', toErrorMessage(error));
        }
        return;
      }

      const external = get().sessions.find(s => s.id === sessionId);
      if (external?.streams?.some(s => ['plot-annotations-json-v1', 'table-updates-json-v1'].includes(s.payloadFormat)) && external.state !== 'running') throw new Error('Annotation start requires a fresh graph export.');
      await startSession(sessionId);
      await get().refreshSessionList();
    },

    stopSessionById: async (sessionId) => {
      const version = beginSessionAction(sessionId);
      const tabId = get().findTabIdBySessionId(sessionId);
      if (tabId) {
        await get().stopSessionForTab(tabId);
        return;
      }

      const previous = get().sessions.find(s => s.id === sessionId);
      const ownsExecution = () => actionVersionBySessionId.get(sessionId) === version &&
        !get().findTabIdBySessionId(sessionId) &&
        get().sessions.find(s => s.id === sessionId)?.executionId === previous?.executionId;
      const stopped = await stopSession(sessionId);
      await reconcileTerminalStreams(previous, stopped, ownsExecution);
      await get().refreshSessionList();
    },

    restartSessionById: async (sessionId) => {
      beginSessionAction(sessionId);
      const tabId = get().findTabIdBySessionId(sessionId);
      if (tabId) {
        await get().restartSessionForTab(tabId);
        return;
      }

      if (get().sessions.some(s => s.id === sessionId && s.streams?.some(stream => ['plot-annotations-json-v1', 'table-updates-json-v1'].includes(stream.payloadFormat)))) throw new Error('Annotation restart requires a fresh graph export.');
      await restartSession(sessionId);
      await get().refreshSessionList();
    },

    deleteSessionById: async (sessionId) => {
      beginSessionAction(sessionId);
      const tabId = get().findTabIdBySessionId(sessionId);
      if (tabId) {
        await get().deleteSessionForTab(tabId);
        return;
      }

      await deleteSession(sessionId);
      endSessionTablesAndAnnotations(sessionId);
      await get().refreshSessionList();
    },

    linkSessionToTab: async (tabId, sessionId) => {
      set((state) => {
        const nextContexts = { ...state.contextsByTabId };

        for (const [candidateTabId, candidate] of Object.entries(nextContexts)) {
          if (candidateTabId !== tabId && candidate.sessionId === sessionId) {
            nextContexts[candidateTabId] = pushActivity(
              {
                ...candidate,
                sessionId: null,
                session: null,
                sessionRefreshedAt: null,
                lastError: 'Session moved to another tab.',
                lastUpdatedAt: nowIsoString(),
              },
              {
                action: 'refresh',
                message: 'Session moved to another tab.',
                level: 'info',
              },
            );
          }
        }

        const target = nextContexts[tabId] ?? createDefaultContext();
        nextContexts[tabId] = {
          ...target,
          sessionId,
          session: null,
          sessionRefreshedAt: null,
          lastSubmittedHash: null,
          graphSubmissionUpdatedAt: null,
          lastUpdatedAt: nowIsoString(),
        };

        return { contextsByTabId: nextContexts };
      });

      await get().refreshSessionStateForTab(tabId);
    },

    unlinkSessionFromTab: (tabId) => {
      patchContext(tabId, (current) =>
        pushActivity(
          {
            ...current,
            sessionId: null,
            session: null,
            lastSubmittedHash: null,
            graphSubmissionUpdatedAt: null,
            sessionRefreshedAt: null,
            lastUpdatedAt: nowIsoString(),
            lastError: null,
          },
          {
            action: 'refresh',
            message: 'Session unlinked from tab.',
            level: 'info',
          },
        ),
      );
    },

    findTabIdBySessionId: (sessionId) => {
      const entries = Object.entries(get().contextsByTabId);
      const found = entries.find(([, context]) => context.sessionId === sessionId);
      return found?.[0] ?? null;
    },

    refreshSessionList: async () => {
      try {
        const sessions = await listSessions();
        set({ sessions });
      } catch {
        // auxiliary list refresh
      }
    },
  };
});

function endSessionTablesAndAnnotations(sessionId: string) { endSessionAnnotations(sessionId); endSessionTables(sessionId); }

// Keep subscriptions alive until each active reducer reaches its producer's frozen cursor.
// No transport result is interpreted as a producer's finalization or a region update.
async function reconcileTerminalStreams(
  previous: SessionRecord | null | undefined,
  terminal: SessionRecord,
  ownsExecution: () => boolean,
): Promise<void> {
  const current = () => ownsExecution() &&
    (!previous?.executionId || previous.executionId === terminal.executionId);
  if (!current()) return;

  const streams = (previous?.streams ?? []).filter(stream =>
    ['dataset-waterfall-json-v1', 'plot-annotations-json-v1', 'table-updates-json-v1'].includes(stream.payloadFormat));
  const results = await Promise.all(streams.map(async stream => {
    const endpoint = buildApiUrl(stream.path);
    try {
      const settings = await getBlockSettings(terminal.id, stream.blockInstanceName, AbortSignal.timeout(3000));
      if (!current()) return false;
      const metadata = settings.__gr4cp_terminal;
      if (!metadata || typeof metadata !== 'object' ||
        (terminal.executionId && metadata.execution_id !== terminal.executionId) ||
        typeof settings.publication_cursor !== 'string') return false;
      const awaitCursor = stream.payloadFormat === 'dataset-waterfall-json-v1' ? awaitDatasetWaterfallCursor :
        stream.payloadFormat === 'plot-annotations-json-v1' ? awaitAnnotationsCursor : awaitTablesCursor;
      const complete = await awaitCursor(endpoint, settings.publication_cursor);
      // An action or execution can change during either wait. Never end the
      // endpoint now owned by a newer run, even if the old reply matched its run.
      if (!current()) return false;
      if (stream.payloadFormat === 'dataset-waterfall-json-v1') endDatasetWaterfall(endpoint, complete);
      return complete;
    } catch {
      return false;
    }
  }));
  if (!current()) return;
  const complete = results.every(Boolean);
  endSessionAnnotations(terminal.id, complete);
  endSessionTables(terminal.id, complete);
  if (!complete) for (const stream of streams) {
    if (stream.payloadFormat === 'dataset-waterfall-json-v1') endDatasetWaterfall(buildApiUrl(stream.path), false);
  }
}
