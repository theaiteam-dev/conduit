/**
 * Harness-flow journey scaffolding: drives `kind: harness` stations through
 * the shipped `conduit` binary with fake-claude standing in for the agent CLI.
 *
 * `startHarnessFlow()` builds a temp workspace (project root, flow.yaml,
 * prompts, seeded inputs), temp state and journal DBs, a scenario file for
 * fake-claude and a `#!/bin/sh` wrapper that execs it, then exposes the real
 * CLI as subprocesses: `conduit run`, `conduit run status`,
 * `conduit journal inspect`, `conduit doctor`. The claude-headless adapter is
 * wired purely through engine-config env (`CONDUIT_HARNESS_*`), exactly as an
 * operator would configure it.
 *
 * Harness journeys need no Slack or listener, so this is a sibling of
 * journey-harness.ts rather than an option on it.
 *
 * BLACK-BOX RULE: zero imports from src/. The only non-builtin import is the
 * type-only import of fake-claude's scenario shapes.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import type { FakeClaudeLogEntry, FakeClaudeRole } from "./fake-claude";

export type { FakeClaudeCall, FakeClaudeLogEntry, FakeClaudeRole } from "./fake-claude";

const CONDUIT_ENTRY = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** One `journal` row, as written by the shipped binary. */
export interface JournalSpanRow {
  card_id: string;
  station: string;
  attempt: number;
  name: string;
  attributes: Record<string, unknown>;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cost_usd: number | null;
  adapter: string | null;
  duration_ms: number | null;
  usage_unknown: number;
}

export interface HarnessFlowOptions {
  /** Full flow.yaml text. `project_root: .` resolves to the scaffolded project dir. */
  flowYaml: string;
  /** Files written under the project root before the run (prompts, inputs). */
  files: Record<string, string>;
  /** The entry input passed as `conduit run --input`, relative to the project root. */
  entryInput: string;
  /**
   * fake-claude roles; `stateDir`/`logPath` are filled in here. A function
   * receives the scratch dir, for scenarios that name files outside the
   * project root (pid files).
   */
  roles: FakeClaudeRole[] | ((ctx: { scratchDir: string }) => FakeClaudeRole[]);
  /** Extra kernel env, e.g. `CONDUIT_HARNESS_CLAUDE_HEADLESS_MODEL`. */
  env?: Record<string, string>;
}

export interface HarnessFlow {
  /** Temp root holding everything below; removed by cleanup(). */
  root: string;
  projectRoot: string;
  flowPath: string;
  runId: string;
  /** The entry card `conduit run` seeds for `runId`. */
  cardId: string;
  /** The env every `conduit` subprocess gets: the ambient env minus CONDUIT_*, plus this workspace's keys. */
  env: Readonly<Record<string, string>>;
  /** A directory OUTSIDE the project root, for files a test wants the stub to drop (pid files). */
  scratchDir: string;
  /** `conduit run <flow> --input <entry> --run-id <runId> [extra]`, awaited to exit. */
  run(extraArgs?: string[], opts?: { timeoutMs?: number }): Promise<CliResult>;
  /** `conduit <args>` against this workspace's DBs and env. */
  conduit(args: string[], opts?: { timeoutMs?: number }): Promise<CliResult>;
  runStatus(): Promise<CliResult>;
  journalInspect(cardId?: string): Promise<CliResult>;
  /** Every fake-claude invocation so far, in order. */
  stubLog(): FakeClaudeLogEntry[];
  /**
   * Journal rows for this run, read straight from the journal DB (read-only).
   * No CLI prints a span's token usage or attributes: `journal inspect`
   * prints `[card] station@attempt name` only. This read is for those
   * columns, and every test pairs it with a CLI assertion on the same span.
   */
  journalSpans(cardId?: string): JournalSpanRow[];
  waitFor(cond: () => boolean | Promise<boolean>, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
  cleanup(): Promise<void>;
}

let runCounter = 0;

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const intervalMs = opts?.intervalMs ?? 50;
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start >= timeoutMs) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Is `pid` a live process (not a zombie)? Reads /proc, so Linux only. */
export function pidAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 3, after the parenthesised comm, is the state letter.
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

/**
 * Should cleanup() reap `pid`? Only a live process whose cmdline names
 * fake-claude, so a pid the OS recycled for something else is left alone.
 */
export function isOrphanedStub(pid: number): boolean {
  try {
    return pidAlive(pid) && readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(FAKE_CLAUDE);
  } catch {
    return false;
  }
}

export function startHarnessFlow(opts: HarnessFlowOptions): HarnessFlow {
  if (process.platform !== "linux") {
    throw new Error(`blackbox harness-flow journeys require Linux (got '${process.platform}'; see blackbox/README.md)`);
  }
  const root = mkdtempSync(join(tmpdir(), "conduit-bb-harness-"));
  const projectRoot = join(root, "project");
  const scratchDir = join(root, "scratch");
  const stubDir = join(root, "stub");
  for (const d of [projectRoot, scratchDir, stubDir]) mkdirSync(d, { recursive: true });

  for (const [rel, content] of Object.entries(opts.files)) {
    const abs = join(projectRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const flowPath = join(projectRoot, "flow.yaml");
  writeFileSync(flowPath, opts.flowYaml);

  const logPath = join(stubDir, "invocations.ndjson");
  const roles = typeof opts.roles === "function" ? opts.roles({ scratchDir }) : opts.roles;
  const scenarioPath = join(stubDir, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify({ stateDir: join(stubDir, "counters"), logPath, roles }, null, 2),
  );

  // The adapter scrubs the child env to its allowlist, so `bun` may not be on
  // the child's PATH. The wrapper names the running bun binary absolutely.
  const wrapper = join(stubDir, "claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CLAUDE}' "$@"\n`);
  chmodSync(wrapper, 0o755);

  runCounter += 1;
  const runId = `bbh-${process.pid}-${runCounter}`;
  const cardId = `entry-${runId}`;

  // Ambient CONDUIT_* variables from the developer's or CI shell are dropped,
  // so only the keys set here and in opts.env configure the binary.
  const ambient = Object.entries(process.env).filter(
    (e): e is [string, string] => !e[0].startsWith("CONDUIT_") && e[1] !== undefined,
  );
  const env: Record<string, string> = {
    ...Object.fromEntries(ambient),
    CONDUIT_STATE_DB: join(root, "state.db"),
    CONDUIT_JOURNAL_DB: join(root, "journal.db"),
    CONDUIT_PROJECT_ROOT: projectRoot,
    // `conduit run`'s preflight requires a model gateway even for a
    // harness-only flow; nothing ever calls it.
    CONDUIT_API_KEY: "blackbox-harness-unused",
    CONDUIT_BASE_URL: "http://127.0.0.1:9",
    CONDUIT_HARNESS_ADAPTERS: "claude-headless",
    CONDUIT_HARNESS_CLAUDE_HEADLESS_COMMAND: wrapper,
    // PATH so the stub can find `setsid`/`sh`; FAKE_CLAUDE_SCENARIO carries the scenario.
    CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: "PATH,FAKE_CLAUDE_SCENARIO",
    FAKE_CLAUDE_SCENARIO: scenarioPath,
    ...opts.env,
  };

  const live = new Set<ReturnType<typeof Bun.spawn>>();

  async function conduit(args: string[], o?: { timeoutMs?: number }): Promise<CliResult> {
    const proc = Bun.spawn([process.execPath, CONDUIT_ENTRY, ...args], {
      env,
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    live.add(proc);
    const timeoutMs = o?.timeoutMs ?? 60_000;
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      clearTimeout(timer);
      live.delete(proc);
    }
  }

  function stubLog(): FakeClaudeLogEntry[] {
    if (!existsSync(logPath)) return [];
    // fake-claude appends from its own process, so a read can race a write
    // and see a truncated final line; only that line may fail to parse. A
    // malformed line before it is a real logging failure and throws.
    const lines = readFileSync(logPath, "utf8").split("\n");
    const last = lines.pop()!;
    const entries: FakeClaudeLogEntry[] = [];
    lines.forEach((l, i) => {
      if (l.length === 0) return;
      try {
        entries.push(JSON.parse(l) as FakeClaudeLogEntry);
      } catch (err) {
        throw new Error(`fake-claude invocations.ndjson line ${i + 1} is malformed: ${(err as Error).message}`);
      }
    });
    try {
      if (last.length > 0) entries.push(JSON.parse(last) as FakeClaudeLogEntry);
    } catch {
      /* partial write */
    }
    return entries;
  }

  return {
    root,
    projectRoot,
    flowPath,
    runId,
    cardId,
    env,
    scratchDir,
    run: (extraArgs = [], o) =>
      conduit(["run", flowPath, "--input", join(projectRoot, opts.entryInput), "--run-id", runId, ...extraArgs], o),
    conduit,
    runStatus: () => conduit(["run", "status", "--run", runId]),
    journalInspect: (card = cardId) => conduit(["journal", "inspect", card, "--run", runId]),
    stubLog,
    journalSpans(card = cardId) {
      if (!existsSync(env.CONDUIT_JOURNAL_DB!)) {
        throw new Error(`journalSpans: the journal DB ${env.CONDUIT_JOURNAL_DB} does not exist (no conduit command has run yet)`);
      }
      const db = new Database(env.CONDUIT_JOURNAL_DB!, { readonly: true });
      try {
        const rows = db
          .query(
            `SELECT card_id, station, attempt, name, attributes_json, model, input_tokens, output_tokens,
                    cache_read_input_tokens, cache_creation_input_tokens, cost_usd, adapter, duration_ms, usage_unknown
               FROM journal WHERE run_id = ? AND card_id = ? ORDER BY id`,
          )
          .all(runId, card) as Array<Omit<JournalSpanRow, "attributes"> & { attributes_json: string }>;
        return rows.map(({ attributes_json, ...rest }) => ({ ...rest, attributes: JSON.parse(attributes_json) }));
      } finally {
        db.close();
      }
    },
    waitFor,
    async cleanup() {
      for (const proc of live) {
        try {
          proc.kill("SIGKILL");
          await proc.exited;
        } catch {
          /* already gone */
        }
      }
      try {
        // A stub still running here was orphaned by a conduit process the
        // timeout above killed (its own group kill never ran). The reap is
        // best effort: a malformed log is for a test's stubLog() call to report.
        let logged: FakeClaudeLogEntry[] = [];
        try {
          logged = stubLog();
        } catch {
          /* reported by stubLog() callers */
        }
        for (const { pid } of logged) {
          try {
            if (isOrphanedStub(pid)) process.kill(-pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
