/**
 * Await a batch of in-process calls (the transform batch and the harness
 * overlap batch in `runExecutor`) and return their results in order.
 *
 * `Promise.all` rejects at the first rejection while the other members are
 * still running, so the executor could return, or the run end, with a
 * member still writing card state. This waits for every member to settle,
 * then rethrows the first rejection in member order. Each later rejection is
 * passed to `onOtherRejection` first, so the caller can report it.
 */
export async function allSettledOrThrow<T>(
  promises: readonly Promise<T>[],
  onOtherRejection?: (reason: unknown, index: number) => void,
): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const results: T[] = [];
  let first: { reason: unknown } | undefined;
  settled.forEach((s, index) => {
    if (s.status === 'fulfilled') results.push(s.value);
    else if (first === undefined) first = { reason: s.reason };
    else onOtherRejection?.(s.reason, index);
  });
  if (first !== undefined) throw first.reason;
  return results;
}
