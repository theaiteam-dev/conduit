/**
 * fake-codex-app-server: smoke test.
 *
 * Drives the fake directly over stdio, as a JSON-RPC client, so a journey
 * failure can be told apart from a broken fake: `--version` answers without a
 * scenario (the adapter's probe passes only PATH and HOME), and inside a turn
 * the fake performs a step's effect only when the client answers `accept`,
 * logging every decision it received. With a stub sink (harness-flow's
 * `stubSink`), the call number and log line go over HTTP, a barrier releases
 * two turns only when both are running, and an accepted command's exit code
 * is logged.
 *
 * BLACK-BOX RULE: zero imports from src/.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeCodexCall, FakeCodexLogEntry } from "./fake-codex-app-server";
import { startStubSink } from "./harness-flow";

const FAKE = join(import.meta.dir, "fake-codex-app-server.ts");

type Json = Record<string, any>;

/**
 * One turn against the fake as a JSON-RPC client: the handshake, then each
 * approval answered by `decide` (given the approval's index), until
 * turn/completed. Resolves with every message received and the exit code.
 */
async function driveTurn(
  cwd: string,
  scenarioPath: string,
  decide: (index: number) => string,
  prompt = "ROLE:MAKER go",
): Promise<{ received: Json[]; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, FAKE, "app-server"], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_CODEX_SCENARIO: scenarioPath },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const write = (m: Json): void => {
    proc.stdin.write(JSON.stringify(m) + "\n");
    proc.stdin.flush();
  };
  const received: Json[] = [];
  let approvals = 0;
  write({ method: "initialize", id: 1, params: {} });
  write({ method: "thread/start", id: 2, params: { model: "m" } });
  write({ method: "turn/start", id: 3, params: { threadId: "thr-fake-root", input: [{ type: "text", text: prompt }] } });
  const decoder = new TextDecoder();
  let carry = "";
  outer: for await (const chunk of proc.stdout) {
    carry += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = carry.indexOf("\n")) >= 0) {
      const m = JSON.parse(carry.slice(0, nl)) as Json;
      carry = carry.slice(nl + 1);
      received.push(m);
      if (typeof m.method === "string" && m.method.endsWith("/requestApproval")) {
        write({ id: m.id, result: { decision: decide(approvals++) } });
      }
      if (m.method === "turn/completed") break outer;
    }
  }
  proc.stdin.end();
  return { received, exitCode: await proc.exited };
}

describe("fake-codex-app-server", () => {
  const root = mkdtempSync(join(tmpdir(), "conduit-bb-fake-codex-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("--version prints a codex version with no scenario in the env", async () => {
    const proc = Bun.spawn([process.execPath, FAKE, "--version"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^codex-cli \d+\.\d+\.\d+$/);
  });

  test("an accepted write happens, a declined one does not, and both decisions are logged", async () => {
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    const logPath = join(root, "invocations.ndjson");
    const scenarioPath = join(root, "scenario.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        stateDir: join(root, "counters"),
        logPath,
        roles: [
          {
            name: "maker",
            promptIncludes: "ROLE:MAKER",
            calls: [
              {
                steps: [
                  { label: "yes", write: { path: "a.txt", content: "a" } },
                  { label: "no", write: { path: "b.txt", content: "b" } },
                ],
                usage: { inputTokens: 10, outputTokens: 2 },
              },
            ],
          },
        ],
      }),
    );
    // Accept the first approval and decline the rest.
    const { received, exitCode } = await driveTurn(cwd, scenarioPath, (i) => (i === 0 ? "accept" : "decline"));
    expect(exitCode).toBe(0);

    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(cwd, "b.txt"))).toBe(false);
    expect(received.find((m) => m.method === "thread/tokenUsage/updated")?.params.tokenUsage.total).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
    const log = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeCodexLogEntry);
    expect(log).toHaveLength(1);
    expect(log[0]!.decisions.map((d) => [d.label, d.decision])).toEqual([
      ["yes", "accept"],
      ["no", "decline"],
    ]);
    expect(log[0]!.threadStart).toEqual({ model: "m" });
  });

  test("with a stub sink, a barrier releases two turns only once both are running, and both log through the sink", async () => {
    const sinkDir = join(root, "sink");
    const cwd = join(sinkDir, "project");
    mkdirSync(cwd, { recursive: true });
    const logPath = join(sinkDir, "invocations.ndjson");
    const server = startStubSink(join(sinkDir, "counters"), logPath);
    try {
      const scenario = (calls: FakeCodexCall[]): string => {
        const path = join(sinkDir, `scenario-${calls.length}.json`);
        writeFileSync(
          path,
          JSON.stringify({
            // Neither file-based path exists: everything has to go through the sink.
            stateDir: join(sinkDir, "no-counters", "x"),
            logPath: join(sinkDir, "no-log", "invocations.ndjson"),
            sinkUrl: `http://127.0.0.1:${server.port}`,
            roles: [{ name: "maker", promptIncludes: "ROLE:MAKER", calls }],
          }),
        );
        return path;
      };
      const meet = { barrier: { name: "pair", parties: 2, timeoutMs: 10_000 } };
      const pair = scenario([
        { ...meet, steps: [{ label: "ok", command: "true" }, { label: "fails", command: "exit 3" }] },
        { ...meet, steps: [] },
      ]);
      const [a, b] = await Promise.all([driveTurn(cwd, pair, () => "accept"), driveTurn(cwd, pair, () => "accept")]);
      expect([a.exitCode, b.exitCode]).toEqual([0, 0]);
      const log = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeCodexLogEntry);
      // The sink's counter numbered the two turns, and both were released by the other's arrival.
      expect(log.map((e) => e.call).sort()).toEqual([1, 2]);
      expect(log.map((e) => e.barrierReleased)).toEqual([true, true]);
      for (const e of log) expect(e.endedAt).toBeGreaterThanOrEqual(e.startedAt);
      const first = log.find((e) => e.call === 1)!;
      expect(first.decisions.map((d) => [d.label, d.decision, d.exitCode])).toEqual([
        ["ok", "accept", 0],
        ["fails", "accept", 3],
      ]);
      expect(existsSync(join(sinkDir, "no-log"))).toBe(false);
      expect(existsSync(join(sinkDir, "no-counters"))).toBe(false);

      // A barrier no second turn reaches times out, and the turn still completes.
      const alone = await driveTurn(cwd, scenario([{ barrier: { name: "alone", parties: 2, timeoutMs: 200 } }]), () => "accept");
      expect(alone.exitCode).toBe(0);
      expect(alone.received.some((m) => m.method === "turn/completed")).toBe(true);
      const last = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeCodexLogEntry).at(-1)!;
      expect(last.barrierReleased).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
