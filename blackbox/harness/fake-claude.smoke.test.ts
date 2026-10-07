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

describe("fake-claude — result shape", () => {
  const root = mkdtempSync(join(tmpdir(), "conduit-bb-fake-claude-shape-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("every result's modelUsage entries carry costUSD and canonicalModel, as the real CLI's do", async () => {
    const scenarioPath = join(root, "scenario.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        stateDir: join(root, "counters"),
        logPath: join(root, "invocations.ndjson"),
        roles: [
          {
            name: "maker",
            promptIncludes: "ROLE:MAKER",
            calls: [
              {
                earlierResults: [
                  { usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { "claude-a": { inputTokens: 10, outputTokens: 5, costUSD: 0.01 } } },
                ],
                modelUsage: {
                  "claude-a": { inputTokens: 20, outputTokens: 10, costUSD: 0.02 },
                  "claude-b": { inputTokens: 3, outputTokens: 1, canonicalModel: "claude-b-canonical" },
                },
              },
            ],
          },
        ],
      }),
    );
    const proc = Bun.spawn([process.execPath, FAKE_CLAUDE, "-p", "--", "ROLE:MAKER"], {
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath },
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const results = stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, any>)
      .filter((e) => e.type === "result");
    expect(results.map((r) => r.modelUsage)).toEqual([
      { "claude-a": expect.objectContaining({ costUSD: 0.01, canonicalModel: "claude-a" }) },
      {
        "claude-a": expect.objectContaining({ costUSD: 0.02, canonicalModel: "claude-a" }),
        "claude-b": expect.objectContaining({ costUSD: 0, canonicalModel: "claude-b-canonical" }),
      },
    ]);
  });
});
