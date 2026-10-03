/**
 * fake-opencode: smoke test.
 *
 * The journey only ever sends the right password, so this drives the fake
 * directly to prove its Basic-auth check is real: a wrong password and a
 * missing header get 401 and an `auth-rejected` log line, and the right one
 * opens the event stream.
 *
 * BLACK-BOX RULE: zero imports from src/.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeOpenCodeLogEntry } from "./fake-opencode";

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
