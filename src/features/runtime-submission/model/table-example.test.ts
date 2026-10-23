import { expect, it } from 'vitest';
import example from '../../../../examples/persistent-tables.gr4s?raw';
import { parseGraphDocument } from '../../graph-document/model/schema';
import { editorGraphFromDocument } from '../../graph-document/model/toEditor';
import { graphDocumentFromEditor } from '../../graph-document/model/fromEditor';
import { toGrctrlContentSubmission } from './toGrctrlPayload';
it('roundtrips three simultaneous panels and exports independent streams with a fresh shared execution namespace', () => {
 const d = parseGraphDocument(JSON.parse(example));const restored = graphDocumentFromEditor(editorGraphFromDocument(d));
 expect(restored.metadata.studio?.panels).toEqual(d.metadata.studio?.panels);
 const first = toGrctrlContentSubmission(d, { executionNamespace: 'run-one' }).content, second = toGrctrlContentSubmission(d, { executionNamespace: 'run-two' }).content;
 expect(first).toContain('payload_format: table-updates-json-v1');expect(first).toContain('annotation_producer: syntheticAnnotations0');
 const namespaces = [...first.matchAll(/run_namespace: ([^\n]+)/g)].map(m => m[1]);expect(namespaces).toHaveLength(5);expect(new Set(namespaces).size).toBe(1);expect(second).not.toBe(first);
 expect(first.match(/producer_instance: syntheticTables0/g)).toHaveLength(2);
});
