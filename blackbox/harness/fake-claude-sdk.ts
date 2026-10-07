#!/usr/bin/env bun
/**
 * fake-claude-sdk: a scenario-driven stand-in for the Claude Code CLI as the
 * Agent SDK drives it.
 *
 * The black-box agent-sdk journeys point the shipped `agent-sdk` adapter at
 * this script through engine config (`CONDUIT_HARNESS_AGENT_SDK_COMMAND`). The
 * adapter passes it to the SDK as `pathToClaudeCodeExecutable`, and the SDK
 * spawns it, through the adapter's `spawnClaudeCodeProcess`, with
 * `--output-format stream-json --verbose --input-format stream-json ...`.
 * Nothing here is imported from src/. The message shapes are read from the
 * installed `@anthropic-ai/claude-agent-sdk` (sdk.mjs and sdk.d.ts) and from
 * the recorded CLI fixture used by fake-claude.ts.
 *
 * The SDK talks to the CLI in stream-json in both directions. This fake
 * implements the CLI side of the part the adapter uses:
 *
 *   SDK -> CLI (stdin):
 *     - `control_request` `initialize`, carrying `hooks.PreToolUse` (and
 *       `PostToolUse`, `PostToolUseFailure`) as
 *       `[{ matcher, hookCallbackIds, timeout }]`. The fake records the ids
 *       and answers `control_response` `success`. Any other SDK control
 *       request is answered `success` with an empty response.
 *     - the prompt, as `{ type: "user", message: { role: "user", content:
 *       [{ type: "text", text }] } }`. It starts the turn.
 *     - `control_response` answers to the fake's own requests.
 *   CLI -> SDK (stdout):
 *     - `system` `init`, then per scenario step an `assistant` message with a
 *       `tool_use` block and a `control_request` `hook_callback` for each
 *       registered PreToolUse callback id, with the PreToolUse hook input
 *       (`hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, ...).
 *       The SDK runs the adapter's hook and returns its output as the
 *       `control_response` `response`.
 *     - after each step, a `user` message with the `tool_result`.
 *     - a `result` message with `usage`, `modelUsage` and `total_cost_usd`,
 *       optionally preceded by earlier `result` messages, as a session with a
 *       background subagent sends. The SDK closes stdin after the first, and
 *       still delivers every one the fake wrote before it exits.
 *
 * Named agents. With `--agent <plugin>:<agent>` and `--plugin-dir <dir>` in
 * argv (the SDK's `agent` and `plugins` options), the fake reads each plugin
 * dir's `.claude-plugin/plugin.json` name and the frontmatter `name:` of each
 * `agents/*.md`, lists every `<plugin>:<agent>` it found in the init message's
 * `agents`, and, when the requested agent is among them, sends it as
 * `agent_type` on every hook input, as Claude Code 2.1.290 does for the main
 * thread of an `--agent` session. A requested agent it did not find is not an
 * error: like the real CLI on the SDK path, it runs the default agent, lists
 * only what it loaded, and sends no `agent_type`. `dropAgent` on a call makes
 * the fake ignore the requested agent even when a plugin dir defines it.
 *
 * A step's effect (running a Bash command, writing a file) happens only when
 * no hook answered `permissionDecision: "deny"`. A step with `rewriteInput`
 * stands in for a plugin PreToolUse hook that answered after the SDK's with
 * `updatedInput`: the effect runs with the rewritten input. After an effect
 * runs, the fake sends a `hook_callback` for each registered `PostToolUse`
 * callback id (or `PostToolUseFailure` when the call failed), carrying the
 * same `tool_use_id` and the input that ran, as the real CLI does. A hook
 * output with `continue: false`, from a pre or a post hook, stops the turn
 * after that step, as the real CLI does: no further step runs and the result
 * message follows. When no PreToolUse
 * callback was registered at initialize, no step's effect runs and the log
 * records `ungated`, so a journey can tell a missing gate from an allowed one.
 * After the result, the fake exits once the SDK closes stdin.
 *
 * The scenario file (JSON, see `FakeClaudeSdkScenario`) names roles, picked
 * by a substring of the prompt, with a per-role counter file so call 1 and
 * call 2 can differ (the last entry repeats). Every invocation appends one
 * JSON line to `logPath` with its role, call number, argv, cwd, pid, the
 * PreToolUse callback ids and every hook answer it received. The fields match
 * FakeClaudeLogEntry, so harness-flow's `stubLog()` and orphan reaper read it
 * unchanged.
 *
 * Launched through a generated `#!/bin/sh` wrapper that execs the running bun
 * binary on this file (see harness-flow.ts). The wrapper has no `.js`/`.ts`
 * extension, so the SDK runs it directly, as it runs a native `claude`.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface FakeClaudeSdkUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** One `modelUsage` entry, cumulative over the session. */
export interface FakeClaudeSdkModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * A `result` message sent before the terminal one, as a session with a
 * background subagent sends (issue #108). `usage` covers the last API turn
 * only; `modelUsage` is the session total so far.
 */
export interface FakeClaudeSdkEarlierResult {
  usage: FakeClaudeSdkUsage;
  modelUsage: Record<string, FakeClaudeSdkModelUsage>;
  costUsd?: number;
}

/** One tool call the model makes. */
export interface FakeClaudeSdkStep {
  /** Names the step in the log. */
  label: string;
  /** Tool name as Claude Code reports it: `Bash`, `Write`, `Read`, `AskUserQuestion`, ... */
  tool: string;
  /**
   * The tool input sent to the hook. A relative `file_path` is resolved
   * against the cwd first, since Claude Code's file tools take absolute
   * paths. On allow, `Bash` runs `input.command` with /bin/sh in the cwd and
   * `Write` writes `input.content` to `input.file_path`. Any other tool has
   * no effect.
   */
  input: Record<string, unknown>;
  /**
   * The input that runs instead of `input` when no hook denied the call, as
   * when a plugin PreToolUse hook rewrote it after the SDK's hook approved
   * `input`. The post hooks receive this input. A relative `file_path` is
   * resolved as for `input`.
   */
  rewriteInput?: Record<string, unknown>;
}

/** One invocation's behaviour. */
export interface FakeClaudeSdkCall {
  steps?: FakeClaudeSdkStep[];
  /** Usage on the result message. Default: 100 in / 50 out. */
  usage?: FakeClaudeSdkUsage;
  /** `total_cost_usd` on the result message. Default 0.001. */
  costUsd?: number;
  /**
   * `modelUsage` on the terminal result message, the session total. Default:
   * one entry under the model equal to `usage`, as a single-turn call reports.
   */
  modelUsage?: Record<string, FakeClaudeSdkModelUsage>;
  /**
   * `result` messages sent, each followed by an assistant text message, after
   * the steps and before the terminal one. All of them are written before the
   * fake reads the stdin close the SDK sends after the first.
   */
  earlierResults?: FakeClaudeSdkEarlierResult[];
  /**
   * Spawn a `setsid` descendant (a new session, so it leaves the fake's
   * process group) that writes its own pid to this path and sleeps. Use an
   * absolute path outside the project root.
   */
  setsidSleeperPidFile?: string;
  /**
   * Do not load the `--agent` the SDK asked for, even when a plugin dir
   * defines it: run the default agent, leave it out of init's `agents`, and
   * send no `agent_type`. Stands for a CLI that resolves plugin agents
   * differently from the kernel.
   */
  dropAgent?: boolean;
}

export interface FakeClaudeSdkRole {
  name: string;
  /** Substring of the prompt that selects this role. */
  promptIncludes: string;
  calls: FakeClaudeSdkCall[];
}

export interface FakeClaudeSdkScenario {
  stateDir: string;
  logPath: string;
  roles: FakeClaudeSdkRole[];
}

/** What the hooks answered for one step, and what the fake did. */
export interface FakeClaudeSdkAnswer {
  label: string;
  tool: string;
  toolUseId: string;
  /** `allow` when no hook denied, `deny` when one did, `error` when the SDK answered with an error. */
  decision: "allow" | "deny" | "error";
  /** `permissionDecisionReason` of a deny, or the error text. */
  reason: string | null;
  /** False when a pre or post hook answered `continue: false`. */
  continue: boolean;
  /** True when the step's effect ran. */
  performed: boolean;
  /** True when the effect ran with the step's `rewriteInput`. */
  rewritten: boolean;
  /** The post hook event sent after the effect ran, if any. */
  postEvent: "PostToolUse" | "PostToolUseFailure" | null;
  /** Exit code of a Bash command that ran. */
  exitCode?: number;
}

export interface FakeClaudeSdkLogEntry {
  role: string;
  call: number;
  argv: string[];
  cwd: string;
  pid: number;
  prompt: string;
  model: string | null;
  startedAt: number;
  /** The `hookCallbackIds` the SDK registered for PreToolUse at initialize. */
  preToolUseCallbackIds: string[];
  /** The `hookCallbackIds` the SDK registered for PostToolUse and PostToolUseFailure at initialize. */
  postToolUseCallbackIds: string[];
  postToolUseFailureCallbackIds: string[];
  /** True when no PreToolUse callback was registered, so nothing ran. */
  ungated: boolean;
  answers: FakeClaudeSdkAnswer[];
  /** True when a hook stopped the turn with `continue: false`. */
  stopped: boolean;
  /** Subtypes of the SDK control requests received, in order. */
  sdkRequests: string[];
  /** `--agent` from argv, or null. */
  agent: string | null;
  /** True when the requested agent was loaded and sent as `agent_type`. */
  agentLoaded: boolean;
}

type Json = Record<string, any>;

const SESSION_ID = "00000000-0000-4000-8000-00000000fa5d";

/** Synchronous, so nothing is lost when the kernel kills the process right after. */
function emit(obj: unknown): void {
  writeSync(1, JSON.stringify(obj) + "\n");
}

/** `modelUsage` entries with every token class present, as the CLI sends them. */
function modelUsageEntries(entries: Record<string, FakeClaudeSdkModelUsage>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [model, e] of Object.entries(entries)) {
    out[model] = {
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadInputTokens: e.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: e.cacheCreationInputTokens ?? 0,
    };
  }
  return out;
}

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i === -1 || i + 1 >= argv.length ? null : argv[i + 1]!;
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

function argValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === flag) values.push(argv[i + 1]!);
  return values;
}

/** `<plugin>:<agent>` for every agent file in the given plugin dirs. */
function pluginAgents(pluginDirs: string[]): string[] {
  const found: string[] = [];
  for (const dir of pluginDirs) {
    let plugin: string;
    try {
      plugin = String(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).name);
    } catch {
      continue;
    }
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, "agents")).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      let body: string;
      try {
        body = readFileSync(join(dir, "agents", file), "utf8");
      } catch {
        continue;
      }
      const m = /^name:\s*(\S+)\s*$/m.exec(body);
      if (m) found.push(`${plugin}:${m[1]}`);
    }
  }
  return found;
}

function spawnSetsidSleeper(pidFile: string): void {
  mkdirSync(dirname(pidFile), { recursive: true });
  Bun.spawn(["setsid", "sh", "-c", `echo $$ > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}' && exec sleep 300`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
  const deadline = Date.now() + 5_000;
  while (!existsSync(pidFile) && Date.now() < deadline) Bun.sleepSync(10);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const scenarioPath = process.env.FAKE_CLAUDE_SDK_SCENARIO;
  if (!scenarioPath) {
    process.stderr.write("fake-claude-sdk: FAKE_CLAUDE_SDK_SCENARIO is not set (is it on the adapter env allowlist?)\n");
    return 64;
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as FakeClaudeSdkScenario;
  const model = argValue(argv, "--model");
  const requestedAgent = argValue(argv, "--agent");
  const loadedPluginAgents = pluginAgents(argValues(argv, "--plugin-dir"));

  let preToolUseCallbackIds: string[] = [];
  let postToolUseCallbackIds: string[] = [];
  let postToolUseFailureCallbackIds: string[] = [];
  const sdkRequests: string[] = [];
  let nextRequestId = 1;
  const pending = new Map<string, (response: Json) => void>();
  let turnStarted = false;

  /** Send a CLI -> SDK control request and resolve with the SDK's `response` object. */
  const request = (body: Json): Promise<Json> =>
    new Promise((res) => {
      const requestId = `fake-req-${nextRequestId++}`;
      pending.set(requestId, res);
      emit({ type: "control_request", request_id: requestId, request: body });
    });

  const runTurn = async (prompt: string): Promise<void> => {
    const matches = scenario.roles.filter((r) => prompt.includes(r.promptIncludes));
    if (matches.length !== 1) {
      process.stderr.write(`fake-claude-sdk: ${matches.length} roles match the prompt: ${prompt.slice(0, 200)}\n`);
      process.exit(65);
    }
    const role = matches[0]!;
    const callNumber = nextCallNumber(scenario.stateDir, role.name);
    const call = role.calls[Math.min(callNumber, role.calls.length) - 1] ?? {};
    const startedAt = Date.now();
    const cwd = process.cwd();
    const agents = call.dropAgent === true ? loadedPluginAgents.filter((a) => a !== requestedAgent) : loadedPluginAgents;
    const agentLoaded = requestedAgent !== null && agents.includes(requestedAgent);

    emit({
      type: "system",
      subtype: "init",
      cwd,
      session_id: SESSION_ID,
      tools: ["Bash", "Read", "Write", "AskUserQuestion"],
      model: model ?? "claude-fake",
      permissionMode: argValue(argv, "--permission-mode") ?? "default",
      agents: ["general-purpose", ...agents],
      uuid: "00000000-0000-4000-8000-000000000001",
    });

    if (call.setsidSleeperPidFile !== undefined) spawnSetsidSleeper(resolve(cwd, call.setsidSleeperPidFile));

    const ungated = preToolUseCallbackIds.length === 0;
    const answers: FakeClaudeSdkAnswer[] = [];
    let stopped = false;
    for (const [i, scripted] of (call.steps ?? []).entries()) {
      const toolUseId = `toolu_fake_${callNumber}_${i + 1}`;
      // Claude Code's file tools take an absolute file_path, so a relative one in the scenario is resolved
      // against the cwd before the model reports it.
      const absolutePath = (input: Record<string, unknown>): Record<string, unknown> =>
        typeof input.file_path === "string" ? { ...input, file_path: resolve(cwd, input.file_path) } : input;
      const step: FakeClaudeSdkStep = {
        ...scripted,
        input: absolutePath(scripted.input),
        ...(scripted.rewriteInput !== undefined ? { rewriteInput: absolutePath(scripted.rewriteInput) } : {}),
      };
      emit({
        type: "assistant",
        message: {
          model: model ?? "claude-fake",
          id: `msg_fake_${callNumber}_${i + 1}`,
          type: "message",
          role: "assistant",
          content: [{ type: "tool_use", id: toolUseId, name: step.tool, input: step.input }],
        },
        parent_tool_use_id: null,
        session_id: SESSION_ID,
      });

      const answer: FakeClaudeSdkAnswer = {
        label: step.label,
        tool: step.tool,
        toolUseId,
        decision: ungated ? "deny" : "allow",
        reason: ungated ? "no PreToolUse hook was registered" : null,
        continue: true,
        performed: false,
        rewritten: false,
        postEvent: null,
      };
      for (const callbackId of preToolUseCallbackIds) {
        const response = await request({
          subtype: "hook_callback",
          callback_id: callbackId,
          tool_use_id: toolUseId,
          input: {
            session_id: SESSION_ID,
            transcript_path: join(cwd, ".fake-transcript.jsonl"),
            cwd,
            permission_mode: "default",
            hook_event_name: "PreToolUse",
            tool_name: step.tool,
            tool_input: step.input,
            tool_use_id: toolUseId,
            ...(agentLoaded ? { agent_type: requestedAgent } : {}),
          },
        });
        if (response.subtype !== "success") {
          answer.decision = "error";
          answer.reason = String(response.error ?? "control_response error");
          continue;
        }
        const out = (response.response ?? {}) as Json;
        if (out.continue === false) answer.continue = false;
        if (out.hookSpecificOutput?.permissionDecision === "deny" && answer.decision !== "error") {
          answer.decision = "deny";
          answer.reason = String(out.hookSpecificOutput.permissionDecisionReason ?? "");
        }
      }

      let resultText = "ok";
      let isError = false;
      // What a later plugin hook's `updatedInput` would make run instead of what the hooks above saw.
      const executed = answer.decision === "allow" && step.rewriteInput !== undefined ? step.rewriteInput : step.input;
      if (answer.decision === "allow") {
        answer.performed = true;
        answer.rewritten = executed !== step.input;
        if (step.tool === "Bash") {
          const proc = Bun.spawnSync(["/bin/sh", "-c", String(executed.command ?? "")], {
            cwd,
            stdout: "pipe",
            stderr: "ignore",
          });
          answer.exitCode = proc.exitCode;
          resultText = proc.stdout.toString();
          isError = proc.exitCode !== 0;
          if (isError) resultText = `Exit code ${proc.exitCode}`;
        } else if (step.tool === "Write") {
          const abs = String(executed.file_path ?? "");
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, String(executed.content ?? ""));
          resultText = `File created successfully at: ${abs}`;
        }
        // The CLI reports a call that ran to the post hooks, with the same tool_use_id and the input that ran.
        const postEvent = isError ? "PostToolUseFailure" : "PostToolUse";
        const postIds = isError ? postToolUseFailureCallbackIds : postToolUseCallbackIds;
        if (postIds.length > 0) answer.postEvent = postEvent;
        for (const callbackId of postIds) {
          const response = await request({
            subtype: "hook_callback",
            callback_id: callbackId,
            tool_use_id: toolUseId,
            input: {
              session_id: SESSION_ID,
              transcript_path: join(cwd, ".fake-transcript.jsonl"),
              cwd,
              permission_mode: "default",
              hook_event_name: postEvent,
              tool_name: step.tool,
              tool_input: executed,
              tool_use_id: toolUseId,
              ...(isError ? { error: resultText } : { tool_response: resultText }),
            },
          });
          if (response.subtype === "success" && (response.response ?? {}).continue === false) answer.continue = false;
        }
      } else {
        isError = true;
        resultText = answer.reason ?? "denied";
      }
      answers.push(answer);
      emit({
        type: "user",
        message: {
          role: "user",
          content: [{ tool_use_id: toolUseId, type: "tool_result", content: resultText, ...(isError ? { is_error: true } : {}) }],
        },
        parent_tool_use_id: null,
        session_id: SESSION_ID,
      });
      if (!answer.continue) {
        stopped = true;
        break;
      }
    }

    // Logged before the result: the kernel may kill the process once it has the result.
    const entry: FakeClaudeSdkLogEntry = {
      role: role.name,
      call: callNumber,
      argv,
      cwd,
      pid: process.pid,
      prompt,
      model,
      startedAt,
      preToolUseCallbackIds,
      postToolUseCallbackIds,
      postToolUseFailureCallbackIds,
      ungated,
      answers,
      stopped,
      sdkRequests,
      agent: requestedAgent,
      agentLoaded,
    };
    appendFileSync(scenario.logPath, JSON.stringify(entry) + "\n");

    const usage = call.usage ?? { input_tokens: 100, output_tokens: 50 };
    const costUsd = call.costUsd ?? 0.001;
    const canonicalModel = model ?? "claude-fake";
    const resultMessage = (
      u: FakeClaudeSdkUsage,
      modelUsage: Record<string, Record<string, unknown>>,
      cost: number,
      uuid: string,
      final: boolean,
    ): Json => ({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 10,
      num_turns: 1,
      result: final && stopped ? "stopped by a hook" : "done",
      stop_reason: final && stopped ? null : "end_turn",
      session_id: SESSION_ID,
      total_cost_usd: cost,
      usage: {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      },
      modelUsage,
      permission_denials: [],
      terminal_reason: "completed",
      uuid,
    });
    for (const [i, earlier] of (call.earlierResults ?? []).entries()) {
      const n = String(i + 1).padStart(2, "0");
      emit(resultMessage(earlier.usage, modelUsageEntries(earlier.modelUsage), earlier.costUsd ?? 0.001, `00000000-0000-4000-8000-0000000001${n}`, false));
      emit({
        type: "assistant",
        message: {
          model: canonicalModel,
          id: `msg_fake_sdk_after_result_${i + 1}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "The background agent reported back." }],
        },
        parent_tool_use_id: null,
        session_id: SESSION_ID,
      });
    }
    const modelUsage = call.modelUsage
      ? modelUsageEntries(call.modelUsage)
      : {
          [canonicalModel]: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
            costUSD: costUsd,
          },
        };
    emit(resultMessage(usage, modelUsage, costUsd, "00000000-0000-4000-8000-000000000099", true));
  };

  const handle = (m: Json): void => {
    if (m.type === "control_response") {
      const response = (m.response ?? {}) as Json;
      const waiting = pending.get(response.request_id);
      if (waiting !== undefined) {
        pending.delete(response.request_id);
        waiting(response);
      }
      return;
    }
    if (m.type === "control_request") {
      const subtype = String(m.request?.subtype ?? "");
      sdkRequests.push(subtype);
      let response: Json = {};
      if (subtype === "initialize") {
        const ids = (event: string): string[] =>
          ((m.request?.hooks?.[event] ?? []) as Json[]).flatMap((e) =>
            Array.isArray(e.hookCallbackIds) ? e.hookCallbackIds.map(String) : [],
          );
        preToolUseCallbackIds = ids("PreToolUse");
        postToolUseCallbackIds = ids("PostToolUse");
        postToolUseFailureCallbackIds = ids("PostToolUseFailure");
        response = { commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [], account: {} };
      }
      emit({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
      return;
    }
    if (m.type === "user" && !turnStarted) {
      turnStarted = true;
      const content = m.message?.content;
      const prompt = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((p: Json) => (typeof p?.text === "string" ? p.text : "")).join("\n")
          : "";
      void runTurn(prompt).catch((err) => {
        process.stderr.write(`fake-claude-sdk: turn failed: ${String(err)}\n`);
        process.exit(70);
      });
    }
    // keep_alive, control_cancel_request and anything else need no answer.
  };

  // Read stdin line by line until the SDK closes it (after the result) or the kernel kills the process.
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

const code = await main();
process.exit(code);
