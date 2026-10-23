import { afterEach, expect, it, vi } from 'vitest';
import { awaitTerminalCursor, type CursorEntry } from './terminal-stream-cursor';
afterEach(()=>vi.useRealTimers());
it('waits for the exact final reduction and removes the listener',async()=>{
  const entry:CursorEntry<{cursor:string}>={state:{cursor:'19'},listeners:new Set()};
  let settled=false;const done=awaitTerminalCursor(entry,'20').then(result=>{settled=result;return result;});
  await Promise.resolve();expect(settled).toBe(false);
  entry.state={cursor:'20'};entry.listeners.forEach(listener=>listener(entry.state,''));
  expect(await done).toBe(true);expect(entry.listeners.size).toBe(0);
});
it('does not wait when the final cursor is already applied, including zero',async()=>{
  const entry:CursorEntry<{cursor:string}>={state:{cursor:'0'},listeners:new Set()};
  expect(await awaitTerminalCursor(entry,'0')).toBe(true);expect(entry.listeners.size).toBe(0);
});
it('reports incomplete reconciliation at its deadline without an indefinite client wait',async()=>{
  vi.useFakeTimers();const entry:CursorEntry<{cursor:string}>={state:{cursor:'19'},listeners:new Set()};
  const done=awaitTerminalCursor(entry,'20',25);await vi.advanceTimersByTimeAsync(25);
  expect(await done).toBe(false);expect(entry.listeners.size).toBe(0);
});
it('does not treat a different terminal cursor as reconciled',async()=>{
  vi.useFakeTimers();const entry:CursorEntry<{cursor:string}>={state:{cursor:'21'},listeners:new Set()};
  const done=awaitTerminalCursor(entry,'20',25);await vi.advanceTimersByTimeAsync(25);expect(await done).toBe(false);
});
it('requires no future connection for an absent view',async()=>expect(await awaitTerminalCursor(undefined,'20')).toBe(true));
