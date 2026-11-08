/**
 * Transform cache-read journey (issue #156): three transform stations against
 * a fake OpenAI-compatible gateway, each answering with a different cache
 * shape, through the shipped `conduit run`.
 *
 *   - draft:  `usage.prompt_tokens_details.cached_tokens` in the body
 *             (OpenAI, xAI, LiteLLM)
 *   - polish: the `fireworks-cached-prompt-tokens` response header only
 *   - finish: no cache figure at all
 *
 * `conduit run status` prints each station's cache reads and their share of
 * input, and "no cache figure" for finish rather than 0%. `conduit journal
 * inspect` appends the split to the two spans that have one. The span columns
 * hold uncached input and cache reads, which sum to the gateway's
 * prompt_tokens.
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

const FLOW = `
flow: bb-transform-cache
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 100000 }
  per_card: { max_execution_attempts: 2 }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: draft
    worker:
      kind: transform
      model: bb-openai-model
      prompt_file: prompts/draft.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [topic.md]
    outputs: [draft.json]
    next: polish
  - id: polish
    worker:
      kind: transform
      model: bb-fireworks-model
      prompt_file: prompts/polish.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [draft.json]
    outputs: [polish.json]
    next: finish
  - id: finish
    worker:
      kind: transform
      model: bb-plain-model
      prompt_file: prompts/finish.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [polish.json]
    outputs: [finish.json]
    next: done
channels:
  ingress:
    type: cli
`;

/** OpenAI-compatible /chat/completions; the cache shape depends on the requested model. */
function startGateway(): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/chat/completions" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const { model } = (await req.json()) as { model?: string };
      const choices = [{ message: { content: JSON.stringify({ summary: "a card on a board" }) }, finish_reason: "stop" }];
      if (model === "bb-openai-model") {
        return Response.json({
          choices,
          usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 } },
        });
      }
      if (model === "bb-fireworks-model") {
        return Response.json(
          { choices, usage: { prompt_tokens: 800, completion_tokens: 10 } },
          { headers: { "fireworks-prompt-tokens": "800", "fireworks-cached-prompt-tokens": "200" } },
        );
      }
      return Response.json({ choices, usage: { prompt_tokens: 500, completion_tokens: 5 } });
    },
  });
  return { url: server.url.toString().replace(/\/$/, ""), stop: () => server.stop(true) };
}

describe("transform cache-read journey: run status and journal inspect report the split", () => {
  let gateway: ReturnType<typeof startGateway>;
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    gateway = startGateway();
    f = startHarnessFlow({
      flowYaml: FLOW,
      files: {
        "prompts/draft.md": "Summarize {{topic.md}} as JSON.\n",
        "prompts/polish.md": "Polish {{draft.json}} as JSON.\n",
        "prompts/finish.md": "Finish {{polish.json}} as JSON.\n",
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

  test("the run completes", () => {
    expect(run.exitCode).toBe(0);
  });

  test("run status prints per-station cache reads, and no figure for the station without one", async () => {
    const status = await f.runStatus();
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=complete)`);
    const lines = status.stdout.split("\n");
    const at = lines.findIndex((l) => l.startsWith("cache reads"));
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at, at + 4)).toEqual([
      "cache reads (share of input = cache reads / (uncached input + cache reads + cache creation)):",
      "  draft: cache read 600 of 1000 input tokens (60.0%), 1 call(s)",
      "  finish: no cache figure, 1 call(s)",
      "  polish: cache read 200 of 800 input tokens (25.0%), 1 call(s)",
    ]);
    expect(status.stdout).not.toContain("finish: cache read");
  });

  test("journal inspect appends the split to each span that has one", async () => {
    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    const lines = inspect.stdout.split("\n");
    expect(lines).toContain(`[${f.cardId}] draft@0 draft.transform cache read 600 of 1000 input tokens (60.0%)`);
    expect(lines).toContain(`[${f.cardId}] polish@0 polish.transform cache read 200 of 800 input tokens (25.0%)`);
    expect(lines).toContain(`[${f.cardId}] finish@0 finish.transform`);
  });

  test("the span columns hold uncached input and cache reads that sum to prompt_tokens", () => {
    const usage = Object.fromEntries(
      f.journalSpans()
        .filter((s) => s.name.endsWith(".transform"))
        .map((s) => [s.station, [s.input_tokens, s.cache_read_input_tokens, s.cache_creation_input_tokens, s.output_tokens]]),
    );
    expect(usage).toEqual({
      draft: [400, 600, null, 20],
      polish: [600, 200, null, 10],
      finish: [500, null, null, 5],
    });
  });
});
