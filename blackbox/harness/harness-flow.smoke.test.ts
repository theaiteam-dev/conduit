/**
 * Harness-flow scaffolding — smoke test.
 *
 * fake-claude appends to invocations.ndjson from its own process, so a read
 * that races a write can see a truncated final line. cleanup() reads that log
 * to find orphaned stubs, and a throw there must not leak the temp root.
 *
 * BLACK-BOX RULE: zero imports from src/.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startHarnessFlow } from "./harness-flow";

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
});
