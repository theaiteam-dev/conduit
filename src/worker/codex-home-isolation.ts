/**
 * Run-scoped CODEX_HOME for the codex-app-server child (issue #21).
 *
 * `codex app-server` reads its configuration, skills, plugins, MCP servers and
 * credentials from CODEX_HOME (default `$HOME/.codex`). None of that is in
 * flow.yaml or the binding stamp, and a `config.toml` there could enable an
 * ungated tool or change the approval policy. The adapter therefore points the
 * child at a directory it builds per invocation: an empty `config.toml` and,
 * when the operator is logged in, a symlink to the operator's `auth.json`.
 *
 * The credentials file is LINKED, never copied, and never read here. Codex
 * rotates a ChatGPT login's refresh token, and a copy would take the rotated
 * token with it when the directory is deleted, leaving the operator's own file
 * holding a token the provider no longer accepts. Whether codex rewrites
 * `auth.json` in place (which updates the target through the link) or replaces
 * it (which does not) has not been observed here, because no refresh happened
 * in any run.
 */

import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const HOME_PREFIX = 'conduit-codex-home-';

const AUTH_FILE = 'auth.json';

/**
 * Variables that authenticate the CLI without an `auth.json`. Any one of them
 * allowlisted and set in the kernel env means the constructed dir needs no
 * credentials link when the operator has no login file.
 */
export const CODEX_AUTH_ENV_VARS: readonly string[] = ['OPENAI_API_KEY', 'CODEX_API_KEY'];

/** The operator's own codex home as the kernel sees it: CODEX_HOME, else $HOME/.codex. */
export function operatorCodexHome(sourceEnv: Record<string, string | undefined>): string | undefined {
  const explicit = sourceEnv.CODEX_HOME;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const home = sourceEnv.HOME;
  return home !== undefined && home.length > 0 ? join(home, '.codex') : undefined;
}

/**
 * Create a fresh codex home for one invocation: an empty `config.toml` and a
 * link to the operator's `auth.json` when there is one.
 *
 * Throws before anything is spawned when the child would have no way to
 * authenticate: no login file and no allowlisted auth variable.
 */
export function createRunScopedCodexHome(
  sourceEnv: Record<string, string | undefined>,
  envAllowlist: readonly string[],
): string {
  const operatorHome = operatorCodexHome(sourceEnv);
  const auth = operatorHome !== undefined ? join(operatorHome, AUTH_FILE) : undefined;
  const linkAuth = auth !== undefined && existsSync(auth);
  const authVar = CODEX_AUTH_ENV_VARS.find(
    (name) => envAllowlist.includes(name) && (sourceEnv[name] ?? '').trim().length > 0,
  );

  if (!linkAuth && authVar === undefined) {
    throw new Error(
      `codex-app-server: no credentials for the child: no ${AUTH_FILE} at ` +
        `${auth ?? '(neither CODEX_HOME nor HOME is set)'} and none of ` +
        `${CODEX_AUTH_ENV_VARS.join(', ')} is allowlisted and set`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), HOME_PREFIX));
  try {
    writeFileSync(join(dir, 'config.toml'), '');
    if (linkAuth) symlinkSync(auth!, join(dir, AUTH_FILE));
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}

/**
 * Delete a dir made by createRunScopedCodexHome. Removes the link, never its target.
 * Throws, deleting nothing, for a path that is not a run-scoped home directly under the temp dir.
 */
export function removeRunScopedCodexHome(dir: string): void {
  if (!basename(dir).startsWith(HOME_PREFIX) || dirname(resolve(dir)) !== resolve(tmpdir())) {
    throw new Error(`refusing to remove '${dir}': not a run-scoped codex home`);
  }
  rmSync(dir, { recursive: true, force: true });
}
