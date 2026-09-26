/**
 * CONDUIT_HARNESS_* engine-config parser (WI-586).
 *
 * Pure function: reads only the passed-in env record, does no I/O, and does
 * not validate adapter names against the shipped factory map (that's the
 * registry's job — see harness-config.test.ts header for the full contract).
 */

import { isAbsolute } from 'node:path';

export type HarnessConfigResult =
  | { ok: true; defs: HarnessAdapterConfigDef[] }
  | { ok: false; error: string };

export interface HarnessAdapterConfigDef {
  name: string;
  envAllowlist: string[];
  command?: string;
  model?: string;
  /** Default `--agent` (issue #28). A station's own `agent:` wins. From `_AGENT`. */
  agent?: string;
  /**
   * Absolute plugin directories, one `--plugin-dir` each (issue #28). From the
   * `_PLUGIN_DIRS` CSV. Absent when the variable is unset or lists nothing.
   */
  pluginDirs?: string[];
  /**
   * Give the child a run-scoped config dir instead of the operator's (issue
   * #29). From `_ISOLATE_CONFIG`: `1`/`true` or `0`/`false`.
   */
  isolateConfig?: boolean;
}

const BOOLEAN_VALUES: Record<string, boolean> = { '1': true, true: true, '0': false, false: false };

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function derivePrefix(name: string): string {
  return `CONDUIT_HARNESS_${name.toUpperCase().replace(/-/g, '_')}_`;
}

export function parseHarnessConfig(env: Record<string, string | undefined>): HarnessConfigResult {
  const adaptersRaw = env.CONDUIT_HARNESS_ADAPTERS;
  if (adaptersRaw === undefined || adaptersRaw.trim() === '') {
    return { ok: true, defs: [] };
  }

  const names = splitCsv(adaptersRaw);

  const prefixToNames = new Map<string, string[]>();
  for (const name of names) {
    const prefix = derivePrefix(name);
    const existing = prefixToNames.get(prefix);
    if (existing) {
      existing.push(name);
    } else {
      prefixToNames.set(prefix, [name]);
    }
  }
  for (const [, collidingNames] of prefixToNames) {
    if (collidingNames.length > 1) {
      return {
        ok: false,
        error: `harness config: adapter names collide on the same derived env prefix: ${collidingNames.join(', ')}`,
      };
    }
  }

  const defs: HarnessAdapterConfigDef[] = [];
  for (const name of names) {
    const prefix = derivePrefix(name);
    const envVarName = `${prefix}ENV`;
    const envAllowlistRaw = env[envVarName];
    if (envAllowlistRaw === undefined) {
      return {
        ok: false,
        error: `harness config: adapter "${name}" is missing required env allowlist var ${envVarName}`,
      };
    }

    const def: HarnessAdapterConfigDef = {
      name,
      envAllowlist: splitCsv(envAllowlistRaw),
    };

    const command = env[`${prefix}COMMAND`];
    if (command !== undefined) {
      def.command = command;
    }

    const model = env[`${prefix}MODEL`];
    if (model !== undefined) {
      def.model = model;
    }

    const agentVar = `${prefix}AGENT`;
    const agentRaw = env[agentVar];
    if (agentRaw !== undefined) {
      const agent = agentRaw.trim();
      if (agent.length === 0) {
        return {
          ok: false,
          error: `harness config: ${agentVar} is set but empty`,
        };
      }
      def.agent = agent;
    }

    // Absolute only: the kernel and the child resolve paths from different
    // working directories, and this parser does no I/O to settle which one a
    // relative entry meant. Existence is checked where the adapter is built.
    const pluginDirsVar = `${prefix}PLUGIN_DIRS`;
    const pluginDirsRaw = env[pluginDirsVar];
    if (pluginDirsRaw !== undefined) {
      const pluginDirs = splitCsv(pluginDirsRaw);
      const relative = pluginDirs.find((dir) => !isAbsolute(dir));
      if (relative !== undefined) {
        return {
          ok: false,
          error: `harness config: ${pluginDirsVar} entry "${relative}" is not an absolute path`,
        };
      }
      if (pluginDirs.length > 0) {
        def.pluginDirs = pluginDirs;
      }
    }

    const isolateVar = `${prefix}ISOLATE_CONFIG`;
    const isolateRaw = env[isolateVar];
    if (isolateRaw !== undefined) {
      const isolate = BOOLEAN_VALUES[isolateRaw.trim()];
      if (isolate === undefined) {
        return {
          ok: false,
          error: `harness config: ${isolateVar} must be 1, true, 0 or false, got "${isolateRaw}"`,
        };
      }
      def.isolateConfig = isolate;
    }

    defs.push(def);
  }

  return { ok: true, defs };
}
