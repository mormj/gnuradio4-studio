import type { EditorGraphNode } from '../../graph-editor/model/types';
import type { StudioVariable } from '../../graph-document/model/studio-workspace';
import { graphDocumentFromEditor } from '../../graph-document/model/fromEditor';
import { resolveGraphVariables } from '../../variables/model/resolveGraphVariables';

/** Invalid expressions remain present as empty values, so count defaults cannot mask them. */
export function resolvePortParameterValues(nodes: EditorGraphNode[], variables?: StudioVariable[]) {
  const document = graphDocumentFromEditor({ metadata: { name: '', studioVariables: variables }, nodes, edges: [] });
  const resolved = resolveGraphVariables(document);
  return Object.fromEntries(nodes.map((node) => [node.instanceId,
    Object.fromEntries(Object.entries(node.parameters).map(([name, parameter]) => {
      const value = resolved.parametersByNodeId[node.instanceId]?.[name];
      return [name, parameter.bindingKind === 'expression'
        ? value?.state === 'resolved' ? String(value.value) : ''
        : parameter.value];
    })),
  ]));
}
