/**
 * fake-claude — smoke test.
 *
 * Concurrent invocations of one role must each claim a distinct call number,
 * or two of them run the same scripted call and a step is skipped. A prompt
 * that matches two roles' markers must fail rather than pick the first.
 *
 * BLACK-BOX RULE: zero imports from src/.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeClaudeLogEntry } from "./fake-claude";

const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");
const CONCURRENT = 24;

describe("fake-claude — call numbering", () => {
  const root = mkdtempSync(join(tmpdir(), "conduit-bb-fake-claude-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test(`${CONCURRENT} concurrent invocations of one role get distinct call numbers`, async () => {
    const logPath = join(root, "invocations.ndjson");
    const scenarioPath = join(root, "scenario.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({ stateDir: join(root, "counters"), logPath, roles: [{ name: "maker", promptIncludes: "ROLE:MAKER", calls: [] }] }),
    );
    const procs = Array.from({ length: CONCURRENT }, () =>
      Bun.spawn([process.execPath, FAKE_CLAUDE, "-p", "--", "ROLE:MAKER"], {
        env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath },
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    await Promise.all(procs.map((p) => p.exited));

    const calls = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as FakeClaudeLogEntry).call)
      .sort((a, b) => a - b);
    expect(calls).toEqual(Array.from({ length: CONCURRENT }, (_, i) => i + 1));
  }, 30_000);

  test("a prompt matching two roles' promptIncludes fails, naming both", async () => {
    const scenarioPath = join(root, "overlap.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        stateDir: join(root, "overlap-counters"),
        logPath: join(root, "overlap.ndjson"),
        roles: [
          { name: "reviewer", promptIncludes: "ROLE:REVIEW", calls: [] },
          { name: "gate", promptIncludes: "ROLE:REVIEW the gate", calls: [] },
        ],
      }),
    );
    const proc = Bun.spawn([process.execPath, FAKE_CLAUDE, "-p", "--", "ROLE:REVIEW the gate"], {
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(65);
    expect(stderr).toContain(`"ROLE:REVIEW"`);
    expect(stderr).toContain(`"ROLE:REVIEW the gate"`);
  });
});
