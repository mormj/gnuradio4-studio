import { AnnotationOverlay } from '../runtime/annotation-overlay';
import { visibleAnnotationBoxes } from '../runtime/annotation-projection';
import { frequencyToPixel } from './waterfall-coordinates';
import { fullWaterfallViewport, moveWaterfallViewport, pixelToFrequency, frequencyColumn, pixelToObservation, type WaterfallViewport } from './waterfall-coordinates';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { PlotAdapterProps } from '../model/types';
import type { WaterfallRaster } from './waterfall-rendering';
import { buildWaterfallRaster } from './waterfall-rendering';

type HoverSample = {
  row: number;
  column: number;
  frequency?: number;
  value: number;
};

function toNumberArray(values: number[] | Float32Array | Float64Array | Uint8Array): number[] {
  return Array.isArray(values) ? values : Array.from(values);
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  if (Math.abs(value) >= 1000 || Math.abs(value) < 0.01) {
    return value.toExponential(2);
  }
  return value.toFixed(2);
}

function formatAxisValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }
  if (Math.abs(value) >= 1000 || Math.abs(value) < 0.01) {
    return value.toExponential(2);
  }
  return value.toFixed(2);
}

export function calculateWaterfallCanvasDimensions(params: {
  width: number;
  height: number;
  devicePixelRatio: number;
}): { pixelWidth: number; pixelHeight: number } {
  return {
    pixelWidth: Math.max(1, Math.floor(params.width * params.devicePixelRatio)),
    pixelHeight: Math.max(1, Math.floor(params.height * params.devicePixelRatio)),
  };
}

export function resolveWaterfallHoverSample(params: {
  raster: WaterfallRaster | null;
  sourceValues: ArrayLike<number>;
  frequencyBins?: readonly number[];
  rect: { width: number; height: number };
  clientX: number;
  clientY: number;
  viewport?: WaterfallViewport;
}): HoverSample | null {
  const { raster, sourceValues, frequencyBins, rect, clientX, clientY } = params;
  if (!raster || raster.width === 0 || raster.height === 0 || sourceValues.length === 0) {
    return null;
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const localX = Math.max(0, Math.min(rect.width, clientX));
  const localY = Math.max(0, Math.min(rect.height, clientY));
  const column = Math.min(raster.width - 1, Math.max(0, Math.floor((localX / rect.width) * raster.width)));
  const row = Math.min(raster.height - 1, Math.max(0, Math.floor((localY / rect.height) * raster.height)));
  const view = params.viewport;
  const physicalColumn = view && frequencyBins ? frequencyColumn(pixelToFrequency(localX, frequencyBins, rect.width, view), frequencyBins) : column;
  const physicalRow = view ? pixelToObservation(localY, raster.height, rect.height, view) : row;
  const value = sourceValues[physicalRow * raster.width + physicalColumn] ?? Number.NaN;
  return {
    row: physicalRow,
    column: physicalColumn,
    frequency: frequencyBins?.[physicalColumn],
    value,
  };
}

export function WaterfallCanvasAdapter({ spec, frame, width, height, viewResetKey }: PlotAdapterProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const lastPointer = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const [hover, setHover] = useState<HoverSample | null>(null);

  const [viewport, setViewport] = useState(fullWaterfallViewport);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const image = frame.image;
  useEffect(() => { setViewport(fullWaterfallViewport); }, [image?.streamEpoch, viewResetKey]);
  const raster = useMemo(() => (image ? buildWaterfallRaster(image) : null), [image]);
  const sourceValues = useMemo(
    () => (image ? (image.observationAxis ? image.values : toNumberArray(image.values)) : []),
    [image],
  );
  const frequencyBins = useMemo(
    () => (image?.xAxis ? toNumberArray(image.xAxis) : undefined),
    [image],
  );
  const signalLabel = image?.signalName?.trim() || spec.title?.trim() || 'Waterfall';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !raster || width <= 0 || height <= 0) {
      return;
    }

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const canvasSize = calculateWaterfallCanvasDimensions({
      width,
      height,
      devicePixelRatio: dpr,
    });
    canvas.width = canvasSize.pixelWidth;
    canvas.height = canvasSize.pixelHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    context.save();
    context.scale(dpr, dpr);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#020617';
    context.fillRect(0, 0, width, height);

    if (raster.width > 0 && raster.height > 0) {
      if (!offscreenRef.current || offscreenRef.current.width !== raster.width || offscreenRef.current.height !== raster.height) {
        offscreenRef.current = document.createElement('canvas');
      }

      const sourceCanvas = offscreenRef.current;
      sourceCanvas.width = raster.width;
      sourceCanvas.height = raster.height;
      const sourceContext = sourceCanvas.getContext('2d');
      if (sourceContext) {
        const imageData = sourceContext.createImageData(raster.width, raster.height);
        imageData.data.set(raster.pixels);
        sourceContext.putImageData(imageData, 0, 0);
        context.imageSmoothingEnabled = !image?.observationAxis;
        context.imageSmoothingQuality = 'high';
        if (image?.observationAxis) {
          context.drawImage(sourceCanvas, viewport.left * raster.width, viewport.top * raster.height,
            (viewport.right - viewport.left) * raster.width, (viewport.bottom - viewport.top) * raster.height, 0, 0, width, height);
        } else context.drawImage(sourceCanvas, 0, 0, width, height);
      }
    }

    context.restore();
  }, [height, raster, width, viewport, image?.observationAxis]);

  useEffect(() => {
    if (!image?.observationAxis) { setHover(null); return; }
    const p = lastPointer.current;
    if (p) setHover(resolveWaterfallHoverSample({ raster, sourceValues, frequencyBins, rect: p, clientX: p.x, clientY: p.y, viewport }));
  }, [frame.meta?.sequence, image, raster, sourceValues, frequencyBins, viewport]);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (drag.current && image?.observationAxis) {
      const previous = drag.current;
      setViewport(v => moveWaterfallViewport(v, -(event.clientX - previous.x) / rect.width * (v.right - v.left), -(event.clientY - previous.y) / rect.height * (v.bottom - v.top)));
      drag.current = { x: event.clientX, y: event.clientY };
    }
    lastPointer.current = { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
    const next = resolveWaterfallHoverSample({
      raster,
      sourceValues,
      frequencyBins,
      viewport: image?.observationAxis ? viewport : undefined,
      rect: {
        width: rect.width,
        height: rect.height,
      },
      clientX: event.clientX - rect.left,
      clientY: event.clientY - rect.top,
    });
    setHover(next);
  };

  const onPointerLeave = () => {
    lastPointer.current = null;
    setHover(null);
  };

  const minValue = image?.minValue ?? raster?.minValue;
  const maxValue = image?.maxValue ?? raster?.maxValue;

  return (
    <div data-waterfall-rows={image?.height} data-waterfall-last-sequence={image?.rowKeys?.[0]?.sequence} className="relative h-full w-full overflow-hidden rounded border border-slate-800 bg-slate-950 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.65)]"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onDoubleClick={() => setViewport(fullWaterfallViewport)}
        onWheel={event => { if (image?.observationAxis) { event.preventDefault(); setViewport(v => moveWaterfallViewport(v, 0, 0, event.deltaY > 0 ? 1.2 : 1 / 1.2)); } }}
        onPointerDown={event => { if (image?.observationAxis) { drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); } }}
        onPointerUp={() => { drag.current = null; }}
    >
      <canvas
        ref={canvasRef}
        className="block h-full w-full"

      />

      {image?.observationAxis && frequencyBins ? <AnnotationOverlay items={frame.annotations} retained={frame.annotations?.length ?? 0} boxes={visibleAnnotationBoxes(frame.annotations ?? [], width, height, hz => frequencyToPixel(hz, frequencyBins, width, viewport), image.rowKeys, row => (row / image.height - viewport.top) / (viewport.bottom - viewport.top) * height)} /> : null}
      <details data-waterfall-info open={image?.observationAxis ? undefined : true} className="pointer-events-none absolute left-3 top-3 rounded-md border border-slate-700/80 bg-slate-950/80 px-2 py-1 shadow-lg backdrop-blur">
        {image?.observationAxis ? <summary className="pointer-events-auto cursor-pointer text-[10px] text-slate-300" onPointerDown={event => event.stopPropagation()}>Info</summary> : null}
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-300">{signalLabel}</div>
        <div className="mt-1 text-[10px] text-slate-400">
          {raster ? `${raster.height} rows × ${raster.width} bins` : 'No waterfall data'}
        </div>
        {image?.observationAxis ? <>
          {image.rowDiscontinuities?.some(reasons => reasons.length > 0) ? <div className="text-[10px] text-amber-300">Partition resets / sequence gaps: {image.rowDiscontinuities.filter(reasons => reasons.length > 0).length} retained rows (hover for reasons)</div> : null}
          <div className="text-[10px] text-slate-300">Observation sequence: {image.rowKeys?.[Math.floor(viewport.top * image.height)]?.sequence ?? 'empty'} → {image.rowKeys?.[Math.min(image.height - 1, Math.ceil(viewport.bottom * image.height) - 1)]?.sequence ?? 'empty'}</div>
          <div className="text-[10px] text-slate-400">{frequencyBins?.length ? `${frequencyBins[0]} … ${frequencyBins[frequencyBins.length - 1]} Hz` : ''}</div>
          {frequencyBins?.length ? <div className="text-[10px] text-slate-500">view {pixelToFrequency(0, frequencyBins, width, viewport)} … {pixelToFrequency(width, frequencyBins, width, viewport)} Hz (midpoint cells)</div> : null}
          <div className="text-[10px] text-slate-400">evicted {image.evictedRows} · rejected {image.droppedUpdates} · wheel zoom / drag pan / double-click reset</div>
        </> : null}
        {image?.timeSpan ? (
          <div className="mt-0.5 text-[10px] text-slate-500">span {formatValue(image.timeSpan)} s</div>
        ) : null}
      </details>
      {image?.observationAxis ? <div className="pointer-events-none absolute bottom-16 left-3 max-w-sm rounded bg-slate-950/80 text-xs text-amber-400">
        {image.annotationCapacityEvictions && image.annotationCapacityEvictions !== '0' ? <div role="alert">Annotation capacity exceeded: {image.annotationCapacityEvictions} evictions from retained observation history this execution. Increase annotation_max_bytes or annotation_max_items.</div> : null}
        {image.streamStatus?.startsWith('Stale') ? <div role="status">{image.streamStatus}</div> : null}
      </div> : null}

      {image?.observationAxis && frequencyBins?.length ? <div className="pointer-events-none absolute bottom-1 left-2 right-2 flex justify-between text-[10px] text-white [text-shadow:0_1px_3px_black]">
        {[0, 0.5, 1].map(fraction => <span key={fraction}>{pixelToFrequency(width * fraction, frequencyBins, width, viewport)} Hz</span>)}
      </div> : null}
      {raster ? (
        <div className="pointer-events-none absolute bottom-3 right-3 flex items-end gap-2 rounded-md border border-slate-700/80 bg-slate-950/80 px-2 py-1 shadow-lg backdrop-blur">
          <div
            className="h-24 w-3 overflow-hidden rounded-sm border border-slate-800"
            style={{
              background: `linear-gradient(to top, ${[
                '#081120',
                '#18204c',
                '#384cac',
                '#1391a8',
                '#2ab775',
                '#f0bc39',
                '#f27c22',
                '#ee463d',
              ].join(', ')})`,
            }}
          />
          <div className="text-[10px] leading-tight text-slate-300">
            <div className="font-semibold text-slate-100">Intensity</div>
            <div>{formatValue(raster.maxValue)}</div>
            <div className="text-slate-500">→</div>
            <div>{formatValue(raster.minValue)}</div>
          </div>
        </div>
      ) : null}

      {hover ? (
        <div className="pointer-events-none absolute right-3 top-3 max-w-[16rem] rounded-md border border-cyan-500/30 bg-slate-950/90 px-2 py-1 text-[10px] shadow-xl backdrop-blur">
          <div className="font-semibold text-cyan-100">{signalLabel}</div>
          <div className="mt-1 text-slate-300">
            row {hover.row + 1}/{raster?.height ?? 0} · bin {hover.column + 1}/{raster?.width ?? 0}
          </div>
          {image?.observationAxis ? <div className="text-slate-300">
            observation {image.rowKeys?.[hover.row]?.sequence}<br />
            timestamp {image.rowTimestamps?.[hover.row]?.raw_text || 'unknown'} ({image.rowTimestamps?.[hover.row]?.provenance})<br />
            {image.rowDiscontinuities?.[hover.row]?.join(', ')}
          </div> : null}
          <div className="text-slate-300">
            f={image?.observationAxis ? String(hover.frequency) : formatAxisValue(hover.frequency)} {image?.axisUnit ? image.axisUnit : ''}
          </div>
          <div className="text-slate-300">
            value={formatValue(hover.value)} {image?.signalUnit ? image.signalUnit : ''}
          </div>
          <div className="text-slate-500">
            range {formatValue(minValue ?? 0)} .. {formatValue(maxValue ?? 1)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
