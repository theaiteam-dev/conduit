#!/usr/bin/env bun
/**
 * fake-claude: a scenario-driven stand-in for the headless Claude Code CLI.
 *
 * The black-box harness journeys point the shipped `claude-headless` adapter
 * at this script through engine config
 * (`CONDUIT_HARNESS_CLAUDE_HEADLESS_COMMAND`), so the real `conduit run`
 * spawns it exactly as it would spawn `claude -p --output-format stream-json
 * --verbose ... -- <prompt>`. Nothing here is imported from src/: the stream
 * shapes are copied from the recorded CLI fixture
 * (fixtures/harness/claude-stream-json.ndjson) and the adapter's own tests.
 *
 * The child env is scrubbed to the adapter's allowlist, so the scenario path
 * arrives through one allowlisted variable, FAKE_CLAUDE_SCENARIO. The
 * scenario file (JSON, see `Scenario` below) names roles. Each invocation
 * picks the first role whose `promptIncludes` text appears in the prompt,
 * bumps that role's counter file, and runs `calls[n]` (the last entry repeats
 * once the list is exhausted). Every invocation appends one JSON line to
 * `logPath` with its role, call number, argv, cwd and pid, so a test can
 * assert on what the kernel passed.
 *
 * Launched through a generated `#!/bin/sh` wrapper that execs the running bun
 * binary on this file (see harness-flow.ts), so it does not depend on `bun`
 * being on the scrubbed child PATH.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface FakeClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** One `modelUsage` entry, cumulative over the session. */
export interface FakeClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Default 0. */
  costUSD?: number;
  /** Default: the model key. */
  canonicalModel?: string;
}

/**
 * A `result` event emitted before the terminal one. The real CLI emits one per
 * turn that ends while a background subagent is still running, so a session
 * with a background subagent has two or more (issue #108). `usage` covers the
 * last API turn only; `modelUsage` is the session total so far.
 */
export interface FakeClaudeEarlierResult {
  usage: FakeClaudeUsage;
  modelUsage: Record<string, FakeClaudeModelUsage>;
  /** `total_cost_usd` on this result: the session total so far, as the CLI reports it. Default 0.001. */
  costUsd?: number;
}

export interface FakeClaudeRateLimit {
  /** e.g. "allowed", "allowed_warning", "rejected". */
  status: string;
  /** Epoch seconds. */
  resetsAt: number;
  rateLimitType?: string;
  utilization?: number;
}

/** One invocation's behaviour. Every field is optional. */
export interface FakeClaudeCall {
  /** Files to write, relative to the child's cwd (the project root). */
  writeFiles?: Record<string, string>;
  /** Usage on the terminal `result` event. Default: 100 in / 50 out. */
  usage?: FakeClaudeUsage;
  /**
   * `total_cost_usd` on the terminal result event, the session total as the CLI
   * reports it. Like `modelUsage`, it is emitted as given: the fake does not add
   * `earlierResults`' costs to it. Default 0.001.
   */
  costUsd?: number;
  /** Model named in `modelUsage`. Default: the `--model` argv value, else "claude-fake". */
  canonicalModel?: string;
  /**
   * `modelUsage` on the terminal result event, the session total. Default: one
   * entry under `canonicalModel` equal to `usage`, as a single-turn call reports.
   */
  modelUsage?: Record<string, FakeClaudeModelUsage>;
  /** `result` events emitted, each followed by an assistant text message, before the terminal one. */
  earlierResults?: FakeClaudeEarlierResult[];
  /** A `rate_limit_event` emitted before the result. */
  rateLimit?: FakeClaudeRateLimit;
  /** Result event overrides for a failed call (e.g. is_error, api_error_status, result text). */
  resultOverrides?: Record<string, unknown>;
  /** Omit the terminal `result` event entirely. */
  noResult?: boolean;
  /** Text written to stderr before exit. */
  stderr?: string;
  /**
   * Milliseconds the call takes before its rate-limit/result events, after its
   * file writes. Models a slow provider call; it is not used to synchronize
   * anything.
   */
  delayMs?: number;
  /** Process exit code. Default 0. */
  exitCode?: number;
  /**
   * Print the system/init line, then stop writing stdout and never exit (the
   * idle-timeout case). Files and the sleeper are still written first.
   */
  hang?: boolean;
  /**
   * Spawn a `setsid` descendant (a new session, so it leaves the stub's process
   * group) that writes its own pid to this path and sleeps. Relative paths
   * resolve against the child's cwd. Use an absolute path outside the project
   * root: a harness maker's writes inside it are checked against owned_paths.
   */
  setsidSleeperPidFile?: string;
}

export interface FakeClaudeRole {
  name: string;
  /** Substring of the prompt (the argv after `--`) that selects this role. */
  promptIncludes: string;
  calls: FakeClaudeCall[];
}

export interface FakeClaudeScenario {
  /** Directory holding one `<role>.<n>` claim file per call made. */
  stateDir: string;
  /** NDJSON invocation log. */
  logPath: string;
  roles: FakeClaudeRole[];
}

export interface FakeClaudeLogEntry {
  role: string;
  /** 1-based call number within the role. */
  call: number;
  argv: string[];
  cwd: string;
  pid: number;
  prompt: string;
  model: string | null;
  startedAt: number;
}

const SESSION_ID = "00000000-0000-4000-8000-00000000fa4e";

/** Synchronous, so nothing is lost when the stub exits right after. */
function emit(obj: unknown): void {
  writeSync(1, JSON.stringify(obj) + "\n");
}

/** `modelUsage` entries with every token class, the cost and the canonical model, as the CLI sends them on every result. */
function modelUsageEntries(entries: Record<string, FakeClaudeModelUsage>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [model, e] of Object.entries(entries)) {
    out[model] = {
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadInputTokens: e.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: e.cacheCreationInputTokens ?? 0,
      costUSD: e.costUSD ?? 0,
      canonicalModel: e.canonicalModel ?? model,
    };
  }
  return out;
}

/** A successful `result` event. */
function resultEvent(usage: FakeClaudeUsage, modelUsage: Record<string, unknown>, costUsd: number): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 10,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    session_id: SESSION_ID,
    total_cost_usd: costUsd,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
    modelUsage,
    terminal_reason: "completed",
  };
}

function argValue(argv: string[], flag: string): string | null {
  const end = argv.indexOf("--");
  const i = argv.indexOf(flag);
  if (i === -1 || (end !== -1 && i > end) || i + 1 >= argv.length) return null;
  return argv[i + 1]!;
}

/**
 * Next 1-based call number for `role`, persisted across invocations. Each call
 * claims `<role>.<n>` with an exclusive create, so concurrent invocations of
 * one role cannot both claim the same number.
 */
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

function spawnSetsidSleeper(pidFile: string): void {
  mkdirSync(dirname(pidFile), { recursive: true });
  // `setsid` makes the shell a new session leader, so it is no longer in the
  // stub's process group; `exec sleep` keeps the pid the shell recorded. All
  // stdio is detached so the sleeper cannot hold the runner's pipes open.
  Bun.spawn(["setsid", "sh", "-c", `echo $$ > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}' && exec sleep 300`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
  // The pid file is the stub's handshake that the sleeper exists before the
  // kernel can kill anything.
  const deadline = Date.now() + 5_000;
  while (!existsSync(pidFile) && Date.now() < deadline) Bun.sleepSync(10);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
  if (!scenarioPath) {
    process.stderr.write("fake-claude: FAKE_CLAUDE_SCENARIO is not set (is it on the adapter env allowlist?)\n");
    return 64;
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as FakeClaudeScenario;
  const sep = argv.indexOf("--");
  const prompt = sep === -1 ? "" : argv.slice(sep + 1).join(" ");
  const model = argValue(argv, "--model");

  // Every match, not the first: overlapping markers would otherwise run the
  // wrong role's calls with no signal.
  const matches = scenario.roles.filter((r) => prompt.includes(r.promptIncludes));
  if (matches.length > 1) {
    const markers = matches.map((r) => JSON.stringify(r.promptIncludes)).join(", ");
    process.stderr.write(`fake-claude: the prompt matches more than one role's promptIncludes: ${markers}\n`);
    return 65;
  }
  const role = matches[0];
  if (!role) {
    process.stderr.write(`fake-claude: no scenario role matches the prompt: ${prompt.slice(0, 200)}\n`);
    return 65;
  }
  const callNumber = nextCallNumber(scenario.stateDir, role.name);
  const call = role.calls[Math.min(callNumber, role.calls.length) - 1] ?? {};

  const entry: FakeClaudeLogEntry = {
    role: role.name,
    call: callNumber,
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    prompt,
    model,
    startedAt: Date.now(),
  };
  appendFileSync(scenario.logPath, JSON.stringify(entry) + "\n");

  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: SESSION_ID,
    tools: ["Bash", "Read", "Write"],
    model: model ?? "claude-fake",
    permissionMode: "default",
    uuid: "00000000-0000-4000-8000-000000000001",
  });

  if (call.setsidSleeperPidFile !== undefined) {
    spawnSetsidSleeper(resolve(process.cwd(), call.setsidSleeperPidFile));
  }

  for (const [rel, content] of Object.entries(call.writeFiles ?? {})) {
    const abs = join(process.cwd(), rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const toolUseId = `toolu_fake_${callNumber}_${rel.replace(/[^A-Za-z0-9]/g, "_")}`;
    emit({
      type: "assistant",
      message: {
        model: model ?? "claude-fake",
        id: `msg_fake_${callNumber}`,
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "Write", input: { file_path: abs, content } }],
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    });
    emit({
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: toolUseId, type: "tool_result", content: `File created successfully at: ${abs}` }],
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      tool_use_result: { type: "create", filePath: abs, content },
    });
  }

  if (call.hang) {
    // Silent from here on: no stdout line resets the kernel's idle timer.
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
  }

  if (call.delayMs !== undefined) await Bun.sleep(call.delayMs);

  if (call.rateLimit !== undefined) {
    const rl = call.rateLimit;
    emit({
      type: "rate_limit_event",
      rate_limit_info: {
        status: rl.status,
        resetsAt: rl.resetsAt,
        rateLimitType: rl.rateLimitType ?? "five_hour",
        utilization: rl.utilization ?? 1,
        isUsingOverage: false,
      },
      uuid: "00000000-0000-4000-8000-000000000013",
      session_id: SESSION_ID,
    });
  }

  for (const [i, earlier] of (call.earlierResults ?? []).entries()) {
    emit(resultEvent(earlier.usage, modelUsageEntries(earlier.modelUsage), earlier.costUsd ?? 0.001));
    emit({
      type: "assistant",
      message: {
        model: model ?? "claude-fake",
        id: `msg_fake_${callNumber}_after_result_${i + 1}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "The background agent reported back." }],
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    });
  }
  if (!call.noResult) {
    const usage = call.usage ?? { input_tokens: 100, output_tokens: 50 };
    const canonicalModel = call.canonicalModel ?? model ?? "claude-fake";
    const costUsd = call.costUsd ?? 0.001;
    const modelUsage = call.modelUsage
      ? modelUsageEntries(call.modelUsage)
      : {
          [canonicalModel]: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
            costUSD: costUsd,
            canonicalModel,
          },
        };
    emit({ ...resultEvent(usage, modelUsage, costUsd), ...call.resultOverrides });
  }

  if (call.stderr) writeSync(2, call.stderr);
  return call.exitCode ?? 0;
}

const code = await main();
process.exit(code);
