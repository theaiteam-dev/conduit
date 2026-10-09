/**
 * PR #121 review: a batch of in-process calls (the transform batch, the
 * harness overlap batch) must not hand control back while a member is still
 * running, even when another member threw.
 */
import { describe, it, expect } from 'bun:test';
import { allSettledOrThrow } from './settle-all';

describe('allSettledOrThrow', () => {
  it('returns every result in order when all resolve', async () => {
    expect(await allSettledOrThrow([Promise.resolve(1), Promise.resolve(2)])).toEqual([1, 2]);
  });

  it('waits for a slower member before rethrowing an earlier rejection', async () => {
    let slowFinished = false;
    const slow = new Promise<number>((res) =>
      setTimeout(() => {
        slowFinished = true;
        res(2);
      }, 30),
    );
    const failing = Promise.reject(new Error('member threw'));
    await expect(allSettledOrThrow([failing, slow])).rejects.toThrow('member threw');
    expect(slowFinished).toBe(true);
  });

  it('rethrows the first rejection in member order when several reject', async () => {
    const late = new Promise<number>((_, rej) => setTimeout(() => rej(new Error('first member')), 20));
    const early = Promise.reject(new Error('second member'));
    await expect(allSettledOrThrow([late, early])).rejects.toThrow('first member');
  });
});
