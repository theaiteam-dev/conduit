/**
 * Run-scoped CLAUDE_CONFIG_DIR for the claude-headless child (issue #29).
 *
 * With HOME allowlisted, `claude -p` reads the operator's ~/.claude: installed
 * and skills-dir plugins, user agents, settings and their hooks, the user
 * CLAUDE.md, and account-level claude.ai MCP connectors. None of that is in
 * flow.yaml or the binding stamp. The CLI reads its config dir from
 * CLAUDE_CONFIG_DIR independently of HOME, so the adapter can point the child
 * at a directory it constructs per invocation instead.
 *
 * Observed against claude 2.1.282: a CLAUDE_CONFIG_DIR holding only a
 * `.credentials.json` authenticates a subscription login, and the child then
 * loads no user plugin, user agent, user CLAUDE.md or user MCP server. The
 * CLI writes session state (`.claude.json`, `projects/`, `backups/`, synced
 * skills) into that directory as it runs, so it must be writable and is
 * deleted afterwards.
 *
 * The credentials file is LINKED, never copied, and never read here.
 */

import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CREDENTIALS_FILE = '.credentials.json';

/**
 * Variables that authenticate the CLI without a credentials file. Any one of
 * them allowlisted and set in the kernel env means the constructed dir needs
 * no credentials link at all.
 *
 * The token/key variables (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 * CLAUDE_CODE_OAUTH_TOKEN) count on any non-empty value. The three USE_*
 * variables are feature flags, not credentials, so they count only when
 * env-truthy: '1', 'true', 'yes' or 'on', case-insensitive and trimmed,
 * matching the claude CLI's own reading of them. CLAUDE_CODE_USE_BEDROCK=0
 * or =false does not authenticate the child.
 */
export const CLAUDE_AUTH_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/** The USE_* flags count as authenticating only when set to one of these, matching the CLI's own env-truthy rule. */
const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

const USE_FLAG_VARS = new Set(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);

/** Whether `name`'s value counts as authenticating the child: non-empty for token vars, env-truthy for the USE_* flags. */
function authenticatingValue(name: string, value: string | undefined): boolean {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return false;
  return USE_FLAG_VARS.has(name) ? TRUTHY_VALUES.has(trimmed.toLowerCase()) : true;
}

/** The operator's own config dir as the kernel sees it: CLAUDE_CONFIG_DIR, else $HOME/.claude. */
export function operatorClaudeConfigDir(sourceEnv: Record<string, string | undefined>): string | undefined {
  const explicit = sourceEnv.CLAUDE_CONFIG_DIR;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const home = sourceEnv.HOME;
  return home !== undefined && home.length > 0 ? join(home, '.claude') : undefined;
}

/**
 * Create a fresh config dir for one invocation. It holds a link to the
 * operator's `.credentials.json` when the child needs one, and nothing else.
 *
 * Throws before anything is spawned when the child would have no way to
 * authenticate: no credentials file and no allowlisted auth variable.
 */
export function createRunScopedClaudeConfigDir(
  sourceEnv: Record<string, string | undefined>,
  envAllowlist: readonly string[],
): string {
  const authVar = CLAUDE_AUTH_ENV_VARS.find(
    (name) => envAllowlist.includes(name) && authenticatingValue(name, sourceEnv[name]),
  );
  const operatorDir = operatorClaudeConfigDir(sourceEnv);
  const credentials = operatorDir !== undefined ? join(operatorDir, CREDENTIALS_FILE) : undefined;
  const linkCredentials = authVar === undefined;

  if (linkCredentials && (credentials === undefined || !existsSync(credentials))) {
    throw new Error(
      `claude-headless: isolateConfig found no credentials for the child: no ${CREDENTIALS_FILE} at ` +
        `${credentials ?? '(neither CLAUDE_CONFIG_DIR nor HOME is set)'} and none of ` +
        `${CLAUDE_AUTH_ENV_VARS.join(', ')} is allowlisted and set`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'conduit-claude-config-'));
  if (linkCredentials) symlinkSync(credentials!, join(dir, CREDENTIALS_FILE));
  return dir;
}

/** Delete a dir made by createRunScopedClaudeConfigDir. Removes the link, never its target. */
export function removeRunScopedClaudeConfigDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
