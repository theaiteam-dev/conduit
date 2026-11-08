/**
 * Cache-aware token budget journey (issue #125, ADR-0014).
 *
 * The issue's scenario, scaled down 1000x: a run whose Claude harness calls
 * are mostly cache reads halted on the tokens andon long before its spend
 * reached the limit. Here two harness stations, `walk` then `report`, each
 * bill 600 uncached input, 70 output and 6,350 cache reads (7,020 raw tokens)
 * against `budgets.run.max_tokens: 6000`.
 *
 *   - default weights (cache_read 0.1): each call counts 1,305, the run
 *     completes, and `conduit run status` prints the budget figure next to the
 *     raw one;
 *   - `token_weights: { cache_read: 1 }`: the raw count, so the run halts on
 *     the tokens andon before `report` runs, as it did before #125;
 *   - the same raw size reported as uncached input: counts at weight 1 and
 *     halts the same way.
 *
 * The journal keeps raw figures in every case.
 *
 * BLACK-BOX: imports only the harness-flow module, the fake's types and bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FakeClaudeUsage } from "./harness/fake-claude";
import { startHarnessFlow, type CliResult, type FakeClaudeRole, type HarnessFlow } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;

const CACHE_HEAVY: FakeClaudeUsage = { input_tokens: 600, output_tokens: 70, cache_read_input_tokens: 6_350 };
const UNCACHED: FakeClaudeUsage = { input_tokens: 6_950, output_tokens: 70 };

function flowYaml(name: string, weights: string): string {
  const worker = (prompt: string): string => `
    worker:
      kind: harness
      harness: claude-headless
      tools: [Read, Write]
      prompt_file: prompts/${prompt}.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: summary, type: string, required: true }`;
  return `
flow: ${name}
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 6000 }
${weights}
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: walk${worker("walk")}
    inputs: [topic.md]
    outputs: [walk.json]
    next: report
  - id: report${worker("report")}
    inputs: [walk.json]
    outputs: [report.json]
    next: done
channels:
  ingress:
    type: cli
`;
}

function roles(usage: FakeClaudeUsage): FakeClaudeRole[] {
  return [
    { name: "walk", promptIncludes: "ROLE:WALK", calls: [{ writeFiles: { "walk.json": JSON.stringify({ summary: "walked" }) }, usage }] },
    { name: "report", promptIncludes: "ROLE:REPORT", calls: [{ writeFiles: { "report.json": JSON.stringify({ summary: "reported" }) }, usage }] },
  ];
}

function start(name: string, weights: string, usage: FakeClaudeUsage): HarnessFlow {
  return startHarnessFlow({
    flowYaml: flowYaml(name, weights),
    files: {
      "prompts/walk.md": "ROLE:WALK Walk topic.md into walk.json.\n",
      "prompts/report.md": "ROLE:REPORT Report walk.json into report.json.\n",
      "topic.md": "What is a kanban card?\n",
    },
    entryInput: "topic.md",
    roles: roles(usage),
  });
}

function rawSpanTokens(f: HarnessFlow): Record<string, number[]> {
  return Object.fromEntries(
    f.journalSpans()
      .filter((s) => s.name.endsWith(".harness"))
      .map((s) => [s.station, [s.input_tokens ?? 0, s.cache_read_input_tokens ?? 0, s.output_tokens ?? 0]]),
  );
}

const andonLines = (r: CliResult): string[] => r.stderr.split("\n").filter((l) => l.startsWith("andon:"));

describe("cache-aware budget journey: cache reads count at 0.1 by default", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = start("bb-cache-budget-default", "", CACHE_HEAVY);
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("both stations run and the card reaches done under a budget the raw tokens exceed", () => {
    expect(run.exitCode).toBe(0);
    expect(andonLines(run)).toEqual([]);
    expect(f.stubLog().map((e) => `${e.role}#${e.call}`)).toEqual(["walk#1", "report#1"]);
  });

  test("run status prints the budget figure, the limit, the raw figure and the weights", async () => {
    const status = await f.runStatus();
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=complete)`);
    expect(status.stdout.split("\n")).toContain(
      "budget tokens: 2610 of run max_tokens 6000 (raw 14040; cache read x0.1, cache creation x1)",
    );
  });

  test("the journal keeps the raw figures", () => {
    expect(rawSpanTokens(f)).toEqual({ walk: [600, 6_350, 70], report: [600, 6_350, 70] });
  });
});

describe("control: cache_read: 1 restores the raw count and the run halts before report", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = start("bb-cache-budget-raw", "  token_weights: { cache_read: 1 }", CACHE_HEAVY);
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the run halts on the tokens andon after walk", async () => {
    expect(run.exitCode).toBe(1);
    expect(andonLines(run)).toEqual(["andon: run halted — tokens budget exceeded"]);
    expect(f.stubLog().map((e) => `${e.role}#${e.call}`)).toEqual(["walk#1"]);
    const status = await f.runStatus();
    // Budget and raw figures agree, so status prints no budget line.
    expect(status.stdout).not.toContain("budget tokens:");
  });
});

describe("control: an uncached run of the same raw size halts before report", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = start("bb-cache-budget-uncached", "", UNCACHED);
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the run halts on the tokens andon after walk", () => {
    expect(run.exitCode).toBe(1);
    expect(andonLines(run)).toEqual(["andon: run halted — tokens budget exceeded"]);
    expect(f.stubLog().map((e) => `${e.role}#${e.call}`)).toEqual(["walk#1"]);
  });
});

describe("a flow with an out-of-range weight is refused at load", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = start("bb-cache-budget-invalid", "  token_weights: { cache_read: 1.5 }", CACHE_HEAVY);
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("conduit run exits nonzero naming INVALID_TOKEN_WEIGHTS and calls nothing", () => {
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("INVALID_TOKEN_WEIGHTS");
    expect(run.stderr).toContain("cache_read");
    expect(f.stubLog()).toEqual([]);
  });
});
