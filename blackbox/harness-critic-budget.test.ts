/**
 * Harness journey 3: the consumption andon counts the agentic critic's spend
 * (issue #26).
 *
 * The maker reports 1000 tokens and the critic 1000 tokens, and the critic
 * PASSES. With `budgets.run.max_tokens: 1500` the maker alone stays under the
 * budget, and only the critic's spend takes the run over it. If the critic's
 * usage were not folded into the run budget (the #26 bug), the card would
 * sail through to `done`. The control case runs the identical scenario with
 * `max_tokens: 2500` and reaches `done`, so the only difference between a
 * halt and a completion is whether maker + critic exceeds the budget.
 *
 * BLACK-BOX: imports only the harness-flow module + bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarnessFlow, type CliResult, type FakeClaudeRole, type HarnessFlow } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;

function budgetFlow(name: string, maxTokens: number): string {
  return `
flow: ${name}
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: research
    worker:
      kind: harness
      harness: claude-headless
      tools: [Read, Write]
      prompt_file: prompts/maker.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [topic.md]
    outputs: [result.json]
    next: done
    check:
      kind: gate
      critic:
        role: adversarial-critic
        harness: claude-headless
        tools: [Read, Write]
        prompt_file: prompts/critic.md
        prompt_version: "1"
      on_reject: research
      rework_cap: 2
channels:
  ingress:
    type: cli
`;
}

const FILES = {
  "prompts/maker.md": "ROLE:MAKER Answer topic.md into result.json.\n",
  "prompts/critic.md": "ROLE:CRITIC Judge result.json and write verdict.json.\n",
  "topic.md": "What is a kanban card?\n",
};

/** 1000 tokens per call for both roles; the critic passes. */
const ROLES: FakeClaudeRole[] = [
  {
    name: "maker",
    promptIncludes: "ROLE:MAKER",
    calls: [
      {
        writeFiles: { "result.json": JSON.stringify({ summary: "a card on a board" }) },
        usage: { input_tokens: 600, output_tokens: 400 },
      },
    ],
  },
  {
    name: "critic",
    promptIncludes: "ROLE:CRITIC",
    calls: [
      {
        writeFiles: { "verdict.json": JSON.stringify({ verdict: "pass", findings: [] }) },
        usage: { input_tokens: 600, output_tokens: 400 },
      },
    ],
  },
];

describe("harness journey: critic spend trips the run token budget", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = startHarnessFlow({ flowYaml: budgetFlow("bb-harness-budget-trip", 1500), files: FILES, entryInput: "topic.md", roles: ROLES });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the run halts on the tokens andon and exits nonzero, the card never reaches done", async () => {
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("andon: run halted — tokens budget exceeded");
    expect(run.stderr).toContain(`run "${f.runId}" halted`);
    // Left where it was, resumable: not done, not scrapped.
    expect(run.stderr).toContain(`${f.cardId}: lane=research station=research`);

    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain(`[${f.cardId}] research@0 research.harness`);
    expect(inspect.stdout).toContain(`[${f.cardId}] research@0 research.harness-critic`);
    expect(inspect.stdout).not.toMatch(/→ done/);
    // The andon trips on the critic's own spend before the pass verdict is routed.
    expect(inspect.stdout).not.toContain("gate_verdict: pass");
  });

  test("the maker alone was under budget; the critic's spend is what crossed it", () => {
    expect(f.stubLog().map((e) => `${e.role}#${e.call}`)).toEqual(["maker#1", "critic#1"]);
    const spans = f.journalSpans();
    const total = (name: string) =>
      spans
        .filter((s) => s.name === name)
        .reduce((n, s) => n + (s.input_tokens ?? 0) + (s.output_tokens ?? 0) + (s.cache_read_input_tokens ?? 0) + (s.cache_creation_input_tokens ?? 0), 0);
    expect(total("research.harness")).toBe(1000);
    expect(total("research.harness-critic")).toBe(1000);
  });

  // Issue #83: the runs row is status=halted and no process holds the run, but
  // the card is still `ready`, and `run status` used to report `running`.
  test("run status reports the andon-halted run as halted, with its resume command", async () => {
    const status = await f.runStatus();
    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toContain(`run ${f.runId}: running`);
    expect(status.stdout).toContain(`run ${f.runId}: halted with 1 unfinished card;`);
    expect(status.stdout).toMatch(new RegExp(`resume with: conduit resume \\S+ --run ${f.runId}`));
  });
});

describe("control: the same scenario under a budget maker + critic fits in reaches done", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = startHarnessFlow({ flowYaml: budgetFlow("bb-harness-budget-fits", 2500), files: FILES, entryInput: "topic.md", roles: ROLES });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("maker + critic (2000 tokens) under a 2500 budget completes", async () => {
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain("andon");
    const status = await f.runStatus();
    expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=complete)`);
    const inspect = await f.journalInspect();
    expect(inspect.stdout).toContain("gate_verdict: pass");
    expect(inspect.stdout).toContain(`entered_lane: research → done`);
  });
});
