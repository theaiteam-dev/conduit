/**
 * Harness journey: a gate critic on a harness adapter is visible to the
 * preflight surfaces (issue #35).
 *
 * The flow's only harness is the gate critic of a `kind: transform` station
 * (`check.critic.harness`). Before #35 the binary probe, `conduit doctor` and
 * `conduit explain` all keyed on `station.kind === 'harness'`, so doctor
 * passed this flow with the critic's binary absent and explain showed no
 * critic adapter.
 *
 * Case A: the critic's binary is missing (`_COMMAND` names a path that does
 * not exist). doctor prints a FAIL line naming the station and the critic and
 * exits nonzero; `conduit run` refuses to start with HARNESS_BINARY_NOT_FOUND
 * naming the critic, and the stub never runs.
 *
 * Case B: the critic's binary is the fake-claude stub. doctor prints an ok
 * line for the critic, and explain shows the critic's adapter, model and
 * tools, labelled as the critic's.
 *
 * BLACK-BOX: imports only the harness-flow module + bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarnessFlow, type HarnessFlow } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;

// doctor's model-endpoint probe needs a reachable /models, so that doctor's
// exit code turns on the critic's binary alone. Nothing calls the model.
let gateway: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("{}") });
});
afterAll(() => {
  gateway?.stop(true);
});
const gatewayEnv = (): Record<string, string> => ({ CONDUIT_BASE_URL: `http://127.0.0.1:${gateway.port}` });

const FLOW = `
flow: bb-critic-visibility
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 1000000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: draft
    worker:
      kind: transform
      model: bb-maker-model
      prompt_file: prompts/maker.md
      prompt_version: "1"
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
        model: claude-bb-critic-model
        tools: [Read, Write]
        prompt_file: prompts/critic.md
        prompt_version: "1"
      on_reject: draft
      rework_cap: 1
channels:
  ingress:
    type: cli
`;

const FILES = {
  "prompts/maker.md": "ROLE:MAKER Answer topic.md.\n",
  "prompts/critic.md": "ROLE:CRITIC Judge result.json and write verdict.json.\n",
  "topic.md": "What is a kanban card?\n",
};

describe("harness journey: a missing critic binary fails doctor and the run preflight", () => {
  let f: HarnessFlow;
  const missing = "/nonexistent/conduit-bb-critic-visibility/claude";

  beforeAll(() => {
    f = startHarnessFlow({
      flowYaml: FLOW,
      files: FILES,
      entryInput: "topic.md",
      roles: [{ name: "critic", promptIncludes: "ROLE:CRITIC", calls: [] }],
      // Overrides the scaffold's stub wrapper with a binary that does not exist.
      env: { ...gatewayEnv(), CONDUIT_HARNESS_CLAUDE_HEADLESS_COMMAND: missing },
    });
  });

  afterAll(async () => {
    await f?.cleanup();
  });

  test(
    "doctor prints a FAIL line for the critic and exits nonzero",
    async () => {
      const doctor = await f.conduit(["doctor", f.flowPath]);
      const lines = doctor.stdout.split("\n");
      const critic = lines.find((l) => l.includes("(station 'draft' critic)"));
      expect(critic).toBeDefined();
      expect(critic!).toStartWith(`  harness 'claude-headless' (station 'draft' critic) at '`);
      expect(critic!).toContain(missing);
      expect(critic!).toEndWith(": FAIL");
      // Every other doctor probe passes, so the critic's binary is what fails doctor.
      expect(lines.filter((l) => l.endsWith(": FAIL") || l.includes(": FAIL —"))).toEqual([critic!]);
      expect(doctor.exitCode).not.toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "conduit run refuses to start, naming the critic, and never invokes the harness",
    async () => {
      const run = await f.run();
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("HARNESS_BINARY_NOT_FOUND");
      expect(run.stderr).toContain(`Station 'draft' critic harness adapter 'claude-headless' binary not found`);
      expect(f.stubLog()).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

describe("harness journey: doctor and explain list a present critic harness", () => {
  let f: HarnessFlow;

  beforeAll(() => {
    f = startHarnessFlow({
      flowYaml: FLOW,
      files: FILES,
      entryInput: "topic.md",
      roles: [{ name: "critic", promptIncludes: "ROLE:CRITIC", calls: [] }],
      env: gatewayEnv(),
    });
  });

  afterAll(async () => {
    await f?.cleanup();
  });

  test(
    "doctor prints an ok line for the critic",
    async () => {
      const doctor = await f.conduit(["doctor", f.flowPath]);
      expect(doctor.stdout).toContain(`  harness 'claude-headless' (station 'draft' critic) at '${f.stubCommand}': ok`);
      // The flow has no harness maker, so there is no maker line.
      expect(doctor.stdout).not.toContain(`(station 'draft') at`);
      expect(doctor.exitCode).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "explain shows the critic's adapter, model and tools, labelled as the critic's",
    async () => {
      const explain = await f.conduit(["explain", f.flowPath, "--color", "never"]);
      expect(explain.exitCode).toBe(0);
      const out = explain.stdout.replace(/[║│]/g, " ").replace(/\s+/g, " ");
      expect(out).toContain("critic harness=claude-headless");
      expect(out).toContain("critic model=claude-bb-critic-model");
      expect(out).toContain("critic tools=Read,Write");
      expect(out).not.toMatch(/(?<!critic )harness=/);
    },
    TIMEOUT_MS,
  );
});
