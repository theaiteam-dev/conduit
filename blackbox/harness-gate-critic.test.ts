/**
 * Harness journey 2: a harness maker gated by an agentic (harness) critic.
 *
 * The station's `check.critic.harness` runs fake-claude a second time under a
 * different prompt, and the critic writes its verdict to `verdict.json` in the
 * project root (quality/gate.ts, the WI-570 agentic critic contract).
 *
 * Case A: the critic rejects with findings on its first call and passes on its
 * second. The card goes back through the maker (two maker invocations), the
 * journal records the reject verdict with its findings and a
 * `research.harness-critic` span per critic call, and the card ends in `done`.
 *
 * Case B: the critic rejects every time, each time with different findings so
 * the progress guard (same findings hash twice) cannot be what stops it. The
 * per-gate `rework_cap` does: the card is scrapped and the run exits nonzero.
 *
 * BLACK-BOX: imports only the harness-flow module + bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarnessFlow, type CliResult, type FakeClaudeCall, type HarnessFlow } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;

function gatedFlow(name: string, reworkCap: number): string {
  return `
flow: ${name}
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 1000000 }
  per_card: { max_execution_attempts: 5 }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: research
    worker:
      kind: harness
      harness: claude-headless
      model: claude-bb-maker-model
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
        model: claude-bb-critic-model
        tools: [Read, Write]
        prompt_file: prompts/critic.md
        prompt_version: "1"
      on_reject: research
      rework_cap: ${reworkCap}
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

function makerCall(n: number): FakeClaudeCall {
  return { writeFiles: { "result.json": JSON.stringify({ summary: `draft ${n}` }) } };
}

function verdict(v: "pass" | "reject", findings: string[]): FakeClaudeCall {
  return { writeFiles: { "verdict.json": JSON.stringify({ verdict: v, findings }) } };
}

describe("harness journey: agentic critic rejects once, then passes", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = startHarnessFlow({
      flowYaml: gatedFlow("bb-harness-gate-pass", 2),
      files: FILES,
      entryInput: "topic.md",
      roles: [
        { name: "maker", promptIncludes: "ROLE:MAKER", calls: [makerCall(1), makerCall(2)] },
        {
          name: "critic",
          promptIncludes: "ROLE:CRITIC",
          calls: [verdict("reject", ["summary does not define the term"]), verdict("pass", [])],
        },
      ],
    });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the run completes and the card reaches done", async () => {
    expect(run.exitCode).toBe(0);
    const status = await f.runStatus();
    expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=complete)`);
    expect(status.stdout).toMatch(/research: 2 maker \+ 2 critic call\(s\)/);
  });

  test("the maker ran twice and the critic twice, in maker/critic order", () => {
    const log = f.stubLog();
    expect(log.map((e) => `${e.role}#${e.call}`)).toEqual(["maker#1", "critic#1", "maker#2", "critic#2"]);
    // The critic got its own model from check.critic.model.
    const critic = log.find((e) => e.role === "critic")!;
    expect(critic.argv[critic.argv.indexOf("--model") + 1]).toBe("claude-bb-critic-model");
  });

  test("journal inspect shows the reject verdict with its finding, the critic spans and done", async () => {
    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    const out = inspect.stdout;
    expect(out).toContain(`[${f.cardId}] gate_verdict: reject`);
    expect(out).toContain(`[${f.cardId}]   summary does not define the term`);
    expect(out).toContain(`[${f.cardId}] gate_verdict: pass`);
    expect(out.match(/research\.harness-critic/g)?.length).toBe(2);
    expect(out.match(/research\.harness$/gm)?.length).toBe(2);
    expect(out).toContain(`entered_lane: research → done`);
    expect(out).not.toMatch(/→ (scrap|hold)/);

    // Each critic span records the critic's own usage. That the usage is also
    // counted against the run budget (issue #26) is pinned by the tripping
    // budget in harness-critic-budget.test.ts, not by these rows.
    const critic = f.journalSpans().filter((s) => s.name === "research.harness-critic");
    expect(critic).toHaveLength(2);
    for (const s of critic) {
      expect(s.usage_unknown).toBe(0);
      expect(s.input_tokens).toBe(100);
      expect(s.output_tokens).toBe(50);
    }
  });
});

describe("harness journey: agentic critic always rejects, rework_cap scraps the card", () => {
  let f: HarnessFlow;
  let run: CliResult;
  const REWORK_CAP = 1;

  beforeAll(async () => {
    f = startHarnessFlow({
      flowYaml: gatedFlow("bb-harness-gate-cap", REWORK_CAP),
      files: FILES,
      entryInput: "topic.md",
      roles: [
        { name: "maker", promptIncludes: "ROLE:MAKER", calls: [makerCall(1), makerCall(2), makerCall(3)] },
        {
          name: "critic",
          promptIncludes: "ROLE:CRITIC",
          // Distinct findings each call, so the findings-hash progress guard
          // sees progress and only the rework cap can stop the loop.
          calls: [verdict("reject", ["finding A"]), verdict("reject", ["finding B"]), verdict("reject", ["finding C"])],
        },
      ],
    });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the run exits nonzero and names the card scrapped on rework_cap", async () => {
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`run "${f.runId}" halted`);
    expect(run.stderr).toMatch(new RegExp(`${f.cardId}: lane=scrap station=research attempt=\\d+ — rework_cap`));
    const status = await f.runStatus();
    expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=halted)`);
  });

  test("one rework is allowed, the second reject scraps: two maker and two critic calls", () => {
    // rework_cap: 1 permits one trip back to the maker. The third scripted
    // maker/critic call must never happen.
    expect(f.stubLog().map((e) => `${e.role}#${e.call}`)).toEqual(["maker#1", "critic#1", "maker#2", "critic#2"]);
  });

  test("journal inspect shows both rejects, one rework, and the rework_cap scrap", async () => {
    const out = (await f.journalInspect()).stdout;
    expect(out.match(/gate_verdict: reject/g)?.length).toBe(2);
    expect(out).toContain(`[${f.cardId}]   finding A`);
    expect(out).toContain(`[${f.cardId}]   finding B`);
    expect(out.match(/entered_lane: research → research \(rework\)/g)?.length).toBe(1);
    expect(out).toContain(`[${f.cardId}] entered_lane: research → scrap (scrap)`);
    expect(out).toContain(`[${f.cardId}] terminal: rework_cap`);
    expect(out).not.toMatch(/→ done/);
  });
});
