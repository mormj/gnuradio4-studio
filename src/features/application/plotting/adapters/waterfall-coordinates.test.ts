import { describe, it, expect } from 'vitest';
import { frequencyToPixel, pixelToFrequency, frequencyColumn, observationToPixel, pixelToObservation, moveWaterfallViewport, fullWaterfallViewport } from './waterfall-coordinates';
describe('dataset waterfall coordinates', () => {
  it('roundtrips float64 points after zoom, pan and resize', () => {
    const x=Array.from({length:6817},(_,i)=>902000000.1234567 + i * 0.125);
    const view=moveWaterfallViewport(moveWaterfallViewport(fullWaterfallViewport,0,0,0.5),0.1,-0.1);
    for(const width of [400,1024,1793]) for(const i of [0,1,4000,6816]) {
      const pixel=frequencyToPixel(x[i],x,width,view);
      expect(pixelToFrequency(pixel,x,width,view)).toBe(x[i]);expect(frequencyColumn(x[i],x)).toBe(i);
    }
    for(const i of [0,20,255])expect(pixelToObservation(observationToPixel(i,256,400,view),256,400,view)).toBe(i);
  });
});
