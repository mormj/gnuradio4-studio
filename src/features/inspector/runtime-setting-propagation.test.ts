import { describe, expect, it, vi } from 'vitest';
import type { BlockDetails } from '../../lib/api/block-details';
import type { GraphDocument } from '../graph-document/model/types';
import type { EditorGraphNode } from '../graph-editor/model/types';
import { resolveGraphVariables } from '../variables/model/resolveGraphVariables';
import { resolveRuntimeSettingPropagation, stageRuntimeSettingPropagation } from './runtime-setting-propagation';

describe('resolved runtime variable propagation', () => {
  function setup() {
    const names = ['live', 'stopped', 'topology', 'unknown', 'invalid', 'readOnly'];
    const document: GraphDocument = { format: 'gr4-studio.graph', version: 1,
      metadata: { name: 'Mixed', studio: { panels: [], variables: [{ id: 'frequency', name: 'frequency', binding: { kind: 'literal', value: 10 } }] } },
      graph: { edges: [], nodes: [{ id: 'generator', blockType: 'Generator', position: { x: 0, y: 0 },
        parameters: Object.fromEntries(names.map((name) => [name, { kind: 'expression', expr: name === 'invalid' ? 'missing + 1' : 'frequency * 2' }])) }] } };
    const node: EditorGraphNode = { instanceId: 'generator', blockTypeId: 'Generator', displayName: 'Generator', position: { x: 0, y: 0 }, parameters: {} };
    const details: BlockDetails = { blockTypeId: 'Generator', displayName: 'Generator', inputPorts: [], outputPorts: [],
      parameters: names.map((name) => ({ name, label: name, mutable: true, readOnly: name === 'readOnly', valueKind: 'scalar', valueType: 'float',
        updatePolicy: name === 'live' || name === 'invalid' || name === 'readOnly' ? 'live' : name === 'stopped' ? 'stopped' : name === 'topology' ? 'topology' : undefined })) };
    return { document, node, details };
  }

  it('stages only eligible dependents, explains mixed dependencies, and preserves the saved graph', async () => {
    const { document, node, details } = setup();
    document.graph.nodes[0].parameters.literal = { kind: 'literal', value: 123 };
    details.parameters.push({ name: 'literal', label: 'Literal', mutable: true, readOnly: false, valueType: 'float', valueKind: 'scalar', updatePolicy: 'live' });
    const before = JSON.stringify(document);
    const resolved = resolveGraphVariables(document, { variableOverridesByName: { frequency: { kind: 'literal', value: 25 } } });
    const plan = resolveRuntimeSettingPropagation([node], new Map([['Generator', details]]), resolved);
    const send = vi.fn().mockResolvedValue(undefined);
    const feedback = await stageRuntimeSettingPropagation(plan, send);
    expect(send).toHaveBeenCalledExactlyOnceWith('generator', { live: 50 });
    expect(feedback).toContain('Staged 1');
    expect(feedback).toContain('before starting');
    expect(feedback).toContain('reconfiguration');
    expect(feedback).toContain('Live updates are not declared');
    expect(feedback).toContain('missing');
    expect(feedback).toContain('read-only');
    expect(feedback).not.toContain('applied');
    expect(JSON.stringify(document)).toBe(before);
    expect(resolved.variablesByName.frequency.value).toBe(25);
  });

  it('explains missing metadata and propagates request failures instead of reporting success', async () => {
    const { document, node, details } = setup();
    const resolved = resolveGraphVariables(document);
    const missing = resolveRuntimeSettingPropagation([node], new Map(), resolved);
    expect(missing.updates).toEqual([]);
    expect(missing.skipped.join(' ')).toContain('metadata');
    const plan = resolveRuntimeSettingPropagation([node], new Map([['Generator', details]]), resolved);
    await expect(stageRuntimeSettingPropagation(plan, vi.fn().mockRejectedValue(new Error('rejected')))).rejects.toThrow('rejected');
  });
});
