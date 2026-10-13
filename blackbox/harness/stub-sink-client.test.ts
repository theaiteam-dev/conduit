import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { claimSinkCallNumber, sinkLog, sinkPost } from "./stub-sink-client";

// A sink that accepts each request and never answers, as a wedged stub sink would.
describe("stub sink client against a sink that never answers", () => {
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
  });

  const settleMs = async (p: Promise<unknown>): Promise<{ rejected: boolean; ms: number }> => {
    const t = performance.now();
    const rejected = await p.then(
      () => false,
      () => true,
    );
    return { rejected, ms: performance.now() - t };
  };

  test("sinkPost rejects once its timeout passes", async () => {
    const r = await settleMs(sinkPost(url, "/call", "{}", 200));
    expect(r.rejected).toBe(true);
    expect(r.ms).toBeLessThan(5_000);
  });

  test("claimSinkCallNumber rejects instead of hanging", async () => {
    const r = await settleMs(claimSinkCallNumber(url, "maker", 200));
    expect(r.rejected).toBe(true);
    expect(r.ms).toBeLessThan(5_000);
  });

  test("sinkLog rejects instead of hanging", async () => {
    const r = await settleMs(sinkLog(url, { role: "maker" }, 200));
    expect(r.rejected).toBe(true);
    expect(r.ms).toBeLessThan(5_000);
  });
});
