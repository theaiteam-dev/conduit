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
 *     directory name only when the manifest parses but omits `name`;
 *   - agents are the `.md` files in `agents/` plus any the manifest's `agents`
 *     field lists, and each is addressed by its frontmatter `name:`, not its
 *     filename.
 *
 * The file is hashed, not interpreted: only the frontmatter `name:` line is
 * read, to match the address. Every miss fails closed; the caller never falls
 * back to hashing the name alone, which would let an edited agent replay from
 * a stale checkpoint. A manifest that cannot be read or parsed is not a valid
 * plugin root at all: the kernel cannot know which namespace the CLI would
 * use for it, so it is neither loaded as a plugin (no directory-name
 * fallback) nor scanned as a folder of plugins, and looking it up returns
 * `{ ok: false }` naming the manifest path rather than guessing.
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

/**
 * The result of looking at one directory for `.claude-plugin/plugin.json`:
 * no manifest at all (not a plugin root — a folder-of-plugins candidate),
 * a manifest present but unreadable/unparseable (a plugin root the kernel
 * fails closed on, never a folder-of-plugins candidate), or a valid root.
 */
type PluginLookup = { kind: 'none' } | { kind: 'invalid'; dir: string; manifestPath: string } | { kind: 'root'; root: PluginRoot };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readPluginRoot(dir: string): PluginLookup {
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) return { kind: 'none' };
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch {
    return { kind: 'invalid', dir, manifestPath };
  }
  let manifest: { name?: unknown; agents?: unknown };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return { kind: 'invalid', dir, manifestPath };
  }
  const declared = manifest.agents;
  const declaredAgents =
    typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared.filter((a) => typeof a === 'string') : [];
  return {
    kind: 'root',
    root: {
      dir,
      name: typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : basename(dir),
      declaredAgents,
    },
  };
}

/**
 * The plugins one `--plugin-dir` entry loads: itself (if it is a plugin
 * root, valid or invalid), or each child plugin. An invalid manifest at the
 * entry itself is reported, not silently skipped, and never triggers a
 * folder-of-plugins scan.
 */
function pluginsIn(pluginDir: string): Exclude<PluginLookup, { kind: 'none' }>[] {
  const self = readPluginRoot(pluginDir);
  if (self.kind !== 'none') return [self];
  if (!isDirectory(pluginDir)) return [];
  return readdirSync(pluginDir)
    .sort()
    .map((child) => join(pluginDir, child))
    .filter(isDirectory)
    .map((child) => readPluginRoot(child))
    .filter((lookup): lookup is Exclude<PluginLookup, { kind: 'none' }> => lookup.kind !== 'none');
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
  // The manifest path of an invalid plugin.json whose directory name matches
  // `pluginName` — reported when no match is found, since a directory-name
  // guess is the only identifier available for a manifest that failed to
  // parse, and the operator needs to know why nothing resolved.
  let invalidManifest: string | undefined;
  for (const pluginDir of pluginDirs) {
    for (const lookup of pluginsIn(pluginDir)) {
      if (lookup.kind === 'invalid') {
        if (invalidManifest === undefined && basename(lookup.dir) === pluginName) invalidManifest = lookup.manifestPath;
        continue;
      }
      const plugin = lookup.root;
      if (plugin.name !== pluginName) continue;
      for (const file of agentFilesOf(plugin)) {
        let text: string;
        try {
          text = readFileSync(file, 'utf-8');
        } catch (err) {
          return { ok: false, error: `agent '${agent}' definition file '${file}' could not be read: ${errorMessage(err)}` };
        }
        if (frontmatterName(text) === agentName) matches.push(file);
      }
    }
  }

  if (matches.length === 0) {
    if (invalidManifest !== undefined) {
      return {
        ok: false,
        error: `agent '${agent}' cannot be resolved: plugin manifest '${invalidManifest}' is not valid JSON, so its namespace is unknown`,
      };
    }
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
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    return { ok: false, error: `agent '${agent}' definition file '${path}' could not be read: ${errorMessage(err)}` };
  }
  return { ok: true, path, sha256: createHash('sha256').update(bytes).digest('hex') };
}
