/**
 * Harness journey 5: a provider rate limit parks the card instead of spending
 * an attempt, and the run is recorded parked and resumable.
 *
 * fake-claude reports a blocking cap the way the real CLI does: a
 * `rate_limit_event` with status `rejected` and a reset one hour out, a
 * `result` event with `is_error: true` and `api_error_status: 429`, and exit
 * code 1. The call takes 1.5s, so by the time it returns the run's 1-second
 * wall-clock budget (`--budget-wall-clock-seconds 1`) has elapsed and the
 * consumption andon halts the run at its release-gate check instead of
 * waiting out the reset.
 *
 * Asserted: the card is parked at its lane with no attempt consumed (stderr,
 * the journal's `(rate_limited)` self-move, the span's attempt and outcome),
 * never scrapped or held, the stub ran once, and `conduit run status` reports
 * the run parked with the resume command.
 *
 * The last describe pins issue #84: when the call returns BEFORE the
 * wall-clock budget is spent, the run halts at its budget instead of sleeping
 * to the provider reset.
 *
 * BLACK-BOX: imports only the harness-flow module + bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarnessFlow, type CliResult, type FakeClaudeCall, type HarnessFlow } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;

const FLOW = `
flow: bb-harness-park
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 100000 }
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
channels:
  ingress:
    type: cli
`;

const FILES = {
  "prompts/maker.md": "ROLE:MAKER Answer topic.md into result.json.\n",
  "topic.md": "What is a kanban card?\n",
};

function cappedCall(resetsAt: number, delayMs?: number): FakeClaudeCall {
  return {
    ...(delayMs !== undefined ? { delayMs } : {}),
    rateLimit: { status: "rejected", resetsAt, rateLimitType: "five_hour", utilization: 1 },
    resultOverrides: {
      is_error: true,
      api_error_status: 429,
      terminal_reason: "api_error",
      result: "You've hit your session limit · resets later",
    },
    usage: { input_tokens: 10, output_tokens: 5 },
    costUsd: 0,
    exitCode: 1,
  };
}

describe("harness journey: a provider rate limit parks the card and the run", () => {
  let f: HarnessFlow;
  let run: CliResult;
  let resetsAt: number;

  beforeAll(async () => {
    resetsAt = Math.floor(Date.now() / 1000) + 3600;
    f = startHarnessFlow({
      flowYaml: FLOW,
      files: FILES,
      entryInput: "topic.md",
      roles: [{ name: "maker", promptIncludes: "ROLE:MAKER", calls: [cappedCall(resetsAt, 1_500)] }],
    });
    run = await f.run(["--budget-wall-clock-seconds", "1"], { timeoutMs: 30_000 });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  /**
   * release_at is the tick's clock plus the time remaining to the reported
   * reset, and the tick's clock was read before the 1.5s call, so it lands a
   * second or two before `resetsAt`, never after it.
   */
  function parkedReleaseAt(): number {
    const m = run.stderr.match(new RegExp(`rate limited: card ${f.cardId} parked at 'research' until release_at=(\\d+) \\(no attempt consumed\\)`));
    expect(m).not.toBeNull();
    return Number(m![1]);
  }

  test("the card is parked with no attempt consumed, and the run halts instead of waiting an hour", () => {
    // 137 would mean the harness-flow timeout killed a run that slept to the reset.
    expect(run.exitCode).toBe(1);
    const releaseAt = parkedReleaseAt();
    expect(releaseAt).toBeLessThanOrEqual(resetsAt);
    expect(releaseAt).toBeGreaterThan(resetsAt - 10);
    expect(run.stderr).toContain("andon: run halted — wall_clock budget exceeded while parked behind a provider rate limit");
    expect(run.stderr).toContain(`run "${f.runId}" parked behind a provider rate limit`);
    expect(run.stderr).toContain("nothing was scrapped");
    expect(f.stubLog()).toHaveLength(1);
  });

  test("run status reports the run parked, with the resume command", async () => {
    const status = await f.runStatus();
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`run ${f.runId}: parked behind a provider rate limit until`);
    expect(status.stdout).toContain("nothing was scrapped");
    expect(status.stdout).toContain(`conduit resume ${f.flowPath} --run ${f.runId}`);
  });

  test("the journal shows a rate_limited self-move at attempt 0, never scrap or hold", async () => {
    const inspect = await f.journalInspect();
    expect(inspect.stdout).toContain(`[${f.cardId}] research@0 research.harness`);
    expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: research → research (rate_limited)`);
    expect(inspect.stdout).not.toMatch(/→ (scrap|hold|done)/);
    const spans = f.journalSpans().filter((s) => s.name === "research.harness");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attempt).toBe(0);
    expect(spans[0]!.attributes.outcome).toBe("harness-rate-limited");
    expect(spans[0]!.attributes.rate_limit_release_at).toBe(parkedReleaseAt());
    expect(spans[0]!.attributes.rate_limit_reset_reported).toBe(resetsAt * 1000);
    // The capped call's reported spend is recorded on its span. Whether it is
    // counted against the budget is pinned by the next describe.
    expect(spans[0]!.usage_unknown).toBe(0);
    expect(spans[0]!.input_tokens).toBe(10);
  });
});

describe("harness journey: a capped call's spend counts against the run token budget", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    f = startHarnessFlow({
      // 10 tokens: the capped call's 10 in + 5 out crosses it only if the park folds them in.
      flowYaml: FLOW.replace("max_tokens: 100000", "max_tokens: 10"),
      files: FILES,
      entryInput: "topic.md",
      roles: [{ name: "maker", promptIncludes: "ROLE:MAKER", calls: [cappedCall(resetsAt)] }],
    });
    // Without the fold, nothing trips and the run sleeps toward the wall-clock
    // deadline (2 minutes) until this timeout kills it with 137.
    run = await f.run([], { timeoutMs: 15_000 });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the tokens andon trips on the parked call's spend (issue #26 AC5)", () => {
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("andon: run halted — tokens budget exceeded while parked behind a provider rate limit");
    expect(run.stderr).toContain(`run "${f.runId}" parked behind a provider rate limit`);
    expect(f.stubLog()).toHaveLength(1);
  });
});

describe("harness journey: a park longer than the remaining wall-clock budget", () => {
  let f: HarnessFlow | undefined;

  afterAll(async () => {
    await f?.cleanup();
  });

  // Issue #84: the capped call returns at once, with the reset an hour out and
  // `--budget-wall-clock-seconds 2`. The release-gate sleep must end at the
  // wall-clock deadline, not at the reset, so the andon halts the run parked.
  test(
    "halts at its wall-clock budget and records the run parked",
    async () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 3600;
      f = startHarnessFlow({
        flowYaml: FLOW,
        files: FILES,
        entryInput: "topic.md",
        roles: [{ name: "maker", promptIncludes: "ROLE:MAKER", calls: [cappedCall(resetsAt)] }],
      });
      const startedAt = Date.now();
      // Killed with 137 at 15s if it is still sleeping toward the reset.
      const run = await f.run(["--budget-wall-clock-seconds", "2"], { timeoutMs: 15_000 });
      const elapsedMs = Date.now() - startedAt;
      expect(run.exitCode).toBe(1);
      expect(elapsedMs).toBeLessThan(10_000);
      expect(run.stderr).toContain("andon: run halted — wall_clock budget exceeded while parked behind a provider rate limit");
      expect(run.stderr).toContain(`run "${f.runId}" parked behind a provider rate limit`);
      expect(f.stubLog()).toHaveLength(1);
      const status = await f.runStatus();
      expect(status.stdout).toContain(`run ${f.runId}: parked behind a provider rate limit until`);
      expect(status.stdout).toContain(`conduit resume ${f.flowPath} --run ${f.runId}`);
    },
    TIMEOUT_MS,
  );
});
