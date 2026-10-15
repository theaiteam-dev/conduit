/**
 * Harness journey: editing a prompt or a skill between a halt and a resume
 * re-runs the station that renders it (issues #131 and #93).
 *
 * The flow has one harness maker, `research`, that uses one skill
 * (`skills/house-style`) and renders `prompts/maker.md`, gated by an agentic
 * critic that renders `prompts/critic.md`. Call 1 of each role reports 1000
 * tokens against a 1500-token run budget, so the first `conduit run` halts on
 * the tokens andon after the maker's checkpoint is written and the critic has
 * run, with the card still in `research`. Every later call reports 100
 * tokens, and `conduit resume` starts a fresh per-invocation budget, so the
 * resume runs to `done`.
 *
 * Each case edits one file (or nothing) before the resume:
 *   - nothing: the maker's checkpoint matches and the maker is not called again;
 *   - prompts/maker.md, with prompt_version unchanged: the maker runs again;
 *   - the skill's SKILL.md: the maker runs again;
 *   - prompts/critic.md: the maker is skipped and the critic runs with the new prompt.
 *
 * BLACK-BOX: imports only the harness-flow module + bun:test and node:fs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHarnessFlow, type CliResult, type FakeClaudeRole, type HarnessFlow } from "./harness/harness-flow";

const TIMEOUT_MS = 90_000;

function flowYaml(name: string): string {
  return `
flow: ${name}
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 1500 }
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
      uses: [house-style]
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

const SKILL = (body: string) => `---\nname: house-style\ndescription: house style\n---\n\n${body}\n`;

const FILES = {
  "prompts/maker.md": "ROLE:MAKER maker prompt one. Answer topic.md into result.json.\n",
  "prompts/critic.md": "ROLE:CRITIC critic prompt one. Judge result.json and write verdict.json.\n",
  "skills/house-style/SKILL.md": SKILL("House style one: short sentences."),
  "topic.md": "What is a kanban card?\n",
};

const BIG = { input_tokens: 600, output_tokens: 400 };
const SMALL = { input_tokens: 60, output_tokens: 40 };

const ROLES: FakeClaudeRole[] = [
  {
    name: "maker",
    promptIncludes: "ROLE:MAKER",
    calls: [
      { writeFiles: { "result.json": JSON.stringify({ summary: "first answer" }) }, usage: BIG },
      { writeFiles: { "result.json": JSON.stringify({ summary: "second answer" }) }, usage: SMALL },
    ],
  },
  {
    name: "critic",
    promptIncludes: "ROLE:CRITIC",
    calls: [
      { writeFiles: { "verdict.json": JSON.stringify({ verdict: "pass", findings: [] }) }, usage: BIG },
      { writeFiles: { "verdict.json": JSON.stringify({ verdict: "pass", findings: [] }) }, usage: SMALL },
    ],
  },
];

interface Journey {
  f: HarnessFlow;
  first: CliResult;
  resumed: CliResult;
}

/** Run until the andon halts, apply `edit` to the project, then resume. */
async function haltEditResume(name: string, edit: (projectRoot: string) => void): Promise<Journey> {
  const f = startHarnessFlow({ flowYaml: flowYaml(name), files: FILES, entryInput: "topic.md", roles: ROLES });
  const first = await f.run();
  edit(f.projectRoot);
  const resumed = await f.conduit(["resume", f.flowPath, "--run", f.runId]);
  return { f, first, resumed };
}

function calls(f: HarnessFlow): string[] {
  return f.stubLog().map((e) => `${e.role}#${e.call}`);
}

function promptOf(f: HarnessFlow, roleCall: string): string {
  const entry = f.stubLog().find((e) => `${e.role}#${e.call}` === roleCall);
  if (entry === undefined) throw new Error(`no stub call ${roleCall}`);
  return entry.prompt;
}

/** The first run halted with the card in research, which is the precondition every case resumes from. */
function expectHaltedInResearch(j: Journey): void {
  expect(j.first.exitCode).toBe(1);
  expect(j.first.stderr).toContain("andon: run halted — tokens budget exceeded");
  expect(j.first.stderr).toContain(`${j.f.cardId}: lane=research station=research`);
  expect(calls(j.f).slice(0, 2)).toEqual(["maker#1", "critic#1"]);
}

async function expectDone(j: Journey): Promise<void> {
  expect(j.resumed.exitCode).toBe(0);
  const status = await j.f.runStatus();
  expect(status.stdout).toContain(`run ${j.f.runId}: terminal (outcome=complete)`);
}

describe("prompt-edit resume: no edit", () => {
  let j: Journey;
  beforeAll(async () => {
    j = await haltEditResume("bb-prompt-resume-none", () => {});
  }, TIMEOUT_MS);
  afterAll(async () => {
    await j?.f.cleanup();
  });

  test("the maker's checkpoint is reused: only the critic runs again", async () => {
    expectHaltedInResearch(j);
    await expectDone(j);
    expect(calls(j.f)).toEqual(["maker#1", "critic#1", "critic#2"]);
  });
});

describe("prompt-edit resume: the maker's prompt file changed", () => {
  let j: Journey;
  beforeAll(async () => {
    j = await haltEditResume("bb-prompt-resume-maker", (root) => {
      writeFileSync(join(root, "prompts/maker.md"), "ROLE:MAKER maker prompt two. Answer topic.md into result.json.\n");
    });
  }, TIMEOUT_MS);
  afterAll(async () => {
    await j?.f.cleanup();
  });

  test("the maker runs again with the edited prompt, with prompt_version unchanged", async () => {
    expectHaltedInResearch(j);
    await expectDone(j);
    expect(calls(j.f)).toEqual(["maker#1", "critic#1", "maker#2", "critic#2"]);
    expect(promptOf(j.f, "maker#1")).toContain("maker prompt one");
    expect(promptOf(j.f, "maker#2")).toContain("maker prompt two");
  });

  test("the journal records a different prompt_template_version and binding stamp for each maker call", () => {
    const makerSpans = j.f.journalSpans().filter((s) => s.name === "research.harness");
    expect(makerSpans).toHaveLength(2);
    const [before, after] = makerSpans;
    expect(before!.prompt_template_version).not.toBeNull();
    expect(after!.prompt_template_version).not.toBe(before!.prompt_template_version);
    expect(after!.binding_stamp).not.toBe(before!.binding_stamp);
  });
});

describe("prompt-edit resume: a used skill changed", () => {
  let j: Journey;
  beforeAll(async () => {
    j = await haltEditResume("bb-prompt-resume-skill", (root) => {
      writeFileSync(join(root, "skills/house-style/SKILL.md"), SKILL("House style two: active voice."));
    });
  }, TIMEOUT_MS);
  afterAll(async () => {
    await j?.f.cleanup();
  });

  test("the maker runs again with the edited skill in its prompt", async () => {
    expectHaltedInResearch(j);
    await expectDone(j);
    expect(calls(j.f)).toEqual(["maker#1", "critic#1", "maker#2", "critic#2"]);
    expect(promptOf(j.f, "maker#1")).toContain("House style one");
    expect(promptOf(j.f, "maker#2")).toContain("House style two");
  });
});

describe("prompt-edit resume: the critic's prompt file changed", () => {
  let j: Journey;
  beforeAll(async () => {
    j = await haltEditResume("bb-prompt-resume-critic", (root) => {
      writeFileSync(join(root, "prompts/critic.md"), "ROLE:CRITIC critic prompt two. Judge result.json and write verdict.json.\n");
    });
  }, TIMEOUT_MS);
  afterAll(async () => {
    await j?.f.cleanup();
  });

  test("the unchanged maker is skipped and the gate runs with the edited critic prompt", async () => {
    expectHaltedInResearch(j);
    await expectDone(j);
    expect(calls(j.f)).toEqual(["maker#1", "critic#1", "critic#2"]);
    expect(promptOf(j.f, "critic#2")).toContain("critic prompt two");
  });
});
