/**
 * Harness journey: a Claude call's tokens are the session total from
 * `modelUsage`, not the last `result` event's `usage` (issue #108).
 *
 * A session with a background subagent ends in two or more `result` events.
 * Each one's `usage` covers only the last API turn, while `modelUsage` is the
 * session total so far. Here the `research` maker's call emits two results:
 * the earlier one with a 1500-token session total, the terminal one with a
 * 1000-token `usage` and a 3000-token `modelUsage` split across two models.
 * A second station, `polish`, reports the default 150 tokens.
 *
 * With `budgets.run.max_tokens: 2000`, counting the terminal `usage` (the #108
 * bug) gives 1000 + 150 and the card reaches `done`. Counting the session
 * total gives 3000, so the run halts on the tokens andon before `polish` is
 * dispatched. The control case gives the same scenario a 5000 budget and
 * completes. Both shipped Claude adapters run it: `claude-headless` behind
 * fake-claude and `agent-sdk` behind fake-claude-sdk.
 *
 * BLACK-BOX: imports only the harness-flow module, the fakes' types and bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { FakeClaudeSdkCall, FakeClaudeSdkRole } from "./harness/fake-claude-sdk";
import { startHarnessFlow, type CliResult, type FakeClaudeCall, type FakeClaudeRole, type HarnessFlow, type HarnessStub } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;

const SDK_STUB: HarnessStub = {
  adapter: "agent-sdk",
  script: join(import.meta.dir, "harness", "fake-claude-sdk.ts"),
  binName: "claude",
  scenarioVar: "FAKE_CLAUDE_SDK_SCENARIO",
};

/** The terminal result's `usage`: the last API turn only. */
const LAST_TURN = { input_tokens: 400, output_tokens: 600 };
const LAST_TURN_TOKENS = 1000;
/** The earlier result: 1500 tokens of session so far. */
const EARLIER = {
  usage: { input_tokens: 200, output_tokens: 300 },
  modelUsage: { "claude-bb-main": { inputTokens: 600, outputTokens: 900 } },
};
const EARLIER_TOKENS = 1500;
/** The terminal result's `modelUsage`: the main model plus a side model, 3000 in all. */
const SESSION = {
  "claude-bb-main": { inputTokens: 1200, outputTokens: 1300 },
  "claude-bb-side": { inputTokens: 400, outputTokens: 100 },
};
const SESSION_TOKENS = 3000;
/** fake-claude's and fake-claude-sdk's default usage, which `polish` reports. */
const POLISH_TOKENS = 150;

function flowYaml(name: string, adapter: string, maxTokens: number): string {
  const worker = (prompt: string): string => `
    worker:
      kind: harness
      harness: ${adapter}
      tools: [Read, Write]
      prompt_file: prompts/${prompt}.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: summary, type: string, required: true }`;
  return `
flow: ${name}
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: ${maxTokens} }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: research${worker("research")}
    inputs: [topic.md]
    outputs: [result.json]
    next: polish
  - id: polish${worker("polish")}
    inputs: [result.json]
    outputs: [final.json]
    next: done
channels:
  ingress:
    type: cli
`;
}

const FILES = {
  "prompts/research.md": "ROLE:RESEARCH Answer topic.md into result.json.\n",
  "prompts/polish.md": "ROLE:POLISH Tighten result.json into final.json.\n",
  "topic.md": "What is a kanban card?\n",
};

const RESULT = JSON.stringify({ summary: "a card on a board" });
const FINAL = JSON.stringify({ summary: "a card" });

/** claude-headless behind fake-claude. */
const HEADLESS_ROLES: FakeClaudeRole[] = [
  {
    name: "research",
    promptIncludes: "ROLE:RESEARCH",
    calls: [
      { writeFiles: { "result.json": RESULT }, usage: LAST_TURN, modelUsage: SESSION, earlierResults: [EARLIER] } satisfies FakeClaudeCall,
    ],
  },
  { name: "polish", promptIncludes: "ROLE:POLISH", calls: [{ writeFiles: { "final.json": FINAL } }] },
];

/** agent-sdk behind fake-claude-sdk. */
const SDK_ROLES: FakeClaudeSdkRole[] = [
  {
    name: "research",
    promptIncludes: "ROLE:RESEARCH",
    calls: [
      {
        steps: [{ label: "write-result", tool: "Write", input: { file_path: "result.json", content: RESULT } }],
        usage: LAST_TURN,
        modelUsage: SESSION,
        earlierResults: [EARLIER],
      } satisfies FakeClaudeSdkCall,
    ],
  },
  {
    name: "polish",
    promptIncludes: "ROLE:POLISH",
    calls: [{ steps: [{ label: "write-final", tool: "Write", input: { file_path: "final.json", content: FINAL } }] }],
  },
];

const ADAPTERS: Array<{ adapter: string; stub?: HarnessStub; roles: FakeClaudeRole[] | FakeClaudeSdkRole[] }> = [
  { adapter: "claude-headless", roles: HEADLESS_ROLES },
  { adapter: "agent-sdk", stub: SDK_STUB, roles: SDK_ROLES },
];

function start(adapter: (typeof ADAPTERS)[number], name: string, maxTokens: number): HarnessFlow {
  return startHarnessFlow<FakeClaudeRole | FakeClaudeSdkRole>({
    flowYaml: flowYaml(name, adapter.adapter, maxTokens),
    files: FILES,
    entryInput: "topic.md",
    roles: adapter.roles,
    ...(adapter.stub ? { stub: adapter.stub } : {}),
  });
}

function spanTokens(f: HarnessFlow, name: string): number {
  return f
    .journalSpans()
    .filter((s) => s.name === name)
    .reduce((n, s) => n + (s.input_tokens ?? 0) + (s.output_tokens ?? 0) + (s.cache_read_input_tokens ?? 0) + (s.cache_creation_input_tokens ?? 0), 0);
}

/** `tokens=` of each `usage` row `journal inspect` prints under the research.harness span, in order. */
function researchUsageRows(inspect: string, cardId: string): number[] {
  const lines = inspect.split("\n");
  const header = lines.findIndex((l) => l.includes(`[${cardId}] research@0 research.harness`));
  expect(header).toBeGreaterThanOrEqual(0);
  const tokens: number[] = [];
  for (const l of lines.slice(header + 1)) {
    if (!/ #\d+ /.test(l)) break;
    const m = / usage tokens=(\d+)/.exec(l);
    if (m) tokens.push(Number(m[1]));
  }
  return tokens;
}

for (const a of ADAPTERS) {
  describe(`${a.adapter} journey: a two-result session's modelUsage total trips the run token budget`, () => {
    let f: HarnessFlow;
    let run: CliResult;

    beforeAll(async () => {
      f = start(a, `bb-${a.adapter}-session-usage-trip`, 2000);
      run = await f.run();
    }, TIMEOUT_MS);

    afterAll(async () => {
      await f?.cleanup();
    });

    test("the run halts on the tokens andon before polish runs", async () => {
      expect(run.exitCode).toBe(1);
      expect(run.stderr.split("\n").filter((l) => l.startsWith("andon:"))).toEqual(["andon: run halted — tokens budget exceeded"]);
      expect(run.stderr).toContain(`run "${f.runId}" halted`);
      expect(f.stubLog().map((e) => `${e.role}#${e.call}`)).toEqual(["research#1"]);
      const inspect = await f.journalInspect();
      expect(inspect.exitCode).toBe(0);
      expect(inspect.stdout).not.toContain("polish.harness");
      expect(inspect.stdout).not.toMatch(/→ done/);
    });

    test("the research span carries the session total, not the last turn's usage", () => {
      expect(spanTokens(f, "research.harness")).toBe(SESSION_TOKENS);
      expect(spanTokens(f, "research.harness")).not.toBe(LAST_TURN_TOKENS);
    });

    test("journal inspect shows one cumulative usage row per result", async () => {
      const inspect = await f.journalInspect();
      expect(researchUsageRows(inspect.stdout, f.cardId)).toEqual([EARLIER_TOKENS, SESSION_TOKENS]);
    });
  });

  describe(`control: ${a.adapter} with a budget the session total fits in reaches done`, () => {
    let f: HarnessFlow;
    let run: CliResult;

    beforeAll(async () => {
      f = start(a, `bb-${a.adapter}-session-usage-fits`, 5000);
      run = await f.run();
    }, TIMEOUT_MS);

    afterAll(async () => {
      await f?.cleanup();
    });

    test("both stations run and the card reaches done", async () => {
      expect(run.exitCode).toBe(0);
      expect(run.stderr).not.toContain("andon");
      expect(f.stubLog().map((e) => `${e.role}#${e.call}`)).toEqual(["research#1", "polish#1"]);
      const status = await f.runStatus();
      expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=complete)`);
      expect(spanTokens(f, "research.harness") + spanTokens(f, "polish.harness")).toBe(SESSION_TOKENS + POLISH_TOKENS);
    });
  });
}
