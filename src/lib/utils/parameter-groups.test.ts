import { describe, expect, it } from 'vitest';
import { isAdvancedParameter, isAdvancedUiHint, isReadOnlyRuntimeMutability } from './parameter-groups';

describe('parameter group helpers', () => {
  it('uses reflected presentation metadata and keeps absent metadata visible', () => {
    expect(isAdvancedParameter({ visible: false })).toBe(true);
    expect(isAdvancedParameter({ visible: true })).toBe(false);
    expect(isAdvancedParameter({})).toBe(false);
  });

  it('matches advanced ui hints', () => {
    expect(isAdvancedUiHint('advanced')).toBe(true);
    expect(isAdvancedUiHint('show:advanced')).toBe(true);
    expect(isAdvancedUiHint('Advanced only')).toBe(true);
    expect(isAdvancedUiHint('')).toBe(false);
    expect(isAdvancedUiHint(undefined)).toBe(false);
  });

  it('matches read-only runtime mutability variants', () => {
    expect(isReadOnlyRuntimeMutability('immutable')).toBe(true);
    expect(isReadOnlyRuntimeMutability('read_only')).toBe(true);
    expect(isReadOnlyRuntimeMutability('readonly')).toBe(true);
    expect(isReadOnlyRuntimeMutability('const')).toBe(true);
    expect(isReadOnlyRuntimeMutability('fixed')).toBe(true);
    expect(isReadOnlyRuntimeMutability('mutable')).toBe(false);
    expect(isReadOnlyRuntimeMutability(undefined)).toBe(false);
  });
});
