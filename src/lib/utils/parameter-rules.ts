import type { BlockParameterMeta } from '../api/block-details';

export function isParameterEnabled(
  parameter: Pick<BlockParameterMeta, 'enabledWhen'>,
  values: Readonly<Record<string, unknown>>,
): boolean {
  const rule = parameter.enabledWhen;
  if (!rule) return true;
  if (typeof rule.value !== 'boolean') return false;
  const value = values[rule.parameter];
  return value === rule.value || (typeof value === 'string' && value.trim() === String(rule.value));
}

export function parameterConditionDescription(parameter: Pick<BlockParameterMeta, 'enabledWhen'>): string {
  const rule = parameter.enabledWhen;
  return rule ? `Enabled when ${rule.parameter} is ${rule.value ?? 'known'}.` : '';
}
