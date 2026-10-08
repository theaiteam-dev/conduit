/**
 * Harness journey: the per-call tool gate on the shipped `opencode` adapter
 * (issue #21), against a real `opencode serve` stand-in.
 *
 * The real `conduit run` spawns fake-opencode through the adapter. The fake
 * is a separate process serving HTTP with Basic auth and an SSE event stream;
 * it raises a `permission.asked` per tool call and records the answer the
 * adapter posts. The station allows `Bash(cat)` and `Write`, so of one
 * invocation's asks the gate allows `cat topic.md` and the write of the
 * declared output, denies `ls -la` (not allowlisted) and the pipeline
 * `cat topic.md | wc -l` (`wc` is not allowlisted), and the adapter rejects an `external_directory` ask without
 * asking the gate. A second case sends a question, which the adapter holds.
 *
 * Asserted through public surfaces: the run's exit code, `conduit run status`,
 * `conduit journal inspect` (the `research.harness` span and the
 * harness_events rows printed under it), the declared output on disk, and the
 * answers the fake recorded. The span's token columns come from a read-only
 * journal read, because no CLI prints them.
 *
 * BLACK-BOX: imports only the harness-flow module, fake-opencode's types and bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeOpenCodeLogEntry, FakeOpenCodeRole } from "./harness/fake-opencode";
import { startHarnessFlow, type CliResult, type HarnessFlow, type HarnessStub } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;

const FAKE_OPENCODE_STUB: HarnessStub = {
  adapter: "opencode",
  script: join(import.meta.dir, "harness", "fake-opencode.ts"),
  binName: "opencode",
  scenarioVar: "FAKE_OPENCODE_SCENARIO",
  // The adapter needs a credential for the model's provider: an allowlisted
  // OPENAI_API_KEY stands in for an `opencode auth login` entry.
  allowlist: ["OPENAI_API_KEY"],
};

const STUB_ENV = {
  CONDUIT_HARNESS_OPENCODE_MODEL: "openai/gpt-bb-fake",
  OPENAI_API_KEY: "sk-blackbox-fake",
  // The adapter copies the provider's entry from the operator's opencode
  // auth.json when one exists. Pointing XDG_DATA_HOME at a path that does not
  // exist keeps a developer's real login out of the fake's env.
  XDG_DATA_HOME: join(tmpdir(), `conduit-bb-no-opencode-auth-${process.pid}`),
};

const flowYaml = (name: string): string => `
flow: ${name}
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
      harness: opencode
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

const FILES = {
  "prompts/maker.md": "ROLE:MAKER Answer the question in topic.md and write result.json.\n",
  "topic.md": "What is a kanban card?\n",
};

const answers = (f: HarnessFlow) =>
  f.stubLog<FakeOpenCodeLogEntry>().filter(
    (e): e is Extract<FakeOpenCodeLogEntry, { kind: "answer" }> => e.kind === "answer",
  );

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

describe("opencode journey: the tool gate answers each ask of a real opencode server", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = startHarnessFlow<FakeOpenCodeRole>({
      flowYaml: flowYaml("bb-opencode-gate"),
      files: FILES,
      entryInput: "topic.md",
      stub: FAKE_OPENCODE_STUB,
      env: STUB_ENV,
      roles: [
        {
          name: "maker",
          promptIncludes: "ROLE:MAKER",
          calls: [
            {
              steps: [
                { type: "bash", command: "cat topic.md" },
                { type: "bash", command: "ls -la" },
                { type: "bash", command: "cat topic.md | wc -l", patterns: ["cat topic.md", "wc -l"] },
                { type: "external_directory", path: "/etc/hostname" },
                { type: "write", path: "result.json", content: JSON.stringify({ summary: "a card on a board" }) },
              ],
              tokens: { input: 300, output: 40, reasoning: 10, cacheRead: 600, cacheWrite: 50 },
              cost: 0.0031,
            },
          ],
        },
      ],
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

  test("the server was started as opencode serve, asking for every tool, and saw only authenticated requests", () => {
    const log = f.stubLog<FakeOpenCodeLogEntry>();
    const serves = log.filter((e) => e.kind === "serve");
    expect(serves).toHaveLength(1);
    expect(serves[0]!.argv).toEqual(["serve", "--port", "0", "--hostname", "127.0.0.1"]);
    expect(serves[0]!.cwd).toBe(f.projectRoot);
    expect(serves[0]).toMatchObject({ askAll: true });
    expect(log.filter((e) => e.kind === "auth-rejected")).toEqual([]);

    const prompts = log.filter((e) => e.kind === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.model).toBe("openai/gpt-bb-fake");
    expect(prompts[0]!.prompt).toContain("ROLE:MAKER Answer the question in topic.md");
  });

  test("the fake recorded once for the allowed calls and reject for the rest, and ran only the allowed ones", () => {
    const got = answers(f).map((a) => ({ step: a.step, permission: a.permission, reply: a.reply, performed: a.performed }));
    expect(got).toEqual([
      { step: 0, permission: "bash", reply: "once", performed: true },
      { step: 1, permission: "bash", reply: "reject", performed: false },
      { step: 2, permission: "bash", reply: "reject", performed: false },
      { step: 3, permission: "external_directory", reply: "reject", performed: false },
      { step: 4, permission: "edit", reply: "once", performed: true },
    ]);
    // A reject carries the reason, so the model can try another approach.
    const byStep = new Map(answers(f).map((a) => [a.step, a.message]));
    expect(byStep.get(1)).toContain("denied by conduit:");
    expect(byStep.get(1)).toContain("not allowlisted");
    // A pipe is accepted syntax; the gate refuses it because `wc` is not on the allowlist.
    expect(byStep.get(2)).toContain('"wc" is not allowlisted');
    expect(byStep.get(3)).toContain("outside the project root");
    expect(byStep.get(0)).toBeNull();
  });

  test("the declared output is on disk as the allowed write left it", () => {
    expect(JSON.parse(readFileSync(join(f.projectRoot, "result.json"), "utf8"))).toEqual({ summary: "a card on a board" });
  });

  test("journal inspect prints the harness span, a gate decision per ask, and the move to done", async () => {
    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: research → done (forward)`);
    expect(inspect.stdout).not.toMatch(/→ (scrap|hold)/);

    const rows = harnessRows(inspect.stdout, f.cardId);
    const decisions = rows.filter((r) => r.includes(" gate-decision ")).map((r) => r.slice(r.indexOf(" gate-decision ") + 1));
    expect(decisions).toEqual([
      "gate-decision allow Bash",
      "gate-decision deny Bash code=not_allowlisted reason=Bash executable \"ls\" is not allowlisted",
      "gate-decision deny Bash code=not_allowlisted reason=Bash executable \"wc\" is not allowlisted",
      "gate-decision deny external_directory code=path_escape reason=access outside the project root is not allowed",
      "gate-decision allow Write",
    ]);
    // The write's input row names the path; the allowed calls each settle with an output row.
    expect(rows.some((r) => / tool-input-available Write path=.*\/result\.json$/.test(r))).toBe(true);
    expect(rows.filter((r) => / tool-output-available ok$/.test(r))).toHaveLength(2);
    expect(rows.some((r) => / usage tokens=1000 cost=\$0\.0031$/.test(r))).toBe(true);
    expect(rows[0]).toMatch(/ #0 lifecycle start$/);
    expect(rows[rows.length - 1]).toMatch(/ lifecycle end$/);
  });

  test("the span's usage is the tokens the fake reported", async () => {
    const inspect = await f.journalInspect();
    expect(inspect.stdout).toContain(`[${f.cardId}] research@0 research.harness`);
    const spans = f.journalSpans().filter((s) => s.name === "research.harness");
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.adapter).toBe("opencode");
    expect(span.usage_unknown).toBe(0);
    expect(span.input_tokens).toBe(300);
    // The adapter counts reasoning as output, as the claude and codex adapters do.
    expect(span.output_tokens).toBe(50);
    expect(span.cache_read_input_tokens).toBe(600);
    expect(span.cache_creation_input_tokens).toBe(50);
    expect(span.cost_usd).toBeCloseTo(0.0031, 6);
    // The model opencode reported on the assistant message.
    expect(span.model).toBe("gpt-bb-fake");
    expect(span.attributes.outcome).toBe("success");
  });
});

describe("opencode journey: a question holds the card without spending an attempt", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = startHarnessFlow<FakeOpenCodeRole>({
      flowYaml: flowYaml("bb-opencode-hold"),
      files: FILES,
      entryInput: "topic.md",
      stub: FAKE_OPENCODE_STUB,
      env: STUB_ENV,
      roles: [
        {
          name: "maker",
          promptIncludes: "ROLE:MAKER",
          calls: [
            {
              steps: [
                { type: "bash", command: "cat topic.md" },
                { type: "question", text: "Which board?" },
                { type: "write", path: "result.json", content: JSON.stringify({ summary: "never written" }) },
              ],
              tokens: { input: 70, output: 30 },
              cost: 0.0009,
            },
          ],
        },
      ],
    });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the adapter rejected the question, aborted the session, and the server was asked nothing after", () => {
    const log = f.stubLog<FakeOpenCodeLogEntry>();
    expect(answers(f).map((a) => [a.step, a.reply])).toEqual([[0, "once"]]);
    expect(log.filter((e) => e.kind === "question-reject").map((e) => (e as { step: number }).step)).toEqual([1]);
    expect(log.filter((e) => e.kind === "abort")).not.toHaveLength(0);
    expect(log.filter((e) => e.kind === "prompt")).toHaveLength(1);
    expect(existsSync(join(f.projectRoot, "result.json"))).toBe(false);
  });

  test("the card is held at attempt 0, not retried or scrapped, and the run says so", async () => {
    // The run halts with the card in hold. Its attempt is still 0: a hold
    // spends no execution attempt, so with max_execution_attempts: 2 a spent
    // attempt would also show as a second invocation.
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`run "${f.runId}" halted`);
    expect(run.stderr).toContain(`${f.cardId}: lane=hold station=research attempt=0`);
    expect(run.stderr).toContain("the tool gate held the card on AskUserQuestion (needs_human)");

    const status = await f.runStatus();
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`run ${f.runId}: held (1 held card)`);

    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain(`[${f.cardId}] research@0 research.harness`);
    expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: research → hold (hold)`);
    expect(inspect.stdout).not.toMatch(/→ (scrap|done)/);
    expect(inspect.stdout.match(/research\.harness$/gm)).toHaveLength(1);

    const rows = harnessRows(inspect.stdout, f.cardId);
    const decisions = rows.filter((r) => r.includes(" gate-decision ")).map((r) => r.slice(r.indexOf(" gate-decision ") + 1));
    expect(decisions).toEqual([
      "gate-decision allow Bash",
      "gate-decision hold AskUserQuestion code=needs_human reason=the tool asks a human",
    ]);
  });

  test("the held call's usage is billed on its span", () => {
    const spans = f.journalSpans().filter((s) => s.name === "research.harness");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.usage_unknown).toBe(0);
    expect(spans[0]!.input_tokens).toBe(70);
    expect(spans[0]!.output_tokens).toBe(30);
    expect(spans[0]!.attributes.outcome).toBe("harness-gate-hold");
  });
});
