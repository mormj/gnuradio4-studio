import { expect, it } from 'vitest';
import type { GraphDocument } from '../../graph-document/model/types';
import { toGrctrlContentSubmission } from './toGrctrlPayload';

it('exports an arbitrary annotation producer directly to the waterfall without injecting producer-owned identity', () => {
  const document: GraphDocument = {
    format: 'gr4-studio.graph', version: 1, metadata: { name: 'Producer annotations' },
    graph: {
      nodes: [
        { id: 'producer', blockType: 'example::AnnotationProducer', position: { x: 0, y: 0 }, parameters: {} },
        { id: 'waterfall', blockType: 'gr::studio::StudioDataSetWaterfallSink<float64>', position: { x: 300, y: 0 },
          parameters: { scope_mode: { kind: 'literal', value: 'producer' } } },
      ],
      edges: [{ id: 'annotations', source: { nodeId: 'producer', portId: 'out' }, target: { nodeId: 'waterfall', portId: 'annotations' } }],
    },
  };
  const first = toGrctrlContentSubmission(document).content;
  expect(first).toContain('example::AnnotationProducer');
  expect(first).toContain('annotations');
  expect(first).toContain('scope_mode: producer');
  expect(first).not.toContain('run_namespace:');
  expect(first).not.toContain('source_epoch:');
  expect(first).not.toContain('producer_instance:');
  expect(toGrctrlContentSubmission(document).content).toBe(first);
});
