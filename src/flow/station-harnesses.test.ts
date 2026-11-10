/**
 * stationHarnesses / flowHarnesses (issue #35): the one collector that the
 * binary probe, `conduit doctor` and `conduit explain` read to learn which
 * harness adapters a station uses. A gate critic's adapter lives on
 * `gateCheck.criticHarness`, independent of the station's own `kind`, so the
 * collector must return it for a `kind: transform` station too.
 */
import { describe, it, expect } from 'bun:test';
import { flowHarnesses, stationHarnesses } from './station-harnesses';
import type { FlowConfig, StationConfig, StationGateConfig } from '../types/kernel';

const GATE: StationGateConfig = {
  criticModel: '',
  criticPromptFile: '/tmp/verify.md',
  criticPromptVersion: '1',
  onReject: 'draft',
  reworkCap: 2,
  criticInputScope: [],
};

function transformStation(overrides: Partial<StationConfig> = {}): StationConfig {
  return { kind: 'transform', effectful: false, wip: 1, inputs: [], outputs: [], model: 'm', ...overrides };
}

function harnessStation(overrides: Partial<StationConfig> = {}): StationConfig {
  return {
    kind: 'harness',
    effectful: false,
    wip: 1,
    inputs: [],
    outputs: [],
    harness: 'claude-headless',
    tools: ['Read'],
    ...overrides,
  };
}

describe('stationHarnesses (issue #35)', () => {
  it('returns nothing for a station with no harness maker and no harness critic', () => {
    expect(stationHarnesses(transformStation())).toEqual([]);
    expect(stationHarnesses(transformStation({ gateCheck: GATE }))).toEqual([]);
  });

  it('returns the critic of a kind: transform station with check.critic.harness', () => {
    const station = transformStation({
      gateCheck: { ...GATE, criticHarness: 'codex-exec', criticTools: ['Read'], criticModel: 'gpt-5', criticAgent: 'reviewer' },
    });

    expect(stationHarnesses(station)).toEqual([
      { role: 'critic', adapter: 'codex-exec', model: 'gpt-5', agent: 'reviewer', tools: ['Read'], unrestrictedTools: false },
    ]);
  });

  it('reads the loader\'s empty critic model as absent', () => {
    const station = transformStation({ gateCheck: { ...GATE, criticHarness: 'codex-exec', criticTools: ['Read'] } });

    const [critic] = stationHarnesses(station);

    expect(critic).toBeDefined();
    expect('model' in critic!).toBe(false);
    expect('agent' in critic!).toBe(false);
  });

  it('returns the maker and then the critic when a harness station has a harness critic on another adapter', () => {
    const station = harnessStation({
      model: 'sonnet',
      agent: 'team:coder',
      unrestricted_tools: true,
      gateCheck: { ...GATE, criticHarness: 'codex-exec', criticTools: ['Read', 'Bash(ls)'] },
    });

    expect(stationHarnesses(station)).toEqual([
      {
        role: 'maker',
        adapter: 'claude-headless',
        model: 'sonnet',
        agent: 'team:coder',
        tools: ['Read'],
        unrestrictedTools: true,
      },
      { role: 'critic', adapter: 'codex-exec', tools: ['Read', 'Bash(ls)'], unrestrictedTools: false },
    ]);
  });

  it('ignores a harness field on a station whose kind is not harness', () => {
    // Only kind: harness dispatches through station.harness; a stray field elsewhere runs nothing.
    expect(stationHarnesses(transformStation({ harness: 'claude-headless' }))).toEqual([]);
  });
});

describe('flowHarnesses (issue #35)', () => {
  it('lists every station\'s harnesses, tagged with the station id, in station order', () => {
    const flow = Object.freeze({
      version: 1,
      stations: {
        coder: harnessStation(),
        draft: transformStation({ gateCheck: { ...GATE, criticHarness: 'codex-exec', criticTools: ['Read'] } }),
        build: { kind: 'deterministic', effectful: false, wip: 1, inputs: [], outputs: [] },
      },
    }) as FlowConfig;

    expect(flowHarnesses(flow).map((u) => [u.stationId, u.role, u.adapter])).toEqual([
      ['coder', 'maker', 'claude-headless'],
      ['draft', 'critic', 'codex-exec'],
    ]);
  });
});
