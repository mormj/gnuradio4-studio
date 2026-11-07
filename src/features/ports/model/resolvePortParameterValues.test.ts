import { expect, it } from 'vitest';
import type { EditorGraphNode } from '../../graph-editor/model/types';
import { resolvePortParameterValues } from './resolvePortParameterValues';
import { resolveRenderedPorts } from './resolveRenderedPorts';

it('updates port counts from graph expressions and preserves unresolved expressions', () => {
  const node: EditorGraphNode = {
    instanceId: 'node', blockTypeId: 'test', displayName: 'Test', position: { x: 0, y: 0 },
    parameters: { count: { bindingKind: 'expression', value: 'channels * 2' } },
  };
  const parameters = resolvePortParameterValues([node], [
    { id: 'channels', name: 'channels', binding: { kind: 'literal', value: 3 } },
  ]);
  const schema = [{ name: 'in', direction: 'input' as const, cardinalityKind: 'dynamic' as const,
    sizeParameter: 'count', renderPortCount: 1 }];
  expect(resolveRenderedPorts({ schemaPorts: schema, parameterValues: parameters.node }).inputs).toHaveLength(6);
  const unresolved = resolvePortParameterValues([node]);
  expect(unresolved.node.count).toBe('');
  expect(resolveRenderedPorts({ schemaPorts: schema, parameterValues: unresolved.node }).inputs[0].connectable).toBe(false);
});
