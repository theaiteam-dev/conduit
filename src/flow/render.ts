/**
 * Prompt template renderer (WI-352, WI-379).
 *
 * FR-4a — renders a versioned prompt template by substituting each
 * `{{<artifact>}}` placeholder with the on-disk contents of that artifact,
 * read from the project root. This is the exact string handed to the model
 * adapter as `ModelCall.prompt` (src/worker/adapter.ts).
 *
 * Invariants enforced here (the loader in WI-351 validates statically; this
 * module enforces them at runtime):
 *
 *   - Only DECLARED inputs may appear as placeholders. An undeclared placeholder
 *     is rejected immediately — no substitution, no disk read, no content leak.
 *   - Reads are placeholder-driven, not eager: declared inputs not referenced
 *     in the template are never read, so they need not exist on disk.
 *   - Every occurrence of a placeholder is substituted (not just the first).
 *   - Missing declared+referenced artifact → clear error naming the artifact,
 *     not a raw ENOENT.
 *   - `feedback` is a RESERVED synthetic input (WI-379 / FR-5): when declared
 *     and referenced, it is resolved from the runtime `feedback` argument —
 *     never from disk. Absent → substituted as empty string (first-entry path).
 *     Undeclared `{{feedback}}` still triggers the scope guard.
 *   - CARD-SCOPED inputs (the reserved `seed.json` from WI-468, plus anything a
 *     station lists in `input_scope.owned_dir` — issue #51) are read from the
 *     CHILD's owned directory rather than from `projectRoot`, via the shared
 *     ./resolve-input.ts the binding-stamp hasher also calls, so an input can
 *     never be rendered from one location and hashed from another. Declared,
 *     referenced, and unresolvable → clear error, never a silent fallback to the
 *     project-root file of the same name.
 */

import { readFileSync } from 'node:fs';
import { isCardScoped, resolveInputPath } from './resolve-input';

/**
 * Regex matching `{{<name>}}` placeholders where `<name>` contains no
 * whitespace or brace characters. The `g` flag is required for `matchAll`.
 */
const PLACEHOLDER_RE = /\{\{([^{}\s]+)\}\}/g;

/**
 * Reserved synthetic input name (WI-379 / FR-5).
 *
 * When a template declares and references `{{feedback}}`, its content is
 * supplied by the caller at runtime (the executor on a back-edge re-entry)
 * rather than read from disk. This name is intentionally hard-coded here:
 * it is part of the Conduit flow contract, not something a flow author may
 * redefine.
 */
const FEEDBACK_INPUT = 'feedback';

/**
 * Render a prompt template by substituting `{{<artifact>}}` placeholders with
 * their on-disk contents, read from `projectRoot`.
 *
 * @param template    - The raw prompt template string, possibly containing
 *                      `{{name}}` placeholders.
 * @param inputs      - Declared input artifact names in scope for this station
 *                      (e.g. `['context.json', 'idea.json']`). Only names in
 *                      this list may appear as placeholders.
 * @param projectRoot - Absolute directory from which declared artifacts are
 *                      read: `readFileSync(join(projectRoot, name))`.
 * @param feedback    - Optional runtime-supplied string for the reserved
 *                      `{{feedback}}` placeholder. When provided, every
 *                      `{{feedback}}` occurrence is replaced with this value
 *                      verbatim (no re-substitution of embedded `{{...}}`).
 *                      When absent, `{{feedback}}` renders to empty string
 *                      (FR-5: first-entry path). The caller MUST still declare
 *                      `'feedback'` in `inputs`; omitting it causes the scope
 *                      guard to throw as with any undeclared placeholder.
 * @param imageInputs - Optional list of declared IMAGE-input names for this
 *                      station (the `path` field of each WI-414 image_inputs
 *                      entry, e.g. `['keyframe.png', 'logo.png']`). A template
 *                      placeholder that matches an image-input name is rejected
 *                      with a clear image-specific error — images are ATTACHED to
 *                      the model call (ModelCall.images), never substituted as
 *                      text. Unreferenced image inputs are never read from disk.
 *                      Omitting this parameter (arity-4 callers) is identical to
 *                      passing an empty list — the existing behaviour is unchanged.
 * @param ownedPaths  - Optional card-scoped owned paths (WI-468). When supplied,
 *                      every CARD-SCOPED placeholder is resolved from
 *                      `<firstEntry>/<name>` — the child's own copy — NOT from
 *                      `projectRoot`. Declared and referenced but unresolvable
 *                      (absent/empty ownedPaths, or no such file in the owned
 *                      dir) → clear error, never silent empty.
 * @param ownedDirInputs - Optional list of declared inputs that are card-scoped
 *                      (the station's `input_scope.owned_dir`, issue #51). The
 *                      effective set is this list UNION the reserved `seed.json`,
 *                      so omitting the parameter is identical to the WI-468
 *                      behaviour: seed card-scoped, every other input read from
 *                      `projectRoot`.
 * @returns The fully-rendered prompt string with every placeholder substituted.
 * @throws  If any placeholder names a declared IMAGE input (image-specific error).
 * @throws  If any placeholder names an artifact not in `inputs` (scope guard).
 * @throws  If a declared+referenced artifact file is missing on disk.
 */
export function renderPrompt(
  template: string,
  inputs: string[],
  projectRoot: string,
  feedback?: string,
  imageInputs?: string[],
  ownedPaths?: string[],
  ownedDirInputs?: string[],
): string {
  const declaredInputs = new Set(inputs);
  const declaredImageInputs = new Set(imageInputs ?? []);

  // ── Overlap guard: a name cannot be both a text input and an image input ──
  // When a name appears in both sets, the image-specific error must fire even
  // though the text-input check would short-circuit first (declaredInputs wins
  // in the scope-guard loop). We catch this upfront so it is never silently
  // read as text.
  for (const name of declaredInputs) {
    if (declaredImageInputs.has(name)) {
      throw new Error(
        `Input "${name}" is declared as both a text input and an image input — a name can only appear in one. Remove it from either inputs or image_inputs.`,
      );
    }
  }

  // ── Discover used placeholders ────────────────────────────────────────────
  // Collect unique names referenced in the template. This is the ONLY set we
  // read from disk — declared-but-unreferenced inputs are never touched.
  const referencedNames = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    referencedNames.add(match[1]);
  }

  // ── Verbatim passthrough (no placeholders) ────────────────────────────────
  if (referencedNames.size === 0) {
    return template;
  }

  // ── FR-4a scope guard (check BEFORE any disk reads) ──────────────────────
  // Reject undeclared placeholders first so we never inadvertently read or
  // surface contents of files that were not explicitly declared as inputs.
  //
  // Resolution order for each referenced name (WI-416):
  //   1. name ∈ declaredInputs (text)       → allow; read from disk below.
  //   2. name ∈ declaredImageInputs (image)  → REJECT with image-specific error.
  //      Images are ATTACHED parts (ModelCall.images), never text substitutions.
  //      The check fires before any read so no image bytes reach the prompt.
  //   3. name ∈ neither                     → existing undeclared-input guard.
  for (const name of referencedNames) {
    if (!declaredInputs.has(name)) {
      if (declaredImageInputs.has(name)) {
        throw new Error(
          `Placeholder {{${name}}} references a declared image input — image inputs are attached to the model call, not substituted as text. Remove {{${name}}} from the template or use a text input instead.`,
        );
      }
      throw new Error(
        `Placeholder {{${name}}} references an artifact that is not declared as an input for this station`,
      );
    }
  }

  // ── Read referenced artifacts ─────────────────────────────────────────────
  // Only referenced names reach this point. Wrap any I/O error so callers see
  // a clear message naming the artifact, never a raw ENOENT.
  //
  // The reserved `feedback` input is synthetic: its content comes from the
  // runtime argument, never from disk. This keeps the scope guard semantics
  // intact (declaration is still required) while guaranteeing no readFileSync
  // call is made for this name, even when a file named 'feedback' exists on
  // disk (FR-5: first-entry renders to '' when no runtime value is supplied).
  const artifactContents = new Map<string, string>();
  for (const name of referencedNames) {
    if (name === FEEDBACK_INPUT) {
      artifactContents.set(name, feedback ?? '');
      continue;
    }

    // A card-scoped input (the reserved seed.json, or a name the station listed
    // in input_scope.owned_dir) with NO owned scope to resolve against is
    // FAIL-CLOSED: substituting the project-root file would hand this card the
    // shared artifact its per-card copy was meant to replace — silently, with a
    // plausible-looking prompt. resolveInputPath now throws on exactly this
    // condition too; this guard runs first only to name the template context in
    // the message, matching every other unreadable-artifact error below.
    if (isCardScoped(name, ownedDirInputs) && (!ownedPaths || ownedPaths.length === 0)) {
      throw new Error(
        `Artifact "${name}" is declared and referenced in the template but could not be read: no owned_paths scope was supplied for this card`,
      );
    }

    const artifactPath = resolveInputPath(name, projectRoot, ownedPaths, ownedDirInputs);
    try {
      artifactContents.set(name, readFileSync(artifactPath, 'utf-8'));
    } catch {
      throw new Error(
        `Artifact "${name}" is declared and referenced in the template but could not be read from "${artifactPath}"`,
      );
    }
  }

  // ── Substitute all occurrences ────────────────────────────────────────────
  // String.replace with a global regex visits every match, so repeated
  // placeholders for the same artifact are each resolved independently.
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    // All names here are guaranteed to be in artifactContents (scope guard +
    // read loop above). The non-null assertion is sound.
    return artifactContents.get(name) as string;
  });
}
