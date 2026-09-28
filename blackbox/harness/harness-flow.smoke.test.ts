/**
 * Harness-flow scaffolding — smoke test.
 *
 * fake-claude appends to invocations.ndjson from its own process, so a read
 * that races a write can see a truncated final line. cleanup() reads that log
 * to find orphaned stubs, and a throw there must not leak the temp root. The
 * reap itself must kill a live stub and leave a recycled pid alone.
 *
 * BLACK-BOX RULE: zero imports from src/.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isOrphanedStub, pidAlive, startHarnessFlow } from "./harness-flow";

const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");
const IDLE = "setTimeout(() => {}, 30_000)";

function scaffold() {
  return startHarnessFlow({
    flowYaml: "name: unused\n",
    files: {},
    entryInput: "topic.md",
    roles: [],
  });
}

describe("startHarnessFlow — stub log and cleanup", () => {
  test("stubLog() skips a partially written trailing line", async () => {
    const f = scaffold();
    try {
      const logPath = join(f.root, "stub", "invocations.ndjson");
      mkdirSync(join(f.root, "stub"), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify({ role: "maker", call: 1, pid: 999999999 })}\n{"role":"mak`);
      expect(f.stubLog().map((e) => `${e.role}#${e.call}`)).toEqual(["maker#1"]);
    } finally {
      await f.cleanup();
    }
  });

  test("cleanup() removes the temp root even when a truncated log line is present", async () => {
    const f = scaffold();
    appendFileSync(join(f.root, "stub", "invocations.ndjson"), `{"role":"mak`);
    await f.cleanup();
    expect(existsSync(f.root)).toBe(false);
  });

  test("isOrphanedStub() matches a live fake-claude process only", async () => {
    const stub = Bun.spawn([process.execPath, "-e", IDLE, FAKE_CLAUDE]);
    // The recycled-pid case: a live process that is not a stub.
    const other = Bun.spawn([process.execPath, "-e", IDLE]);
    try {
      await Bun.sleep(100);
      expect(isOrphanedStub(stub.pid)).toBe(true);
      expect(isOrphanedStub(other.pid)).toBe(false);
    } finally {
      stub.kill("SIGKILL");
      other.kill("SIGKILL");
      await Promise.all([stub.exited, other.exited]);
    }
    expect(isOrphanedStub(stub.pid)).toBe(false);
  });

  test("cleanup() kills a stub still running from the log, and leaves other pids alone", async () => {
    const f = scaffold();
    // setsid: the harness runner spawns each stub as its own group leader.
    const stub = Bun.spawn(["setsid", process.execPath, "-e", IDLE, FAKE_CLAUDE]);
    const other = Bun.spawn([process.execPath, "-e", IDLE]);
    try {
      await Bun.sleep(100);
      const line = (pid: number, call: number) => JSON.stringify({ role: "maker", call, pid }) + "\n";
      appendFileSync(join(f.root, "stub", "invocations.ndjson"), line(stub.pid, 1) + line(other.pid, 2));
      await f.cleanup();
      await f.waitFor(() => !pidAlive(stub.pid), { timeoutMs: 2_000 });
      expect(pidAlive(other.pid)).toBe(true);
    } finally {
      stub.kill("SIGKILL");
      other.kill("SIGKILL");
      await Promise.all([stub.exited, other.exited]);
    }
  });
});
