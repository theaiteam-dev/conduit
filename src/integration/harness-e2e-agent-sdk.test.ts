/**
 * Flag-gated real-binary E2E for the agent-sdk adapter (issue #21).
 *
 * GATED OFF BY DEFAULT, like harness-e2e-claude.test.ts: it runs only when
 * CONDUIT_E2E_AGENT_SDK is set and a `claude` binary is on PATH.
 *
 *   CONDUIT_E2E_AGENT_SDK=1 bun test src/integration/harness-e2e-agent-sdk.test.ts
 *
 * It calls the real API through the Agent SDK with the operator's existing
 * login (isolateConfig links the credentials file into a run-scoped config
 * dir). Two haiku calls with a tiny prompt:
 *
 *   1. an allow-all gate: the result carries real usage and cost;
 *   2. a deny gate (createHarnessToolGate with a bare `Bash`, which allowlists
 *      no executable): the model's Bash write is blocked, the file is never
 *      created, and a deny gate-decision event is emitted, since the SDK
 *      reports a hook denial nowhere else.
 *
 * Cost: about $0.05 per run of the file.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSdkHarnessAdapter } from '../worker/harness-adapter-agent-sdk';
import type { KnownUsage } from '../worker/harness-adapter';
import type { HarnessEvent } from '../worker/harness-events';
import { createHarnessToolGate } from '../worker/harness-gate';

const E2E_ENABLED = !!process.env.CONDUIT_E2E_AGENT_SDK && Bun.which('claude') !== null;
const MODEL = process.env.CONDUIT_E2E_AGENT_SDK_MODEL ?? 'claude-haiku-4-5';
const TIMEOUT_MS = 120_000;

function adapterFor(projectRoot: string) {
  return createAgentSdkHarnessAdapter({
    projectRoot,
    envAllowlist: ['HOME', 'PATH'],
    isolateConfig: true,
    model: MODEL,
  });
}

describe.skipIf(!E2E_ENABLED)('agent-sdk adapter against the real API (CONDUIT_E2E_AGENT_SDK=1)', () => {
  it('returns populated usage and cost for a tiny prompt through an allow-all gate', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-agent-sdk-')));
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
      expect(usage.cost).toBeGreaterThan(0);
      expect(usage.breakdown?.outputTokens).toBeGreaterThan(0);
      expect(usage.model).toContain('haiku');
      expect(events.some((e) => e.type === 'usage')).toBe(true);
      expect(events[0]).toMatchObject({ type: 'lifecycle', phase: 'start' });
      expect(events[events.length - 1]).toMatchObject({ type: 'lifecycle', phase: 'end' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS + 10_000);

  it('blocks a Bash write when the gate denies it, and emits the deny decision', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-agent-sdk-')));
    try {
      const events: HarnessEvent[] = [];
      const out = await adapterFor(root).invoke({
        prompt:
          'Run this exact shell command with the Bash tool: echo denied > denied.txt . ' +
          'If the tool is refused, say so in one sentence and stop.',
        inputs: [],
        tools: ['Bash'],
        timeoutMs: TIMEOUT_MS,
        gate: createHarnessToolGate({ projectRoot: root, tools: ['Bash'], ownedPaths: [] }),
        onEvent: (e) => events.push(e),
      });
      expect(existsSync(join(root, 'denied.txt'))).toBe(false);
      const decisions = events.filter((e) => e.type === 'gate-decision');
      expect(decisions.length).toBeGreaterThan(0);
      expect(decisions.every((d) => d.type === 'gate-decision' && d.decision === 'deny')).toBe(true);
      expect(decisions[0]).toMatchObject({ toolName: 'Bash' });
      expect((out.usage as KnownUsage).tokens).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS + 10_000);
});
