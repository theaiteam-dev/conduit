/**
 * Harness journey: Landlock write confinement of overlapped harness calls on
 * the `codex-app-server` and `opencode` adapters (issue #122, ADR-0013),
 * driven through a real `conduit run --concurrency 3`. It is the
 * landlock-overlap.test.ts journey (agent-sdk) run once per adapter, with
 * fake-codex-app-server and fake-opencode as the vendor CLIs.
 *
 * Both adapters drive a long-lived server rather than a one-shot CLI: the
 * kernel starts `codex app-server` or `opencode serve` under the llexec
 * helper, and the server runs each approved command in its own process tree,
 * which inherits the Landlock ruleset. So the commands below are refused by
 * the kernel's Landlock ruleset, not by the fakes.
 *
 * The flow fans out to three children of an `overlap: true` harness station.
 * A deterministic `plan` station copies a fixed proposal (plan.json) to
 * children.json, which seeds:
 *   - c1, owning evidence/c1 (the attacker);
 *   - c2, owning evidence/c2 (the victim, which holds notes.md);
 *   - c3, owning evidence/c3 and reports/c3. reports/c3 is never created.
 * Every child writes its declared output, result.json, in its own owned dir,
 * through the adapter's file tool (a codex `fileChange`, an opencode `write`),
 * which the gate allows because the path is inside the card's owned paths.
 * After that, c1 tries five writes through allowlisted Bash. The tool gate
 * checks the executable, not the target path, so it allows each one:
 *   - `cp` of its result into evidence/c2;
 *   - `cp` over shared.md, a project file no card owns;
 *   - `truncate -s 0 shared.md`;
 *   - `cp` through `shortcut`, a symlink in the project root to evidence/c2;
 *   - `rm evidence/c2/notes.md`.
 * The attacks are Bash commands on purpose. A codex `fileChange` or an
 * opencode `edit` outside the owned dir is denied by the gate itself (the
 * adapters gate each path as Write or Edit against the owned paths), which
 * would prove the gate, not the confinement. Codex sends a command as
 * `/bin/bash -lc '<cmd>'` and the adapter unwraps it to a Bash call; opencode
 * sends a `bash` ask joined by callID to the tool part that carries the
 * command. The fakes report through harness-flow's stub sink, since a confined
 * server cannot write the stub's log file.
 *
 * Case 1, confined, per adapter: `conduit doctor` reports write confinement
 * available with the Landlock ABI. c1 and c2 run as one overlap batch: both
 * wait at a barrier that releases only when both calls are running, and both
 * spans carry `concurrent: true` and `write_confinement: landlock`. The gate
 * allowed every attack, each ran and exited non-zero, and nothing landed: no
 * file in evidence/c2, notes.md intact, shared.md unchanged. c1 reaches done.
 * c3 runs after the batch on the serial path, and its span's
 * `overlap_fallback` names reports/c3. Every child and the parent reach done.
 * The kernel process runs with TMPDIR set to a dir this test owns, so the
 * per-call temp dir each confined call got (`conduit-call-tmp-*`, which the
 * fake saw as its TMPDIR) can be checked: it existed during the call and is
 * gone after the run. The temp dir is empty after the run: the adapter's
 * run-scoped config dirs (`conduit-codex-home-*`, `conduit-opencode-*`) and
 * the kernel's probe dirs were removed too.
 *
 * Case 2, the control, per adapter: the same flow with `CONDUIT_LLEXEC`
 * naming a file that does not exist, so the probe reports confinement
 * unavailable. Every child runs on the serial path with an `overlap_fallback`
 * naming the reason and no `concurrent` or `write_confinement`. c1's attacks
 * land, the serial integrity check holds c1 for the files it created, changed
 * or deleted outside its owned dir, and `fan_in: all` holds the parent. The
 * control runs for both adapters, not one: each adapter's fake runs the
 * commands in its own server, so only a control on the same adapter shows that
 * this adapter's attacks were real and that the confinement alone stopped
 * them in case 1. The doctor and stderr wording of the unavailable path is
 * adapter-independent and asserted in landlock-overlap.test.ts.
 *
 * Skip rule: as landlock-overlap.test.ts. Case 1 needs a kernel with Landlock
 * ABI 3 or later and the helper (scripts/build-llexec.sh, found at
 * native/llexec/build/llexec, or `CONDUIT_LLEXEC` in the test's env, which is
 * passed through). When `conduit doctor` reports write confinement
 * unavailable, case 1 is registered as skipped with the doctor line, unless
 * CONDUIT_REQUIRE_LANDLOCK=1, in which case it fails naming the doctor line.
 * Case 2 runs everywhere.
 *
 * Asserted through public surfaces: exit codes and stderr, files on disk,
 * `conduit run status`, `conduit journal inspect`, `conduit doctor`, and what
 * the fakes recorded. Span attributes come from a read-only journal read,
 * because `journal inspect` does not print them.
 *
 * BLACK-BOX: imports only the harness-flow module, the fakes' types and bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeCodexLogEntry, FakeCodexRole, FakeCodexStep } from "./harness/fake-codex-app-server";
import type { FakeOpenCodeLogEntry, FakeOpenCodeRole, FakeOpenCodeStep } from "./harness/fake-opencode";
import { startHarnessFlow, type CliResult, type HarnessFlow, type HarnessStub } from "./harness/harness-flow";

const TIMEOUT_MS = 90_000;
const CHILDREN = ["c1", "c2", "c3"] as const;
const SHARED = "shared notes nobody owns\n";
const NOTES = "c2's own notes\n";
const BARRIER = { name: "batch", parties: 2, timeoutMs: 15_000 };

/** One attack command c1 runs after writing its output. */
const ATTACKS: Array<{ label: string; command: string }> = [
  { label: "into-sibling", command: "cp evidence/c1/result.json evidence/c2/planted.json" },
  { label: "over-shared", command: "cp evidence/c1/result.json shared.md" },
  { label: "truncate-shared", command: "truncate -s 0 shared.md" },
  { label: "through-symlink", command: "cp evidence/c1/result.json shortcut/via-link.json" },
  { label: "remove-sibling", command: "rm evidence/c2/notes.md" },
];
const ATTACK_LABELS = ATTACKS.map((a) => a.label);

/** One step as every adapter's fake reports it, in step order. */
interface StepRecord {
  label: string;
  allowed: boolean;
  performed: boolean;
  exitCode: number | undefined;
}

/** One call as every adapter's fake reports it. */
interface CallRecord {
  role: string;
  startedAt: number;
  endedAt: number;
  barrierReleased: boolean | null;
  tmpdir: string | null;
  steps: StepRecord[];
}

/** What differs between the adapters: the stub, its env, the flow's model line, its scenario and its log. */
interface AdapterCase {
  adapter: string;
  stub: HarnessStub;
  env: Record<string, string>;
  model: string;
  roles(barrier: boolean): unknown[];
  calls(f: HarnessFlow): Map<string, CallRecord>;
}

const output = (child: string): string => JSON.stringify({ summary: `${child} was here` });
const meet = (barrier: boolean) => (barrier ? { barrier: BARRIER } : {});

const CODEX: AdapterCase = {
  adapter: "codex-app-server",
  stub: {
    adapter: "codex-app-server",
    script: join(import.meta.dir, "harness", "fake-codex-app-server.ts"),
    binName: "codex",
    scenarioVar: "FAKE_CODEX_SCENARIO",
    allowlist: ["OPENAI_API_KEY"],
  },
  // CODEX_HOME names a dir that does not exist, so the adapter never links the
  // developer's own auth.json: the child authenticates through the allowlisted key.
  env: { OPENAI_API_KEY: "sk-blackbox-unused", CODEX_HOME: "/nonexistent/conduit-bb-codex-home" },
  model: "gpt-bb-landlock",
  roles(barrier): FakeCodexRole[] {
    const write = (child: string): FakeCodexStep => ({
      label: "write-output",
      write: { path: `evidence/${child}/result.json`, content: output(child) },
    });
    const attacks: FakeCodexStep[] = ATTACKS.map((a) => ({ label: a.label, command: a.command }));
    return [
      { name: "c1", promptIncludes: "evidence/c1/result.json", calls: [{ ...meet(barrier), steps: [write("c1"), ...attacks] }] },
      { name: "c2", promptIncludes: "evidence/c2/result.json", calls: [{ ...meet(barrier), steps: [write("c2")] }] },
      { name: "c3", promptIncludes: "evidence/c3/result.json", calls: [{ steps: [write("c3")] }] },
    ];
  },
  calls(f) {
    return new Map(
      f.stubLog<FakeCodexLogEntry>().map((e) => [
        e.role,
        {
          role: e.role,
          startedAt: e.startedAt,
          endedAt: e.endedAt,
          barrierReleased: e.barrierReleased,
          tmpdir: e.tmpdir,
          steps: e.decisions.map((d) => ({
            label: d.label,
            allowed: d.decision === "accept",
            // The fake runs an accepted command or write, and records an exit code for a command.
            performed: d.decision === "accept",
            exitCode: d.exitCode,
          })),
        },
      ]),
    );
  },
};

/** The opencode steps of each child, kept so a logged answer's step index can be named. */
function opencodeSteps(child: string): Array<FakeOpenCodeStep & { label: string }> {
  const write = { label: "write-output", type: "write" as const, path: `evidence/${child}/result.json`, content: output(child) };
  if (child !== "c1") return [write];
  return [write, ...ATTACKS.map((a) => ({ label: a.label, type: "bash" as const, command: a.command }))];
}

const OPENCODE: AdapterCase = {
  adapter: "opencode",
  stub: {
    adapter: "opencode",
    script: join(import.meta.dir, "harness", "fake-opencode.ts"),
    binName: "opencode",
    scenarioVar: "FAKE_OPENCODE_SCENARIO",
    // The adapter needs a credential for the model's provider.
    allowlist: ["OPENAI_API_KEY"],
  },
  // XDG_DATA_HOME names a dir that does not exist, so a developer's real
  // opencode login never reaches the fake's env.
  env: { OPENAI_API_KEY: "sk-blackbox-unused", XDG_DATA_HOME: "/nonexistent/conduit-bb-opencode-data" },
  model: "openai/gpt-bb-landlock",
  roles(barrier): FakeOpenCodeRole[] {
    const strip = (steps: Array<FakeOpenCodeStep & { label: string }>): FakeOpenCodeStep[] =>
      steps.map(({ label: _label, ...step }) => step as FakeOpenCodeStep);
    return [
      { name: "c1", promptIncludes: "evidence/c1/result.json", calls: [{ ...meet(barrier), steps: strip(opencodeSteps("c1")) }] },
      { name: "c2", promptIncludes: "evidence/c2/result.json", calls: [{ ...meet(barrier), steps: strip(opencodeSteps("c2")) }] },
      { name: "c3", promptIncludes: "evidence/c3/result.json", calls: [{ steps: strip(opencodeSteps("c3")) }] },
    ];
  },
  calls(f) {
    const log = f.stubLog<FakeOpenCodeLogEntry>();
    const out = new Map<string, CallRecord>();
    for (const e of log) {
      if (e.kind !== "done") continue;
      const steps = opencodeSteps(e.role);
      const answers = log.filter(
        (a): a is Extract<FakeOpenCodeLogEntry, { kind: "answer" }> => a.kind === "answer" && a.role === e.role,
      );
      out.set(e.role, {
        role: e.role,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        barrierReleased: e.barrierReleased,
        tmpdir: e.tmpdir,
        steps: answers.map((a) => ({
          label: steps[a.step]?.label ?? `step-${a.step}`,
          allowed: a.reply === "once",
          performed: a.performed,
          exitCode: a.exitCode,
        })),
      });
    }
    return out;
  },
};

function flowYaml(name: string, c: AdapterCase): string {
  return `
flow: ${name}
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
      harness: ${c.adapter}
      model: ${c.model}
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
}

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

function startFlow(c: AdapterCase, name: string, opts: { barrier: boolean; env?: Record<string, string> }): HarnessFlow {
  const f = startHarnessFlow<unknown>({
    flowYaml: flowYaml(name, c),
    files: FILES,
    entryInput: "plan.json",
    stub: c.stub,
    stubSink: true,
    env: { ...c.env, ...opts.env },
    roles: c.roles(opts.barrier),
  });
  symlinkSync(join(f.projectRoot, "evidence", "c2"), join(f.projectRoot, "shortcut"));
  return f;
}

async function doctorLine(f: HarnessFlow): Promise<string> {
  const doctor = await f.conduit(["doctor"]);
  return (doctor.stdout + doctor.stderr).split("\n").find((l) => l.includes("write-confinement:"))?.trim() ?? "";
}

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

// Decide once, before registering case 1, whether this host can confine writes. The doctor line does not depend on the adapter.
const hostDoctor = await (async () => {
  const probe = startFlow(CODEX, "bb-landlock-adapters-doctor", { barrier: false, env: passthroughLlexec });
  try {
    return await doctorLine(probe);
  } finally {
    await probe.cleanup();
  }
})();
const hostConfines = /write-confinement: ok — Landlock ABI \d+ via /.test(hostDoctor);
const doctorSaid = hostDoctor || "(no write-confinement line)";

for (const c of [CODEX, OPENCODE]) {
  const slug = c.adapter.replace(/[^a-z]/g, "");

  if (!hostConfines && process.env.CONDUIT_REQUIRE_LANDLOCK === "1") {
    describe(`landlock journey (${c.adapter}): confined overlap`, () => {
      test("write confinement is available (CONDUIT_REQUIRE_LANDLOCK=1)", () => {
        throw new Error(
          `CONDUIT_REQUIRE_LANDLOCK=1 but conduit doctor reports no write confinement, so overlapped harness ` +
            `calls would run one at a time (issue #122). doctor said: ${doctorSaid}`,
        );
      });
    });
  } else if (!hostConfines) {
    console.warn(
      `[landlock-overlap-adapters] SKIPPED the confined ${c.adapter} case: conduit doctor reports no write confinement ` +
        `(issue #122). Run scripts/build-llexec.sh, or set CONDUIT_REQUIRE_LANDLOCK=1 to make this a failure. ` +
        `doctor said: ${doctorSaid}`,
    );
    describe.skip(`landlock journey (${c.adapter}): confined overlap (skipped: ${doctorSaid})`, () => {
      test("skipped", () => {});
    });
  } else {
    describe(`landlock journey (${c.adapter}): overlapped calls run write-confined, and a sibling's dir is out of reach`, () => {
      let f: HarnessFlow;
      let run: CliResult;
      let doctor: string;
      // The kernel's temp dir, owned by this test, so its run-scoped dirs can be listed after the run.
      let kernelTmp: string;

      beforeAll(async () => {
        kernelTmp = mkdtempSync(join(tmpdir(), "conduit-bb-kernel-tmp-"));
        f = startFlow(c, `bb-landlock-${slug}-confined`, { barrier: true, env: { ...passthroughLlexec, TMPDIR: kernelTmp } });
        doctor = await doctorLine(f);
        run = await f.run(["--concurrency", "3"]);
      }, TIMEOUT_MS);

      afterAll(async () => {
        await f?.cleanup();
        if (kernelTmp !== undefined) rmSync(kernelTmp, { recursive: true, force: true });
      });

      test("conduit doctor reports write confinement available, with the Landlock ABI", () => {
        expect(doctor).toMatch(/^write-confinement: ok — Landlock ABI (\d+) via \/\S*llexec; overlapped harness calls run write-confined$/);
        expect(Number(/ABI (\d+)/.exec(doctor)![1])).toBeGreaterThanOrEqual(3);
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
        const calls = c.calls(f);
        // Each waited at the barrier until the other's call was running.
        expect(calls.get("c1")!.barrierReleased).toBe(true);
        expect(calls.get("c2")!.barrierReleased).toBe(true);
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
        const c1 = c.calls(f).get("c1")!;
        expect(c1.steps.map((s) => [s.label, s.allowed, s.performed])).toEqual([
          ["write-output", true, true],
          ...ATTACK_LABELS.map((label) => [label, true, true]),
        ]);
        for (const s of c1.steps.filter((x) => ATTACK_LABELS.includes(x.label))) {
          expect({ label: s.label, exitCode: s.exitCode, failed: s.exitCode !== 0 }).toMatchObject({ label: s.label, failed: true });
          expect(typeof s.exitCode).toBe("number");
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
        const calls = c.calls(f);
        expect(calls.get("c3")!.startedAt).toBeGreaterThanOrEqual(Math.max(calls.get("c1")!.endedAt, calls.get("c2")!.endedAt));
      });

      test("each confined call ran with its own per-call TMPDIR, and every run-scoped dir is gone after the run", () => {
        const calls = c.calls(f);
        const seen = (["c1", "c2"] as const).map((child) => calls.get(child)!.tmpdir);
        for (const dir of seen) {
          expect(dir).not.toBeNull();
          expect(dir!.startsWith(join(kernelTmp, "conduit-call-tmp-"))).toBe(true);
          expect(existsSync(dir!)).toBe(false);
        }
        expect(new Set(seen).size).toBe(2);
        // The per-call temp dirs, the adapter's run-scoped config dirs (conduit-codex-home-*, conduit-opencode-*),
        // the confinement probe's scratch dir and the codex version probe's cwd all lived here, and none is left.
        expect(readdirSync(kernelTmp)).toEqual([]);
      });
    });
  }

  describe(`landlock journey (${c.adapter}): without write confinement, overlap falls back to serial and the attack lands`, () => {
    let f: HarnessFlow;
    let run: CliResult;
    const missingHelper = "/nonexistent/conduit-bb/llexec";
    const reason = `CONDUIT_LLEXEC='${missingHelper}' is not an executable file`;

    beforeAll(async () => {
      f = startFlow(c, `bb-landlock-${slug}-unavailable`, { barrier: false, env: { CONDUIT_LLEXEC: missingHelper } });
      run = await f.run(["--concurrency", "3"]);
    }, TIMEOUT_MS);

    afterAll(async () => {
      await f?.cleanup();
    });

    test("every child ran on the serial path, one call after another, with the fallback reason on its span", () => {
      expect(run.stderr).toContain(`overlap: write confinement is unavailable (${reason})`);
      for (const child of CHILDREN) {
        const attrs = probeSpan(f, child).attributes;
        expect(attrs.overlap_fallback).toBe(`write confinement unavailable: ${reason}`);
        expect(attrs.concurrent).toBeUndefined();
        expect(attrs.write_confinement).toBeUndefined();
      }
      const calls = c.calls(f);
      // c1 is held, so only the order of the calls that ran is asserted: each starts after the one before ended.
      const ordered = CHILDREN.map((child) => calls.get(child)!).sort((a, b) => a.startedAt - b.startedAt);
      for (let i = 1; i < ordered.length; i++) expect(ordered[i]!.startedAt).toBeGreaterThanOrEqual(ordered[i - 1]!.endedAt);
    });

    test("unconfined, c1's attacks landed", () => {
      const c1 = c.calls(f).get("c1")!;
      for (const s of c1.steps.filter((x) => ATTACK_LABELS.includes(x.label))) {
        expect({ label: s.label, allowed: s.allowed, exitCode: s.exitCode }).toEqual({ label: s.label, allowed: true, exitCode: 0 });
      }
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
}
