/**
 * Tests for the MARK_DONE integrity Summary Hook (WI-297, SPEC §5 step 4, FR-7).
 *
 * This is the INTEGRITY half of the quality system — a PURE, no-LLM check that
 * runs in the DONE transaction BEFORE commit+checkpoint. It verifies:
 *   - every touched file resolves (symlinks + relative paths → canonical absolute)
 *     INSIDE the card's owned_paths (escapes, including via symlink, are rejected),
 *   - the output schema validates,
 *   - every declared artifact actually exists.
 *
 * A failure must BLOCK the checkpoint and signal INTEGRITY_FAIL (the FSM, WI-293,
 * then attributes it to the EXECUTION-ATTEMPT counter, not the rework counter —
 * that counter behavior is tested in WI-293, not re-tested here).
 *
 * Contract this file pins for src/worker/integrity.ts:
 *
 *   interface IntegrityInput {
 *     projectRoot: string;
 *     ownedPaths: readonly string[];        // relative to projectRoot (or absolute)
 *     touchedPaths: readonly string[];      // files the station wrote/touched
 *     declaredArtifacts: readonly string[]; // outputs that MUST exist
 *     output: unknown;
 *     validateOutput: (output: unknown) => boolean;   // injected; NO LLM
 *   }
 *   type IntegrityFailure =
 *     | { code: 'path_escape'; path: string }
 *     | { code: 'missing_artifact'; path: string }
 *     | { code: 'schema_invalid' }
 *   type IntegrityResult = { ok: true } | { ok: false; failures: IntegrityFailure[] }
 *   function checkIntegrity(input: IntegrityInput): IntegrityResult         // pure, sync
 *
 *   interface MarkDoneOutcome {
 *     event: 'INTEGRITY_PASS' | 'INTEGRITY_FAIL';
 *     checkpointed: boolean;    // true ONLY when integrity passes (fail blocks checkpoint)
 *     integrity: IntegrityResult;
 *   }
 *   function runMarkDoneHook(input: IntegrityInput): MarkDoneOutcome
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIntegrity, runMarkDoneHook, type IntegrityInput } from './integrity';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conduit-integrity-'));
  mkdirSync(join(root, 'owned'));
  mkdirSync(join(root, 'outside'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mkInput(overrides: Partial<IntegrityInput> = {}): IntegrityInput {
  return {
    projectRoot: root,
    ownedPaths: ['owned'],
    touchedPaths: [],
    declaredArtifacts: [],
    output: { ok: true },
    validateOutput: () => true,
    ...overrides,
  };
}

function findFailureCodes(result: ReturnType<typeof checkIntegrity>): string[] {
  if (result.ok) return [];
  return result.failures.map((f) => f.code);
}

// ---------------------------------------------------------------------------
// AC3 — passes when touched ⊆ owned (symlinks resolved) AND schema valid.
// ---------------------------------------------------------------------------

describe('checkIntegrity — pass (AC3)', () => {
  it('passes when a touched file is inside owned_paths and schema validates', () => {
    writeFileSync(join(root, 'owned', 'result.txt'), 'data');
    const result = checkIntegrity(
      mkInput({ touchedPaths: ['owned/result.txt'], declaredArtifacts: ['owned/result.txt'] }),
    );
    expect(result.ok).toBe(true);
  });

  it('passes when a touched path is a symlink that resolves INSIDE owned_paths', () => {
    writeFileSync(join(root, 'owned', 'real.txt'), 'data');
    symlinkSync(join(root, 'owned', 'real.txt'), join(root, 'owned', 'link'));
    const result = checkIntegrity(mkInput({ touchedPaths: ['owned/link'] }));
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC4 — fails when a touched path resolves OUTSIDE owned_paths (incl. symlink).
// ---------------------------------------------------------------------------

describe('checkIntegrity — path escape (AC4)', () => {
  it('fails when a touched symlink escapes owned_paths', () => {
    writeFileSync(join(root, 'outside', 'secret.txt'), 'stolen');
    // A symlink that lives inside owned/ but points OUT to outside/secret.txt.
    symlinkSync(join(root, 'outside', 'secret.txt'), join(root, 'owned', 'escape'));

    const result = checkIntegrity(mkInput({ touchedPaths: ['owned/escape'] }));

    expect(result.ok).toBe(false);
    expect(findFailureCodes(result)).toContain('path_escape');
    if (!result.ok) {
      const escape = result.failures.find((f) => f.code === 'path_escape');
      expect(escape && 'path' in escape ? escape.path : '').toContain('escape');
    }
  });

  it('fails when a relative ../ traversal escapes owned_paths', () => {
    writeFileSync(join(root, 'outside', 'secret.txt'), 'stolen');
    const result = checkIntegrity(mkInput({ touchedPaths: ['owned/../outside/secret.txt'] }));

    expect(result.ok).toBe(false);
    expect(findFailureCodes(result)).toContain('path_escape');
  });

  it('fails (fail-closed) when a touched path does not exist on disk', () => {
    // realpathSync throws ENOENT → resolution returns null → path_escape, never a pass.
    const result = checkIntegrity(mkInput({ touchedPaths: ['owned/ghost.txt'] }));
    expect(result.ok).toBe(false);
    expect(findFailureCodes(result)).toContain('path_escape');
  });

  it('reports BOTH path_escape and missing_artifact for a non-existent path in both lists', () => {
    const result = checkIntegrity(
      mkInput({ touchedPaths: ['owned/ghost.txt'], declaredArtifacts: ['owned/ghost.txt'] }),
    );
    expect(result.ok).toBe(false);
    const codes = findFailureCodes(result);
    expect(codes).toContain('path_escape'); // never created → unresolvable touched path
    expect(codes).toContain('missing_artifact'); // declared output absent
  });

  it('fails when a sibling dir merely shares a name PREFIX with an owned dir', () => {
    // 'ownedextra' starts with 'owned' but is NOT inside it — the containment check
    // must require a path-separator boundary, not a bare string prefix.
    mkdirSync(join(root, 'ownedextra'));
    writeFileSync(join(root, 'ownedextra', 'file.txt'), 'data');
    const result = checkIntegrity(mkInput({ touchedPaths: ['ownedextra/file.txt'] }));
    expect(result.ok).toBe(false);
    expect(findFailureCodes(result)).toContain('path_escape');
  });

  it('fails on a deep (4-hop) symlink chain that ultimately escapes owned_paths', () => {
    writeFileSync(join(root, 'outside', 'secret.txt'), 'stolen');
    // link1 → link2 → link3 → link4 → outside/secret.txt
    symlinkSync(join(root, 'outside', 'secret.txt'), join(root, 'owned', 'link4'));
    symlinkSync(join(root, 'owned', 'link4'), join(root, 'owned', 'link3'));
    symlinkSync(join(root, 'owned', 'link3'), join(root, 'owned', 'link2'));
    symlinkSync(join(root, 'owned', 'link2'), join(root, 'owned', 'link1'));

    const result = checkIntegrity(mkInput({ touchedPaths: ['owned/link1'] }));
    expect(result.ok).toBe(false);
    expect(findFailureCodes(result)).toContain('path_escape');
  });

  it('fails closed on a circular symlink (no infinite loop)', () => {
    // a → b → a  (realpathSync throws ELOOP → unresolvable → path_escape)
    symlinkSync(join(root, 'owned', 'b'), join(root, 'owned', 'a'));
    symlinkSync(join(root, 'owned', 'a'), join(root, 'owned', 'b'));

    const result = checkIntegrity(mkInput({ touchedPaths: ['owned/a'] }));
    expect(result.ok).toBe(false);
    expect(findFailureCodes(result)).toContain('path_escape');
  });
});

// ---------------------------------------------------------------------------
// Should #18 — owned-path resolution must be symmetric with touched-path
// resolution. An owned leaf that does not yet exist must still resolve symlinks
// in its EXISTING ancestors (longest-existing-prefix), so the comparison is on
// the same canonical footing as the (resolved) touched path.
// ---------------------------------------------------------------------------

describe('checkIntegrity — owned-path ancestor symlink resolution (Should #18)', () => {
  it('ALLOWS a not-yet-created leaf written under an owned dir whose PARENT is a symlink INTO the project', () => {
    // The card owns the directory 'owned-link', a symlink that resolves to the real
    // in-project dir <root>/real-owned. The owned path declares a leaf — 'owned-link/new.txt'
    // — that has NOT yet been created at integrity-check setup time. We exercise the
    // longest-existing-prefix walk by ALSO declaring ownership of a genuinely-absent
    // nested path 'owned-link/pending/leaf.txt' (neither 'pending' nor 'leaf.txt' exist):
    // its full path cannot be canonicalised, so resolution must walk up to the existing
    // ancestor 'owned-link', resolve it (→ real-owned), and re-append the lexical tail,
    // yielding '<root>/real-owned/pending/leaf.txt'.
    //
    // The station writes its real output through the symlink to owned-link/new.txt
    // (canonically <root>/real-owned/new.txt). With owned resolved on the SAME canonical
    // footing as the (resolved) touched path, containment holds → ALLOWED. The pre-fix
    // code fell back to the unresolved lexical owned path for the absent entry, putting
    // owned and touched in different string namespaces — the asymmetry this fixes.
    mkdirSync(join(root, 'real-owned'));
    symlinkSync(join(root, 'real-owned'), join(root, 'owned-link'));
    writeFileSync(join(root, 'real-owned', 'new.txt'), 'data');

    const result = checkIntegrity(
      mkInput({
        // 'owned-link/pending/leaf.txt' is fully absent on disk → forces the
        // longest-existing-prefix walk (owned-link → real-owned) for the owned entry.
        ownedPaths: ['owned-link/pending/leaf.txt', 'owned-link'],
        touchedPaths: ['owned-link/new.txt'], // resolves to <root>/real-owned/new.txt
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('ALLOWS a brand-new leaf whose only existing ancestor is a symlinked owned dir (prefix walk)', () => {
    // Pinpoint the prefix-walk directly: own a symlinked dir; the touched file is a
    // not-yet-nested path 'link/fresh/out.txt' created NOW under the canonical dir.
    // owned 'link/fresh' has no on-disk leaf 'fresh' at the lexical owned name except
    // through the symlink; resolution must canonicalise link → real before comparing.
    mkdirSync(join(root, 'real-target'));
    symlinkSync(join(root, 'real-target'), join(root, 'link'));
    mkdirSync(join(root, 'real-target', 'fresh'));
    writeFileSync(join(root, 'real-target', 'fresh', 'out.txt'), 'data');

    const result = checkIntegrity(
      mkInput({
        ownedPaths: ['link/fresh'],
        touchedPaths: ['real-target/fresh/out.txt'],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('DENIES a touched leaf that escapes via an owned dir whose PARENT symlink points OUTSIDE the project', () => {
    // A symlink 'escape-dir' inside the project resolves OUT to <root>/outside. The
    // station writes through it, so the touched path canonicalises to
    // <root>/outside/leaf.txt. The card legitimately owns only <root>/owned. With both
    // owned and touched resolved canonically, there is no containment → path_escape.
    // (This is the inverse of the allow case: an attacker-controlled parent symlink
    // pointing outside must NOT be laundered into a spurious allow.)
    symlinkSync(join(root, 'outside'), join(root, 'escape-dir'));
    writeFileSync(join(root, 'outside', 'leaf.txt'), 'data');

    const result = checkIntegrity(
      mkInput({
        ownedPaths: ['owned'],
        touchedPaths: ['escape-dir/leaf.txt'],
      }),
    );

    expect(result.ok).toBe(false);
    expect(findFailureCodes(result)).toContain('path_escape');
  });

  it('DENIES when the OWNED path itself is declared through a parent symlink that escapes the project', () => {
    // The owned path is declared via 'escape-dir/zone' where escape-dir → <root>/outside.
    // Its leaf 'zone' is absent, forcing the prefix walk; the walk must resolve
    // escape-dir → outside, so the canonical owned dir is <root>/outside/zone (OUTSIDE
    // the legitimate project area). A touched file written under <root>/owned (a genuine
    // in-project owned dir is NOT declared here) must therefore be denied — the escaping
    // owned declaration cannot vouch for an unrelated in-project write.
    symlinkSync(join(root, 'outside'), join(root, 'escape-dir'));
    writeFileSync(join(root, 'owned', 'real.txt'), 'data'); // in-project, but NOT owned here

    const result = checkIntegrity(
      mkInput({
        ownedPaths: ['escape-dir/zone'], // canonicalises to <root>/outside/zone via prefix walk
        touchedPaths: ['owned/real.txt'], // <root>/owned/real.txt — not inside <root>/outside/zone
      }),
    );

    expect(result.ok).toBe(false);
    expect(findFailureCodes(result)).toContain('path_escape');
  });
});

// ---------------------------------------------------------------------------
// Multiple simultaneous failures are all reported (not short-circuited).
// ---------------------------------------------------------------------------

describe('checkIntegrity — multiple failures', () => {
  it('reports path_escape, missing_artifact, and schema_invalid together', () => {
    writeFileSync(join(root, 'outside', 'secret.txt'), 'stolen');
    symlinkSync(join(root, 'outside', 'secret.txt'), join(root, 'owned', 'escape'));

    const result = checkIntegrity(
      mkInput({
        touchedPaths: ['owned/escape'], // → path_escape
        declaredArtifacts: ['owned/missing.txt'], // → missing_artifact
        validateOutput: () => false, // → schema_invalid
      }),
    );

    expect(result.ok).toBe(false);
    const codes = findFailureCodes(result);
    expect(codes).toContain('path_escape');
    expect(codes).toContain('missing_artifact');
    expect(codes).toContain('schema_invalid');
  });
});

// ---------------------------------------------------------------------------
// AC5 — fails when a declared artifact is missing (blocks the checkpoint).
// ---------------------------------------------------------------------------

describe('checkIntegrity — missing artifact (AC5)', () => {
  it('fails when a declared artifact does not exist', () => {
    // owned/ exists but the declared artifact was never written.
    const result = checkIntegrity(mkInput({ declaredArtifacts: ['owned/missing.txt'] }));

    expect(result.ok).toBe(false);
    expect(findFailureCodes(result)).toContain('missing_artifact');
    if (!result.ok) {
      const miss = result.failures.find((f) => f.code === 'missing_artifact');
      expect(miss && 'path' in miss ? miss.path : '').toContain('missing.txt');
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 (schema half) — fails when the output schema does not validate.
// ---------------------------------------------------------------------------

describe('checkIntegrity — schema (AC3)', () => {
  it('fails when validateOutput returns false', () => {
    writeFileSync(join(root, 'owned', 'result.txt'), 'data');
    const result = checkIntegrity(
      mkInput({ touchedPaths: ['owned/result.txt'], validateOutput: () => false }),
    );
    expect(result.ok).toBe(false);
    expect(findFailureCodes(result)).toContain('schema_invalid');
  });
});

// ---------------------------------------------------------------------------
// AC6 — checkIntegrity is a pure, deterministic, no-LLM function.
// ---------------------------------------------------------------------------

describe('checkIntegrity — purity (AC6)', () => {
  it('is deterministic and does not mutate its input', () => {
    writeFileSync(join(root, 'owned', 'result.txt'), 'data');
    const input = mkInput({ touchedPaths: ['owned/result.txt'] });
    const before = JSON.stringify({
      ownedPaths: input.ownedPaths,
      touchedPaths: input.touchedPaths,
      declaredArtifacts: input.declaredArtifacts,
    });

    const first = checkIntegrity(input);
    const second = checkIntegrity(input);

    expect(first).toEqual(second); // deterministic
    // input arrays untouched (no mutation, no side effects on the input).
    expect(
      JSON.stringify({
        ownedPaths: input.ownedPaths,
        touchedPaths: input.touchedPaths,
        declaredArtifacts: input.declaredArtifacts,
      }),
    ).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// runMarkDoneHook — pass → checkpoint; fail → BLOCK checkpoint + INTEGRITY_FAIL.
// ---------------------------------------------------------------------------

describe('checkIntegrity — deleted paths (a delete is a write, SPEC §7)', () => {
  it('passes a deleted path inside owned_paths', () => {
    expect(checkIntegrity(mkInput({ deletedPaths: ['owned/gone.txt'] })).ok).toBe(true);
  });

  it('passes a deleted path whose parent directory was deleted too', () => {
    expect(checkIntegrity(mkInput({ deletedPaths: [join(root, 'owned', 'sub', 'gone.txt')] })).ok).toBe(true);
  });

  it('flags a deleted path outside owned_paths', () => {
    const result = checkIntegrity(mkInput({ deletedPaths: ['outside/gone.txt'] }));
    expect(result).toEqual({ ok: false, failures: [{ code: 'path_escape', path: 'outside/gone.txt' }] });
  });

  it('flags a deleted path outside the project root', () => {
    expect(checkIntegrity(mkInput({ deletedPaths: ['/etc/gone'] })).ok).toBe(false);
  });

  it('flags a deleted path whose directory was replaced by a symlink into owned_paths', () => {
    // The call deleted outside/gone.txt, then swapped outside/ for a symlink to
    // owned/. Resolving the deleted path now would place it inside owned/.
    rmSync(join(root, 'outside'), { recursive: true });
    symlinkSync(join(root, 'owned'), join(root, 'outside'));
    expect(checkIntegrity(mkInput({ deletedPaths: ['outside/gone.txt'] })).ok).toBe(false);
  });

  it('flags a sibling delete when the owned dir was replaced by a symlink to the sibling', () => {
    rmSync(join(root, 'owned'), { recursive: true });
    symlinkSync(join(root, 'outside'), join(root, 'owned'));
    expect(checkIntegrity(mkInput({ deletedPaths: ['outside/gone.txt'] })).ok).toBe(false);
  });
});

describe('runMarkDoneHook — checkpoint gating (AC4/AC5)', () => {
  it('on a clean station emits INTEGRITY_PASS and allows the checkpoint', () => {
    writeFileSync(join(root, 'owned', 'result.txt'), 'data');
    const outcome = runMarkDoneHook(
      mkInput({ touchedPaths: ['owned/result.txt'], declaredArtifacts: ['owned/result.txt'] }),
    );
    expect(outcome.event).toBe('INTEGRITY_PASS');
    expect(outcome.checkpointed).toBe(true);
    expect(outcome.integrity.ok).toBe(true);
  });

  it('on a path escape emits INTEGRITY_FAIL and BLOCKS the checkpoint', () => {
    writeFileSync(join(root, 'outside', 'secret.txt'), 'stolen');
    symlinkSync(join(root, 'outside', 'secret.txt'), join(root, 'owned', 'escape'));

    const outcome = runMarkDoneHook(mkInput({ touchedPaths: ['owned/escape'] }));

    // INTEGRITY_FAIL is the event the FSM (WI-293) maps to the EXECUTION-ATTEMPT
    // counter (not rework). The checkpoint must NOT be taken.
    expect(outcome.event).toBe('INTEGRITY_FAIL');
    expect(outcome.checkpointed).toBe(false);
    expect(outcome.integrity.ok).toBe(false);
  });

  it('on a missing declared artifact emits INTEGRITY_FAIL and BLOCKS the checkpoint', () => {
    const outcome = runMarkDoneHook(mkInput({ declaredArtifacts: ['owned/missing.txt'] }));
    expect(outcome.event).toBe('INTEGRITY_FAIL');
    expect(outcome.checkpointed).toBe(false);
  });
});
