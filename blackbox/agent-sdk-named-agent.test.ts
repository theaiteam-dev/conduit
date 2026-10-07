/**
 * Harness journey: a named plugin agent on the shipped `agent-sdk` adapter
 * (issue #109), driven through a real `conduit run`.
 *
 * Engine config sets `CONDUIT_HARNESS_AGENT_SDK_PLUGIN_DIRS` to a plugin dir
 * holding `team:maker`, and the station declares `agent: team:maker`. The
 * real SDK passes the adapter's `agent` and `plugins` options to
 * fake-claude-sdk as `--agent` and `--plugin-dir`. The fake lists the agents
 * it loaded in its init message and sends the agent as `agent_type` on each
 * hook input, as Claude Code does for the main thread of an `--agent` session.
 *
 * Case 1: the fake loads the agent. The gate allows the Write, the card
 * reaches done.
 *
 * Case 2: the fake does not load the agent (`dropAgent`), as the real CLI on
 * the SDK path does for an agent it cannot find: it runs the default agent and
 * reports success. The adapter sees the agent missing from init, ends the
 * call, and the card is held at attempt 0 with one invocation. The Write the
 * fake would have made never runs.
 *
 * BLACK-BOX: imports only the harness-flow module, the fake's types and bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeClaudeSdkLogEntry, FakeClaudeSdkRole } from "./harness/fake-claude-sdk";
import { startHarnessFlow, type CliResult, type HarnessFlow, type HarnessStub } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;

const SDK_STUB: HarnessStub = {
  adapter: "agent-sdk",
  script: join(import.meta.dir, "harness", "fake-claude-sdk.ts"),
  binName: "claude",
  scenarioVar: "FAKE_CLAUDE_SDK_SCENARIO",
};

const FLOW = (name: string): string => `
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
      harness: agent-sdk
      agent: team:maker
      tools: [Write]
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

const roles = (dropAgent: boolean): FakeClaudeSdkRole[] => [
  {
    name: "maker",
    promptIncludes: "ROLE:MAKER",
    calls: [
      {
        dropAgent,
        steps: [
          { label: "write-output", tool: "Write", input: { file_path: "result.json", content: JSON.stringify({ summary: "a card" }) } },
        ],
      },
    ],
  },
];

/** A plugin dir `team` holding one agent, `maker`. */
function makePluginDir(): string {
  const root = mkdtempSync(join(tmpdir(), "conduit-bb-plugin-"));
  const dir = join(root, "team");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "team" }));
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "maker.md"), "---\nname: maker\ndescription: writes the answer\n---\nWrite result.json.\n");
  return dir;
}

function start(name: string, pluginDir: string, dropAgent: boolean): HarnessFlow {
  return startHarnessFlow<FakeClaudeSdkRole>({
    flowYaml: FLOW(name),
    files: FILES,
    entryInput: "topic.md",
    stub: SDK_STUB,
    roles: roles(dropAgent),
    env: { CONDUIT_HARNESS_AGENT_SDK_PLUGIN_DIRS: pluginDir },
  });
}

describe("agent-sdk journey: a plugin agent the CLI loads runs the station", () => {
  let pluginDir: string;
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    pluginDir = makePluginDir();
    f = start("bb-agent-sdk-agent", pluginDir, false);
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
    if (pluginDir) rmSync(join(pluginDir, ".."), { recursive: true, force: true });
  });

  test("the run completes and the agent's Write ran", async () => {
    expect(run.exitCode).toBe(0);
    const status = await f.runStatus();
    expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=complete)`);
    expect(existsSync(join(f.projectRoot, "result.json"))).toBe(true);
  });

  test("the SDK passed --agent and --plugin-dir, and the CLI ran as that agent", () => {
    const log = f.stubLog<FakeClaudeSdkLogEntry>();
    expect(log).toHaveLength(1);
    const argv = log[0]!.argv;
    expect(argv[argv.indexOf("--agent") + 1]).toBe("team:maker");
    expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe(pluginDir);
    expect(log[0]!.agentLoaded).toBe(true);
    expect(log[0]!.answers.map((a) => [a.label, a.decision, a.performed])).toEqual([["write-output", "allow", true]]);
  });
});

describe("agent-sdk journey: a plugin agent the CLI does not load holds the card", () => {
  let pluginDir: string;
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    pluginDir = makePluginDir();
    f = start("bb-agent-sdk-agent-dropped", pluginDir, true);
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
    if (pluginDir) rmSync(join(pluginDir, ".."), { recursive: true, force: true });
  });

  test("the card is held at attempt 0 and the run names the agent", async () => {
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`${f.cardId}: lane=hold station=research attempt=0`);
    expect(run.stderr).toContain("the CLI did not load agent 'team:maker'");

    const status = await f.runStatus();
    expect(status.stdout).toContain(`run ${f.runId}: held (1 held card)`);
    const inspect = await f.journalInspect();
    expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: research → hold (hold)`);
    expect(inspect.stdout.match(/research\.harness$/gm)).toHaveLength(1);
  });

  test("the CLI was invoked once and the Write never ran", () => {
    // The adapter ends the call at init, so the fake may be killed before it logs. Its per-call counter
    // file is claimed before init, so it counts invocations either way.
    expect(readdirSync(join(f.root, "stub", "counters"))).toEqual(["maker.1"]);
    expect(existsSync(join(f.projectRoot, "result.json"))).toBe(false);
  });
});
