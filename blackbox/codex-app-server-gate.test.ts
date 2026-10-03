/**
 * Harness journey: the codex-app-server adapter's per-call tool gate, driven
 * through a real `conduit run` against a real child process.
 *
 * The real `conduit run` spawns fake-codex-app-server through the shipped
 * codex-app-server adapter. The fake speaks the app-server's line-delimited
 * JSON-RPC on stdio and, inside one turn, asks the kernel to approve shell
 * commands and file changes. It records the decision the adapter returned for
 * each and performs the effect (runs the command, writes the file) only on
 * `accept`. The station allows `Bash(cat)` and `Write`, and the flow sets
 * `enforce_owned_paths`, so the gate receives the card's owned paths
 * (topic.md, result.json) and a write outside them is a `path_escape`.
 *
 * Case 1, a mixed turn:
 *   - `cat topic.md` is accepted (allowlisted executable);
 *   - `curl -s https://example.com` is declined (not allowlisted);
 *   - `cat topic.md > copy.md` is declined (shell metacharacter);
 *   - a write of result.json is accepted, and the file exists;
 *   - a write to a file outside the project root is declined, and the file
 *     does not exist.
 *   The run exits 0 and the card reaches done. `conduit journal inspect` shows
 *   the research.harness span with one gate-decision row per request, and the
 *   span's token columns (a read-only journal read, since no CLI prints them)
 *   match the fake's `thread/tokenUsage/updated` total.
 *
 * Case 2, the same gate on a flow that does not set `enforce_owned_paths`:
 * the gate gets no owned paths, so it confines writes to the project root. The
 * output write is accepted and a write outside the root is still declined. (An
 * undeclared write inside the root would pass the gate and then hold the card
 * at the harness integrity check, which no flow setting turns off.)
 *
 * Case 3, a turn of denied calls only: the fake completes the turn without
 * writing result.json, so each invocation ends `harness-output-missing`, is
 * retried up to `max_execution_attempts`, and the card is scrapped.
 *
 * BLACK-BOX: imports only the harness-flow module, the fake's types and
 * bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarnessFlow, type CliResult, type HarnessFlow, type HarnessStub } from "./harness/harness-flow";
import type { FakeCodexLogEntry, FakeCodexRole } from "./harness/fake-codex-app-server";

const TIMEOUT_MS = 60_000;
const MODEL = "gpt-bb-codex-model";

const CODEX_STUB: HarnessStub = {
  adapter: "codex-app-server",
  script: join(import.meta.dir, "harness", "fake-codex-app-server.ts"),
  binName: "codex",
  scenarioVar: "FAKE_CODEX_SCENARIO",
  allowlist: ["OPENAI_API_KEY"],
};

function flowYaml(name: string, attempts: number, enforceOwnedPaths = true): string {
  return `
flow: ${name}
project_root: .
flow_version: 1
defaults:
  enforce_owned_paths: ${enforceOwnedPaths}
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 100000 }
  per_card: { max_execution_attempts: ${attempts} }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: research
    worker:
      kind: harness
      harness: codex-app-server
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

/**
 * The kernel env every case shares. CODEX_HOME names a directory that does
 * not exist, so the adapter never links the developer's own `auth.json`: the
 * child authenticates through the allowlisted OPENAI_API_KEY instead.
 */
const KERNEL_ENV = { OPENAI_API_KEY: "sk-blackbox-unused", CODEX_HOME: "/nonexistent/conduit-bb-codex-home" };

function decisionsOf(entry: FakeCodexLogEntry): Array<[string, string]> {
  return entry.decisions.map((d) => [d.label, d.decision]);
}

describe("harness journey: codex-app-server gates each shell command and file change", () => {
  let f: HarnessFlow;
  let run: CliResult;
  let outsidePath: string;

  beforeAll(async () => {
    f = startHarnessFlow<FakeCodexRole>({
      flowYaml: flowYaml("bb-codex-gate", 2),
      files: FILES,
      entryInput: "topic.md",
      stub: CODEX_STUB,
      roles: ({ scratchDir }) => {
        outsidePath = join(scratchDir, "escape.txt");
        return [
          {
            name: "maker",
            promptIncludes: "ROLE:MAKER",
            calls: [
              {
                steps: [
                  { label: "cat", command: "cat topic.md" },
                  { label: "curl", command: "curl -s https://example.com" },
                  { label: "redirect", command: "cat topic.md > copy.md" },
                  { label: "write-output", write: { path: "result.json", content: JSON.stringify({ summary: "a card on a board" }) } },
                  { label: "write-outside", write: { path: outsidePath, content: "escaped\n" } },
                ],
                usage: { inputTokens: 300, cachedInputTokens: 200, outputTokens: 40 },
              },
            ],
          },
        ];
      },
      env: KERNEL_ENV,
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
  });

  test("the adapter accepted the allowlisted calls and declined the rest, in order", () => {
    const log = f.stubLog<FakeCodexLogEntry>();
    expect(log).toHaveLength(1);
    expect(decisionsOf(log[0]!)).toEqual([
      ["cat", "accept"],
      ["curl", "decline"],
      ["redirect", "decline"],
      ["write-output", "accept"],
      ["write-outside", "decline"],
    ]);
    // The kernel started a fresh thread under the untrusted approval policy, with the station's model.
    expect(log[0]!.threadStart).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write", ephemeral: true, model: MODEL });
    expect(log[0]!.argv[0]).toBe("app-server");
    expect(log[0]!.cwd).toBe(f.projectRoot);
  });

  test("only accepted effects happened: the output exists, the redirect target and the out-of-root file do not", () => {
    expect(JSON.parse(readFileSync(join(f.projectRoot, "result.json"), "utf8"))).toEqual({ summary: "a card on a board" });
    expect(existsSync(join(f.projectRoot, "copy.md"))).toBe(false);
    expect(existsSync(outsidePath)).toBe(false);
    // The accepted `cat` ran: the fake recorded its exit code.
    const log = f.stubLog<FakeCodexLogEntry>();
    expect(log[0]!.decisions.find((d) => d.label === "cat")!.exitCode).toBe(0);
  });

  test("journal inspect shows the research.harness span, one gate-decision row per request, and the move to done", async () => {
    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    const out = inspect.stdout;
    expect(out).toContain(`[${f.cardId}] research@0 research.harness`);
    expect(out).toContain(`[${f.cardId}] entered_lane: research → done (forward)`);
    expect(out).not.toMatch(/→ (scrap|hold)/);

    const gateLines = out.split("\n").filter((l) => l.includes(" gate-decision "));
    expect(gateLines).toHaveLength(5);
    expect(gateLines[0]).toMatch(/ gate-decision allow Bash$/);
    expect(gateLines[1]).toMatch(/ gate-decision deny Bash code=not_allowlisted reason=.*"curl"/);
    expect(gateLines[2]).toMatch(/ gate-decision deny Bash code=shell_metacharacter /);
    expect(gateLines[3]).toMatch(/ gate-decision allow Write$/);
    expect(gateLines[4]).toMatch(/ gate-decision deny Write code=path_escape /);

    // The fileChange items' paths are journaled on their tool-input rows.
    expect(out).toContain(`tool-input-available Write path=${join(f.projectRoot, "result.json")}`);
    expect(out).toContain(`tool-input-available Write path=${outsidePath}`);
    expect(out).toMatch(/ usage tokens=340/);
  });

  test("the span's usage columns are the fake's token total, with no cost", () => {
    const spans = f.journalSpans().filter((s) => s.name === "research.harness");
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.adapter).toBe("codex-app-server");
    expect(span.usage_unknown).toBe(0);
    // input = inputTokens - cachedInputTokens; the cached part is the cache read.
    expect(span.input_tokens).toBe(100);
    expect(span.cache_read_input_tokens).toBe(200);
    expect(span.cache_creation_input_tokens).toBe(0);
    expect(span.output_tokens).toBe(40);
    expect(span.cost_usd).toBe(0);
    expect(span.model).toBe(MODEL);
    expect(span.attributes.outcome).toBe("success");
  });
});

describe("harness journey: codex-app-server turn of denied calls only scraps the card on harness-output-missing", () => {
  const ATTEMPTS = 2;
  let f: HarnessFlow;
  let run: CliResult;

  beforeAll(async () => {
    f = startHarnessFlow<FakeCodexRole>({
      flowYaml: flowYaml("bb-codex-gate-denied", ATTEMPTS),
      files: FILES,
      entryInput: "topic.md",
      stub: CODEX_STUB,
      roles: [
        {
          name: "maker",
          promptIncludes: "ROLE:MAKER",
          calls: [
            {
              steps: [
                { label: "curl", command: "curl -s https://example.com" },
                { label: "write-unowned", write: { path: "notes.md", content: "not owned\n" } },
              ],
              usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 10 },
            },
          ],
        },
      ],
      env: KERNEL_ENV,
    });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test(`every call was declined, the call was retried up to ${ATTEMPTS} attempts, and nothing was written`, () => {
    const log = f.stubLog<FakeCodexLogEntry>();
    expect(log.map((e) => e.call)).toEqual([1, 2]);
    for (const entry of log) {
      expect(decisionsOf(entry)).toEqual([
        ["curl", "decline"],
        ["write-unowned", "decline"],
      ]);
    }
    expect(existsSync(join(f.projectRoot, "result.json"))).toBe(false);
    expect(existsSync(join(f.projectRoot, "notes.md"))).toBe(false);
  });

  test("the run exits nonzero and names the card scrapped on harness-output-missing", async () => {
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toMatch(
      new RegExp(`${f.cardId}: lane=scrap station=research attempt=\\d+ — harness-output-missing: result\\.json`),
    );
    const inspect = await f.journalInspect();
    expect(inspect.exitCode).toBe(0);
    expect(inspect.stdout).toContain(`[${f.cardId}] entered_lane: research → scrap (scrap)`);
    expect(inspect.stdout.split("\n").filter((l) => / gate-decision deny /.test(l))).toHaveLength(2 * ATTEMPTS);
    expect(inspect.stdout).toMatch(/ gate-decision deny Write code=path_escape /);

    // Both billed attempts carry their usage, and say why they failed.
    const spans = f.journalSpans().filter((s) => s.name === "research.harness");
    expect(spans).toHaveLength(ATTEMPTS);
    for (const span of spans) {
      expect(span.usage_unknown).toBe(0);
      expect(span.output_tokens).toBe(10);
      expect(span.attributes.outcome).toBe("harness-output-missing: result.json");
    }
  });
});

describe("harness journey: without enforce_owned_paths, codex-app-server writes are still confined to the project root", () => {
  let f: HarnessFlow;
  let run: CliResult;
  let outsidePath: string;

  beforeAll(async () => {
    f = startHarnessFlow<FakeCodexRole>({
      flowYaml: flowYaml("bb-codex-gate-unenforced", 2, false),
      files: FILES,
      entryInput: "topic.md",
      stub: CODEX_STUB,
      roles: ({ scratchDir }) => {
        outsidePath = join(scratchDir, "escape.txt");
        return [
          {
            name: "maker",
            promptIncludes: "ROLE:MAKER",
            calls: [
              {
                steps: [
                  { label: "write-output", write: { path: "result.json", content: JSON.stringify({ summary: "a card on a board" }) } },
                  { label: "write-outside", write: { path: outsidePath, content: "escaped\n" } },
                ],
                usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 10 },
              },
            ],
          },
        ];
      },
      env: KERNEL_ENV,
    });
    run = await f.run();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
  });

  test("the write inside the project root is accepted and the write outside it is declined", () => {
    expect(run.exitCode).toBe(0);
    const log = f.stubLog<FakeCodexLogEntry>();
    expect(log).toHaveLength(1);
    expect(decisionsOf(log[0]!)).toEqual([
      ["write-output", "accept"],
      ["write-outside", "decline"],
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
