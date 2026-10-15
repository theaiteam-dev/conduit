/**
 * Fan-out owned_paths journeys (issues #73 and #124), through the shipped binary.
 *
 * A child's owned_paths come from the plan station's proposal, which is model
 * output. The kernel resolves each entry against the run's project root, never
 * against its own cwd, and rejects a proposal whose entries resolve outside the
 * root. The listener, and every `conduit run` it spawns, runs from this test
 * process's cwd, which is not the project root, so both journeys run with the
 * two different.
 *
 *   1. Relative owned dirs: the plan proposes `reviews/<lens>`. Each child's
 *      seed.json lands under the project root, the reviewers write their
 *      findings there, and a `skip_when: { source: seed }` predicate on the
 *      review station reads the seed from the same place: the child whose seed
 *      says skip passes straight through, the others run. The run ends `done`.
 *   2. Escaping owned dirs: the plan proposes existing directories outside the
 *      project root. The proposal is rejected the documented way: no child is
 *      seeded, no seed.json is written, and the parent is held with a reason
 *      naming `owned_path_out_of_bounds`, the child and the path.
 *
 * BLACK-BOX: imports only the harness + bun:test, nothing from src/.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startJourneyHarness, CONCURRENT_FANOUT_CHILDREN } from "./harness/journey-harness";

// Above the longest sum of inner waits (30s spawn + 60s findings), so an inner
// waitFor times out first and reports the check it was waiting on.
const JOURNEY_TIMEOUT_MS = 120_000;
const SKIPPED = "review-style";

/** Parse a spawned run's run id from its argv (`--run-id` / `--run`). */
function runIdFromArgs(args: string[]): string | undefined {
  for (const flag of ["--run-id", "--run"]) {
    const i = args.indexOf(flag);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

describe("fan-out owned_paths resolve against the project root (#124, shipped binary)", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;

  beforeAll(async () => {
    h = await startJourneyHarness({ concurrentFanOut: true, fanOutOwnedPaths: "relative", skipChild: SKIPPED });
  }, JOURNEY_TIMEOUT_MS);

  afterAll(async () => {
    await h?.cleanup();
  });

  test(
    "relative child dirs are seeded under the project root, and skip_when reads the seed from there",
    async () => {
      // The kernel's cwd is this process's cwd, not the project root, and the
      // relative dirs do not exist under it.
      expect(process.cwd()).not.toBe(h.projectRoot);
      for (const c of CONCURRENT_FANOUT_CHILDREN) expect(existsSync(join(process.cwd(), c.dir))).toBe(false);

      const res = await h.sendSignedEvent({
        event_id: "evt-fanout-relative-0001",
        type: "event_callback",
        event: { type: "message", channel: "C_HARNESS", text: "review with relative child dirs" },
      });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      await h.waitFor(() => h.spawns.runInvocations().length >= 1, { timeoutMs: 30_000 });
      const run = h.spawns.runInvocations()[0];
      // Gate on the reviewers' findings, not on assert.exitCode alone: that
      // reports 0 as soon as any card reaches 'done', which the skipped child
      // does before its siblings finish.
      const reviewed = CONCURRENT_FANOUT_CHILDREN.filter((c) => c.id !== SKIPPED);
      // Keep the last failed check so a timeout reports which condition never
      // held (a missing findings.json, or the run's exit code) instead of a
      // bare timeout.
      let lastError: unknown;
      try {
        await h.waitFor(
          () => {
            try {
              for (const c of reviewed) h.assert.artifactContent(`${c.dir}/findings.json`);
              h.assert.exitCode(run, 0);
              return true;
            } catch (err) {
              lastError = err;
              return false;
            }
          },
          { timeoutMs: 60_000 },
        );
      } catch (timeout) {
        throw new Error(`${(timeout as Error).message}; last check failed with: ${String(lastError)}`);
      }


      for (const c of CONCURRENT_FANOUT_CHILDREN) {
        // Every seed landed in the child's dir under the project root.
        expect(JSON.parse(h.assert.artifactContent(`${c.dir}/seed.json`))).toEqual({ lens: c.lens, skip: c.id === SKIPPED });
        if (c.id === SKIPPED) {
          // The skip_when seed read found skip: true and passed the card through.
          expect(() => h.assert.artifactContent(`${c.dir}/findings.json`)).toThrow();
        } else {
          expect(JSON.parse(h.assert.artifactContent(`${c.dir}/findings.json`))).toEqual({ finding: c.lens });
        }
      }

      const runId = runIdFromArgs(run!.args)!;
      const skipped = await h.runConduit(["journal", "inspect", SKIPPED, "--run", runId]);
      expect(skipped.exitCode).toBe(0);
      expect(skipped.stdout).toContain("seed.skip == true");
      const ran = await h.runConduit(["journal", "inspect", "review-security", "--run", runId]);
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout).toContain("[review-security]");
      expect(ran.stdout).not.toContain("seed.skip == true");
    },
    JOURNEY_TIMEOUT_MS,
  );
});

describe("fan-out owned_paths outside the project root are rejected (#73, shipped binary)", () => {
  let h: Awaited<ReturnType<typeof startJourneyHarness>>;

  beforeAll(async () => {
    h = await startJourneyHarness({ concurrentFanOut: true, fanOutOwnedPaths: "outside" });
  }, JOURNEY_TIMEOUT_MS);

  afterAll(async () => {
    await h?.cleanup();
  });

  test(
    "the proposal is rejected, the parent held with the path named, and nothing is seeded",
    async () => {
      const res = await h.sendSignedEvent({
        event_id: "evt-fanout-outside-0001",
        type: "event_callback",
        event: { type: "message", channel: "C_HARNESS", text: "review with escaping child dirs" },
      });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      await h.waitFor(() => h.spawns.runInvocations().length >= 1, { timeoutMs: 30_000 });
      const runId = runIdFromArgs(h.spawns.runInvocations()[0]!.args)!;
      expect(runId).toBeDefined();

      const first = CONCURRENT_FANOUT_CHILDREN[0]!;
      const escaping = join(h.outsideRoot, first.dir);
      let journey: { stdout: string; exitCode: number } | undefined;
      await h.waitFor(
        async () => {
          journey = await h.runConduit(["journal", "inspect", `entry-${runId}`, "--run", runId]);
          return journey.exitCode === 0 && journey.stdout.includes("owned_path_out_of_bounds");
        },
        { timeoutMs: 30_000, intervalMs: 300 },
      );
      expect(journey!.stdout).toContain(
        `fan-out station 'plan' proposal rejected: owned_path_out_of_bounds (child '${first.id}', path '${escaping}')`,
      );

      // The escaping directories exist, so only confinement stopped the seed.
      for (const c of CONCURRENT_FANOUT_CHILDREN) {
        expect(existsSync(join(h.outsideRoot, c.dir))).toBe(true);
        expect(existsSync(join(h.outsideRoot, c.dir, "seed.json"))).toBe(false);
        expect(() => h.assert.artifactContent(`${c.dir}/seed.json`)).toThrow();
      }

      // No child card was seeded: `journal inspect` exits 0 and prints no
      // span or card_log line for a card id the run never created.
      for (const c of CONCURRENT_FANOUT_CHILDREN) {
        const child = await h.runConduit(["journal", "inspect", c.id, "--run", runId]);
        expect(child.exitCode).toBe(0);
        expect(child.stdout.trim()).toBe("");
      }
    },
    JOURNEY_TIMEOUT_MS,
  );
});
