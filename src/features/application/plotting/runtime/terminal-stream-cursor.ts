// A terminal publication cursor is a barrier on reduction, independent of painting.
export type CursorEntry<T extends { cursor: string }> = {
  state?: T; listeners: Set<(state: T | undefined, status: string) => void>;
};
export function awaitTerminalCursor<T extends { cursor: string }>(entry: CursorEntry<T> | undefined, cursor: string, timeoutMs = 2000): Promise<boolean> {
  if (!entry) return Promise.resolve(true); // no active view to reconcile
  return new Promise(resolve => {
    const finish = (complete: boolean) => { clearTimeout(timer); entry.listeners.delete(check); resolve(complete); };
    const check = () => { if (entry.state?.cursor === cursor) finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    entry.listeners.add(check); check();
  });
}
