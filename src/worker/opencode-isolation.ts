/**
 * Run-scoped state for the opencode child (issue #21).
 *
 * `opencode serve` reads configuration, plugins, MCP servers, skills, its
 * session database and its credentials from the XDG directories. None of that
 * is in flow.yaml or the binding stamp, and a config file there could turn a
 * permission to `allow` or load a plugin. The adapter therefore points all four
 * XDG roots at a directory it builds per invocation and hands the credentials
 * over in the environment instead of through the operator's `auth.json`.
 *
 * HOME. opencode also loads `~/.opencode/` (config, agents, commands, MCP
 * servers) from `os.homedir()`, whatever the XDG roots say, and falls back to
 * the passwd entry when HOME is unset. An `allow` rule there is merged after
 * the adapter's `"*":"ask"` and wins, so the call never asks the gate. HOME is
 * therefore an empty directory under the same root, never the operator's.
 *
 * Credentials. Only the entry for the provider of the chosen model is passed,
 * as `OPENCODE_AUTH_CONTENT`. The value is never logged, journaled or put in an
 * error message. An OAuth entry is copied, not linked: a token the child
 * refreshes is discarded with the run-scoped directory, and whether opencode
 * refreshes at all was not observed (the one login checked is an API key).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Roots createRunScopedOpenCodeDirs returned and removeRunScopedOpenCodeDirs has not yet removed. */
const createdRoots = new Set<string>();

/** The HOME and XDG variables the child is pointed at, all under one run-scoped directory. */
export interface RunScopedOpenCodeDirs {
  root: string;
  env: {
    HOME: string;
    XDG_CONFIG_HOME: string;
    XDG_DATA_HOME: string;
    XDG_STATE_HOME: string;
    XDG_CACHE_HOME: string;
  };
}

/** Create an empty HOME and the four empty XDG directories under a fresh temp directory. */
export function createRunScopedOpenCodeDirs(): RunScopedOpenCodeDirs {
  const root = mkdtempSync(join(tmpdir(), 'conduit-opencode-'));
  try {
    const dir = (name: string): string => {
      const path = join(root, name);
      mkdirSync(path);
      return path;
    };
    const dirs = {
      root,
      env: {
        HOME: dir('home'),
        XDG_CONFIG_HOME: dir('config'),
        XDG_DATA_HOME: dir('data'),
        XDG_STATE_HOME: dir('state'),
        XDG_CACHE_HOME: dir('cache'),
      },
    };
    createdRoots.add(root);
    return dirs;
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Delete a directory made by createRunScopedOpenCodeDirs.
 * Throws, deleting nothing, for a root this module did not create or has already removed.
 * Throws when the directory survives removal, and keeps the root registered so a retry can succeed.
 */
export function removeRunScopedOpenCodeDirs(dirs: RunScopedOpenCodeDirs): void {
  const root = dirs.root;
  if (!createdRoots.has(root)) {
    throw new Error(`refusing to remove '${root}': not a run-scoped opencode directory`);
  }
  rmSync(root, { recursive: true, force: true });
  if (existsSync(root)) throw new Error(`could not remove run-scoped opencode directory '${root}'`);
  createdRoots.delete(root);
}

/** The operator's `auth.json` as the kernel sees it: $XDG_DATA_HOME, else $HOME/.local/share. */
export function operatorOpenCodeAuthPath(sourceEnv: Record<string, string | undefined>): string | undefined {
  const xdg = sourceEnv.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.length > 0) return join(xdg, 'opencode', 'auth.json');
  const home = sourceEnv.HOME;
  return home !== undefined && home.length > 0 ? join(home, '.local', 'share', 'opencode', 'auth.json') : undefined;
}

/**
 * Variables that authenticate a provider without an `auth.json` entry. Any one
 * allowlisted and set in the kernel env means the child gets the credential
 * through the allowlist. This is a short list of the providers most likely to
 * be used, not opencode's own table, and no provider other than openai was
 * run against a live call here.
 */
export const OPENCODE_PROVIDER_ENV_VARS: Readonly<Record<string, readonly string[]>> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

/** Split `provider/model`. The model id may itself contain slashes (`openrouter/anthropic/claude`). */
export function splitOpenCodeModel(model: string | undefined): { providerID: string; modelID: string } | { error: string } {
  const trimmed = model?.trim();
  if (trimmed === undefined || trimmed === '') {
    return {
      error:
        'no model is configured: set the station model or CONDUIT_HARNESS_OPENCODE_MODEL to ' +
        '`provider/model` (there is no safe default)',
    };
  }
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { error: `model ${JSON.stringify(trimmed.slice(0, 80))} is not in the form provider/model` };
  }
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
}

/**
 * The `OPENCODE_AUTH_CONTENT` value for one provider, or undefined when the
 * provider authenticates through an allowlisted environment variable instead.
 * Returns an error string, without any credential text, when neither exists.
 */
export function buildProviderAuthContent(
  sourceEnv: Record<string, string | undefined>,
  envAllowlist: readonly string[],
  providerID: string,
): { content: string | undefined } | { error: string } {
  const authPath = operatorOpenCodeAuthPath(sourceEnv);
  if (authPath !== undefined && existsSync(authPath)) {
    let entry: unknown;
    try {
      const parsed: unknown = JSON.parse(readFileSync(authPath, 'utf-8'));
      entry = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[providerID] : undefined;
    } catch {
      // The parse error can quote the file, so it is not reported.
      return { error: `${authPath} could not be read as JSON` };
    }
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      return { content: JSON.stringify({ [providerID]: entry }) };
    }
  }
  const vars = OPENCODE_PROVIDER_ENV_VARS[providerID] ?? [];
  if (vars.some((name) => envAllowlist.includes(name) && (sourceEnv[name] ?? '').trim().length > 0)) {
    return { content: undefined };
  }
  return {
    error:
      `no credentials for provider ${JSON.stringify(providerID.slice(0, 40))}: no entry in ` +
      `${authPath ?? '(neither XDG_DATA_HOME nor HOME is set)'}` +
      (vars.length > 0 ? ` and none of ${vars.join(', ')} is allowlisted and set` : '') +
      ' (run `opencode auth login`)',
  };
}
