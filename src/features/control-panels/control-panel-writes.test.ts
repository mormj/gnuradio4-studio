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
