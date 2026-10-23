import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  WaterfallCanvasAdapter,
  calculateWaterfallCanvasDimensions,
  resolveWaterfallHoverSample,
} from './waterfall-canvas-adapter';
import type { WaterfallRaster } from './waterfall-rendering';

describe('waterfall canvas adapter helpers', () => {
  it('rounds canvas dimensions against device pixel ratio for crisp resizing', () => {
    expect(
      calculateWaterfallCanvasDimensions({
        width: 321.5,
        height: 123.4,
        devicePixelRatio: 2,
      }),
    ).toEqual({
      pixelWidth: 643,
      pixelHeight: 246,
    });
  });

  it('resolves hover readout against known synthetic data', () => {
    const raster: WaterfallRaster = {
      width: 2,
      height: 2,
      pixels: new Uint8ClampedArray(16),
      minValue: 1,
      maxValue: 4,
    };

    expect(
      resolveWaterfallHoverSample({
        raster,
        sourceValues: [1, 2, 3, 4],
        frequencyBins: [10, 20],
        rect: { width: 200, height: 100 },
        clientX: 150,
        clientY: 75,
      }),
    ).toEqual({
      row: 1,
      column: 1,
      frequency: 20,
      value: 4,
    });
  });
});


describe('waterfall information disclosure', () => {
  function markup(observationAxis: boolean) {
    return renderToStaticMarkup(createElement(WaterfallCanvasAdapter, {
      spec: {kind:'waterfall'},width:400,height:200,
      frame:{kind:'waterfall',image:{width:1,height:1,values:[-100],xAxis:[902000000],observationAxis,
        annotationCapacityEvictions:'1',streamStatus:'Stale dataset waterfall · reconnecting'}},
    }));
  }
  it('starts collapsed for dataset waterfall while leaving capacity and stream warnings visible', () => {
    const html=markup(true),disclosure=html.match(/<details data-waterfall-info[^>]*>/)?.[0];
    expect(disclosure).toBeDefined();expect(disclosure).not.toContain('open=');
    expect(html).toContain('>Info</summary>');
    const afterDisclosure=html.slice(html.indexOf('</details>',html.indexOf('data-waterfall-info')));
    expect(afterDisclosure).toContain('role="alert"');expect(afterDisclosure).toContain('role="status"');
  });
  it('preserves the existing information display for the normal waterfall', () => {
    expect(markup(false).match(/<details data-waterfall-info[^>]*>/)?.[0]).toContain('open=""');
  });
});
