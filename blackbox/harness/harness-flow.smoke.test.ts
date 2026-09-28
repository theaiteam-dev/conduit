/**
 * Harness-flow scaffolding — smoke test.
 *
 * fake-claude appends to invocations.ndjson from its own process, so a read
 * that races a write can see a truncated final line. cleanup() reads that log
 * to find orphaned stubs, and a throw there must not leak the temp root. The
 * reap itself must kill a live stub and leave a recycled pid alone, including
 * the real case: a `conduit run` the helper's timeout SIGKILLed, whose own
 * group kill of the stub never ran.
 *
 * BLACK-BOX RULE: zero imports from src/.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isOrphanedStub, pidAlive, startHarnessFlow } from "./harness-flow";

const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");
const IDLE = "setTimeout(() => {}, 30_000)";

const HANGING_FLOW = `
flow: bb-harness-flow-smoke
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 100000 }
  per_card: { max_execution_attempts: 1 }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: research
    worker:
      kind: harness
      harness: claude-headless
      tools: [Read]
      prompt_file: prompts/maker.md
      prompt_version: "1"
      timeout_seconds: 60
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [topic.md]
    outputs: [result.json]
    next: done
channels:
  ingress:
    type: cli
`;

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

  test("cleanup() reaps the stub a timed-out `conduit run` left behind", async () => {
    const f = startHarnessFlow({
      flowYaml: HANGING_FLOW,
      files: { "prompts/maker.md": "ROLE:MAKER Answer topic.md.\n", "topic.md": "What is a kanban card?\n" },
      entryInput: "topic.md",
      roles: [{ name: "maker", promptIncludes: "ROLE:MAKER", calls: [{ hang: true }] }],
    });
    let pids: number[] = [];
    try {
      // The stub hangs well past this, so the helper's timeout SIGKILLs conduit.
      const run = await f.run([], { timeoutMs: 4_000 });
      expect(run.exitCode).not.toBe(0);
      pids = f.stubLog().map((e) => e.pid);
      expect(pids).toHaveLength(1);
      expect(isOrphanedStub(pids[0]!)).toBe(true);
    } finally {
      await f.cleanup();
    }
    await f.waitFor(() => pids.every((pid) => !pidAlive(pid)), { timeoutMs: 2_000 });
  }, 30_000);
});
