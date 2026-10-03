/**
 * Flag-gated real-binary E2E for the codex-app-server adapter (issue #21).
 *
 * GATED OFF BY DEFAULT, like harness-e2e-agent-sdk.test.ts: it runs only when
 * CONDUIT_E2E_CODEX_APP_SERVER is set and a `codex` binary is on PATH.
 *
 *   CONDUIT_E2E_CODEX_APP_SERVER=1 bun test src/integration/harness-e2e-codex-app-server.test.ts
 *
 * It calls the real API through `codex app-server` with the operator's
 * existing login (the run-scoped CODEX_HOME links `auth.json`). Four short
 * calls:
 *
 *   1. an allow-all gate: the result carries real usage and the billed model;
 *   2. a deny gate: the model's shell write is declined, the file is never
 *      created, and a deny gate-decision event is emitted;
 *   3. a hold gate: the call ends with the hold code and no command runs;
 *   4. a read-only command (cat) still reaches the gate, i.e. `untrusted` does
 *      not exempt Codex's known-safe commands from approval.
 *
 * Codex bills through the operator's login and reports no cost, so the figure
 * to watch is the token count.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAppServerHarnessAdapter } from '../worker/harness-adapter-codex-app-server';
import type { KnownUsage } from '../worker/harness-adapter';
import type { GateToolCall } from '../worker/harness-gate';
import type { HarnessEvent } from '../worker/harness-events';
import { HARNESS_GATE_HOLD_CODE } from '../worker/harness-gate';

const E2E_ENABLED = !!process.env.CONDUIT_E2E_CODEX_APP_SERVER && Bun.which('codex') !== null;
const MODEL = process.env.CONDUIT_E2E_CODEX_APP_SERVER_MODEL ?? 'gpt-5.6-luna';
const TIMEOUT_MS = 120_000;

function isDeniedTxtBash(call: GateToolCall): boolean {
  return call.toolName === 'Bash' && String((call.input as { command?: unknown }).command).includes('denied.txt');
}

function adapterFor(projectRoot: string) {
  return createCodexAppServerHarnessAdapter({ projectRoot, envAllowlist: ['PATH'], model: MODEL });
}

describe.skipIf(!E2E_ENABLED)('codex-app-server adapter against the real API (CONDUIT_E2E_CODEX_APP_SERVER=1)', () => {
  it('returns populated usage and the billed model for a tiny prompt through an allow-all gate', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-codex-app-')));
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

  it('declines a shell write when the gate denies it, and emits the deny decision', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-codex-app-')));
    try {
      const events: HarnessEvent[] = [];
      const seen: GateToolCall[] = [];
      await adapterFor(root).invoke({
        prompt:
          'Run this exact shell command: echo denied > denied.txt . ' +
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
      const deniedCall = seen.find(isDeniedTxtBash);
      expect(deniedCall).toBeDefined();
      expect(existsSync(join(root, 'denied.txt'))).toBe(false);
      // The deny decision must be journaled for the denied.txt call itself, not just for some call.
      expect(deniedCall!.toolCallId).toBeDefined();
      expect(
        events.some((e) => e.type === 'gate-decision' && e.toolCallId === deniedCall!.toolCallId && e.decision === 'deny'),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS + 10_000);

  it('ends the call with the hold code when the gate holds, and runs no command', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-codex-app-')));
    try {
      const events: HarnessEvent[] = [];
      const seen: GateToolCall[] = [];
      let error: (Error & { code?: string }) | undefined;
      try {
        await adapterFor(root).invoke({
          prompt: 'Run this exact shell command: echo denied > denied.txt . Then say done.',
          inputs: [],
          tools: ['Bash'],
          timeoutMs: TIMEOUT_MS,
          gate: (call) => {
            seen.push(call);
            return { decision: 'hold', code: 'needs_human', reason: 'ask a human' };
          },
          onEvent: (e) => events.push(e),
        });
      } catch (err) {
        error = err as Error & { code?: string };
      }
      expect(error?.code).toBe(HARNESS_GATE_HOLD_CODE);
      expect(existsSync(join(root, 'denied.txt'))).toBe(false);
      expect(events.some((e) => e.type === 'gate-decision' && e.decision === 'hold')).toBe(true);
      // The hold ends the call, so the held call is the last one the gate saw and must be the Bash write.
      expect(isDeniedTxtBash(seen[seen.length - 1]!)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS + 10_000);

  it('shows the gate a plain read-only command (does `untrusted` ask before ls and cat?)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-codex-app-')));
    try {
      writeFileSync(join(root, 'note.txt'), 'marker-4711\n');
      const seen: GateToolCall[] = [];
      await adapterFor(root).invoke({
        prompt: 'Run this exact shell command: cat note.txt . Then reply with its contents.',
        inputs: [],
        tools: ['Bash(cat:*)'],
        timeoutMs: TIMEOUT_MS,
        gate: (call) => {
          seen.push(call);
          return { decision: 'allow' };
        },
      });
      const commands = seen.filter((c) => c.toolName === 'Bash').map((c) => String((c.input as { command?: unknown }).command));
      expect(commands.some((c) => c.includes('cat') && c.includes('note.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS + 10_000);
});
