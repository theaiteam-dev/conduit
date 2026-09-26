/**
 * Load-time handling of a harness station's `agent:` (issue #28).
 *
 * `worker.agent` on a `kind: harness` station and `check.critic.agent` on a
 * harness critic name a Claude Code agent (`<plugin>:<agent>`) that the adapter
 * passes as `--agent`. Like `model:`, the loader lifts the value onto the
 * frozen config and leaves it ABSENT (no key) when undeclared: the executor
 * resolves `station.agent ?? adapter.agent` at dispatch.
 *
 * Validation is fail-closed:
 *   INVALID_HARNESS_AGENT     a non-string or empty value, an agent on a station
 *                             that is not kind: harness, or a critic agent with
 *                             no critic harness (nothing would receive it);
 *   UNRESOLVED_HARNESS_AGENT  with a registry injected, the named adapter cannot
 *                             run named agents, or cannot find the agent's
 *                             definition file in its configured plugin dirs.
 * The dispatch-time check in the executor repeats the resolution, since plugin
 * dirs are engine config and their files can change after load.
 */
import { describe, it, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { loadFlow, type LoadFlowResult } from './load';
import type { FlowConfig } from '../types/kernel';
import {
  createHarnessRegistry,
  makeFakeHarnessAdapter,
  type HarnessAdapter,
  type HarnessRegistry,
} from '../worker/harness-adapter';

/** A fake adapter that runs named agents and knows exactly `known`. */
function agentCapableAdapter(name: string, known: readonly string[]): HarnessAdapter {
  const { adapter } = makeFakeHarnessAdapter({ name });
  return {
    ...adapter,
    resolveAgentDefinition: (agent: string) =>
      known.includes(agent)
        ? { ok: true as const, path: `/plugins/${agent}.md`, sha256: 'a'.repeat(64) }
        : { ok: false as const, error: `agent '${agent}' not found in plugin dirs /plugins` },
  };
}

function load(yaml: string, registry?: HarnessRegistry): LoadFlowResult {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-harness-agent-'));
  try {
    const files: Record<string, string> = {
      'flow.yaml': yaml,
      'prompts/coder.md': 'Implement the task.',
      'prompts/verify.md': 'Check the result.',
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content, 'utf-8');
    }
    return loadFlow(join(dir, 'flow.yaml'), { harnessRegistry: registry });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectOk(result: LoadFlowResult): FlowConfig {
  if (!result.ok) throw new Error(`expected ok, got errors: ${JSON.stringify(result.errors)}`);
  return result.flow;
}

function errorsOf(result: LoadFlowResult): Array<{ code: string; message: string }> {
  if (result.ok) throw new Error('expected validation errors, but load succeeded');
  return result.errors;
}

function flow(parts: { kind?: string; agentLine?: string; criticAgentLine?: string; criticHarness?: boolean } = {}): string {
  const kind = parts.kind ?? 'harness';
  const workerHarness = kind === 'harness' ? 'harness: claude-headless' : '';
  const tools = kind === 'harness' ? 'tools: [Read, Write]' : '';
  const criticHarness = parts.criticHarness === false ? '' : 'harness: claude-headless';
  const critic =
    parts.criticAgentLine !== undefined
      ? `
    check:
      kind: gate
      critic:
        role: critic
        ${criticHarness}
        model: sonnet
        tools: [Read, Write]
        prompt_file: prompts/verify.md
        prompt_version: "1"
        ${parts.criticAgentLine}
      on_reject: coder
      rework_cap: 1`
      : '';
  return `
flow: harness-agent
flow_version: 1
terminal_lanes: [done, scrap, hold]
stations:
  - id: coder
    worker:
      kind: ${kind}
      model: sonnet
      ${workerHarness}
      ${parts.agentLine ?? ''}
      prompt_file: prompts/coder.md
      prompt_version: "1"
      ${tools}
      output_schema:
        fields:
          - { name: result, type: string, required: true }
    inputs: []
    outputs: [result.json]
    next: done${critic}
`;
}

describe('worker.agent on a harness station (issue #28 AC1)', () => {
  it('lifts worker.agent onto StationConfig.agent', () => {
    const loaded = expectOk(load(flow({ agentLine: 'agent: team:coder' })));
    expect(loaded.stations.coder!.agent).toBe('team:coder');
  });

  it('leaves StationConfig.agent absent (no key) when undeclared', () => {
    const loaded = expectOk(load(flow()));
    expect('agent' in loaded.stations.coder!).toBe(false);
  });

  it.each([['agent: ""'], ['agent: 7'], ['agent: [a, b]']])('rejects a malformed value (%s)', (line) => {
    const errors = errorsOf(load(flow({ agentLine: line })));
    expect(errors.map((e) => e.code)).toContain('INVALID_HARNESS_AGENT');
    expect(errors.map((e) => e.message).join(' ')).toContain('coder');
  });

  it('rejects agent on a station that is not kind: harness, since nothing would pass it on', () => {
    const errors = errorsOf(load(flow({ kind: 'transform', agentLine: 'agent: team:coder' })));
    expect(errors.map((e) => e.code)).toContain('INVALID_HARNESS_AGENT');
  });

  it('with a registry, rejects an agent the adapter cannot find, carrying the adapter\'s reason', () => {
    const registry = createHarnessRegistry([agentCapableAdapter('claude-headless', ['team:other'])]);
    const errors = errorsOf(load(flow({ agentLine: 'agent: team:coder' }), registry));
    const unresolved = errors.filter((e) => e.code === 'UNRESOLVED_HARNESS_AGENT');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.message).toContain('coder');
    expect(unresolved[0]!.message).toContain('not found in plugin dirs');
  });

  it('with a registry, rejects an agent on an adapter that cannot run named agents, naming the adapter', () => {
    const registry = createHarnessRegistry([makeFakeHarnessAdapter({ name: 'claude-headless' }).adapter]);
    const errors = errorsOf(load(flow({ agentLine: 'agent: team:coder' }), registry));
    const unresolved = errors.filter((e) => e.code === 'UNRESOLVED_HARNESS_AGENT');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.message).toContain('claude-headless');
  });

  it('with a registry, accepts an agent the adapter resolves', () => {
    const registry = createHarnessRegistry([agentCapableAdapter('claude-headless', ['team:coder'])]);
    expectOk(load(flow({ agentLine: 'agent: team:coder' }), registry));
  });
});

describe('check.critic.agent on a harness critic (issue #28 AC2)', () => {
  it('lifts check.critic.agent onto gateCheck.criticAgent', () => {
    const loaded = expectOk(load(flow({ criticAgentLine: 'agent: team:reviewer' })));
    expect(loaded.stations.coder!.gateCheck!.criticAgent).toBe('team:reviewer');
  });

  it('leaves gateCheck.criticAgent absent (no key) when undeclared', () => {
    const loaded = expectOk(load(flow({ criticAgentLine: '' })));
    expect('criticAgent' in loaded.stations.coder!.gateCheck!).toBe(false);
  });

  it('rejects a critic agent when the critic declares no harness', () => {
    const errors = errorsOf(load(flow({ criticAgentLine: 'agent: team:reviewer', criticHarness: false })));
    expect(errors.map((e) => e.code)).toContain('INVALID_HARNESS_AGENT');
  });

  it('with a registry, rejects a critic agent the critic adapter cannot find', () => {
    const registry = createHarnessRegistry([agentCapableAdapter('claude-headless', ['team:coder'])]);
    const errors = errorsOf(load(flow({ criticAgentLine: 'agent: team:reviewer' }), registry));
    expect(errors.map((e) => e.code)).toContain('UNRESOLVED_HARNESS_AGENT');
  });
});
