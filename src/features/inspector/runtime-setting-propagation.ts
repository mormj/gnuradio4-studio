import type { BlockDetails } from '../../lib/api/block-details';
import type { RuntimeSettingsObject } from '../../lib/api/block-settings';
import type { EditorGraphNode } from '../graph-editor/model/types';
import type { ResolvedGraphVariables } from '../variables/model/resolveGraphVariables';
import { runtimeSettingEditReason, shouldPropagateResolvedRuntimeSetting } from './runtime-settings-model';

export function resolveRuntimeSettingPropagation(
  nodes: readonly EditorGraphNode[],
  detailsByType: ReadonlyMap<string, BlockDetails>,
  resolved: ResolvedGraphVariables,
): { updates: { nodeId: string; patch: RuntimeSettingsObject }[]; skipped: string[] } {
  const skipped: string[] = [];
  const updates = nodes.flatMap((node) => {
    const details = detailsByType.get(node.blockTypeId);
    const patch: RuntimeSettingsObject = {};
    for (const [name, value] of Object.entries(resolved.parametersByNodeId[node.instanceId] ?? {})) {
      const parameter = details?.parameters.find((entry) => entry.name === name);
      const reason = value.value === undefined || (value.state !== 'resolved' && value.state !== 'literal')
        ? value.reason ?? 'Expression is unresolved.'
        : runtimeSettingEditReason(parameter) ?? (
          !shouldPropagateResolvedRuntimeSetting({ name, bindingKind: value.binding.kind, updatePolicy: parameter?.updatePolicy })
            ? 'Live updates are not declared; run the graph again to use this value.' : undefined);
      if (reason) {
        if (value.binding.kind === 'expression') skipped.push(`${node.displayName || node.instanceId}.${name}: ${reason}`);
        continue;
      }
      patch[name] = value.value!;
    }
    return Object.keys(patch).length ? [{ nodeId: node.instanceId, patch }] : [];
  });
  return { updates, skipped };
}

export async function stageRuntimeSettingPropagation(
  plan: ReturnType<typeof resolveRuntimeSettingPropagation>,
  send: (nodeId: string, patch: RuntimeSettingsObject) => Promise<unknown>,
): Promise<string> {
  await Promise.all(plan.updates.map(({ nodeId, patch }) => send(nodeId, patch)));
  const count = plan.updates.reduce((total, { patch }) => total + Object.keys(patch).length, 0);
  return [count ? `Staged ${count} runtime setting update(s).` : 'No runtime setting updates were staged.',
    ...plan.skipped.map((reason) => `Not staged: ${reason}`)].join(' ');
}
