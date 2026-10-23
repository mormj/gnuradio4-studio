import type { BlockDetails } from '../../../lib/api/block-details';
import { expect, it } from 'vitest';
import example from '../../../../examples/persistent-annotations.gr4s?raw';
import { parseGraphDocument } from '../../graph-document/model/schema';
import { editorGraphFromDocument } from '../../graph-document/model/toEditor';
import { graphDocumentFromEditor } from '../../graph-document/model/fromEditor';
import { toGrctrlContentSubmission } from './toGrctrlPayload';
it('loads the synthetic saved layout with both annotation bindings, round-trips it and exports a fresh shared namespace', () => {
  const document = parseGraphDocument(JSON.parse(example));
  const restored = graphDocumentFromEditor(editorGraphFromDocument(document));
  expect(restored.metadata.studio?.panels.map(p => p.kind === 'control' ? [] : p.annotationSources)).toEqual(document.metadata.studio?.panels.map(p => p.kind === 'control' ? [] : p.annotationSources));
  const first = toGrctrlContentSubmission(document, { executionNamespace: 'run-one' }).content;
  const second = toGrctrlContentSubmission(document, { executionNamespace: 'run-two' }).content;
  const namespaces = [...first.matchAll(/run_namespace: ([^\n]+)/g)].map(m => m[1]);
  expect(namespaces).toHaveLength(3);expect(new Set(namespaces).size).toBe(1);
  expect(second).not.toEqual(first);
  expect(first.match(/producer_instance: syntheticAnnotations0/g)).toHaveLength(2);
  expect(first).toContain('payload_format: plot-annotations-json-v1');
});

it('preserves native large-sequence defaults and exports explicitly authored decimal strings exactly', () => {
  const document = parseGraphDocument(JSON.parse(example));
  const source = document.graph.nodes.find(n => n.blockType === 'gr::studio::SyntheticSpectrumSource')!;
  const details: BlockDetails = { blockTypeId: source.blockType, displayName: 'Synthetic', inputPorts: [], outputPorts: [], parameters: [{ name: 'first_sequence', label: 'first_sequence', defaultValue: '9007199254740992', valueType: 'uint64', valueKind: 'scalar', mutable: true, readOnly: false }] };
  const options = { blockDetailsByType: new Map([[source.blockType, details]]) };
  expect(toGrctrlContentSubmission(document, options).content).not.toContain('first_sequence:');
  source.parameters.first_sequence = { kind: 'literal', value: '18446744073709551615' };
  expect(toGrctrlContentSubmission(document, options).content).toContain('first_sequence: 18446744073709551615');
  source.parameters.first_sequence = { kind: 'literal', value: 9007199254740992 };
  expect(() => toGrctrlContentSubmission(document, options)).toThrow(/exact uint64/);
});
