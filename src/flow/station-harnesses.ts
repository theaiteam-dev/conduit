/**
 * Which harness adapters a station uses (issue #35).
 *
 * A station can run a harness in two places: as its maker (`kind: harness`,
 * `station.harness`) and as its gate critic (`check.critic.harness`, carried on
 * `gateCheck.criticHarness` whatever the station's own `kind`). The binary
 * probe, `conduit doctor` and `conduit explain` all read this one collector,
 * so none of them can key on `station.kind` alone and miss a critic.
 */
import type { FlowConfig, StationConfig } from '../types/kernel';

export type HarnessRole = 'maker' | 'critic';

export interface StationHarnessUse {
  role: HarnessRole;
  /** Adapter name, resolved against the harness registry. */
  adapter: string;
  /** Declared model; absent when the station declares none. */
  model?: string;
  /** Declared named agent; absent when the station declares none. */
  agent?: string;
  /** Declared tools allowlist; absent when the station declares none. */
  tools?: readonly string[];
  /** True when the maker carries the `unrestricted_tools` waiver. A critic has no waiver. */
  unrestrictedTools: boolean;
}

export interface FlowHarnessUse extends StationHarnessUse {
  stationId: string;
}

/** The station's harness maker (if any), then its harness critic (if any). */
export function stationHarnesses(station: StationConfig): StationHarnessUse[] {
  const uses: StationHarnessUse[] = [];
  if (station.kind === 'harness' && station.harness !== undefined) {
    uses.push({
      role: 'maker',
      adapter: station.harness,
      ...(station.model !== undefined ? { model: station.model } : {}),
      ...(station.agent !== undefined ? { agent: station.agent } : {}),
      ...(station.tools !== undefined ? { tools: station.tools } : {}),
      unrestrictedTools: station.unrestricted_tools === true,
    });
  }
  const gate = station.gateCheck;
  if (gate?.criticHarness !== undefined) {
    uses.push({
      role: 'critic',
      adapter: gate.criticHarness,
      // The loader stores an undeclared critic model as '' (StationGateConfig.criticHarness).
      ...(gate.criticModel !== '' ? { model: gate.criticModel } : {}),
      ...(gate.criticAgent !== undefined ? { agent: gate.criticAgent } : {}),
      ...(gate.criticTools !== undefined ? { tools: gate.criticTools } : {}),
      unrestrictedTools: false,
    });
  }
  return uses;
}

/** Every station's harness uses, in station order. */
export function flowHarnesses(flow: FlowConfig): FlowHarnessUse[] {
  return Object.entries(flow.stations).flatMap(([stationId, station]) =>
    stationHarnesses(station).map((use) => ({ stationId, ...use })),
  );
}
