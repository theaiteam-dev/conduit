/**
 * Await a batch of in-process calls (the transform batch and the harness
 * overlap batch in `runExecutor`) and return their results in order.
 *
 * `Promise.all` rejects at the first rejection while the other members are
 * still running, so the executor could return, or the run end, with a
 * member still writing card state. This waits for every member to settle,
 * then rethrows the first rejection in member order.
 */
export async function allSettledOrThrow<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const results: T[] = [];
  for (const s of settled) {
    if (s.status === 'rejected') throw s.reason;
    results.push(s.value);
  }
  return results;
}
