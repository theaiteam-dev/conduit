/**
 * Harness journey: the per-call tool gate on the shipped `agent-sdk` adapter
 * (issue #21), driven through a real `conduit run`.
 *
 * The real `conduit run` builds the agent-sdk adapter from engine config, and
 * the adapter runs the real `@anthropic-ai/claude-agent-sdk` `query()` with
 * fake-claude-sdk as `pathToClaudeCodeExecutable`. The fake speaks the SDK's
 * stream-json control protocol: the SDK registers the adapter's PreToolUse
 * hook at initialize, and the fake sends a `hook_callback` control request
 * before each scripted tool call. The adapter's hook asks the kernel's gate,
 * and the fake performs a call's effect (runs the command, writes the file)
 * only when no hook denied it. The station allows `Bash(cat)` and `Write`.
 *
 * Case 1, a mixed turn with `enforce_owned_paths`:
 *   - `cat topic.md` is allowed (allowlisted executable) and runs;
 *   - `curl -s https://example.com` is denied (not allowlisted);
 *   - `cat topic.md > copy.md` is denied (shell metacharacter), copy.md does
 *     not exist;
 *   - a Write of result.json is allowed, and the file exists;
 *   - a Write outside the project root is denied (path_escape), and the file
 *     does not exist.
 *   The run exits 0, the card reaches done, `journal inspect` prints one
 *   gate-decision row per call under the research.harness span, and the span's
 *   usage is the fake's result message usage.
 *
 * Case 2, the same gate on a flow without `enforce_owned_paths`: the gate gets
 * no owned paths and confines writes to the project root.
 *
 * Case 3, a hold: an AskUserQuestion call is held. The adapter answers the
 * hook with `continue: false`, the fake stops the turn and emits its result,
 * and the card lands in `hold` at attempt 0 with no second invocation. The
 * held call's usage is billed: it is on the span, and with `max_tokens` below
 * that usage the consumption andon trips on it.
 *
 * Case 4, containment: the fake spawns a `setsid` sleeper during the call.
 * It must be dead after the run when `conduit doctor` reports cgroup
 * containment, with the same skip/require logic as
 * harness-idle-timeout.test.ts.
 *
 * Asserted through public surfaces: the run's exit code and stderr,
 * `conduit run status`, `conduit journal inspect`, files on disk, and the
 * answers the fake recorded. The span's token columns come from a read-only
 * journal read, because no CLI prints them.
 *
 * BLACK-BOX: imports only the harness-flow module, the fake's types and bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeClaudeSdkLogEntry, FakeClaudeSdkRole, FakeClaudeSdkStep } from "./harness/fake-claude-sdk";
import { pidAlive, startHarnessFlow, type CliResult, type HarnessFlow, type HarnessStub } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;
const MODEL = "claude-bb-sdk-model";

const SDK_STUB: HarnessStub = {
  adapter: "agent-sdk",
  script: join(import.meta.dir, "harness", "fake-claude-sdk.ts"),
  binName: "claude",
  scenarioVar: "FAKE_CLAUDE_SDK_SCENARIO",
};

function flowYaml(name: string, opts: { enforceOwnedPaths?: boolean; maxTokens?: number } = {}): string {
  return `
flow: ${name}
project_root: .
flow_version: 1
defaults:
  enforce_owned_paths: ${opts.enforceOwnedPaths ?? true}
budgets:
  run: { wall_clock_minutes: 2, max_tokens: ${opts.maxTokens ?? 100000} }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: research
    worker:
      kind: harness
      harness: agent-sdk
      model: ${MODEL}
      tools: ["Bash(cat)", Write]
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
}

const FILES = {
  "prompts/maker.md": "ROLE:MAKER Answer the question in topic.md and write result.json.\n",
  "topic.md": "What is a kanban card?\n",
};

const OUTPUT = JSON.stringify({ summary: "a card on a board" });

const bash = (label: string, command: string): FakeClaudeSdkStep => ({ label, tool: "Bash", input: { command, description: label } });
const write = (label: string, file_path: string, content: string): FakeClaudeSdkStep => ({
  label,
  tool: "Write",
  input: { file_path, content },
});

function answersOf(entry: FakeClaudeSdkLogEntry): Array<[string, string, boolean]> {
  return entry.answers.map((a) => [a.label, a.decision, a.performed]);
}

/** The lines `journal inspect` prints under the first `research.harness` span. */
function harnessRows(inspect: string, cardId: string): string[] {
  const lines = inspect.split("\n");
  const header = lines.findIndex((l) => l.includes(`[${cardId}] research@0 research.harness`));
  expect(header).toBeGreaterThanOrEqual(0);
  const rows: string[] = [];
  for (const l of lines.slice(header + 1)) {
    if (!/ #\d+ /.test(l)) break;
    rows.push(l);
  }
  return rows;
}

const decisionsIn = (rows: string[]): string[] =>
  rows.filter((r) => r.includes(" gate-decision ")).map((r) => r.slice(r.indexOf(" gate-decision ") + 1));

describe("agent-sdk journey: the tool gate decides each call the SDK's hook reports", () => {
  let f: HarnessFlow;
  let run: CliResult;
  let outsidePath: string;

  beforeAll(async () => {
    f = startHarnessFlow<FakeClaudeSdkRole>({
      flowYaml: flowYaml("bb-agent-sdk-gate"),
      files: FILES,
      entryInput: "topic.md",
      stub: SDK_STUB,
      roles: ({ scratchDir }) => {
        outsidePath = join(scratchDir, "escape.txt");
        return [
          {
            name: "maker",
            promptIncludes: "ROLE:MAKER",
            calls: [
              {
                steps: [
                  bash("cat", "cat topic.md"),
                  bash("curl", "curl -s https://example.com"),
                  bash("redirect", "cat topic.md > copy.md"),
                  write("write-output", "result.json", OUTPUT),
                  write("write-outside", outsidePath, "escaped\n"),
                ],
                usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 600, cache_creation_input_tokens: 50 },
                costUsd: 0.0031,
              },
            ],
          },
        ];
      },
    });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("conduit run exits 0 and run status reports the run complete", async () => {
    expect(run.exitCode).toBe(0);
    const status = await f.runStatus();
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=complete)`);
    expect(status.stdout).toMatch(/research: 1 maker \+ 0 critic call\(s\), busy \d+\.\ds/);
  });

  test("the SDK ran the CLI in stream-json mode with the kernel's hook, settings and tool list", () => {
    const log = f.stubLog<FakeClaudeSdkLogEntry>();
    expect(log).toHaveLength(1);
    const entry = log[0]!;
    expect(entry.cwd).toBe(f.projectRoot);
    expect(entry.prompt).toContain("ROLE:MAKER Answer the question in topic.md");
    expect(entry.model).toBe(MODEL);
    expect(entry.argv).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json"]));
    // settingSources: [] reaches the CLI, so no settings file can add hooks or permissions.
    expect(entry.argv).toContain("--setting-sources=");
    expect(entry.argv[entry.argv.indexOf("--allowedTools") + 1]).toBe("Bash(cat),Write");
    // The adapter's PreToolUse hook was registered at initialize, so every call was gated.
    expect(entry.sdkRequests[0]).toBe("initialize");
    expect(entry.preToolUseCallbackIds).toHaveLength(1);
    expect(entry.ungated).toBe(false);
  });

  test("the hook allowed the allowlisted calls and denied the rest, in order, and only allowed calls ran", () => {
    const entry = f.stubLog<FakeClaudeSdkLogEntry>()[0]!;
    expect(answersOf(entry)).toEqual([
      ["cat", "allow", true],
      ["curl", "deny", false],
      ["redirect", "deny", false],
      ["write-output", "allow", true],
      ["write-outside", "deny", false],
    ]);
    expect(entry.answers.find((a) => a.label === "cat")!.exitCode).toBe(0);
    // A deny carries the gate's reason back to the model.
    const reason = new Map(entry.answers.map((a) => [a.label, a.reason]));
    expect(reason.get("curl")).toContain('"curl" is not allowlisted');
    expect(reason.get("redirect")).toContain("shell metacharacter");
    expect(reason.get("write-outside")).toContain("outside");
    expect(entry.stopped).toBe(false);
  });

  test("only allowed effects happened: the output exists, the redirect target and the out-of-root file do not", () => {
    expect(JSON.parse(readFileSync(join(f.projectRoot, "result.json"), "utf8"))).toEqual({ summary: "a card on a board" });
    expect(existsSync(join(f.projectRoot, "copy.md"))).toBe(false);
    expect(existsSync(outsidePath)).toBe(false);
  });

  test("journal inspect prints the harness span, a gate decision per call, and the move to done", async () => {
    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: research → done (forward)`);
    expect(inspect.stdout).not.toMatch(/→ (scrap|hold)/);

    const rows = harnessRows(inspect.stdout, f.cardId);
    const decisions = decisionsIn(rows);
    expect(decisions).toHaveLength(5);
    expect(decisions[0]).toBe("gate-decision allow Bash");
    expect(decisions[1]).toMatch(/^gate-decision deny Bash code=not_allowlisted reason=.*"curl"/);
    expect(decisions[2]).toMatch(/^gate-decision deny Bash code=shell_metacharacter /);
    expect(decisions[3]).toBe("gate-decision allow Write");
    expect(decisions[4]).toMatch(/^gate-decision deny Write code=path_escape /);
    // Both Writes' paths are on their tool-input rows, the denied one included.
    expect(rows.some((r) => r.endsWith(`tool-input-available Write path=${join(f.projectRoot, "result.json")}`))).toBe(true);
    expect(rows.some((r) => r.endsWith(`tool-input-available Write path=${outsidePath}`))).toBe(true);
    expect(rows.some((r) => / usage tokens=990 cost=\$0\.0031$/.test(r))).toBe(true);
    expect(rows[0]).toMatch(/ #0 lifecycle start$/);
    expect(rows[rows.length - 1]).toMatch(/ lifecycle end/);
  });

  test("the span's usage is the fake's result message usage", () => {
    const spans = f.journalSpans().filter((s) => s.name === "research.harness");
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.adapter).toBe("agent-sdk");
    expect(span.usage_unknown).toBe(0);
    expect(span.input_tokens).toBe(300);
    expect(span.output_tokens).toBe(40);
    expect(span.cache_read_input_tokens).toBe(600);
    expect(span.cache_creation_input_tokens).toBe(50);
    expect(span.cost_usd).toBeCloseTo(0.0031, 6);
    expect(span.attributes.outcome).toBe("success");
  });
});

describe("agent-sdk journey: without enforce_owned_paths, writes are still confined to the project root", () => {
  let f: HarnessFlow;
  let run: CliResult;
  let outsidePath: string;

  beforeAll(async () => {
    f = startHarnessFlow<FakeClaudeSdkRole>({
      flowYaml: flowYaml("bb-agent-sdk-gate-unenforced", { enforceOwnedPaths: false }),
      files: FILES,
      entryInput: "topic.md",
      stub: SDK_STUB,
      roles: ({ scratchDir }) => {
        outsidePath = join(scratchDir, "escape.txt");
        return [
          {
            name: "maker",
            promptIncludes: "ROLE:MAKER",
            calls: [
              {
                steps: [write("write-output", "result.json", OUTPUT), write("write-outside", outsidePath, "escaped\n")],
                usage: { input_tokens: 50, output_tokens: 10 },
              },
            ],
          },
        ];
      },
    });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the write inside the project root is allowed and the write outside it is denied", () => {
    expect(run.exitCode).toBe(0);
    const log = f.stubLog<FakeClaudeSdkLogEntry>();
    expect(log).toHaveLength(1);
    expect(answersOf(log[0]!)).toEqual([
      ["write-output", "allow", true],
      ["write-outside", "deny", false],
    ]);
    expect(existsSync(join(f.projectRoot, "result.json"))).toBe(true);
    expect(existsSync(outsidePath)).toBe(false);
  });

  test("journal inspect names the project root as the boundary the write crossed", async () => {
    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: research → done (forward)`);
    expect(inspect.stdout).toMatch(/ gate-decision deny Write code=path_escape reason=.*outside the project root/);
  });
});

/** The hold scenario: an allowed `cat`, then AskUserQuestion, then a Write that must never run. */
const HOLD_ROLES: FakeClaudeSdkRole[] = [
  {
    name: "maker",
    promptIncludes: "ROLE:MAKER",
    calls: [
      {
        steps: [
          bash("cat", "cat topic.md"),
          { label: "ask", tool: "AskUserQuestion", input: { questions: [{ question: "Which board?", header: "Board", options: [] }] } },
          write("write-output", "result.json", JSON.stringify({ summary: "never written" })),
        ],
        usage: { input_tokens: 700, output_tokens: 300 },
        costUsd: 0.0009,
      },
    ],
  },
];

describe("agent-sdk journey: AskUserQuestion holds the card without spending an attempt", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = startHarnessFlow<FakeClaudeSdkRole>({
      flowYaml: flowYaml("bb-agent-sdk-hold"),
      files: FILES,
      entryInput: "topic.md",
      stub: SDK_STUB,
      roles: HOLD_ROLES,
    });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the hook stopped the turn at the question, and nothing after it ran", () => {
    const log = f.stubLog<FakeClaudeSdkLogEntry>();
    expect(log).toHaveLength(1);
    expect(log[0]!.stopped).toBe(true);
    expect(log[0]!.answers.map((a) => [a.label, a.decision, a.continue])).toEqual([
      ["cat", "allow", true],
      ["ask", "deny", false],
    ]);
    expect(log[0]!.answers[1]!.reason).toBe("the tool asks a human");
    expect(existsSync(join(f.projectRoot, "result.json"))).toBe(false);
  });

  test("the card is held at attempt 0, not retried or scrapped, and the run says so", async () => {
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`run "${f.runId}" halted`);
    expect(run.stderr).toContain(`${f.cardId}: lane=hold station=research attempt=0`);
    expect(run.stderr).toContain("the tool gate held the card on AskUserQuestion (needs_human)");
    expect(run.stderr).not.toContain("andon");

    const status = await f.runStatus();
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`run ${f.runId}: held (1 held card)`);

    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: research → hold (hold)`);
    expect(inspect.stdout).not.toMatch(/→ (scrap|done)/);
    expect(inspect.stdout.match(/research\.harness$/gm)).toHaveLength(1);
    expect(decisionsIn(harnessRows(inspect.stdout, f.cardId))).toEqual([
      "gate-decision allow Bash",
      "gate-decision hold AskUserQuestion code=needs_human reason=the tool asks a human",
    ]);
  });

  test("the held call's usage, from the result message after continue: false, is on its span", () => {
    const spans = f.journalSpans().filter((s) => s.name === "research.harness");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.usage_unknown).toBe(0);
    expect(spans[0]!.input_tokens).toBe(700);
    expect(spans[0]!.output_tokens).toBe(300);
    expect(spans[0]!.cost_usd).toBeCloseTo(0.0009, 6);
    expect(spans[0]!.attributes.outcome).toBe("harness-gate-hold");
  });
});

describe("agent-sdk journey: a held call's usage counts against the run token budget", () => {
  // The held call reports 1000 tokens. With max_tokens 500 the consumption
  // andon trips on that spend alone; the case above, with the identical
  // scenario and a larger budget, holds without an andon. If the hold path
  // did not fold the usage into the run budget, this run would hold quietly too.
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = startHarnessFlow<FakeClaudeSdkRole>({
      flowYaml: flowYaml("bb-agent-sdk-hold-budget", { maxTokens: 500 }),
      files: FILES,
      entryInput: "topic.md",
      stub: SDK_STUB,
      roles: HOLD_ROLES,
    });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the run halts on the tokens andon, and the card is still held at attempt 0", async () => {
    expect(run.exitCode).toBe(1);
    expect(run.stderr.split("\n").filter((l) => l.startsWith("andon:"))).toEqual(["andon: run halted — tokens budget exceeded"]);
    expect(run.stderr).toContain(`${f.cardId}: lane=hold station=research attempt=0`);
    expect(f.stubLog<FakeClaudeSdkLogEntry>()).toHaveLength(1);
  });
});

describe("agent-sdk journey: a setsid descendant of the CLI dies with the call", () => {
  let f: HarnessFlow;
  let run: CliResult;
  let doctorContainment: string;
  let sleeperPidFile: string | undefined;

  const sleeperPid = (): number | undefined => {
    if (sleeperPidFile === undefined || !existsSync(sleeperPidFile)) return undefined;
    const n = Number(readFileSync(sleeperPidFile, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };

  beforeAll(async () => {
    f = startHarnessFlow<FakeClaudeSdkRole>({
      flowYaml: flowYaml("bb-agent-sdk-containment"),
      files: FILES,
      entryInput: "topic.md",
      stub: SDK_STUB,
      roles: ({ scratchDir }) => {
        sleeperPidFile = join(scratchDir, "sleeper.pid");
        return [
          {
            name: "maker",
            promptIncludes: "ROLE:MAKER",
            calls: [{ steps: [write("write-output", "result.json", OUTPUT)], setsidSleeperPidFile: sleeperPidFile }],
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
    const pid = sleeperPid();
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await f?.cleanup();
  });

  test("the call completed and the CLI process is dead", async () => {
    expect(run.exitCode).toBe(0);
    const pids = f.stubLog<FakeClaudeSdkLogEntry>().map((e) => e.pid);
    expect(pids).toHaveLength(1);
    await f.waitFor(() => pids.every((pid) => !pidAlive(pid)), { timeoutMs: 5_000 });
  });

  test("the setsid sleeper is dead after the run, when cgroup containment is in use or required", async () => {
    const pid = sleeperPid();
    expect(pid).toBeDefined();
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
        `[agent-sdk-gate] SKIPPED the setsid-sleeper assertion: conduit doctor reports no cgroup ` +
          `containment, so a setsid descendant is expected to survive the process-group kill ` +
          `(issue #77). Set CONDUIT_REQUIRE_CGROUP_CONTAINMENT=1 to make this a failure. doctor said: ${doctorSaid}`,
      );
      return;
    }
    await f.waitFor(() => !pidAlive(pid!), { timeoutMs: 5_000 });
  });
});
