import { retryAnnotations } from '../runtime/annotation-subscription';
import { usePlotAnnotations, type AnnotationSourceBinding } from '../runtime/use-plot-annotations';
import { retryDatasetWaterfall } from '../runtime/dataset-waterfall-subscription';
import { useState } from 'react';
import type { PlotAxisMode, PlotPanelSpec, PlotRuntimeBinding } from '../model/types';
import { PlotSurface } from './plot-surface';
import { useTimeseriesLiveFrame } from '../runtime/timeseries-live-runtime';

type PlotPanelProps = {
  spec: PlotPanelSpec;
  annotationBindings?: readonly AnnotationSourceBinding[];
  binding: PlotRuntimeBinding;
  executionState?: 'idle' | 'ready' | 'running' | 'stopped' | 'error';
};

const emptyAnnotationBindings: readonly AnnotationSourceBinding[] = [];
export function PlotPanel({ spec, binding, executionState, annotationBindings = emptyAnnotationBindings }: PlotPanelProps) {
  const [isPaused, setIsPaused] = useState(false);
  const [axisMode, setAxisMode] = useState<PlotAxisMode>('x');
  const [viewResetKey, setViewResetKey] = useState(0);
  const frame = useTimeseriesLiveFrame({
    spec,
    binding,
    executionState,
    isPaused,
  });

  const annotations = usePlotAnnotations(spec.annotationSources, annotationBindings, isPaused);
  return (
    <div className="relative h-full w-full">
    {spec.source.payloadFormat === 'dataset-waterfall-json-v1' ? <button className="absolute right-4 top-2 z-30 rounded bg-slate-800 px-2 text-xs text-slate-200" onClick={() => retryDatasetWaterfall(binding.endpoint ?? '')}>Resynchronize stream</button> : null}
    {spec.annotationSources?.length ? <button className="absolute bottom-0 right-2 z-30 rounded bg-slate-800 px-2 text-[10px] text-cyan-100" onClick={() => annotationBindings.filter(b => spec.annotationSources?.some(s => s.sinkId === b.sinkId)).forEach(b => retryAnnotations(b.endpoint))}>Resynchronize annotations</button> : null}
    {annotations.status ? <div role="status" className="pointer-events-none absolute left-2 bottom-1 z-30 text-[10px] text-cyan-100">{annotations.status}</div> : null}
    <div className={annotations.status ? "absolute inset-x-0 top-0 bottom-5" : "absolute inset-0"}>
    <PlotSurface
      spec={spec.view}
      frame={{ ...frame, annotations: [...(frame.image?.annotations ?? frame.annotations ?? []), ...annotations.items] }}
      binding={binding}
      isPaused={isPaused}
      onPausedChange={setIsPaused}
      axisMode={axisMode}
      onAxisModeChange={setAxisMode}
      viewResetKey={viewResetKey}
      onViewReset={() => setViewResetKey((key) => key + 1)}
    />
    </div>
    </div>
  );
}
