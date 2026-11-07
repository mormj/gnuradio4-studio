/** Drain the existing latest-value queue, checking eligibility before each unsent request. */
export async function flushControlWidgetWrites<T>(
  queue: { current: { value: T } | null },
  isEligible: () => boolean,
  write: (value: T) => Promise<unknown>,
): Promise<void> {
  while (queue.current !== null) {
    if (!isEligible()) {
      queue.current = null;
      return;
    }
    const pending = queue.current.value;
    queue.current = null;
    await write(pending);
  }
}
