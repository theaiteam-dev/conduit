/**
 * Transform critic journey (issue #42): a transform maker gated by a
 * transform critic whose model returns the wrong verdict shape. The card is
 * scrapped under a named reason for that failure class, not the maker
 * convention `model-incompatible`, and both `conduit run` and
 * `conduit journal inspect` print it.
 *
 * Three cases against a fake OpenAI-compatible gateway, one run each:
 *   - the critic answers `{"accept": true}` every attempt:
 *     `critic-verdict-invalid: verdict must be "pass" or "reject"`
 *   - the critic answers prose with no JSON: `critic-verdict-unparseable`
 *   - the critic stops at `finish_reason: length` mid-verdict:
 *     `critic-output-truncated`
 *
 * The flow has no harness station; startHarnessFlow supplies the workspace,
 * DBs and CLI wrappers, and CONDUIT_BASE_URL points `conduit run` at the
 * gateway below.
 *
 * BLACK-BOX: imports only the harness-flow module + bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHarnessFlow, type CliResult, type HarnessFlow } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;
const ATTEMPTS = 2;

const FLOW = `
flow: bb-transform-critic-scrap
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 100000 }
  per_card: { max_execution_attempts: ${ATTEMPTS} }
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
    outputs: [summary.json]
    next: done
    check:
      kind: gate
      critic: { role: critic, model: bb-critic-model, prompt_file: prompts/critic.md, prompt_version: "1" }
      on_reject: draft
      rework_cap: 2
channels:
  ingress:
    type: cli
`;

interface CriticReply {
  content: string;
  finishReason?: string;
}

/** OpenAI-compatible /chat/completions: the maker gets a valid answer, the critic gets `critic`. */
function startGateway(critic: CriticReply): { url: string; criticCalls: () => number; stop(): void } {
  let criticCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/chat/completions" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as { model?: string };
      const isCritic = body.model === "bb-critic-model";
      if (isCritic) criticCalls++;
      const content = isCritic ? critic.content : JSON.stringify({ summary: "a card on a board" });
      const finish_reason = isCritic ? (critic.finishReason ?? "stop") : "stop";
      return Response.json({
        choices: [{ message: { content }, finish_reason }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });
    },
  });
  return {
    url: server.url.toString().replace(/\/$/, ""),
    criticCalls: () => criticCalls,
    stop: () => server.stop(true),
  };
}

const CASES: Array<{ name: string; critic: CriticReply; reason: string; criticCalls: number }> = [
  {
    name: "a parseable verdict of the wrong shape",
    critic: { content: JSON.stringify({ accept: true }) },
    reason: 'critic-verdict-invalid: verdict must be "pass" or "reject"',
    criticCalls: ATTEMPTS,
  },
  {
    name: "a verdict with no JSON in it",
    critic: { content: "Looks good to me." },
    reason: "critic-verdict-unparseable",
    criticCalls: ATTEMPTS,
  },
  {
    name: "a verdict cut off by max_tokens",
    critic: { content: '{"verdict":"pa', finishReason: "length" },
    reason: "critic-output-truncated",
    criticCalls: 1,
  },
];

for (const c of CASES) {
  describe(`transform critic journey: ${c.name} scraps as ${c.reason.split(":")[0]}`, () => {
    let gateway: ReturnType<typeof startGateway>;
    let f: HarnessFlow;
    let run: CliResult;

    beforeAll(async () => {
      gateway = startGateway(c.critic);
      f = startHarnessFlow({
        flowYaml: FLOW,
        files: {
          "prompts/maker.md": "Summarize {{topic.md}} as JSON.\n",
          "prompts/critic.md": "Judge {{summary.json}}.\n",
          "topic.md": "What is a kanban card?\n",
        },
        entryInput: "topic.md",
        roles: [],
        env: { CONDUIT_BASE_URL: gateway.url },
      });
      run = await f.run();
    }, TIMEOUT_MS);

    afterAll(async () => {
      await f?.cleanup();
      gateway?.stop();
    });

    test("conduit run reports the scrap under the named reason", () => {
      expect(run.stderr + run.stdout).toContain(`${f.cardId}: lane=scrap station=draft attempt=0 — ${c.reason}`);
      expect(run.stderr + run.stdout).not.toContain("model-incompatible");
      expect(gateway.criticCalls()).toBe(c.criticCalls);
    });

    test("journal inspect records the named reason as the card's terminal reason", async () => {
      const inspect = await f.journalInspect();
      expect(inspect.exitCode).toBe(0);
      expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: draft → scrap (scrap)`);
      expect(inspect.stdout).toContain(`[${f.cardId}] terminal: ${c.reason}`);
      expect(inspect.stdout).not.toContain("model-incompatible");
    });
  });
}
