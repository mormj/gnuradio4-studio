import { useEffect, useRef, useState } from 'react';
import type { PlotPanelSpec } from '../model/types';
import { subscribeAnnotations } from './annotation-subscription';
import type { AnnotationState } from './annotation-registry';
import type { AnnotationOverlayItem } from './annotation-projection';
export type AnnotationSourceBinding = { sinkId: string; endpoint: string; sessionId?: string };
export function usePlotAnnotations(sources: PlotPanelSpec['annotationSources'], bindings: readonly AnnotationSourceBinding[], paused: boolean) {
  const current = useRef(new Map<string, { state?: AnnotationState; status: string }>());
  const [paint, setPaint] = useState<{ items: AnnotationOverlayItem[]; status: string }>({ items: [], status: '' });
  const signature = JSON.stringify([sources, bindings]);
  useEffect(() => {
    current.current.clear();
    const allowed = new Set(sources?.map(s => s.sinkId) ?? []);
    const stops = bindings.filter(b => allowed.has(b.sinkId)).slice(0, 8).map(b => subscribeAnnotations(b.endpoint, (state, status) => { current.current.set(b.sinkId, { state, status }); }, b.sessionId));
    return () => stops.forEach(stop => stop());
  // Bindings are structural execution identities; avoid reconnecting for React object allocation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  useEffect(() => {
    if (paused) return;
    const paintNow = () => {
      const items: AnnotationOverlayItem[] = [], status: string[] = [];
      for (const e of current.current.values()) {
        status.push(e.status);
        if (e.state) for (const a of e.state.items.values()) items.push({ key: JSON.stringify([e.state.scope.run_namespace, a.annotation_id]), annotation: a, executionEnded: e.state.executionEnded && a.style?.terminal !== true });
      }
      setPaint({ items, status: status.join(' · ') });
    };
    paintNow(); const timer = setInterval(paintNow, 100); return () => clearInterval(timer);
  }, [paused, signature]);
  return paint;
}
