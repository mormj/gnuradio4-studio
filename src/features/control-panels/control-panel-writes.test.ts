import { describe, expect, it, vi } from 'vitest';
import { controlWidgetWriteReason, type ResolvedControlWidget } from './control-panel-binding-resolution';
import { flushControlWidgetWrites } from './control-panel-writes';

function widget(updatePolicy?: NonNullable<ResolvedControlWidget['parameterMeta']>['updatePolicy'], readOnly = false): ResolvedControlWidget {
  return { id: 'interval', label: 'Interval', inputKind: 'number', currentValue: '100',
    binding: { kind: 'parameter', nodeId: 'sink', parameterName: 'update_ms' },
    state: 'ready', runtimeSessionId: 'session', runtimeReadable: true,
    parameterMeta: { name: 'update_ms', label: 'Interval', valueType: 'int', valueKind: 'scalar', mutable: true, readOnly, updatePolicy } };
}

describe('control widget mutation dispatch', () => {
  it('uses runtime autoscale, preserves manual bounds, and reevaluates before queued dispatch', async () => {
    const bound: ResolvedControlWidget = { ...widget('live'), currentValue: '-80',
      binding: { kind: 'parameter', nodeId: 'waterfall', parameterName: 'z_min' },
      parameterMeta: { ...widget('live').parameterMeta!, name: 'z_min', enabledWhen: { parameter: 'autoscale', value: false } } };
    const mutation = vi.fn().mockResolvedValue(undefined);
    for (const values of [{ autoscale: true }, {}, { autoscale: 'unresolved' }]) {
      expect(controlWidgetWriteReason(bound, values)).toContain('autoscale');
      const queue = { current: { value: -90 } };
      await flushControlWidgetWrites(queue, () => controlWidgetWriteReason(bound, values) === undefined, mutation);
      expect(mutation).not.toHaveBeenCalled();
      expect(bound.runtimeReadable).toBe(true);
      expect(bound.currentValue).toBe('-80');
    }
    for (const values of [{ autoscale: false }, { autoscale: 'false' }]) {
      expect(controlWidgetWriteReason(bound, values)).toBeUndefined();
    }
    expect(mutation).not.toHaveBeenCalled(); // Reenabling does not send or reset a value.
    await flushControlWidgetWrites({ current: { value: -90 } }, () => controlWidgetWriteReason(bound, { autoscale: false }) === undefined, mutation);
    expect(mutation).toHaveBeenCalledExactlyOnceWith(-90);
    expect(controlWidgetWriteReason({ ...bound, parameterMeta: { ...bound.parameterMeta!, updatePolicy: 'stopped' } }, { autoscale: false })).toContain('before starting');
    expect(controlWidgetWriteReason({ ...bound, parameterMeta: { ...bound.parameterMeta!, updatePolicy: 'topology' } }, { autoscale: false })).toContain('reconfiguration');
  });

  it('drops an unsent manual bound when runtime autoscale changes while a request is pending', async () => {
    const bound: ResolvedControlWidget = { ...widget('live'), parameterMeta: { ...widget('live').parameterMeta!, enabledWhen: { parameter: 'autoscale', value: false } } };
    let values = { autoscale: false };
    let finish!: () => void;
    const mutation = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const queue = { current: { value: -80 } as { value: number } | null };
    const pending = flushControlWidgetWrites(queue, () => controlWidgetWriteReason(bound, values) === undefined, mutation);
    queue.current = { value: -90 };
    values = { autoscale: true };
    finish();
    await pending;
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(queue.current).toBeNull();
  });

  it.each(['stopped', 'topology'] as const)('does not dispatch %s writes even from a ready callback', async (policy) => {
    const queue = { current: { value: 20 } as { value: number } | null };
    const mutation = vi.fn().mockResolvedValue(undefined);
    await flushControlWidgetWrites(queue, () => controlWidgetWriteReason(widget(policy)) === undefined, mutation);
    expect(mutation).not.toHaveBeenCalled();
    expect(queue.current).toBeNull();
  });

  it('dispatches live writes and preserves unspecified manual editing', async () => {
    for (const policy of ['live', undefined] as const) {
      const mutation = vi.fn().mockResolvedValue(undefined);
      await flushControlWidgetWrites({ current: { value: 20 } }, () => controlWidgetWriteReason(widget(policy)) === undefined, mutation);
      expect(mutation).toHaveBeenCalledWith(20);
    }
    expect(controlWidgetWriteReason(widget('live', true))).toContain('read-only');
    expect(controlWidgetWriteReason({ ...widget(), parameterMeta: undefined })).toContain('metadata');
  });

  it('discards an unsent queued write when eligibility changes during a request', async () => {
    let eligible = true;
    let finish!: () => void;
    const queue = { current: { value: 1 } as { value: number } | null };
    const mutation = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = flushControlWidgetWrites(queue, () => eligible, mutation);
    queue.current = { value: 2 };
    eligible = false;
    finish();
    await pending;
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(queue.current).toBeNull();
  });
});
