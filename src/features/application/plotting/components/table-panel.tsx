import { useEffect, useMemo, useRef, useState } from 'react';
import { selectAnnotation, subscribeAnnotationSelection } from '../runtime/annotation-subscription';
import { retryTables, subscribeTables } from '../runtime/table-subscription';
import { queryTable, formatTableValue } from '../runtime/table-query';
import type { TableState } from '../runtime/table-reducer';
import type { PlotRuntimeBinding } from '../model/types';

type Props = { binding: PlotRuntimeBinding; sessionId?: string; visibleColumns?: string[] };
export function TablePanel({ binding, sessionId, visibleColumns }: Props) {
  const current = useRef<{ state?: TableState; status: string }>({ status: 'Waiting for table stream' });
  const [paint, setPaint] = useState(current.current);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key?: string; descending: boolean }>({ descending: false });
  const [visible, setVisible] = useState<string[] | undefined>(visibleColumns);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string>();
  const [localRow, setLocalRow] = useState<string>();
  const ownSelection = useRef(false);
  const publishSelection = (key?: string) => { ownSelection.current = true; selectAnnotation(key); ownSelection.current = false; };
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(240);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => subscribeAnnotationSelection(id => { setSelected(id); if (!ownSelection.current) setLocalRow(undefined); }), []);
  useEffect(() => { setVisible(visibleColumns); }, [visibleColumns]);
  useEffect(() => {
    current.current = { status: binding.reason ?? 'Connecting table' }; setPaint(current.current);
    if (binding.status !== 'configured' || binding.transport !== 'websocket' || !binding.endpoint) return;
    return subscribeTables(binding.endpoint, (state, status) => { current.current = { state, status }; }, sessionId);
  }, [binding.endpoint, binding.status, binding.transport, binding.reason, sessionId]);
  useEffect(() => {
    if (paused) return;
    const paintNow = () => { if (!document.hidden) setPaint(current.current); };
    paintNow(); const timer = setInterval(paintNow, 100); return () => clearInterval(timer);
  }, [paused]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight)); observer.observe(element); return () => observer.disconnect();
  }, []);
  const state = paint.state;
  const rows = useMemo(() => state ? queryTable(state, filter, sort.key, sort.descending) : [], [state, filter, sort]);
  const columns = state?.columns.filter(c => visible === undefined || visible.includes(c.key)) ?? [];
  const local = rows.find(r => JSON.stringify([state?.scope.run_namespace, r.row_id]) === localRow);
  const selectedRow = local?.row_id ?? rows.find(r => r.annotation_id && JSON.stringify([state?.scope.run_namespace, r.annotation_id]) === selected)?.row_id;
  const localAnnotation = local?.annotation_id ? JSON.stringify([state?.scope.run_namespace, local.annotation_id]) : undefined;
  useEffect(() => {
    if (local && selected !== localAnnotation) publishSelection(localAnnotation);
    // Keep row identity selected if its optional annotation reference is revised.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local?.row_id, localAnnotation, selected]);
  const start = Math.max(0, Math.min(Math.floor(scrollTop / 28) - 4, Math.max(0, rows.length - 1)));
  const end = Math.min(rows.length, start + Math.ceil(height / 28) + 8);
  useEffect(() => {
    if (viewport.current && viewport.current.scrollTop > rows.length * 28) viewport.current.scrollTop = 0;
  }, [rows.length]);
  useEffect(() => {
    if (!selectedRow || !viewport.current) return;
    const index = rows.findIndex(r => r.row_id === selectedRow), element = viewport.current;
    if (index * 28 < element.scrollTop || (index + 1) * 28 > element.scrollTop + height - 30) element.scrollTop = index * 28;
    // Scroll on a newly resolved selection, including an annotation that arrived before its row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow]);
  const template = columns.map(c => `${widths[c.key] ?? 170}px`).join(' ');
  return <div className="h-full flex flex-col min-h-0 text-xs text-slate-100" data-table-cursor={state?.cursor} data-retained={state?.items.size}>
    <div className="flex gap-2 items-center p-1 flex-wrap">
      <input aria-label="Filter table" className="bg-slate-800 px-2 py-1" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter rows" />
      <button onClick={() => setPaused(p => !p)}>{paused ? 'Resume table' : 'Pause table'}</button>
      <button onClick={() => retryTables(binding.endpoint ?? '')}>Resynchronize table</button>
      <details><summary>Columns</summary><div className="absolute z-40 bg-slate-800 p-2">{state?.columns.map(c => <label key={c.key} className="block"><input type="checkbox" checked={visible === undefined || visible.includes(c.key)} onChange={e => setVisible(old => e.target.checked ? [...(old ?? state.columns.map(c => c.key)), c.key] : (old ?? state.columns.map(c => c.key)).filter(k => k !== c.key))} />{c.label}</label>)}</div></details>
      <button onClick={() => { setLocalRow(undefined); selectAnnotation(undefined); }}>Clear selection</button>
    </div>
    <div role="status" className="px-2 text-cyan-100">{paused ? 'View paused · ingestion continues · ' : ''}{paint.status} · {rows.length} visible / {state?.items.size ?? 0} retained · {state?.tombstones.size ?? 0} tombstones{selected && !selectedRow ? ' · annotation selection pending or filtered' : ''}</div>
    <div ref={viewport} className="overflow-auto flex-1 min-h-0" onScroll={e => setScrollTop(e.currentTarget.scrollTop)}>
      <div role="table" aria-label="Persistent table" aria-rowcount={rows.length + 1} style={{ minWidth: columns.reduce((n, c) => n + (widths[c.key] ?? 170), 0) }}>
        <div role="row" className="sticky top-0 z-10 bg-slate-800" style={{ display: 'grid', gridTemplateColumns: template, height: 30 }}>
          {columns.map(c => <div key={c.key} role="columnheader" aria-sort={sort.key === c.key ? sort.descending ? 'descending' : 'ascending' : 'none'} className="relative px-2 overflow-hidden">
            <button onClick={() => setSort(old => ({ key: c.key, descending: old.key === c.key && !old.descending }))}>{c.label}{c.unit ? ` (${c.unit})` : ''}</button>
            <span role="separator" aria-label={`Resize ${c.label}`} aria-orientation="vertical" className="absolute top-0 right-0 h-full w-2 cursor-col-resize" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.dataset.start = String(e.clientX); e.currentTarget.dataset.width = String(widths[c.key] ?? 170); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) { const width = Math.max(70, Math.min(600, Number(e.currentTarget.dataset.width) + e.clientX - Number(e.currentTarget.dataset.start))); setWidths(old => ({ ...old, [c.key]: width })); } }} onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} />
          </div>)}
        </div>
        <div role="rowgroup" style={{ height: rows.length * 28, position: 'relative' }}>
          {rows.slice(start, end).map((r, offset) => <div key={r.row_id} role="row" aria-rowindex={start + offset + 2} aria-selected={selectedRow === r.row_id} tabIndex={0} data-row-id={r.row_id} data-revision={r.revision}
            onClick={() => { setLocalRow(JSON.stringify([state!.scope.run_namespace, r.row_id])); publishSelection(r.annotation_id ? JSON.stringify([state!.scope.run_namespace, r.annotation_id]) : undefined); }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
            className={selectedRow === r.row_id ? 'bg-cyan-900' : 'hover:bg-slate-800'} style={{ display: 'grid', gridTemplateColumns: template, position: 'absolute', top: (start + offset) * 28, height: 28 }}>
            {columns.map(c => <div role="cell" key={c.key} className="px-2 overflow-hidden whitespace-nowrap text-ellipsis border-b border-slate-800" title={String(r.values[c.key] ?? '')}>{formatTableValue(r.values[c.key], c)}</div>)}
          </div>)}
        </div>
      </div>
    </div>
  </div>;
}
