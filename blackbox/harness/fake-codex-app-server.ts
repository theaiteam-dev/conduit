#!/usr/bin/env bun
/**
 * fake-codex-app-server: a scenario-driven stand-in for `codex app-server`.
 *
 * The black-box codex journeys point the shipped `codex-app-server` adapter at
 * this script through engine config (`CONDUIT_HARNESS_CODEX_APP_SERVER_COMMAND`),
 * so the real `conduit run` spawns it exactly as it would spawn
 * `codex app-server -c ...`. Nothing here is imported from src/: the message
 * shapes are copied from the adapter's unit test peer
 * (src/worker/harness-adapter-codex-app-server.test.ts).
 *
 * Two entry points:
 *   - `--version` prints a codex version string and exits. The adapter runs it
 *     before each invocation with only PATH and HOME, so it reads no scenario.
 *   - `app-server` speaks line-delimited JSON-RPC on stdio (no `jsonrpc`
 *     field). It answers initialize, thread/start, turn/start and
 *     turn/interrupt, then runs the selected call's steps inside the turn.
 *
 * Each step is one approval request. A `command` step sends an `item/started`
 * commandExecution item and an `item/commandExecution/requestApproval` with
 * the script wrapped as `/bin/bash -lc '<script>'`, as codex displays it. A
 * `write` step sends the `item/started` fileChange item the adapter needs for
 * the paths, then an `item/fileChange/requestApproval`. The decision the
 * kernel returns is recorded, and the effect (running the command, writing the
 * file) happens only on `accept`. Then the call's usage goes out as
 * `thread/tokenUsage/updated`, and `turn/completed` ends the turn.
 *
 * The scenario file (JSON, see `FakeCodexScenario`) names roles, picked by a
 * substring of the turn's prompt, with a per-role counter file so call 1 and
 * call 2 can differ (the last entry repeats). Every turn appends one JSON line
 * to `logPath` with its role, call number, argv, cwd, pid, the thread/start
 * params and every decision received. The fields match FakeClaudeLogEntry, so
 * harness-flow's `stubLog()` and orphan reaper read it unchanged.
 *
 * Launched through a generated `#!/bin/sh` wrapper that execs the running bun
 * binary on this file (see harness-flow.ts).
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The codex version the adapter's ungated built-in list was checked against, so it writes no warning. */
const FAKE_VERSION = "codex-cli 0.159.1";

export interface FakeCodexUsage {
  inputTokens: number;
  /** Part of inputTokens. Default 0. */
  cachedInputTokens?: number;
  outputTokens: number;
}

/** One approval request. Exactly one of `command` or `write` is set. */
export interface FakeCodexStep {
  /** Names the step in the decision log. */
  label: string;
  /** A shell script, sent wrapped as `/bin/bash -lc '<script>'`. On accept it runs in the cwd. */
  command?: string;
  /** Working directory of the command. Default: the process cwd (the project root). */
  cwd?: string;
  /** A file added by a patch. A relative path resolves against the cwd. Written on accept. */
  write?: { path: string; content: string };
}

/** One invocation's behaviour. */
export interface FakeCodexCall {
  steps?: FakeCodexStep[];
  /** The thread's token total, sent before turn/completed. Omitted: no usage is reported. */
  usage?: FakeCodexUsage;
}

export interface FakeCodexRole {
  name: string;
  /** Substring of the turn/start prompt that selects this role. */
  promptIncludes: string;
  calls: FakeCodexCall[];
}

export interface FakeCodexScenario {
  stateDir: string;
  logPath: string;
  roles: FakeCodexRole[];
}

export interface FakeCodexDecision {
  label: string;
  method: string;
  /** The `decision` the kernel answered with, or `error:<message>` for a JSON-RPC error. */
  decision: string;
  /** Exit code of an accepted command. */
  exitCode?: number;
}

export interface FakeCodexLogEntry {
  role: string;
  call: number;
  argv: string[];
  cwd: string;
  pid: number;
  prompt: string;
  model: string | null;
  startedAt: number;
  /** The params the kernel sent on thread/start. */
  threadStart: Record<string, unknown>;
  decisions: FakeCodexDecision[];
}

type Json = Record<string, any>;

const THREAD_ID = "thr-fake-root";
const TURN_ID = "turn-fake-1";

/** Synchronous, so nothing is lost when the kernel kills the process right after. */
function send(obj: unknown): void {
  writeSync(1, JSON.stringify(obj) + "\n");
}

function notify(method: string, params: Json): void {
  send({ method, params });
}

/** Same exclusive-create claim as fake-claude, so concurrent calls never share a number. */
function nextCallNumber(stateDir: string, role: string): number {
  mkdirSync(stateDir, { recursive: true });
  for (let n = 1; ; n++) {
    try {
      closeSync(openSync(join(stateDir, `${role}.${n}`), "wx"));
      return n;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/** Quote a script the way codex's shlex does for its display string. */
function shellQuote(script: string): string {
  return `'${script.replace(/'/g, `'"'"'`)}'`;
}

async function appServer(argv: string[]): Promise<number> {
  const scenarioPath = process.env.FAKE_CODEX_SCENARIO;
  if (!scenarioPath) {
    process.stderr.write("fake-codex-app-server: FAKE_CODEX_SCENARIO is not set (is it on the adapter env allowlist?)\n");
    return 64;
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as FakeCodexScenario;

  let nextServerId = 1000;
  const pending = new Map<number, (m: Json) => void>();
  /** Send a server request and resolve with the client's whole response. */
  const request = (method: string, params: Json): Promise<Json> =>
    new Promise((res) => {
      const id = nextServerId++;
      pending.set(id, res);
      send({ method, id, params });
    });

  let threadStart: Json = {};
  let turnDone = false;

  const runTurn = async (prompt: string): Promise<void> => {
    const matches = scenario.roles.filter((r) => prompt.includes(r.promptIncludes));
    if (matches.length !== 1) {
      process.stderr.write(`fake-codex-app-server: ${matches.length} roles match the prompt: ${prompt.slice(0, 200)}\n`);
      process.exit(65);
    }
    const role = matches[0]!;
    const callNumber = nextCallNumber(scenario.stateDir, role.name);
    const call = role.calls[Math.min(callNumber, role.calls.length) - 1] ?? {};
    const decisions: FakeCodexDecision[] = [];

    for (const [i, step] of (call.steps ?? []).entries()) {
      const itemId = `item-${i + 1}`;
      if (step.command !== undefined) {
        const cwd = step.cwd ?? process.cwd();
        const display = `/bin/bash -lc ${shellQuote(step.command)}`;
        notify("item/started", {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { type: "commandExecution", id: itemId, command: display, cwd, status: "inProgress", commandActions: [] },
        });
        const answer = await request("item/commandExecution/requestApproval", {
          kind: "command", threadId: THREAD_ID, turnId: TURN_ID, itemId, command: display, cwd, commandActions: [],
        });
        const decision = answerOf(answer);
        const entry: FakeCodexDecision = { label: step.label, method: "item/commandExecution/requestApproval", decision };
        let status = "declined";
        let exitCode: number | null = null;
        if (decision === "accept") {
          const proc = Bun.spawnSync(["/bin/sh", "-c", step.command], { cwd, stdout: "ignore", stderr: "ignore" });
          exitCode = proc.exitCode;
          entry.exitCode = exitCode;
          status = exitCode === 0 ? "completed" : "failed";
        }
        decisions.push(entry);
        notify("item/completed", {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { type: "commandExecution", id: itemId, command: display, cwd, status, exitCode, commandActions: [] },
        });
      } else if (step.write !== undefined) {
        const abs = resolve(process.cwd(), step.write.path);
        const changes = [{ path: abs, kind: { type: "add" }, diff: step.write.content }];
        notify("item/started", {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { type: "fileChange", id: itemId, changes, status: "inProgress" },
        });
        const answer = await request("item/fileChange/requestApproval", {
          threadId: THREAD_ID, turnId: TURN_ID, itemId, startedAtMs: Date.now(), reason: null, grantRoot: null,
        });
        const decision = answerOf(answer);
        decisions.push({ label: step.label, method: "item/fileChange/requestApproval", decision });
        if (decision === "accept") {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, step.write.content);
        }
        notify("item/completed", {
          threadId: THREAD_ID, turnId: TURN_ID,
          item: { type: "fileChange", id: itemId, changes, status: decision === "accept" ? "completed" : "declined" },
        });
      }
    }

    // Logged before the turn ends: the kernel kills the process once it sees turn/completed.
    const entry: FakeCodexLogEntry = {
      role: role.name,
      call: callNumber,
      argv,
      cwd: process.cwd(),
      pid: process.pid,
      prompt,
      model: typeof threadStart.model === "string" ? threadStart.model : null,
      startedAt: Date.now(),
      threadStart,
      decisions,
    };
    appendFileSync(scenario.logPath, JSON.stringify(entry) + "\n");

    if (call.usage !== undefined) {
      const u = call.usage;
      const total = {
        totalTokens: u.inputTokens + u.outputTokens,
        inputTokens: u.inputTokens,
        cachedInputTokens: u.cachedInputTokens ?? 0,
        cacheWriteInputTokens: 0,
        outputTokens: u.outputTokens,
        reasoningOutputTokens: 0,
      };
      notify("thread/tokenUsage/updated", { threadId: THREAD_ID, turnId: TURN_ID, tokenUsage: { total, last: total } });
    }
    completeTurn("completed");
  };

  const completeTurn = (status: string): void => {
    if (turnDone) return;
    turnDone = true;
    notify("turn/completed", { threadId: THREAD_ID, turn: { id: TURN_ID, status, error: null, items: [] } });
  };

  const handle = (m: Json): void => {
    if (m.method === undefined) {
      // A response to one of our requests.
      const waiting = typeof m.id === "number" ? pending.get(m.id) : undefined;
      if (waiting !== undefined) {
        pending.delete(m.id);
        waiting(m);
      }
      return;
    }
    switch (m.method) {
      case "initialize":
        send({ id: m.id, result: { userAgent: "fake-codex-app-server" } });
        break;
      case "thread/start":
        threadStart = m.params ?? {};
        send({ id: m.id, result: { thread: { id: THREAD_ID, model: threadStart.model ?? "gpt-fake" } } });
        break;
      case "turn/start": {
        send({ id: m.id, result: { turn: { id: TURN_ID } } });
        notify("turn/started", { threadId: THREAD_ID, turn: { id: TURN_ID } });
        const input = Array.isArray(m.params?.input) ? m.params.input : [];
        const prompt = input.map((p: Json) => (typeof p?.text === "string" ? p.text : "")).join("\n");
        void runTurn(prompt);
        break;
      }
      case "turn/interrupt":
        send({ id: m.id, result: {} });
        completeTurn("interrupted");
        break;
      default:
        // `initialized` and any other notification need no answer; an unknown request gets an error.
        if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `fake does not handle ${m.method}` } });
        break;
    }
  };

  // Read stdin line by line until the kernel closes it or kills the process.
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of Bun.stdin.stream()) {
    carry += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, nl).trim();
      carry = carry.slice(nl + 1);
      if (line.length > 0) handle(JSON.parse(line) as Json);
    }
  }
  return 0;
}

/** The decision a client response carries, or `error:<message>`. */
function answerOf(m: Json): string {
  if (m.error !== undefined) return `error:${String(m.error?.message ?? "")}`;
  return String(m.result?.decision ?? "(none)");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version") {
    process.stdout.write(`${FAKE_VERSION}\n`);
    return 0;
  }
  if (argv[0] === "app-server") return appServer(argv);
  process.stderr.write(`fake-codex-app-server: unsupported invocation: ${argv.join(" ")}\n`);
  return 64;
}

const code = await main();
process.exit(code);
