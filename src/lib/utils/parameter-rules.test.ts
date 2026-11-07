import { expect, it } from 'vitest';
import { isParameterEnabled } from './parameter-rules';

it('evaluates boolean presentation conditions without changing stored values', () => {
  const parameter = { enabledWhen: { parameter: 'automatic', value: false } };
  const values = { automatic: 'false', bound: '1.5' };
  expect(isParameterEnabled(parameter, values)).toBe(true);
  expect(isParameterEnabled(parameter, { automatic: true })).toBe(false);
  expect(isParameterEnabled(parameter, { automatic: '' })).toBe(false);
  expect(isParameterEnabled(parameter, {})).toBe(false);
  expect(isParameterEnabled({}, {})).toBe(true);
  expect(values.bound).toBe('1.5');
});
