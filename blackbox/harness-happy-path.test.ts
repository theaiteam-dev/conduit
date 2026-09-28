/**
 * Harness journey 1: a single `kind: harness` maker station runs to `done`.
 *
 * The real `conduit run` spawns fake-claude through the shipped
 * claude-headless adapter. The stub writes the station's declared output and
 * reports usage on its stream-json `result` event. Asserted through public
 * surfaces: the run's exit code, `conduit run status` (terminal outcome and
 * the harness occupancy report), `conduit journal inspect` (the
 * `research.harness` span and the entered_lane → done row) and the argv the
 * kernel handed the agent CLI. The span's token columns come from a read-only
 * journal read, because no CLI prints them.
 *
 * BLACK-BOX: imports only the harness-flow module + bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarnessFlow, type CliResult, type HarnessFlow } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;

const FLOW = `
flow: bb-harness-happy
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

describe("harness journey: a harness maker writes its output and the card reaches done", () => {
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = startHarnessFlow({
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
          calls: [
            {
              writeFiles: { "result.json": JSON.stringify({ summary: "a card on a board" }) },
              usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 },
              costUsd: 0.0042,
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

  test("conduit run exits 0 and run status reports the run complete with harness busy time", async () => {
    expect(run.exitCode).toBe(0);

    const status = await f.runStatus();
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=complete)`);
    // run/harness-occupancy.ts: one maker call, no critic, busy time reported.
    expect(status.stdout).toContain("harness occupancy");
    expect(status.stdout).toMatch(/research: 1 maker \+ 0 critic call\(s\), busy \d+\.\ds/);
  });

  test("journal inspect narrates the research.harness span and the move to done", async () => {
    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain(`[${f.cardId}] research@0 research.harness`);
    expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: research → done (forward)`);
    expect(inspect.stdout).not.toMatch(/→ (scrap|hold)/);

    // The same span's usage columns: the four token classes, the cost and the
    // model as the stub reported them on its `result` event.
    const spans = f.journalSpans().filter((s) => s.name === "research.harness");
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.adapter).toBe("claude-headless");
    expect(span.usage_unknown).toBe(0);
    expect(span.input_tokens).toBe(120);
    expect(span.output_tokens).toBe(30);
    expect(span.cache_read_input_tokens).toBe(400);
    expect(span.cache_creation_input_tokens).toBe(50);
    expect(span.cost_usd).toBeCloseTo(0.0042, 6);
    expect(span.model).toBe("claude-bb-maker-model");
    expect(span.attributes.outcome).toBe("success");
  });

  test("the declared output is on disk as the stub wrote it", () => {
    expect(JSON.parse(readFileSync(join(f.projectRoot, "result.json"), "utf8"))).toEqual({
      summary: "a card on a board",
    });
  });

  test("the kernel invoked the agent CLI once, headless, with model, tools and the rendered prompt after --", () => {
    const log = f.stubLog();
    expect(log).toHaveLength(1);
    const { argv, cwd } = log[0]!;
    expect(argv.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-bb-maker-model");
    expect(argv[argv.indexOf("--allowed-tools") + 1]).toBe("Read,Write");
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1)).toHaveLength(1);
    expect(argv[sep + 1]).toContain("ROLE:MAKER Answer the question in topic.md");
    // The runner confines the child's cwd to the project root.
    expect(cwd).toBe(f.projectRoot);
  });
});
