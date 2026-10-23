import { expect, it } from 'vitest';
import { frequencyBounds, visibleAnnotationBoxes } from './annotation-projection';
import type { PlotAnnotation } from './annotation-registry';
it('indexes retained row identity once when projecting a dense annotation window', () => {
  const key={run_namespace:'run',source_id:'source',acquisition_id:'task',source_epoch:'epoch',sequence:'0'};
  let reads=0;
  const rows=Array.from({length:256},(_,i)=>({...key,get sequence(){reads++;return String(255-i);}}));
  const annotation:PlotAnnotation={annotation_id:'a',revision:'1',label:'sender',geometry:{kind:'rectangle',x_min:10,x_max:20},
    x_axis:{kind:'frequency',unit:'Hz'},y_axis:{kind:'observation',first:{...key,sequence:'100'},last:{...key,sequence:'110'}}};
  const items=Array.from({length:500},(_,i)=>({key:String(i),annotation:{...annotation,annotation_id:String(i)}}));
  const boxes=visibleAnnotationBoxes(items,100,2560,hz=>hz,rows,row=>row*10);
  expect(boxes).toHaveLength(500);expect(boxes.every(b=>b.y===1450&&b.height===110)).toBe(true);
  expect(reads).toBe(256);
});

it('renders producer-declared geometry without interpreting private metadata', () => {
  const annotation: PlotAnnotation = {
    annotation_id: 'sender-id', revision: '1', label: 'Sender label',
    x_axis: { kind: 'frequency', unit: 'Hz' },
    geometry: { kind: 'rectangle', x_min: 10, x_max: 40 },
    metadata: { latest_x_min: 20, latest_x_max: 25 },
  };
  expect(frequencyBounds(annotation)).toEqual([10, 40]);
  expect(visibleAnnotationBoxes([{ key: 'sender-id', annotation }], 100, 100, hz => hz)[0])
    .toMatchObject({ x: 10, width: 30 });
  expect(frequencyBounds({ ...annotation, geometry: { kind: 'point', x: 15 } })).toEqual([15, 15]);
});
