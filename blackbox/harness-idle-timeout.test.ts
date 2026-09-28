/**
 * Harness journey 4: the idle timeout kills a silent harness call, the call
 * is retried up to the attempt cap, and descendants die with it.
 *
 * The station declares `worker.idle_timeout_seconds: 1`. On every call
 * fake-claude prints its system/init line, spawns a `setsid` sleeper (a new
 * session, so it leaves the stub's process group, as every Claude Code
 * Bash-tool command does), then writes nothing more and never exits.
 *
 * Asserted:
 *   - the stub was invoked `max_execution_attempts` times (each idle kill
 *     spends one attempt and is retried);
 *   - the card is scrapped with the reason `harness-idle-timeout`, visible in
 *     `conduit run`'s stderr and in `conduit journal inspect`;
 *   - every stub process is dead after the run (the process-group kill);
 *   - every setsid sleeper is dead after the run, when `conduit doctor`
 *     reports cgroup containment. Under the process-group fallback a setsid
 *     descendant is documented to survive (issue #77), so that one assertion
 *     is skipped with the doctor line as the reason, unless
 *     CONDUIT_REQUIRE_CGROUP_CONTAINMENT=1, in which case it fails naming the
 *     doctor line. This matches the src containment suite
 *     (src/worker/containment-fixture-files.ts setsidContainmentRequired).
 *
 * CI note: GitHub's hosted ubuntu runner puts the job in a root-owned cgroup.
 * blackbox.yml, like test.yml, creates a runner-owned cgroup before the suite
 * runs and sets CONDUIT_REQUIRE_CGROUP_CONTAINMENT=1, so CI takes the cgroup
 * branch and fails rather than skips if the runner image stops allowing it.
 *
 * BLACK-BOX: imports only the harness-flow module + bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, startHarnessFlow, type CliResult, type HarnessFlow } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;

const FLOW = `
flow: bb-harness-idle
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 100000 }
  per_card: { max_execution_attempts: ${ATTEMPTS} }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: research
    worker:
      kind: harness
      harness: claude-headless
      tools: [Read, Write, Bash]
      prompt_file: prompts/maker.md
      prompt_version: "1"
      timeout_seconds: 30
      idle_timeout_seconds: 1
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

describe("harness journey: idle timeout kills and retries a silent harness call", () => {
  let f: HarnessFlow;
  let run: CliResult;
  let doctorContainment: string;
  const sleeperPidFiles: string[] = [];

  function sleeperPids(): number[] {
    return sleeperPidFiles
      .filter((p) => existsSync(p))
      .map((p) => Number(readFileSync(p, "utf8").trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  beforeAll(async () => {
    f = startHarnessFlow({
      flowYaml: FLOW,
      files: {
        "prompts/maker.md": "ROLE:MAKER Answer topic.md into result.json.\n",
        "topic.md": "What is a kanban card?\n",
      },
      entryInput: "topic.md",
      // Per-call pid files outside the project root: a write inside it would
      // trip the owned-paths integrity gate.
      roles: ({ scratchDir }) => {
        for (let i = 1; i <= ATTEMPTS; i++) sleeperPidFiles.push(join(scratchDir, `sleeper-${i}.pid`));
        return [
          {
            name: "maker",
            promptIncludes: "ROLE:MAKER",
            calls: sleeperPidFiles.map((pidFile) => ({ hang: true, setsidSleeperPidFile: pidFile })),
          },
        ];
      },
    });

    const doctor = await f.conduit(["doctor"]);
    doctorContainment =
      (doctor.stdout + doctor.stderr).split("\n").find((l) => l.includes("process-containment:"))?.trim() ?? "";

    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    // A sleeper that survived (the fallback branch) must not outlive the test.
    for (const pid of sleeperPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await f?.cleanup();
  });

  test("doctor reports which containment mechanism is in use", () => {
    expect(doctorContainment).toMatch(/process-containment: /);
  });

  test(`the silent call was killed and retried: ${ATTEMPTS} invocations, then scrap`, () => {
    const log = f.stubLog();
    expect(log.map((e) => `${e.role}#${e.call}`)).toEqual(
      Array.from({ length: ATTEMPTS }, (_, i) => `maker#${i + 1}`),
    );
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(new RegExp(`${f.cardId}: lane=scrap station=research attempt=\\d+ — harness-idle-timeout`));
  });

  test("journal inspect names the idle timeout as the terminal reason", async () => {
    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout.match(/research\.harness$/gm)?.length).toBe(ATTEMPTS);
    expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: research → scrap (scrap)`);
    expect(inspect.stdout).toContain(`[${f.cardId}] terminal: harness-idle-timeout`);
    expect(inspect.stdout).not.toMatch(/→ done/);
    // Every attempt's span records why it failed.
    const outcomes = f.journalSpans().filter((s) => s.name === "research.harness").map((s) => s.attributes.outcome);
    expect(outcomes).toEqual(Array.from({ length: ATTEMPTS }, () => "harness-idle-timeout"));
    // Each call idled out at ~1s. The span's own duration pins that the idle
    // timer fired, not the 30s wall-clock bound, without timing the whole run.
    const durations = f.journalSpans().filter((s) => s.name === "research.harness").map((s) => s.duration_ms);
    expect(durations).toHaveLength(ATTEMPTS);
    for (const d of durations) {
      expect(typeof d).toBe("number");
      expect(d!).toBeLessThan(10_000);
    }
  });

  test("every stub process is dead after the run (process-group kill)", async () => {
    const pids = f.stubLog().map((e) => e.pid);
    expect(pids).toHaveLength(ATTEMPTS);
    await f.waitFor(() => pids.every((pid) => !pidAlive(pid)), { timeoutMs: 5_000 });
  });

  test("every setsid sleeper is dead after the run, when cgroup containment is in use or required", async () => {
    // The stub wrote each pid file before it went silent.
    expect(sleeperPids()).toHaveLength(ATTEMPTS);
    const cgroupInUse = /process-containment: ok .*cgroup v2/.test(doctorContainment);
    const doctorSaid = doctorContainment || "(no process-containment line)";
    if (!cgroupInUse) {
      if (process.env.CONDUIT_REQUIRE_CGROUP_CONTAINMENT === "1") {
        throw new Error(
          `CONDUIT_REQUIRE_CGROUP_CONTAINMENT=1 but conduit doctor reports no cgroup containment, so a ` +
            `setsid descendant can outlive its harness call (issue #77). doctor said: ${doctorSaid}`,
        );
      }
      console.warn(
        `[harness-idle-timeout] SKIPPED the setsid-sleeper assertion: conduit doctor reports no cgroup ` +
          `containment, so a setsid descendant is expected to survive the process-group kill ` +
          `(issue #77). Set CONDUIT_REQUIRE_CGROUP_CONTAINMENT=1 to make this a failure. doctor said: ${doctorSaid}`,
      );
      return;
    }
    await f.waitFor(() => sleeperPids().every((pid) => !pidAlive(pid)), { timeoutMs: 5_000 });
  });
});
