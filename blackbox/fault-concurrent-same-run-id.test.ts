/**
 * Fault variant (issue #48): two `conduit run` launches of the same run id at
 * the same moment.
 *
 * registerRun read the runs row and inserted it as two steps, so two launches
 * could both read no row and the second insert died with `fatal: UNIQUE
 * constraint failed: runs.run_id`, exit 1, which ingress recovery reads as a
 * run failure. Duplicate ingress deliveries and the periodic re-drive start
 * launches 50 to 700 ms apart, which is this shape.
 *
 * Each round starts two identical `conduit run` processes on a fresh
 * workspace and waits for both. Exactly one drives the run: the stub is
 * called once and the card reaches `done`. The other takes the documented
 * path for a second process on the same run id (docs/single-host-concurrency.md):
 * while the winner is running it exits 1 naming the run and the holding pid;
 * if the winner already finished it reports the run's state and exits 0.
 * Neither prints a constraint error. The maker call is slow (`delayMs`) so the
 * winner is usually still running when the loser registers, which is the
 * window the race needs; the assertions hold for either loser outcome.
 *
 * BLACK-BOX: imports only the harness-flow module + bun:test.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { startHarnessFlow, type CliResult, type HarnessFlow } from "./harness/harness-flow";

const ROUNDS = 5;
const TIMEOUT_MS = 180_000;

const FLOW = `
flow: bb-concurrent-same-run-id
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
channels:
  ingress:
    type: cli
`;

const LEASE_CONFLICT = /another conduit process \(pid \d+\) is driving run "([^"]+)"/;

function startFlow(): HarnessFlow {
  return startHarnessFlow({
    flowYaml: FLOW,
    files: {
      "prompts/maker.md": "ROLE:MAKER Answer the question in topic.md and write result.json.\n",
      "topic.md": "What is a kanban card?\n",
    },
    entryInput: "topic.md",
    roles: [
      {
        name: "maker",
        promptIncludes: "ROLE:MAKER",
        calls: [{ writeFiles: { "result.json": JSON.stringify({ summary: "a card on a board" }) }, delayMs: 1_500 }],
      },
    ],
  });
}

describe("fault: two simultaneous conduit run launches of one run id (issue #48)", () => {
  let f: HarnessFlow | undefined;

  afterEach(async () => {
    await f?.cleanup();
    f = undefined;
  });

  test(
    `exactly one launch drives the run and the other takes the documented path, over ${ROUNDS} rounds`,
    async () => {
      let leaseConflicts = 0;
      for (let round = 0; round < ROUNDS; round++) {
        f = startFlow();
        const results: CliResult[] = await Promise.all([f.run(), f.run()]);
        const context = `round ${round}: ${JSON.stringify(results)}`;

        for (const r of results) {
          expect(r.stderr, context).not.toContain("UNIQUE constraint");
          expect(r.stderr, context).not.toContain("fatal:");
        }

        // One maker call in total: the loser never dispatched the card.
        expect(f.stubLog().length, context).toBe(1);

        const conflicted = results.filter((r) => LEASE_CONFLICT.test(r.stderr));
        expect(conflicted.length, context).toBeLessThanOrEqual(1);
        if (conflicted.length === 1) {
          leaseConflicts += 1;
          const loser = conflicted[0]!;
          expect(loser.exitCode, context).toBe(1);
          expect(LEASE_CONFLICT.exec(loser.stderr)![1], context).toBe(f.runId);
          const winner = results.find((r) => r !== loser)!;
          expect(winner.exitCode, context).toBe(0);
        } else {
          // The winner finished before the loser registered: the loser read
          // the finished run and reported its state.
          for (const r of results) expect(r.exitCode, context).toBe(0);
        }

        const status = await f.runStatus();
        expect(status.exitCode, context).toBe(0);
        expect(status.stdout, context).toContain(`run ${f.runId}: terminal (outcome=complete)`);
        expect(status.stdout, context).toMatch(/research: 1 maker \+ 0 critic call\(s\)/);

        const inspect = await f.journalInspect();
        expect(inspect.exitCode, context).toBe(0);
        expect(inspect.stdout.split(`[${f.cardId}] research@0 research.harness`).length - 1, context).toBe(1);
        expect(inspect.stdout, context).toContain(`[${f.cardId}] entered_lane: research → done (forward)`);

        await f.cleanup();
        f = undefined;
      }
      // Logged, not asserted: how often the loser met a live winner.
      console.log(`fault-concurrent-same-run-id: ${leaseConflicts}/${ROUNDS} rounds ended in a lease conflict`);
    },
    TIMEOUT_MS,
  );
});
