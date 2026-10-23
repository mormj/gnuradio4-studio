import { useEffect, useState, type WheelEvent, type PointerEvent } from 'react';
import { selectAnnotation, subscribeAnnotationSelection } from './annotation-subscription';
import type { AnnotationBox, AnnotationOverlayItem } from './annotation-projection';
export function AnnotationOverlay({ boxes, retained, items, onWheel, onPointerDown }: { boxes: AnnotationBox[]; retained: number; items?: readonly AnnotationOverlayItem[]; onWheel?: (event: WheelEvent<HTMLDivElement>) => void; onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void }) {
  const [selected, setSelected] = useState<string>();
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => subscribeAnnotationSelection(setSelected), []);
  const filtered = boxes.filter(b => !hidden.includes(b.item.annotation.style?.state ?? ''));
  const ordered = [...filtered].sort((a, b) => Number(b.item.key === selected) - Number(a.item.key === selected) || a.key.localeCompare(b.key));
  const visible = ordered.slice(0, 2000);
  const labels: { x: number; y: number; width: number }[] = [];
  let labelCount = 0;
  const labelledIds = new Set<string>();
  const hiddenOverlays = retained - new Set(visible.map(b => b.item.key)).size;
  const states = [...new Set((items ?? boxes.map(b => b.item)).map(item => item.annotation.style?.state).filter((s): s is string => !!s))].sort();
  const inspectable = items ?? [...new Map(boxes.map(b => [b.item.key, b.item])).values()];
  const chosen = inspectable.find(item => item.key === selected);
  return <div onWheel={onWheel} onPointerDown={event => {
    // Interactive overlays own their click. Parent plot pointer capture would
    // redirect pointer-up to the canvas and swallow annotation selection.
    if(event.target instanceof Element && event.target.closest('button,input,select,details'))event.stopPropagation();
    else onPointerDown?.(event);
  }} className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="annotation-overlay">
    {visible.map(b => {
      const a = b.item.annotation, active = b.item.key === selected;
      const emphasis = b.item.executionEnded ? .4 : a.style?.opacity ?? .95;
      const labelWidth = Math.min(260, a.label.length * 7 + 12);
      const label = labelCount < 100 && !labels.some(r => b.x < r.x + r.width && b.x + labelWidth > r.x && Math.abs(b.y - r.y) < 18);
      if (label) { labels.push({ x: b.x, y: b.y, width: labelWidth }); labelCount++; labelledIds.add(b.item.key); }
      return <button key={b.key} data-annotation-id={a.annotation_id} data-revision={a.revision} title={`${a.label}\n${a.annotation_id}\nrevision ${a.revision}\n${a.style?.state ?? ''}${b.broken ? '\nMissing supporting observations' : ''}${b.item.executionEnded ? '\nExecution ended; finalization unavailable' : ''}`}
        onClick={e => { e.stopPropagation(); selectAnnotation(active ? undefined : b.item.key); }}
        className="pointer-events-auto absolute text-left text-[10px]" style={{ left: b.x, top: b.y, width: b.width, height: b.height, border: `${active ? 3 : 1}px ${b.broken || a.style?.line === 'dashed' ? 'dashed' : 'solid'} ${a.style?.color ?? '#67e8f9'}`, background: active ? '#22d3ee30' : '#22d3ee0c', opacity: emphasis }}>
        {label ? <span data-annotation-label className="absolute left-0 top-0 whitespace-nowrap bg-slate-950/90 px-1 text-cyan-100">{a.label}</span> : null}
      </button>;
    })}
    <details className="pointer-events-auto absolute bottom-8 left-2 max-w-xs rounded bg-slate-950/90 p-1 text-[10px] text-cyan-100">
      <summary>{retained} retained · {hiddenOverlays} hidden overlays · {retained - labelledIds.size} hidden labels</summary>
      {states.map(state => <label key={state} className="mr-2"><input type="checkbox" checked={!hidden.includes(state)} onChange={() => setHidden(h => h.includes(state) ? h.filter(s => s !== state) : [...h, state])} />{state}</label>)}
      <select aria-label="Inspect retained annotation" value={selected ?? ''} onChange={e => selectAnnotation(e.target.value || undefined)} className="block w-full bg-slate-900">
        <option value="">Select annotation</option>
        {inspectable.map(item => <option key={item.key} value={item.key}>{item.annotation.label} · {item.annotation.annotation_id}</option>)}
      </select>
      {chosen ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(chosen, null, 2)}</pre> : null}
    </details>
  </div>;
}
