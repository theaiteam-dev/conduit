/**
 * Harness journey: Landlock write confinement of overlapped harness calls
 * (issue #122, ADR-0013), driven through a real `conduit run --concurrency 3`.
 *
 * The flow fans out to three children of an `overlap: true` harness station
 * on the shipped `agent-sdk` adapter, with fake-claude-sdk as the CLI. A
 * deterministic `plan` station copies a fixed proposal (plan.json) to
 * children.json, which seeds:
 *   - c1, owning evidence/c1 (the attacker);
 *   - c2, owning evidence/c2 (the victim, which holds notes.md);
 *   - c3, owning evidence/c3 and reports/c3. reports/c3 is never created.
 * Every child writes its declared output, result.json, in its own owned dir.
 * After that, c1 tries five writes through allowlisted Bash, none of which the
 * tool gate refuses (it checks the executable, not the target path):
 *   - `cp` of its result into evidence/c2;
 *   - `cp` over shared.md, a project file no card owns;
 *   - `truncate -s 0 shared.md`;
 *   - `cp` through `shortcut`, a symlink in the project root to evidence/c2;
 *   - `rm evidence/c2/notes.md`.
 * The fake runs each command in its own process tree, which the adapter starts
 * under the llexec helper, so Landlock is what refuses them. The fake reports
 * through harness-flow's stub sink, since a confined call cannot write the
 * stub's log file.
 *
 * Case 1, confined: `conduit doctor` reports write confinement available with
 * the Landlock ABI. c1 and c2 run as one overlap batch: both wait at a barrier
 * that releases only when both calls are running, and both spans carry
 * `concurrent: true` and `write_confinement: landlock`. Every attack command
 * exits non-zero and nothing landed: no file in evidence/c2, notes.md intact,
 * shared.md unchanged. The MARK_DONE integrity check sees only c1's own
 * output, so c1 reaches done. c3 runs after the batch on the serial path,
 * because Landlock can grant only a path that exists, and its span's
 * `overlap_fallback` names reports/c3. Every child and the parent reach done.
 *
 * Case 2, the control: the same flow with `CONDUIT_LLEXEC` naming a file that
 * does not exist, so the probe reports confinement unavailable. `conduit
 * doctor` says so, the run warns once on stderr, and every child runs on the
 * serial path (c2 starts after c1's call ended) with an `overlap_fallback`
 * naming the reason and no `concurrent` or `write_confinement`. c1's attacks
 * now land, and the serial integrity check holds c1 for the files it created,
 * changed or deleted outside its owned dir. The fan-in station's `fan_in: all`
 * holds the parent with `fan-in child_held` rather than merging past c1, and
 * `run status` reports two held cards. That is the evidence that the attacks
 * in case 1 were real and that only the confinement stopped them.
 *
 * Skip rule: case 1 needs a kernel with Landlock ABI 3 or later and the
 * helper (scripts/build-llexec.sh, found at native/llexec/build/llexec, or
 * `CONDUIT_LLEXEC` in the test's env, which is passed through). When `conduit
 * doctor` reports write confinement unavailable, case 1 is registered as
 * skipped with the doctor line, unless CONDUIT_REQUIRE_LANDLOCK=1, in which
 * case it fails naming the doctor line. Case 2 runs everywhere.
 *
 * Asserted through public surfaces: exit codes and stderr, files on disk,
 * `conduit run status`, `conduit journal inspect`, `conduit doctor`, and what
 * the fake recorded. Span attributes come from a read-only journal read,
 * because `journal inspect` does not print them.
 *
 * BLACK-BOX: imports only the harness-flow module, the fake's types and bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { FakeClaudeSdkLogEntry, FakeClaudeSdkRole, FakeClaudeSdkStep } from "./harness/fake-claude-sdk";
import { startHarnessFlow, type CliResult, type HarnessFlow, type HarnessStub } from "./harness/harness-flow";

const TIMEOUT_MS = 90_000;
const CHILDREN = ["c1", "c2", "c3"] as const;
const SHARED = "shared notes nobody owns\n";
const NOTES = "c2's own notes\n";

const SDK_STUB: HarnessStub = {
  adapter: "agent-sdk",
  script: join(import.meta.dir, "harness", "fake-claude-sdk.ts"),
  binName: "claude",
  scenarioVar: "FAKE_CLAUDE_SDK_SCENARIO",
  // A confined call always gets a run-scoped CLAUDE_CONFIG_DIR, which needs a
  // credential: a dummy API key, never used by the fake.
  allowlist: ["ANTHROPIC_API_KEY"],
};

const FLOW = `
flow: bb-landlock-overlap
project_root: .
flow_version: 1
defaults:
  enforce_owned_paths: true
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 100000 }
  per_card: { max_execution_attempts: 1 }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: plan
    worker:
      kind: deterministic
      role: planner
      command: cp
      args: [plan.json, children.json]
    inputs: [plan.json]
    outputs: [children.json]
    fan_out: 3
    child_entry: probe
    child_terminal: done
    resume_at: gather
    next: gather
  - id: probe
    overlap: true
    wip: 3
    worker:
      kind: harness
      harness: agent-sdk
      model: claude-bb-landlock
      tools: ["Bash(cp)", "Bash(truncate)", "Bash(rm)", Write]
      prompt_file: prompts/probe.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: []
    outputs: [result.json]
    output_scope: owned_dir
    next: done
  - id: gather
    worker:
      kind: deterministic
      role: collector
      command: "true"
    fan_in: { policy: all }
    inputs: []
    outputs: []
    next: done
security:
  bash:
    allow: ["cp", "true"]
    deny_shell_metachars: true
channels:
  ingress:
    type: cli
`;

const PLAN = JSON.stringify({
  children: [
    { id: "c1", depends_on: [], owned_paths: ["evidence/c1"] },
    { id: "c2", depends_on: [], owned_paths: ["evidence/c2"] },
    { id: "c3", depends_on: [], owned_paths: ["evidence/c3", "reports/c3"] },
  ],
});

const FILES = {
  "prompts/probe.md": "ROLE:PROBE Write your summary.\n",
  "plan.json": PLAN,
  "shared.md": SHARED,
  "evidence/c1/.keep": "",
  "evidence/c2/notes.md": NOTES,
  "evidence/c3/.keep": "",
};

const bash = (label: string, command: string): FakeClaudeSdkStep => ({ label, tool: "Bash", input: { command, description: label } });
const writeOutput = (child: string): FakeClaudeSdkStep => ({
  label: "write-output",
  tool: "Write",
  input: { file_path: `evidence/${child}/result.json`, content: JSON.stringify({ summary: `${child} was here` }) },
});

const ATTACKS: FakeClaudeSdkStep[] = [
  bash("into-sibling", "cp evidence/c1/result.json evidence/c2/planted.json"),
  bash("over-shared", "cp evidence/c1/result.json shared.md"),
  bash("truncate-shared", "truncate -s 0 shared.md"),
  bash("through-symlink", "cp evidence/c1/result.json shortcut/via-link.json"),
  bash("remove-sibling", "rm evidence/c2/notes.md"),
];
const ATTACK_LABELS = ATTACKS.map((s) => s.label);

/**
 * One role per child, picked by the absolute output path the kernel appends to
 * each child's prompt. With `barrier`, c1 and c2 wait for each other.
 */
function roles(barrier: boolean): FakeClaudeSdkRole[] {
  const meet = barrier ? { barrier: { name: "batch", parties: 2, timeoutMs: 15_000 } } : {};
  return [
    { name: "c1", promptIncludes: "evidence/c1/result.json", calls: [{ ...meet, steps: [writeOutput("c1"), ...ATTACKS] }] },
    { name: "c2", promptIncludes: "evidence/c2/result.json", calls: [{ ...meet, steps: [writeOutput("c2")] }] },
    { name: "c3", promptIncludes: "evidence/c3/result.json", calls: [{ steps: [writeOutput("c3")] }] },
  ];
}

function startFlow(name: string, opts: { barrier: boolean; env?: Record<string, string> }): HarnessFlow {
  const f = startHarnessFlow<FakeClaudeSdkRole>({
    flowYaml: FLOW.replace("bb-landlock-overlap", name),
    files: FILES,
    entryInput: "plan.json",
    stub: SDK_STUB,
    stubSink: true,
    env: { ANTHROPIC_API_KEY: "blackbox-unused", ...opts.env },
    roles: roles(opts.barrier),
  });
  symlinkSync(join(f.projectRoot, "evidence", "c2"), join(f.projectRoot, "shortcut"));
  return f;
}

async function doctorLine(f: HarnessFlow): Promise<string> {
  const doctor = await f.conduit(["doctor"]);
  return (doctor.stdout + doctor.stderr).split("\n").find((l) => l.includes("write-confinement:"))?.trim() ?? "";
}

const byRole = (f: HarnessFlow): Map<string, FakeClaudeSdkLogEntry> =>
  new Map(f.stubLog<FakeClaudeSdkLogEntry>().map((e) => [e.role, e]));

const probeSpan = (f: HarnessFlow, card: string) => {
  const spans = f.journalSpans(card).filter((s) => s.name === "probe.harness");
  expect(spans).toHaveLength(1);
  return spans[0]!;
};

/** The helper the confined case uses: the operator's CONDUIT_LLEXEC when set, else the kernel's own lookup. */
const passthroughLlexec: Record<string, string> =
  process.env.CONDUIT_LLEXEC !== undefined && process.env.CONDUIT_LLEXEC !== ""
    ? { CONDUIT_LLEXEC: process.env.CONDUIT_LLEXEC }
    : {};

// Decide once, before registering case 1, whether this host can confine writes.
const hostDoctor = await (async () => {
  const probe = startFlow("bb-landlock-doctor", { barrier: false, env: passthroughLlexec });
  try {
    return await doctorLine(probe);
  } finally {
    await probe.cleanup();
  }
})();
const hostConfines = /write-confinement: ok — Landlock ABI \d+ via /.test(hostDoctor);
const doctorSaid = hostDoctor || "(no write-confinement line)";

if (!hostConfines && process.env.CONDUIT_REQUIRE_LANDLOCK === "1") {
  describe("landlock journey: confined overlap", () => {
    test("write confinement is available (CONDUIT_REQUIRE_LANDLOCK=1)", () => {
      throw new Error(
        `CONDUIT_REQUIRE_LANDLOCK=1 but conduit doctor reports no write confinement, so overlapped harness ` +
          `calls would run one at a time (issue #122). doctor said: ${doctorSaid}`,
      );
    });
  });
} else if (!hostConfines) {
  console.warn(
    `[landlock-overlap] SKIPPED the confined case: conduit doctor reports no write confinement (issue #122). ` +
      `Run scripts/build-llexec.sh, or set CONDUIT_REQUIRE_LANDLOCK=1 to make this a failure. doctor said: ${doctorSaid}`,
  );
  describe.skip(`landlock journey: confined overlap (skipped: ${doctorSaid})`, () => {
    test("skipped", () => {});
  });
} else {
  describe("landlock journey: overlapped calls run write-confined, and a sibling's dir is out of reach", () => {
    let f: HarnessFlow;
    let run: CliResult;
    let doctor: string;

    beforeAll(async () => {
      f = startFlow("bb-landlock-confined", { barrier: true, env: passthroughLlexec });
      doctor = await doctorLine(f);
      run = await f.run(["--concurrency", "3"]);
    }, TIMEOUT_MS);

    afterAll(async () => {
      await f?.cleanup();
    });

    test("conduit doctor reports write confinement available, with the Landlock ABI", () => {
      expect(doctor).toMatch(/^write-confinement: ok — Landlock ABI (\d+) via \/\S*llexec; overlapped harness calls run write-confined$/);
      const abi = Number(/ABI (\d+)/.exec(doctor)![1]);
      expect(abi).toBeGreaterThanOrEqual(3);
    });

    test("the run completes: every child and the parent reach done", async () => {
      expect(run.stderr).not.toContain("write confinement is unavailable");
      expect(run.exitCode).toBe(0);
      const status = await f.runStatus();
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=complete)`);
      for (const child of CHILDREN) {
        const inspect = await f.journalInspect(child);
        expect(inspect.exitCode).toBe(0);
        expect(inspect.stdout).toContain(`[${child}] entered_lane: probe → done (forward)`);
        expect(inspect.stdout).not.toMatch(/→ (scrap|hold)/);
        expect(JSON.parse(readFileSync(join(f.projectRoot, "evidence", child, "result.json"), "utf8"))).toEqual({
          summary: `${child} was here`,
        });
      }
    });

    test("c1 and c2 ran at the same time, as one write-confined batch", () => {
      const log = byRole(f);
      // Each waited at the barrier until the other's call was running.
      expect(log.get("c1")!.barrierReleased).toBe(true);
      expect(log.get("c2")!.barrierReleased).toBe(true);
      for (const [child, sibling] of [["c1", "c2"], ["c2", "c1"]] as const) {
        const attrs = probeSpan(f, child).attributes;
        expect(attrs.concurrent).toBe(true);
        expect(attrs.write_confinement).toBe("landlock");
        expect(attrs.overlap_fallback).toBeUndefined();
        // The diff may attribute the sibling's own output to the sibling, and nothing else.
        const attributed = (attrs.overlap_attributed ?? []) as Array<{ card: string; sample: string[] }>;
        for (const a of attributed) {
          expect(a.card).toBe(sibling);
          expect(a.sample).toEqual([`evidence/${sibling}/result.json`]);
        }
      }
    });

    test("the tool gate allowed every attack, and each one failed at the syscall", () => {
      const c1 = byRole(f).get("c1")!;
      expect(c1.answers.map((a) => [a.label, a.decision, a.performed])).toEqual([
        ["write-output", "allow", true],
        ...ATTACK_LABELS.map((label) => [label, "allow", true]),
      ]);
      for (const a of c1.answers.filter((x) => ATTACK_LABELS.includes(x.label))) {
        expect({ label: a.label, failed: a.exitCode !== 0 }).toEqual({ label: a.label, failed: true });
      }
    });

    test("nothing c1 aimed outside its owned dir landed", () => {
      expect(readdirSync(join(f.projectRoot, "evidence", "c2")).sort()).toEqual(["notes.md", "result.json"]);
      expect(readFileSync(join(f.projectRoot, "evidence", "c2", "notes.md"), "utf8")).toBe(NOTES);
      expect(readFileSync(join(f.projectRoot, "shared.md"), "utf8")).toBe(SHARED);
      expect(readdirSync(join(f.projectRoot, "evidence", "c1")).sort()).toEqual([".keep", "result.json"]);
    });

    test("c3, whose second owned path does not exist, ran on the serial path after the batch", () => {
      const attrs = probeSpan(f, "c3").attributes;
      expect(attrs.overlap_fallback).toBe(
        "owned path 'reports/c3' does not exist, and write confinement needs it before the call",
      );
      expect(attrs.concurrent).toBeUndefined();
      expect(attrs.write_confinement).toBeUndefined();
      const log = byRole(f);
      expect(log.get("c3")!.startedAt).toBeGreaterThanOrEqual(Math.max(log.get("c1")!.endedAt, log.get("c2")!.endedAt));
    });
  });
}

describe("landlock journey: without write confinement, overlap falls back to serial and the attack lands", () => {
  let f: HarnessFlow;
  let run: CliResult;
  let doctor: string;
  const missingHelper = "/nonexistent/conduit-bb/llexec";

  beforeAll(async () => {
    f = startFlow("bb-landlock-unavailable", { barrier: false, env: { CONDUIT_LLEXEC: missingHelper } });
    doctor = await doctorLine(f);
    run = await f.run(["--concurrency", "3"]);
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  const reason = (): string => `CONDUIT_LLEXEC='${missingHelper}' is not an executable file`;

  test("conduit doctor reports write confinement unavailable, naming the reason", () => {
    expect(doctor).toBe(
      `write-confinement: ok — warning: unavailable (${reason()}); cards of overlap: true stations run one at a time, ` +
        "see docs/harness-containment.md",
    );
  });

  test("the run warns once that overlap stations run one at a time", () => {
    const warnings = run.stderr.split("\n").filter((l) => l.includes("write confinement is unavailable"));
    expect(warnings).toEqual([`overlap: write confinement is unavailable (${reason()}); cards of overlap: true stations run one at a time`]);
  });

  test("every child ran on the serial path, one call after another, with the fallback reason on its span", () => {
    for (const child of CHILDREN) {
      const attrs = probeSpan(f, child).attributes;
      expect(attrs.overlap_fallback).toBe(`write confinement unavailable: ${reason()}`);
      expect(attrs.concurrent).toBeUndefined();
      expect(attrs.write_confinement).toBeUndefined();
    }
    const log = byRole(f);
    expect(log.get("c2")!.startedAt).toBeGreaterThanOrEqual(log.get("c1")!.endedAt);
    expect(log.get("c3")!.startedAt).toBeGreaterThanOrEqual(log.get("c2")!.endedAt);
  });

  test("unconfined, c1's attacks landed", () => {
    const c1 = byRole(f).get("c1")!;
    for (const a of c1.answers) expect({ label: a.label, exitCode: a.exitCode ?? 0 }).toEqual({ label: a.label, exitCode: 0 });
    expect(existsSync(join(f.projectRoot, "evidence", "c2", "planted.json"))).toBe(true);
    expect(existsSync(join(f.projectRoot, "evidence", "c2", "via-link.json"))).toBe(true);
    expect(existsSync(join(f.projectRoot, "evidence", "c2", "notes.md"))).toBe(false);
    expect(readFileSync(join(f.projectRoot, "shared.md"), "utf8")).toBe("");
  });

  test("the serial integrity check holds c1 for every write outside its owned dir, the delete included", async () => {
    const escalation = run.stderr.split("\n").find((l) => l.startsWith("escalation: card c1 held"));
    expect(escalation).toBeDefined();
    expect(escalation).toContain("integrity violation (owned_paths)");
    for (const rel of ["evidence/c2/planted.json", "evidence/c2/via-link.json", "shared.md", "evidence/c2/notes.md"]) {
      expect(escalation).toContain(`path_escape:${join(f.projectRoot, rel)}`);
    }
    const inspect = await f.journalInspect("c1");
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain("[c1] entered_lane: probe → hold (hold)");
    for (const child of ["c2", "c3"]) {
      const other = await f.journalInspect(child);
      expect(other.stdout).toContain(`[${child}] entered_lane: probe → done (forward)`);
    }
  });

  test("fan_in: all holds the parent instead of merging past the held child", async () => {
    expect(run.exitCode).not.toBe(0);
    const status = await f.runStatus();
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`run ${f.runId}: held (2 held cards)`);
    const parent = await f.journalInspect();
    expect(parent.exitCode).toBe(0);
    expect(parent.stdout).toContain("fan-in child_held");
    expect(parent.stdout).not.toContain("→ gather");
    expect(parent.stdout).not.toContain("→ done");
  });
});
