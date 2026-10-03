/**
 * Flag-gated real-binary E2E for the opencode adapter (issue #21).
 *
 * GATED OFF BY DEFAULT, like harness-e2e-codex-app-server.test.ts: it runs only
 * when CONDUIT_E2E_OPENCODE is set and an `opencode` binary is on PATH.
 *
 *   CONDUIT_E2E_OPENCODE=1 bun test src/integration/harness-e2e-opencode.test.ts
 *
 * It calls the real API through `opencode serve` with the operator's existing
 * login (the adapter passes the model provider's `auth.json` entry to the
 * child). Four short calls:
 *
 *   1. an allow-all gate: the result carries real usage and the billed model;
 *   2. a gate that allows a write inside the project: the file exists, and the
 *      tool events carry the path;
 *   3. a deny gate: the model's shell write is rejected, the file is never
 *      created, and deny gate-decision events are emitted;
 *   4. a hold gate: the call ends with the hold code and no command runs, with
 *      the usage of the step in flight.
 *
 * A fifth check makes no API call: with an operator `~/.opencode/opencode.json`
 * holding allow rules and HOME allowlisted, `opencode debug agent build` run
 * with the env the adapter builds still resolves bash and edit to `ask`.
 *
 * The model defaults to openai/gpt-4.1-mini. Override it with
 * CONDUIT_E2E_OPENCODE_MODEL (`provider/model`).
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpenCodeHarnessAdapter } from '../worker/harness-adapter-opencode';
import type { KnownUsage } from '../worker/harness-adapter';
import type { HarnessEvent } from '../worker/harness-events';
import type { GateToolCall } from '../worker/harness-gate';
import { HARNESS_GATE_HOLD_CODE, createHarnessToolGate } from '../worker/harness-gate';

const E2E_ENABLED = !!process.env.CONDUIT_E2E_OPENCODE && Bun.which('opencode') !== null;
const MODEL = process.env.CONDUIT_E2E_OPENCODE_MODEL ?? 'openai/gpt-4.1-mini';
const TIMEOUT_MS = 120_000;
// The model may look around before it writes, and a denied look can end the call without a write.
const WRITE_TOOLS = ['Write', 'Edit', 'Read', 'Glob', 'Grep'];

function isDeniedTxtBash(call: GateToolCall): boolean {
  return call.toolName === 'Bash' && String((call.input as { command?: unknown }).command).includes('denied.txt');
}

function adapterFor(projectRoot: string) {
  return createOpenCodeHarnessAdapter({ projectRoot, envAllowlist: ['PATH'], model: MODEL });
}

describe.skipIf(!E2E_ENABLED)('opencode adapter against the real API (CONDUIT_E2E_OPENCODE=1)', () => {
  it('returns populated usage and the billed model for a tiny prompt through an allow-all gate', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-opencode-')));
    try {
      const events: HarnessEvent[] = [];
      const out = await adapterFor(root).invoke({
        prompt: 'Reply with the single word OK and nothing else.',
        inputs: [],
        tools: [],
        timeoutMs: TIMEOUT_MS,
        gate: () => ({ decision: 'allow' }),
        onEvent: (e) => events.push(e),
      });
      expect('unknown' in out.usage).toBe(false);
      const usage = out.usage as KnownUsage;
      expect(usage.tokens).toBeGreaterThan(0);
      expect(usage.breakdown?.outputTokens).toBeGreaterThan(0);
      expect(usage.model ?? '').not.toBe('');
      expect(events.some((e) => e.type === 'usage')).toBe(true);
      expect(events[0]).toMatchObject({ type: 'lifecycle', phase: 'start' });
      expect(events[events.length - 1]).toMatchObject({ type: 'lifecycle', phase: 'end' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS + 10_000);

  it('writes a file the real gate allows, and journals its path', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-opencode-')));
    try {
      const events: HarnessEvent[] = [];
      await adapterFor(root).invoke({
        prompt: 'Use the write tool to create a file named note.txt containing the word hello. Then say done.',
        inputs: [],
        tools: WRITE_TOOLS,
        timeoutMs: TIMEOUT_MS,
        gate: createHarnessToolGate({ projectRoot: root, tools: WRITE_TOOLS }),
        onEvent: (e) => events.push(e),
      });
      expect(readFileSync(join(root, 'note.txt'), 'utf-8')).toContain('hello');
      expect(events.some((e) => e.type === 'gate-decision' && e.toolName === 'Write' && e.decision === 'allow')).toBe(true);
      expect(events.some((e) => e.type === 'tool-input-available' && e.toolName === 'Write')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS + 10_000);

  it('rejects a shell write when the gate denies it, and emits the deny decision', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-opencode-')));
    try {
      const events: HarnessEvent[] = [];
      const seen: GateToolCall[] = [];
      await adapterFor(root).invoke({
        prompt:
          'Run this exact bash command: echo denied > denied.txt . ' +
          'If it is refused, say so in one sentence and stop.',
        inputs: [],
        tools: ['Bash'],
        timeoutMs: TIMEOUT_MS,
        gate: (call) => {
          seen.push(call);
          return { decision: 'deny', code: 'not_allowlisted', reason: `no ${call.toolName}` };
        },
        onEvent: (e) => events.push(e),
      });
      // The model must have actually attempted the write, else absence of the file proves nothing.
      const attempt = seen.find(isDeniedTxtBash);
      expect(attempt).toBeDefined();
      expect(existsSync(join(root, 'denied.txt'))).toBe(false);
      const decisions = events.filter((e) => e.type === 'gate-decision');
      expect(
        decisions.some((e) => e.type === 'gate-decision' && e.decision === 'deny' && e.toolName === 'Bash' && e.toolCallId === attempt!.toolCallId),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS + 10_000);

  it('ends the call with the hold code when the gate holds, runs no command, and carries usage', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-opencode-')));
    try {
      const events: HarnessEvent[] = [];
      let error: (Error & { code?: string; usage?: KnownUsage }) | undefined;
      try {
        await adapterFor(root).invoke({
          prompt: 'Run this exact bash command: touch held.txt . Then say done.',
          inputs: [],
          tools: ['Bash'],
          timeoutMs: TIMEOUT_MS,
          gate: () => ({ decision: 'hold', code: 'needs_human', reason: 'ask a human' }),
          onEvent: (e) => events.push(e),
        });
      } catch (err) {
        error = err as Error & { code?: string; usage?: KnownUsage };
      }
      expect(error?.code).toBe(HARNESS_GATE_HOLD_CODE);
      expect(existsSync(join(root, 'held.txt'))).toBe(false);
      expect(events.some((e) => e.type === 'gate-decision' && e.decision === 'hold')).toBe(true);
      expect(error?.usage?.tokens ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS + 10_000);
});

// No API call: the adapter's spawn seam runs `opencode debug agent build` with the env the adapter built,
// which prints the agent's resolved permission rules, then stops the call.
describe.skipIf(!E2E_ENABLED)("opencode adapter: the operator's ~/.opencode (CONDUIT_E2E_OPENCODE=1)", () => {
  type Rule = { permission: string; action: string; pattern: string };
  /** opencode evaluates the last matching rule. */
  const lastMatch = (rules: Rule[], name: string): string | undefined =>
    rules.filter((r) => (r.permission === name || r.permission === '*') && r.pattern === '*').at(-1)?.action;

  it('does not load an allow rule from the operator home, even with HOME allowlisted', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-opencode-')));
    const operatorHome = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-opencode-home-')));
    try {
      mkdirSync(join(operatorHome, '.opencode'));
      writeFileSync(
        join(operatorHome, '.opencode', 'opencode.json'),
        JSON.stringify({ agent: { build: { permission: { bash: 'allow' } } }, permission: { '*': 'allow', edit: 'allow' } }),
      );
      const probe = (env: Record<string, string>): Rule[] => {
        const out = Bun.spawnSync(['opencode', 'debug', 'agent', 'build'], {
          cwd: root,
          env,
          timeout: 30_000,
          killSignal: 'SIGKILL',
        });
        if (out.exitCode !== 0) {
          throw new Error(
            `opencode debug agent build failed (exit ${out.exitCode}, signal ${out.signalCode ?? 'none'}): ${out.stderr.toString().slice(0, 500)}`,
          );
        }
        return JSON.parse(out.stdout.toString()).permission as Rule[];
      };
      let adapterRules: Rule[] | undefined;
      let operatorRules: Rule[] | undefined;
      const adapter = createOpenCodeHarnessAdapter({
        projectRoot: root,
        envAllowlist: ['PATH', 'HOME', 'OPENAI_API_KEY'],
        model: 'openai/gpt-4.1-mini',
        sourceEnv: { PATH: process.env.PATH!, HOME: operatorHome, OPENAI_API_KEY: 'unused' },
        spawn: (spec) => {
          adapterRules = probe(spec.env);
          // Control: the same env with the operator's HOME shows the probe sees the allow rules.
          operatorRules = probe({ ...spec.env, HOME: operatorHome });
          throw new Error('probe done');
        },
      });
      await expect(
        adapter.invoke({ prompt: 'unused', inputs: [], tools: [], timeoutMs: TIMEOUT_MS, gate: () => ({ decision: 'allow' }) }),
      ).rejects.toThrow('probe done');
      expect(lastMatch(operatorRules!, 'bash')).toBe('allow');
      expect(lastMatch(operatorRules!, 'edit')).toBe('allow');
      expect(lastMatch(adapterRules!, 'bash')).toBe('ask');
      expect(lastMatch(adapterRules!, 'edit')).toBe('ask');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(operatorHome, { recursive: true, force: true });
    }
  });
});
