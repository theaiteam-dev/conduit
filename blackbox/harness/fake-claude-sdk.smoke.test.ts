/**
 * fake-claude-sdk: smoke test.
 *
 * Drives the fake with the real `@anthropic-ai/claude-agent-sdk` `query()`
 * and a PreToolUse hook, without conduit, so a journey failure can be told
 * apart from a fake that does not speak the SDK's control protocol: the SDK
 * registers its hook at initialize, the fake calls it once per tool call, an
 * allowed write happens, a denied one does not, and `continue: false` ends the
 * turn with a result message that still carries the usage.
 *
 * BLACK-BOX RULE: zero imports from src/. The SDK is a third-party package.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { FakeClaudeSdkCall, FakeClaudeSdkLogEntry } from "./fake-claude-sdk";

const FAKE = join(import.meta.dir, "fake-claude-sdk.ts");

describe("fake-claude-sdk", () => {
  const root = mkdtempSync(join(tmpdir(), "conduit-bb-fake-claude-sdk-"));
  let runs = 0;

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** One query() against the fake, with a hook that answers per tool call from `decide`. */
  async function drive(call: FakeClaudeSdkCall, decide: (toolName: string) => "allow" | "deny" | "stop") {
    runs += 1;
    const dir = join(root, `run-${runs}`);
    const cwd = join(dir, "project");
    mkdirSync(cwd, { recursive: true });
    const logPath = join(dir, "invocations.ndjson");
    const scenarioPath = join(dir, "scenario.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({ stateDir: join(dir, "counters"), logPath, roles: [{ name: "maker", promptIncludes: "ROLE:MAKER", calls: [call] }] }),
    );
    // Same wrapper shape as harness-flow.ts: no script extension, so the SDK runs it directly.
    const wrapper = join(dir, "claude");
    writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
    chmodSync(wrapper, 0o755);

    const hookCalls: string[] = [];
    const hook: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return { continue: true };
      hookCalls.push(input.tool_name);
      const d = decide(input.tool_name);
      if (d === "allow") return { continue: true };
      const deny = { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: `no ${input.tool_name}` };
      return d === "stop" ? { continue: false, stopReason: "held", hookSpecificOutput: deny } : { hookSpecificOutput: deny };
    };
    const messages: SDKMessage[] = [];
    for await (const m of query({
      prompt: "ROLE:MAKER go",
      options: {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_CLAUDE_SDK_SCENARIO: scenarioPath },
        pathToClaudeCodeExecutable: wrapper,
        settingSources: [],
        hooks: { PreToolUse: [{ hooks: [hook] }] },
      },
    })) {
      messages.push(m);
    }
    const log = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeClaudeSdkLogEntry);
    return { cwd, hookCalls, messages, log };
  }

  test("the SDK's hook decides each call: an allowed write happens, a denied one does not", async () => {
    const { cwd, hookCalls, messages, log } = await drive(
      {
        steps: [
          { label: "yes", tool: "Write", input: { file_path: "a.txt", content: "a" } },
          { label: "no", tool: "Bash", input: { command: "touch b.txt" } },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
        costUsd: 0.0002,
      },
      (tool) => (tool === "Write" ? "allow" : "deny"),
    );
    expect(hookCalls).toEqual(["Write", "Bash"]);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(cwd, "b.txt"))).toBe(false);

    expect(log).toHaveLength(1);
    expect(log[0]!.sdkRequests[0]).toBe("initialize");
    expect(log[0]!.preToolUseCallbackIds).toHaveLength(1);
    expect(log[0]!.ungated).toBe(false);
    expect(log[0]!.answers.map((a) => [a.label, a.decision, a.performed])).toEqual([
      ["yes", "allow", true],
      ["no", "deny", false],
    ]);
    expect(log[0]!.answers[1]!.reason).toBe("no Bash");
    expect(log[0]!.argv).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format"]));

    const result = messages.find((m) => m.type === "result") as Record<string, any> | undefined;
    expect(result?.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 });
    expect(result?.total_cost_usd).toBe(0.0002);
  }, 30_000);

  test("continue: false stops the turn after that call, and the result still arrives", async () => {
    const { cwd, hookCalls, messages, log } = await drive(
      {
        steps: [
          { label: "ask", tool: "AskUserQuestion", input: { questions: [] } },
          { label: "after", tool: "Write", input: { file_path: "after.txt", content: "x" } },
        ],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
      (tool) => (tool === "AskUserQuestion" ? "stop" : "allow"),
    );
    expect(hookCalls).toEqual(["AskUserQuestion"]);
    expect(existsSync(join(cwd, "after.txt"))).toBe(false);
    expect(log[0]!.stopped).toBe(true);
    expect(log[0]!.answers.map((a) => [a.label, a.decision, a.continue])).toEqual([["ask", "deny", false]]);
    const result = messages.find((m) => m.type === "result") as Record<string, any> | undefined;
    expect(result?.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });
  }, 30_000);
});
