/**
 * The fakes' side of harness-flow's stub sink (`stubSink`, `startStubSink`).
 *
 * A write-confined call (issue #122) can write only inside its writable set,
 * which never holds the workspace's stub dir, so a confined fake cannot claim
 * a counter file or append to the log. With `sinkUrl` in its scenario it
 * calls these instead, and the sink writes the same files. Shared by
 * fake-claude-sdk, fake-codex-app-server and fake-opencode.
 *
 * Imports nothing but node builtins, so a fake that loads it stays a plain
 * bun script.
 */

type Json = Record<string, any>;

/** Bounded, so a stalled sink fails the call instead of hanging it. A barrier post passes its own wait plus a margin. */
export async function sinkPost(sinkUrl: string, path: string, body: string, timeoutMs = 30_000): Promise<Json> {
  const res = await fetch(`${sinkUrl}${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`stub sink ${path} answered ${res.status}`);
  return (await res.json()) as Json;
}

/** The sink's call number for `role`. A malformed answer fails the call rather than running the default scenario. */
export async function claimSinkCallNumber(sinkUrl: string, role: string): Promise<number> {
  const claim = (await sinkPost(sinkUrl, "/call", JSON.stringify({ role }))).call;
  // Check the type before the value: Number() would coerce true, [3] and "3\n" into a valid-looking call number.
  if (typeof claim !== "number" || !Number.isInteger(claim) || claim < 1) {
    throw new Error(`stub sink /call returned a bad call number: ${JSON.stringify(claim)}`);
  }
  return claim;
}

/** A call's barrier: wait until `parties` calls have reached `name`, or `timeoutMs` (default 15000) has passed. */
export interface SinkBarrier {
  name: string;
  parties: number;
  timeoutMs?: number;
}

/** True when the barrier released this call, false when it timed out. */
export async function awaitSinkBarrier(sinkUrl: string, barrier: SinkBarrier): Promise<boolean> {
  const waitMs = (barrier.timeoutMs ?? 15_000) + 30_000;
  const answer = await sinkPost(sinkUrl, "/barrier", JSON.stringify(barrier), waitMs);
  // A body without a boolean `released` is a broken sink, not a barrier that timed out.
  if (typeof answer.released !== "boolean") throw new Error(`stub sink /barrier returned a bad answer: ${JSON.stringify(answer)}`);
  return answer.released;
}

/** Append one log entry through the sink. */
export async function sinkLog(sinkUrl: string, entry: unknown): Promise<void> {
  await sinkPost(sinkUrl, "/log", JSON.stringify(entry));
}
