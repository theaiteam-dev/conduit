/**
 * Locate a `--plugin-dir` agent's definition file for the binding stamp
 * (issue #28).
 *
 * A harness station that runs `--agent <plugin>:<agent>` folds the SHA-256 of
 * that agent's definition file into its prompt_template_version, so the
 * kernel must find the same file the claude CLI loads. The rules mirror what
 * claude 2.1.282 was observed to do:
 *
 *   - a `--plugin-dir` entry holding `.claude-plugin/plugin.json` is one
 *     plugin; any other entry is a folder of plugins, and each child holding
 *     that manifest is a plugin (a child without one is not loaded);
 *   - the plugin's namespace is the manifest's `name`, falling back to the
 *     directory name;
 *   - agents are the `.md` files in `agents/` plus any the manifest's `agents`
 *     field lists, and each is addressed by its frontmatter `name:`, not its
 *     filename.
 *
 * The file is hashed, not interpreted: only the frontmatter `name:` line is
 * read, to match the address. Every miss fails closed; the caller never falls
 * back to hashing the name alone, which would let an edited agent replay from
 * a stale checkpoint.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { AgentDefinitionResult } from './harness-adapter';

const MANIFEST = join('.claude-plugin', 'plugin.json');

interface PluginRoot {
  dir: string;
  name: string;
  /** Agent paths the manifest lists, relative to `dir`. */
  declaredAgents: string[];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readPluginRoot(dir: string): PluginRoot | undefined {
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) return undefined;
  let manifest: { name?: unknown; agents?: unknown } = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as typeof manifest;
  } catch {
    // An unreadable manifest still marks a plugin root; its agents dir is scanned.
  }
  const declared = manifest.agents;
  const declaredAgents =
    typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared.filter((a) => typeof a === 'string') : [];
  return {
    dir,
    name: typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : basename(dir),
    declaredAgents,
  };
}

/** The plugins one `--plugin-dir` entry loads: itself, or each child plugin. */
function pluginsIn(pluginDir: string): PluginRoot[] {
  const self = readPluginRoot(pluginDir);
  if (self !== undefined) return [self];
  if (!isDirectory(pluginDir)) return [];
  return readdirSync(pluginDir)
    .sort()
    .map((child) => join(pluginDir, child))
    .filter(isDirectory)
    .flatMap((child) => readPluginRoot(child) ?? []);
}

function markdownFilesIn(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.md'))
    .sort()
    .map((entry) => join(dir, entry));
}

/** Every agent definition file a plugin contributes, de-duplicated. */
function agentFilesOf(plugin: PluginRoot): string[] {
  const files = new Set(markdownFilesIn(join(plugin.dir, 'agents')));
  for (const declared of plugin.declaredAgents) {
    const path = resolve(plugin.dir, declared);
    if (isDirectory(path)) {
      for (const file of markdownFilesIn(path)) files.add(file);
    } else if (existsSync(path)) {
      files.add(path);
    }
  }
  return [...files];
}

/** The frontmatter `name:` value, or undefined when the file declares none. */
export function frontmatterName(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^name:\s*(.*?)\s*$/.exec(line);
    if (field === null) continue;
    const value = field[1]!.replace(/^(['"])(.*)\1$/, '$2');
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Find and hash the definition file for `agent` (`<plugin>:<agent>`) among
 * the plugins the given `--plugin-dir` entries load.
 */
export function resolveClaudePluginAgent(pluginDirs: readonly string[], agent: string): AgentDefinitionResult {
  const separator = agent.indexOf(':');
  if (separator <= 0 || separator === agent.length - 1) {
    return {
      ok: false,
      error:
        `agent '${agent}' is not of the form <plugin>:<agent>; only agents supplied by a ` +
        `--plugin-dir plugin can be hashed into the binding stamp`,
    };
  }
  if (pluginDirs.length === 0) {
    return {
      ok: false,
      error: `agent '${agent}' cannot be resolved: no plugin dirs are configured (CONDUIT_HARNESS_<NAME>_PLUGIN_DIRS)`,
    };
  }
  const pluginName = agent.slice(0, separator);
  const agentName = agent.slice(separator + 1);

  const matches: string[] = [];
  for (const pluginDir of pluginDirs) {
    for (const plugin of pluginsIn(pluginDir)) {
      if (plugin.name !== pluginName) continue;
      for (const file of agentFilesOf(plugin)) {
        if (frontmatterName(readFileSync(file, 'utf-8')) === agentName) matches.push(file);
      }
    }
  }

  if (matches.length === 0) {
    return {
      ok: false,
      error: `agent '${agent}' has no definition file in the configured plugin dirs: ${pluginDirs.join(', ')}`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error:
        `agent '${agent}' is ambiguous: ${matches.length} definition files match (${matches.join(', ')}), ` +
        `so the kernel cannot tell which one the CLI loads`,
    };
  }
  const path = matches[0]!;
  return { ok: true, path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}
