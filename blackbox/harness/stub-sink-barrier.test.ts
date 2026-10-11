import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStubSink } from "./harness-flow";

describe("startStubSink barrier state", () => {
  let root: string;
  let server: ReturnType<typeof startStubSink>;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "stub-sink-barrier-"));
    server = startStubSink(join(root, "counters"), join(root, "log.ndjson"));
  });
  afterAll(() => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  const arrive = async (name: string, parties: number, timeoutMs: number): Promise<boolean> => {
    const res = await fetch(`http://127.0.0.1:${server.port}/barrier`, {
      method: "POST",
      body: JSON.stringify({ name, parties, timeoutMs }),
    });
    return ((await res.json()) as { released: boolean }).released;
  };

  test("a timed-out party no longer counts toward a later arrival at the same name", async () => {
    expect(await arrive("stale", 2, 100)).toBe(false);
    // Only one party is waiting now, so a 2-party barrier must not release.
    expect(await arrive("stale", 2, 100)).toBe(false);
  });

  test("a released barrier starts from zero when its name is reused", async () => {
    const pair = await Promise.all([arrive("reuse", 2, 5000), arrive("reuse", 2, 5000)]);
    expect(pair).toEqual([true, true]);
    expect(await arrive("reuse", 2, 100)).toBe(false);
  });
});
