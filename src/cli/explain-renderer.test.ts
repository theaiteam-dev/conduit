/**
 * Tests for the pure flow renderer (WI-443).
 *
 * Contract pinned for src/cli/explain-renderer.ts:
 *
 *   export function renderFlow(flow: FlowConfig): string
 *
 * renderFlow turns a validated, frozen FlowConfig into a plain-ASCII vertical
 * (top-to-bottom) lane-graph string: a flow-name header, one labeled node per
 * station (id, worker kind, role when present, effectful marker, model OR
 * command), forward edges drawn from happyPathNext, and terminal-lane sinks.
 * It renders strictly from the parsed FlowConfig — never from raw YAML (PRD §6
 * FR-9). The back-edge LINE drawing and the adaptive legend are WI-444; this
 * file does not assert on those.
 *
 * The exact glyphs are intentionally NOT specified by the PRD ("the how —
 * exact glyphs — belongs in the design step"). So where an AC names concrete
 * content (the flow name, station ids, kind words, `duckdb`,
 * `gemini-flash-lite-latest`, the terminal lane ids) these tests assert on that
 * content directly; where an AC asserts only that a *marker* exists (effectful,
 * gate-check) or that an *edge* is drawn, they assert glyph-agnostically by
 * comparing two configs that differ in exactly one field.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import type {
  FlowConfig,
  StationConfig,
  StationGateConfig,
  StationRankConfig,
} from '../types/kernel';
import { loadFlow, type LoadFlowResult } from '../flow/load';
import { renderFlow } from './explain-renderer';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const EXAMPLES_DIR = join(import.meta.dir, '..', '..', 'examples');
const TIKTOK = join(EXAMPLES_DIR, 'tiktok-shoppable-ideas', 'flow.yaml');
const BRANCHING = join(EXAMPLES_DIR, 'branching', 'flow.yaml');

/** The three worker-kind words an AC says appear on (only) worker-station nodes. */
const KIND_WORDS = ['deterministic', 'transform', 'agentic'] as const;

/** Load a real example fixture, failing the test (with detail) if it doesn't load. */
function loadOk(path: string): FlowConfig {
  const result: LoadFlowResult = loadFlow(path);
  if (!result.ok) {
    throw new Error(`fixture ${path} failed to load: ${JSON.stringify(result.errors)}`);
  }
  return result.flow;
}

/** True iff some line of `output` contains every token in `tokens`. */
function hasLineWithAll(output: string, tokens: string[]): boolean {
  return output.split('\n').some((line) => tokens.every((t) => line.includes(t)));
}

/** Every line of `output` that contains the whole-word station id `id`. */
function linesMentioning(output: string, id: string): string[] {
  const wordRe = new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return output.split('\n').filter((line) => wordRe.test(line));
}

/** Build a minimal-but-valid StationConfig for renderer input (arrange only). */
function makeStation(overrides: Partial<StationConfig> = {}): StationConfig {
  return { kind: 'transform', effectful: false, wip: 1, inputs: [], outputs: [], ...overrides };
}

/** Build a minimal-but-valid FlowConfig for renderer input (arrange only). */
function makeFlow(overrides: Partial<FlowConfig> = {}): FlowConfig {
  return {
    version: 1,
    name: 'fixture-flow',
    stations: {},
    terminal_lanes: ['done', 'scrap', 'hold'],
    ...overrides,
  };
}

const SAMPLE_GATE: StationGateConfig = {
  criticModel: 'gpt-4o',
  criticPromptFile: '/tmp/verify.md',
  criticPromptVersion: '1',
  onReject: 'w',
  reworkCap: 2,
  criticInputScope: [],
};

// ---------------------------------------------------------------------------
// AC1 — header carries the flow name on the first line.
// ---------------------------------------------------------------------------

describe('renderFlow — header (AC1)', () => {
  it('first line contains the flow name for the tiktok fixture', () => {
    const out = renderFlow(loadOk(TIKTOK));
    expect(out.split('\n')[0]).toContain('tiktok-shoppable-ideas');
  });

  it('first line contains the flow name for the branching fixture', () => {
    const out = renderFlow(loadOk(BRANCHING));
    expect(out.split('\n')[0]).toContain('branching');
  });

  it('falls back to (unnamed) on the first line when name is absent', () => {
    // name is optional on FlowConfig; the header must degrade gracefully rather
    // than print 'undefined' (CHANGELOG documents the '(unnamed)' fallback).
    const { name: _omitted, ...rest } = makeFlow();
    const out = renderFlow(rest as FlowConfig);
    expect(out.split('\n')[0]).toContain('(unnamed)');
    expect(out.split('\n')[0]).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// AC2/AC3/AC4 — station nodes: id + kind + role; model vs command by kind.
// ---------------------------------------------------------------------------

describe('renderFlow — station nodes (AC2, AC3, AC4)', () => {
  it('renders each worker station as one node line carrying id, kind, and role', () => {
    const out = renderFlow(loadOk(TIKTOK));
    // deterministic worker with a role
    expect(hasLineWithAll(out, ['fetch_context', 'deterministic', 'fetcher'])).toBe(true);
    // transform worker with a role
    expect(hasLineWithAll(out, ['ideate', 'transform', 'creative-strategist'])).toBe(true);
  });

  it('shows the deterministic command and the transform model (tiktok AC4)', () => {
    const out = renderFlow(loadOk(TIKTOK));
    // deterministic station shows its command...
    expect(hasLineWithAll(out, ['fetch_context', 'duckdb'])).toBe(true);
    // ...transform station shows its model.
    expect(hasLineWithAll(out, ['ideate', 'gemini-flash-lite-latest'])).toBe(true);
  });

  it('shows command instead of model for deterministic, and model not command for transform (AC3)', () => {
    const out = renderFlow(loadOk(TIKTOK));
    const fetchLines = linesMentioning(out, 'fetch_context');
    const ideateNode = out
      .split('\n')
      .find((l: string) => l.includes('ideate') && l.includes('transform'));
    expect(ideateNode).toBeDefined();
    // The deterministic node must not carry the transform station's model token.
    expect(fetchLines.some((l) => l.includes('gemini-flash-lite-latest'))).toBe(false);
    // The transform node must not carry the deterministic command token.
    expect(ideateNode!.includes('duckdb')).toBe(false);
  });

  it('renders a node for every station id in the flow (branching)', () => {
    const flow = loadOk(BRANCHING);
    const out = renderFlow(flow);
    for (const id of Object.keys(flow.stations)) {
      expect(out).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 — a no-worker (rank) station: id + check marker only, no crash.
// ---------------------------------------------------------------------------

describe('renderFlow — no-worker rank station (AC5)', () => {
  it('renders the branching rank station without a worker-kind glyph or worker model, and does not crash', () => {
    const flow = loadOk(BRANCHING);
    const out = renderFlow(flow); // must not throw
    expect(out.length).toBeGreaterThan(0);

    const rankLines = linesMentioning(out, 'rank');
    expect(rankLines.length).toBeGreaterThan(0);
    // The rank station has no worker — its node must carry NO worker-kind glyph...
    for (const line of rankLines) {
      for (const kind of KIND_WORDS) {
        expect(line.includes(kind)).toBe(false);
      }
    }
    // ...and must not echo the rank critic's model as a worker model.
    expect(out.includes('rank-model')).toBe(false);
  });

  it('marks a station that has a gate check distinctly from a checkless station (gate-check marker exists)', () => {
    const base = makeStation({ kind: 'transform', model: 'm', next: 'done' });
    const withCheck = makeFlow({
      stations: { w: { ...base, gateCheck: SAMPLE_GATE } },
      happyPathNext: { w: 'done' },
    });
    const withoutCheck = makeFlow({
      stations: { w: { ...base } },
      happyPathNext: { w: 'done' },
    });
    // The only difference between the two flows is the presence of a gate check;
    // a renderer that marks gate-checked nodes must produce different output.
    expect(renderFlow(withCheck)).not.toBe(renderFlow(withoutCheck));
  });
});

// ---------------------------------------------------------------------------
// AC6 — effectful stations carry a marker pure stations do not.
// ---------------------------------------------------------------------------

describe('renderFlow — effectful marker (AC6)', () => {
  it('renders an effectful station differently from an otherwise-identical pure station', () => {
    const effectful = makeFlow({
      stations: { pub: makeStation({ model: 'm', effectful: true, next: 'done' }) },
      happyPathNext: { pub: 'done' },
    });
    const pure = makeFlow({
      stations: { pub: makeStation({ model: 'm', effectful: false, next: 'done' }) },
      happyPathNext: { pub: 'done' },
    });
    // Same station in every respect except `effectful` → the effectful marker is
    // the only thing that can differ, so the outputs must not be identical.
    expect(renderFlow(effectful)).not.toBe(renderFlow(pure));
  });
});

// ---------------------------------------------------------------------------
// AC7 — forward edges from happyPathNext; no dangling edge to nowhere.
// ---------------------------------------------------------------------------

describe('renderFlow — forward edges (AC7)', () => {
  it('draws a forward edge for a happyPathNext entry (absent when the station has no successor)', () => {
    const stations = {
      a: makeStation({ model: 'm' }),
      b: makeStation({ model: 'm', next: 'done' }),
    };
    const withEdge = makeFlow({ stations, happyPathNext: { a: 'b', b: 'done' } });
    const withoutEdge = makeFlow({ stations, happyPathNext: { b: 'done' } });
    // Adding the a→b routing entry must change the rendered graph (an edge appears).
    expect(renderFlow(withEdge)).not.toBe(renderFlow(withoutEdge));
  });

  it('does not draw a dangling edge for a station whose next is null or absent', () => {
    const out = renderFlow(
      makeFlow({
        stations: {
          a: makeStation({ model: 'm' }), // no `next`
          b: makeStation({ model: 'm', next: 'done' }),
        },
        happyPathNext: { a: null, b: 'done' },
      }),
    );
    // A dangling edge to a non-lane manifests as an arrow into nothing or a
    // literal null/undefined target — none of which may appear.
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('null');
    expect(out.split('\n').some((l: string) => /->\s*$/.test(l))).toBe(false);
  });

  it('lays the graph out top-to-bottom following routing (tiktok)', () => {
    const out = renderFlow(loadOk(TIKTOK));
    const iFetch = out.indexOf('fetch_context');
    const iIdeate = out.indexOf('ideate');
    const iDone = out.indexOf('done');
    expect(iFetch).toBeGreaterThanOrEqual(0);
    expect(iFetch).toBeLessThan(iIdeate);
    expect(iIdeate).toBeLessThan(iDone);
  });
});

// ---------------------------------------------------------------------------
// AC8 — terminal lanes rendered as sinks with no worker-kind glyph.
// ---------------------------------------------------------------------------

describe('renderFlow — terminal lanes (AC8)', () => {
  it('renders done/scrap/hold as terminal nodes carrying no worker-kind glyph (tiktok)', () => {
    const out = renderFlow(loadOk(TIKTOK));
    for (const terminal of ['done', 'scrap', 'hold']) {
      const lines = linesMentioning(out, terminal);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        for (const kind of KIND_WORDS) {
          expect(line.includes(kind)).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC9 — plain ASCII only (no non-ASCII glyphs, no ANSI color codes).
// ---------------------------------------------------------------------------

describe('renderFlow — plain ASCII output (AC9)', () => {
  it.each([
    ['tiktok', TIKTOK],
    ['branching', BRANCHING],
  ])('emits only printable ASCII with no ANSI escape codes (%s)', (_label, path) => {
    const out = renderFlow(loadOk(path));
    // Printable ASCII plus tab/newline/carriage-return only.
    expect(/^[\x09\x0A\x0D\x20-\x7E]*$/.test(out)).toBe(true);
    // No ANSI Control Sequence Introducer (ESC [ ...).
    expect(out.includes('\x1b[')).toBe(false);
  });
});

// ===========================================================================
// WI-444 — gate back-edges + adaptive legend (extends WI-443).
//
// These extend the same renderFlow contract: the renderer now also draws each
// flow.back_edges entry as a back-edge (visually distinct from forward edges),
// labels it from the source station's gateCheck (criticRole/criticModel) when
// available, and ends with an ADAPTIVE legend that defines only the markers the
// diagram actually uses.
//
// The exact glyphs remain unspecified, so marker/edge claims are tested
// glyph-agnostically (single-field differentials). The legend is self-describing
// per PRD §7, so these tests pin the natural domain terms it must use to define
// each marker: the worker-kind words (deterministic/transform/agentic), the word
// "effectful", and "back-edge" — the exact terms the WI/PRD use throughout.
// ===========================================================================

/** Build a gate config with an explicit critic role/model (for label tests). */
function makeGate(overrides: Partial<StationGateConfig> = {}): StationGateConfig {
  return { ...SAMPLE_GATE, ...overrides };
}

/** Build a rank config (StationRankConfig has NO criticRole — see AC3). */
function makeRank(overrides: Partial<StationRankConfig> = {}): StationRankConfig {
  return {
    criticModel: 'rank-critic-model',
    criticPromptFile: '/tmp/rank.md',
    criticPromptVersion: '1',
    hitlEnabled: false,
    noSelectionPolicy: 'scrap',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1/AC2/AC3 — gate back-edges: drawn, labeled from gateCheck, unlabeled for rank.
// ---------------------------------------------------------------------------

describe('renderFlow — gate back-edges (WI-444 AC1, AC2, AC3)', () => {
  it('draws the tiktok gate back-edge labeled with the gate critic role (AC1, AC2)', () => {
    const out = renderFlow(loadOk(TIKTOK));
    // tiktok's single back_edge (ideate -> ideate) is labeled from the
    // ideate gateCheck whose critic role is 'ad-critic' (a token that appears
    // nowhere else in the flow — not a station id nor a worker role).
    expect(out).toContain('ad-critic');
  });

  it('labels a gate back-edge with the critic role/model from the source gateCheck (AC2)', () => {
    const g = makeStation({ kind: 'transform', model: 'gm', next: 'done' });
    const flow = makeFlow({
      stations: {
        g: { ...g, gateCheck: makeGate({ criticRole: 'REVIEWER-ROLE', criticModel: 'judge-model' }) },
        s: makeStation({ kind: 'transform', model: 'sm', next: 'done' }),
      },
      happyPathNext: { g: 'done', s: 'done' },
      back_edges: [{ from: 'g', to: 's' }],
    });
    const out = renderFlow(flow);
    // The back-edge carries its source gate critic's role label.
    expect(out).toContain('REVIEWER-ROLE');
  });

  it('renders a back-edge with a marker distinct from a forward edge (AC1)', () => {
    const stations = {
      a: makeStation({ kind: 'transform', model: 'm' }),
      b: makeStation({ kind: 'transform', model: 'm', next: 'done' }),
    };
    // Same a→b relationship, drawn as a FORWARD edge in one flow and as a
    // BACK edge in the other. If the two edge kinds rendered identically, the
    // outputs would match — so a difference proves the markers are distinct.
    const forward = makeFlow({ stations, happyPathNext: { a: 'b', b: 'done' } });
    const back = makeFlow({
      stations,
      happyPathNext: { b: 'done' },
      back_edges: [{ from: 'a', to: 'b' }],
    });
    expect(renderFlow(forward)).not.toBe(renderFlow(back));
  });

  it('renders no empty bracket label when the gate critic has neither role nor model', () => {
    // A gate critic may declare only a prompt (criticRole absent, criticModel
    // defaulted to ''). The back-edge must then render unlabeled — an empty
    // '[]' reads as a rendering glitch, not an absent label.
    const flow = makeFlow({
      stations: {
        g: makeStation({
          kind: 'transform',
          model: 'gm',
          next: 'done',
          gateCheck: makeGate({ criticRole: undefined, criticModel: '' }),
        }),
        s: makeStation({ kind: 'transform', model: 'sm', next: 'done' }),
      },
      happyPathNext: { g: 'done', s: 'done' },
      back_edges: [{ from: 'g', to: 's' }],
    });
    const out = renderFlow(flow);
    // The back-edge line for g must not carry an empty bracket pair.
    const backEdgeLine = out.split('\n').find((l) => l.includes('<~'));
    expect(backEdgeLine).toBeDefined();
    expect(backEdgeLine).not.toContain('[]');
    expect(backEdgeLine).not.toContain('[ ]');
  });

  it('renders a rank-station back-edge without a critic label (AC3)', () => {
    // A rank station carries a rankCheck (no criticRole) and NO gateCheck, so
    // its back-edge must render unlabeled — the renderer must not pull a label
    // from rankCheck. The sentinel model lives only on the rankCheck.
    const flow = makeFlow({
      stations: {
        r: makeStation({ rankCheck: makeRank({ criticModel: 'RANK-ONLY-MODEL' }) }),
        x: makeStation({ kind: 'transform', model: 'm', next: 'done' }),
      },
      happyPathNext: { x: 'done' },
      back_edges: [{ from: 'r', to: 'x' }],
    });
    const out = renderFlow(flow);
    // Back-edge is drawn (a back-edge exists → the adaptive legend names it)...
    expect(out.toLowerCase()).toContain('back-edge');
    // ...but it is NOT labeled from the rankCheck critic model.
    expect(out).not.toContain('RANK-ONLY-MODEL');
  });
});

// ---------------------------------------------------------------------------
// AC4/AC5/AC6 — adaptive legend.
// ---------------------------------------------------------------------------

describe('renderFlow — adaptive legend (WI-444 AC4, AC5, AC6)', () => {
  it('omits a worker-kind glyph the flow never uses (no agentic in tiktok) (AC4)', () => {
    // tiktok uses deterministic + transform only; nothing — node or legend —
    // should reference 'agentic'.
    expect(renderFlow(loadOk(TIKTOK))).not.toContain('agentic');
  });

  it('omits the deterministic legend entry when no deterministic station exists (AC4)', () => {
    const flow = makeFlow({
      stations: {
        a: makeStation({ kind: 'transform', model: 'm', next: 'done' }),
        b: makeStation({ kind: 'transform', model: 'm', next: 'done' }),
      },
      happyPathNext: { a: 'done', b: 'done' },
    });
    // No deterministic station → the word must not appear (no node, no legend).
    expect(renderFlow(flow)).not.toContain('deterministic');
  });

  it('defines the pure-vs-effectful marker in the legend (AC4)', () => {
    const flow = makeFlow({
      stations: { pay: makeStation({ kind: 'transform', model: 'm', effectful: true, next: 'done' }) },
      happyPathNext: { pay: 'done' },
    });
    expect(renderFlow(flow)).toContain('effectful');
  });

  it('notes a harness station that declares overlap: true (issue #30)', () => {
    const flow = makeFlow({
      stations: {
        walk: makeStation({ kind: 'harness', harness: 'agent-sdk', overlap: true, next: 'done' }),
        solo: makeStation({ kind: 'harness', harness: 'agent-sdk', next: 'done' }),
      },
      happyPathNext: { walk: 'done', solo: 'done' },
    });
    for (const rendered of [renderFlow(flow), renderFlow(flow, { rich: true })]) {
      const lines = rendered.split('\n');
      expect(lines.find((l) => l.includes('walk') && l.includes('overlap'))).toBeDefined();
      expect(lines.find((l) => l.includes('solo') && l.includes('overlap'))).toBeUndefined();
    }
    expect(renderFlow(flow)).toContain('(overlap) = harness station');
  });

  it('includes the back-edge marker in the legend when a back-edge exists (AC5)', () => {
    expect(renderFlow(loadOk(TIKTOK)).toLowerCase()).toContain('back-edge');
  });

  it('adaptively draws + names the back-edge only when one exists (AC5, AC6)', () => {
    const stations = {
      g: { ...makeStation({ kind: 'transform', model: 'm', next: 'done' }), gateCheck: makeGate({ criticRole: 'CRIT-SENTINEL' }) },
      s: makeStation({ kind: 'transform', model: 'm', next: 'done' }),
    };
    const withBack = makeFlow({
      stations,
      happyPathNext: { g: 'done', s: 'done' },
      back_edges: [{ from: 'g', to: 's' }],
    });
    const noBack = makeFlow({ stations, happyPathNext: { g: 'done', s: 'done' } });
    // Presence of a back-edge changes the diagram (edge + legend entry appear).
    expect(renderFlow(withBack)).not.toBe(renderFlow(noBack));
    // With a back-edge: it is drawn AND labeled from gateCheck.
    expect(renderFlow(withBack)).toContain('CRIT-SENTINEL');
    // Without any back-edge: no back-edge is drawn (no critic label leaks in)...
    expect(renderFlow(noBack)).not.toContain('CRIT-SENTINEL');
  });

  it('omits the back-edge marker for a flow with no back-edges (branching) (AC6)', () => {
    // branching's rank station has no on_reject, so the flow has no back_edges;
    // the adaptive legend must not advertise the back-edge marker.
    expect(renderFlow(loadOk(BRANCHING)).toLowerCase()).not.toContain('back-edge');
  });

  it('defines the (check) marker in the legend only when a gate station exists', () => {
    // The diagram emits a '(check)' node marker for gate stations; the legend
    // must define it so the diagram is self-describing — but adaptively (absent
    // when no gate station is present).
    const withGate = makeFlow({
      stations: {
        g: makeStation({ kind: 'transform', model: 'm', next: 'done', gateCheck: makeGate() }),
      },
      happyPathNext: { g: 'done' },
    });
    const noGate = makeFlow({
      stations: { a: makeStation({ kind: 'transform', model: 'm', next: 'done' }) },
      happyPathNext: { a: 'done' },
    });
    expect(renderFlow(withGate)).toContain('(check)');
    expect(hasLineWithAll(renderFlow(withGate), ['(check)', 'gate'])).toBe(true);
    expect(renderFlow(noGate)).not.toContain('(check)');
  });

  it('defines the (rank) marker in the legend only when a rank station exists', () => {
    // The diagram emits a '(rank)' node marker for rank stations; the legend
    // must define it adaptively (absent when no rank station is present).
    const withRank = makeFlow({
      stations: { r: makeStation({ rankCheck: makeRank() }) },
    });
    const noRank = makeFlow({
      stations: { a: makeStation({ kind: 'transform', model: 'm', next: 'done' }) },
      happyPathNext: { a: 'done' },
    });
    expect(renderFlow(withRank)).toContain('(rank)');
    expect(hasLineWithAll(renderFlow(withRank), ['(rank)', 'rank'])).toBe(true);
    expect(renderFlow(noRank)).not.toContain('(rank)');
  });
});

// ---------------------------------------------------------------------------
// AC7 — the branching (fan-out / fan-in / rank) fixture renders correctly.
// ---------------------------------------------------------------------------

describe('renderFlow — branching fixture (WI-444 AC7)', () => {
  it('renders the fan_out, child_entry, and resume_at stations as distinct nodes', () => {
    const out = renderFlow(loadOk(BRANCHING));
    // fan_out parent (brief), child_entry (draft), resume_at (assemble) each
    // render as their own labeled worker node.
    expect(hasLineWithAll(out, ['brief', 'transform', 'director'])).toBe(true); // fan_out
    expect(hasLineWithAll(out, ['draft', 'transform', 'drafter'])).toBe(true); // child_entry
    expect(hasLineWithAll(out, ['assemble', 'deterministic', 'assembler'])).toBe(true); // resume_at
    // and the remaining stations are present too.
    for (const id of ['publish', 'rank', 'deliver']) {
      expect(out).toContain(id);
    }
  });

  it('draws forward edges from happyPathNext with no dangling edge to nowhere', () => {
    const flow = loadOk(BRANCHING);
    const out = renderFlow(flow);
    // Forward edges are driven by happyPathNext: emptying it changes the output.
    const noEdges = { ...flow, happyPathNext: {} };
    expect(renderFlow(noEdges)).not.toBe(out);
    // No dangling/"to nowhere" edges.
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('null');
    expect(out.split('\n').some((l: string) => /->\s*$/.test(l))).toBe(false);
    // Top-most station (fan-out entry) precedes the terminal delivery station.
    expect(out.indexOf('brief')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('brief')).toBeLessThan(out.indexOf('deliver'));
  });
});

// ---------------------------------------------------------------------------
// WI-446 — flow-ordered rail layout: main spine in flow order, fan-out/fan-in
// annotations, and an isolated child sub-path block.
// ---------------------------------------------------------------------------

describe('renderFlow — flow-ordered rail layout (WI-446)', () => {
  /** Index of the first line whose tokens all appear; -1 if none. */
  function lineIndexWithAll(output: string, tokens: string[]): number {
    return output.split('\n').findIndex((line) => tokens.every((t) => line.includes(t)));
  }

  it('orders the main spine by routing, not declaration order', () => {
    // Declared order is gamma, alpha, beta; routing is alpha -> beta -> gamma.
    // A declaration-order renderer would emit gamma first; a flow-ordered one
    // must emit alpha, then beta, then gamma.
    const flow = makeFlow({
      stations: {
        gamma: makeStation({ kind: 'transform', model: 'm', next: 'done' }),
        alpha: makeStation({ kind: 'transform', model: 'm', next: 'beta' }),
        beta: makeStation({ kind: 'transform', model: 'm', next: 'gamma' }),
      },
      happyPathNext: { alpha: 'beta', beta: 'gamma', gamma: 'done' },
    });
    const out = renderFlow(flow);
    const iAlpha = lineIndexWithAll(out, ['alpha']);
    const iBeta = lineIndexWithAll(out, ['beta']);
    const iGamma = lineIndexWithAll(out, ['gamma']);
    expect(iAlpha).toBeGreaterThanOrEqual(0);
    expect(iAlpha).toBeLessThan(iBeta);
    expect(iBeta).toBeLessThan(iGamma);
  });

  it('annotates the fan-out hand-off with the count and child entry (branching)', () => {
    const out = renderFlow(loadOk(BRANCHING));
    // brief fans out N=3 into child path 'draft' — the rail must say so.
    expect(hasLineWithAll(out, ['fan-out', '3', 'draft'])).toBe(true);
  });

  it('annotates the fan-in station inline (branching quorum k=2)', () => {
    const out = renderFlow(loadOk(BRANCHING));
    // assemble is a quorum fan-in (k=2): its node carries an inline fan-in note.
    expect(hasLineWithAll(out, ['assemble', 'fan-in'])).toBe(true);
    expect(hasLineWithAll(out, ['assemble', 'fan-in', '2'])).toBe(true);
  });

  it('renders the child sub-path in its own block, after the main spine', () => {
    const out = renderFlow(loadOk(BRANCHING));
    // The child stations (draft, publish) must NOT interleave the main spine;
    // they live under a labeled child sub-path block emitted after 'deliver'.
    const iDeliver = out.indexOf('deliver');
    const iChildHeading = out.indexOf('child sub-path');
    // Target the child NODE line (draft + its role) — not the fan-out rail
    // annotation, which also names 'draft' but precedes the child block.
    const iDraftNode = out.indexOf('drafter');
    expect(iChildHeading).toBeGreaterThan(iDeliver);
    expect(iDraftNode).toBeGreaterThan(iChildHeading);
    // The child-block heading advertises the fan-out replication count.
    expect(hasLineWithAll(out, ['child sub-path', '3'])).toBe(true);
  });

  it('summarizes the terminal lanes on a single line', () => {
    const out = renderFlow(loadOk(BRANCHING));
    expect(hasLineWithAll(out, ['terminals:', 'done', 'scrap', 'hold'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WI-446 — rich TUI layout: framed panel, Unicode box-drawing, optional ANSI
// color. The default (no opts) stays pure-ASCII (AC9, covered above).
// ---------------------------------------------------------------------------

describe('renderFlow — rich TUI layout (WI-446)', () => {
  /** Strip ANSI SGR sequences for visible-width / content assertions. */
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('draws the compact boxed overview with child and join blocks', () => {
    const out = renderFlow(loadOk(BRANCHING), { rich: true });
    // Boxed flow overview must be present.
    expect(out).toContain('╭');
    expect(out).toContain('╯');
    expect(out).toContain('│');
    // The fan-out/fan-in structure is visually explicit.
    expect(out).toContain('child lane x3 / spawn x3');
    expect(out).toContain('join survivors');
    expect(out).toContain('assemble [join 2/3]');
  });

  it('anchors the child-lane branch under the fan-out parent', () => {
    const lines = stripAnsi(renderFlow(loadOk(BRANCHING), { rich: true })).split('\n');
    const parentLineIndex = lines.findIndex((line) => line.includes('brief [split x3]'));
    expect(parentLineIndex).toBeGreaterThanOrEqual(0);

    const connectorLine = lines.slice(parentLineIndex + 1).find((line) => line.trim() === '│');
    const childLine = lines.find((line) => line.includes('child lane x3 / spawn x3'));
    expect(connectorLine).toBeDefined();
    expect(childLine).toBeDefined();

    const connectorColumn = connectorLine!.indexOf('│');
    expect(connectorColumn).toBeGreaterThan(0);
    expect(childLine!.indexOf('├')).toBe(connectorColumn);
  });

  it('emits ANSI color codes only when color is enabled', () => {
    const colored = renderFlow(loadOk(BRANCHING), { rich: true, color: true });
    const mono = renderFlow(loadOk(BRANCHING), { rich: true, color: false });
    expect(colored).toContain('\x1b[');
    expect(mono).not.toContain('\x1b[');
    // Color must not change the layout: stripping ANSI yields the mono output.
    expect(stripAnsi(colored)).toBe(mono);
  });

  it('keeps the default (no opts) output pure ASCII with no box-drawing', () => {
    const out = renderFlow(loadOk(BRANCHING));
    expect(/^[\x09\x0A\x0D\x20-\x7E]*$/.test(out)).toBe(true);
    expect(out).not.toContain('╭');
    expect(out).not.toContain('\x1b[');
  });

  it('renders station and terminal labels in the boxed flow plus terminal summary', () => {
    const out = renderFlow(loadOk(BRANCHING), { rich: true });
    expect(stripAnsi(out)).toContain('│ done');
    expect(stripAnsi(out)).toContain('terminals:');
  });

  it('shows gate and rank station kinds distinctly in the station table', () => {
    const flow = makeFlow({
      stations: {
        g: makeStation({ kind: 'transform', model: 'm', next: 'r', gateCheck: makeGate() }),
        r: makeStation({ rankCheck: makeRank(), next: 'done' }),
      },
      happyPathNext: { g: 'r', r: 'done' },
    });
    const out = stripAnsi(renderFlow(flow, { rich: true }));
    expect(out).toContain('transform+gate');
    expect(out).toContain('rank');
  });

  it('keeps non-terminal cross-block successors as station boxes, not terminal-only labels', () => {
    // A main-spine station routing INTO a fan-out child path has a successor that
    // is outside its block but is NOT a terminal lane. It must render as the
    // child station, while genuine terminals still render as terminal labels.
    const flow = makeFlow({
      stations: {
        main1: makeStation({ kind: 'transform', model: 'm', next: 'child1' }),
        parent: makeStation({
          kind: 'transform',
          model: 'm',
          fan_out: 2,
          child_entry: 'child1',
          child_terminal: 'done',
          resume_at: 'done',
          next: 'done',
        }),
        child1: makeStation({ kind: 'transform', model: 'm', next: 'done' }),
      },
      happyPathNext: { main1: 'child1', parent: 'done', child1: 'done' },
    });
    const out = stripAnsi(renderFlow(flow, { rich: true }));
    expect(out).toContain('│ child1 │');
    expect(out).toContain('│ done');
  });

  it('renders backflow as a separate table in rich mode', () => {
    const out = stripAnsi(renderFlow(loadOk(TIKTOK), { rich: true }));
    expect(out).toContain('Backflow');
    expect(out).toContain('ad-critic');
    expect(out).toContain('mission');
  });
});
