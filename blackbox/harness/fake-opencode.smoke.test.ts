/**
 * fake-opencode: smoke test.
 *
 * The journey only ever sends the right password, so this drives the fake
 * directly to prove its Basic-auth check is real: a wrong password and a
 * missing header get 401 and an `auth-rejected` log line, and the right one
 * opens the event stream. With a stub sink (harness-flow's `stubSink`), the
 * call number and every log line go over HTTP, a barrier releases two calls
 * only when both are running, and a bash command's exit code is logged.
 *
 * BLACK-BOX RULE: zero imports from src/.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeOpenCodeCall, FakeOpenCodeLogEntry } from "./fake-opencode";
import { startStubSink } from "./harness-flow";

const FAKE_OPENCODE = join(import.meta.dir, "fake-opencode.ts");
const PASSWORD = "smoke-password";

describe("fake-opencode: Basic auth on every request", () => {
  const root = mkdtempSync(join(tmpdir(), "conduit-bb-fake-opencode-"));
  const logPath = join(root, "invocations.ndjson");
  const scenarioPath = join(root, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify({ stateDir: join(root, "counters"), logPath, roles: [] }));
  const proc = Bun.spawn([process.execPath, FAKE_OPENCODE, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    env: { ...process.env, FAKE_OPENCODE_SCENARIO: scenarioPath, OPENCODE_SERVER_PASSWORD: PASSWORD },
    stdout: "pipe",
    stderr: "ignore",
  });

  afterAll(async () => {
    proc.kill("SIGKILL");
    await proc.exited;
    rmSync(root, { recursive: true, force: true });
  });

  /** The origin from the listening line, the same line the adapter reads. */
  async function origin(): Promise<string> {
    const reader = proc.stdout.getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`fake-opencode exited before listening: ${text}`);
      text += new TextDecoder().decode(value);
      const m = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text);
      if (m) {
        reader.releaseLock();
        return m[1]!;
      }
    }
  }

  test("a wrong or missing password gets 401 and is logged; the right one opens the event stream", async () => {
    const base = await origin();
    const basic = (pw: string) => `Basic ${btoa(`opencode:${pw}`)}`;

    const wrong = await fetch(`${base}/session`, { method: "POST", headers: { authorization: basic("wrong") } });
    expect(wrong.status).toBe(401);
    const missing = await fetch(`${base}/event`);
    expect(missing.status).toBe(401);

    const abort = new AbortController();
    const ok = await fetch(`${base}/event`, { headers: { authorization: basic(PASSWORD) }, signal: abort.signal });
    expect(ok.status).toBe(200);
    const first = await ok.body!.getReader().read();
    expect(new TextDecoder().decode(first.value)).toContain(`"type":"server.connected"`);
    abort.abort();

    const rejected = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as FakeOpenCodeLogEntry)
      .filter((e) => e.kind === "auth-rejected")
      .map((e) => (e as { method: string; path: string }).method + " " + (e as { path: string }).path);
    expect(rejected).toEqual(["POST /session", "GET /event"]);
  });
});

/**
 * One call against a fresh fake server, as the adapter makes it: open the
 * event stream, create the session, post the prompt, answer every permission
 * ask `once`, and stop at `session.idle`. Resolves with the event types seen.
 */
async function driveCall(cwd: string, scenarioPath: string): Promise<string[]> {
  const proc = Bun.spawn([process.execPath, FAKE_OPENCODE, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_OPENCODE_SCENARIO: scenarioPath, OPENCODE_SERVER_PASSWORD: PASSWORD },
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const reader = proc.stdout.getReader();
    let text = "";
    let base: string | undefined;
    while (base === undefined) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`fake-opencode exited before listening: ${text}`);
      text += new TextDecoder().decode(value);
      base = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1];
    }
    reader.releaseLock();
    const headers = { authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}`, "content-type": "application/json" };
    const abort = new AbortController();
    const events = await fetch(`${base}/event`, { headers, signal: abort.signal });
    const session = (await (await fetch(`${base}/session`, { method: "POST", headers, body: "{}" })).json()) as { id: string };
    const posted = await fetch(`${base}/session/${session.id}/prompt_async`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: { providerID: "openai", modelID: "m" }, parts: [{ type: "text", text: "ROLE:MAKER go" }] }),
    });
    expect(posted.status).toBe(204);
    const seen: string[] = [];
    const sse = events.body!.getReader();
    let carry = "";
    outer: for (;;) {
      const { done, value } = await sse.read();
      if (done) break;
      carry += new TextDecoder().decode(value);
      let end: number;
      while ((end = carry.indexOf("\n\n")) >= 0) {
        const event = JSON.parse(carry.slice(0, end).replace(/^data: /, "")) as { type: string; properties: Record<string, any> };
        carry = carry.slice(end + 2);
        seen.push(event.type);
        if (event.type === "permission.asked") {
          await fetch(`${base}/permission/${event.properties.id}/reply`, { method: "POST", headers, body: JSON.stringify({ reply: "once" }) });
        }
        if (event.type === "session.idle") break outer;
      }
    }
    abort.abort();
    return seen;
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

describe("fake-opencode: the stub sink", () => {
  const root = mkdtempSync(join(tmpdir(), "conduit-bb-fake-opencode-sink-"));
  const logPath = join(root, "invocations.ndjson");
  const server = startStubSink(join(root, "counters"), logPath);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });

  afterAll(() => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  const scenario = (name: string, calls: FakeOpenCodeCall[]): string => {
    const path = join(root, `${name}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        // Neither file-based path exists: everything has to go through the sink.
        stateDir: join(root, "no-counters", "x"),
        logPath: join(root, "no-log", "invocations.ndjson"),
        sinkUrl: `http://127.0.0.1:${server.port}`,
        roles: [{ name: "maker", promptIncludes: "ROLE:MAKER", calls }],
      }),
    );
    return path;
  };
  const read = (): FakeOpenCodeLogEntry[] =>
    readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeOpenCodeLogEntry);

  test("a barrier releases two calls only once both are running, and every line goes through the sink", async () => {
    const meet = { barrier: { name: "pair", parties: 2, timeoutMs: 10_000 } };
    const pair = scenario("pair", [
      { ...meet, steps: [{ type: "bash", command: "true" }, { type: "bash", command: "exit 3" }] },
      { ...meet, steps: [] },
    ]);
    const seen = await Promise.all([driveCall(cwd, pair), driveCall(cwd, pair)]);
    for (const s of seen) expect(s.at(-1)).toBe("session.idle");

    const log = read();
    expect(log.filter((e) => e.kind === "serve")).toHaveLength(2);
    // The sink's counter numbered the two calls, and both were released by the other's arrival.
    const done = log.filter((e): e is Extract<FakeOpenCodeLogEntry, { kind: "done" }> => e.kind === "done");
    expect(done.map((e) => e.call).sort()).toEqual([1, 2]);
    expect(done.map((e) => e.barrierReleased)).toEqual([true, true]);
    for (const e of done) expect(e.endedAt).toBeGreaterThanOrEqual(e.startedAt);
    const answers = log.filter((e): e is Extract<FakeOpenCodeLogEntry, { kind: "answer" }> => e.kind === "answer");
    expect(answers.map((a) => [a.call, a.step, a.reply, a.performed, a.exitCode])).toEqual([
      [1, 0, "once", true, 0],
      [1, 1, "once", true, 3],
    ]);
    expect(existsSync(join(root, "no-log"))).toBe(false);
    expect(existsSync(join(root, "no-counters"))).toBe(false);
  }, 30_000);

  test("a barrier no second call reaches times out, and the call still completes", async () => {
    const seen = await driveCall(cwd, scenario("alone", [{ barrier: { name: "alone", parties: 2, timeoutMs: 200 }, steps: [] }]));
    expect(seen.at(-1)).toBe("session.idle");
    const last = read().filter((e) => e.kind === "done").at(-1) as Extract<FakeOpenCodeLogEntry, { kind: "done" }>;
    expect(last.barrierReleased).toBe(false);
  }, 30_000);
});
