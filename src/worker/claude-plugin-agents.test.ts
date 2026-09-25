/**
 * Locating a `--plugin-dir` agent's definition file (issue #28).
 *
 * The kernel folds the SHA-256 of an agent's definition file into the harness
 * station's prompt_template_version, so it has to find the same file the
 * claude CLI loads for `--agent <plugin>:<agent>`. The rules below mirror what
 * claude 2.1.282 was observed to do:
 *
 *   - a `--plugin-dir` entry that holds `.claude-plugin/plugin.json` is one
 *     plugin; otherwise each child directory that holds one is a plugin (a
 *     child without plugin.json was not loaded);
 *   - the plugin's namespace is plugin.json `name`;
 *   - an agent is addressed by its frontmatter `name:`, not its filename
 *     (`agents/file-name.md` with `name: front-name` is `p:front-name`).
 *
 * Every miss fails closed with a message that names what was looked for. The
 * lookup never falls back to hashing the name alone.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveClaudePluginAgent } from './claude-plugin-agents';

// chmod 0o000 is ineffective as root (root bypasses file permission checks),
// so a test relying on it is skipped when the test runner itself is root —
// there the read would succeed and the assertions would not exercise the guard.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conduit-plugin-agents-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePlugin(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
}

function writeAgent(file: string, frontmatterName: string, body = 'Do the task.'): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `---\nname: ${frontmatterName}\ndescription: test agent\n---\n${body}\n`);
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeMalformedManifest(dir: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{ not valid json');
}

describe('resolveClaudePluginAgent', () => {
  it('resolves <plugin>:<agent> in a --plugin-dir that is itself a plugin, hashing the file bytes', () => {
    const plugin = join(root, 'team');
    writePlugin(plugin, { name: 'team' });
    const file = join(plugin, 'agents', 'coder.md');
    writeAgent(file, 'coder');

    const result = resolveClaudePluginAgent([plugin], 'team:coder');

    expect(result).toEqual({ ok: true, path: file, sha256: sha256(file) });
  });

  it('treats a --plugin-dir without plugin.json as a folder of plugins and loads each child', () => {
    writePlugin(join(root, 'one'), { name: 'one' });
    writeAgent(join(root, 'one', 'agents', 'a.md'), 'a');
    writePlugin(join(root, 'two'), { name: 'two' });
    const file = join(root, 'two', 'agents', 'b.md');
    writeAgent(file, 'b');

    const result = resolveClaudePluginAgent([root], 'two:b');

    expect(result).toEqual({ ok: true, path: file, sha256: sha256(file) });
  });

  it('skips a child directory with no plugin.json, as the CLI does', () => {
    mkdirSync(join(root, 'bare', 'agents'), { recursive: true });
    writeAgent(join(root, 'bare', 'agents', 'x.md'), 'x');

    const result = resolveClaudePluginAgent([root], 'bare:x');

    expect(result.ok).toBe(false);
  });

  it('addresses an agent by its frontmatter name, not its filename', () => {
    const plugin = join(root, 'p');
    writePlugin(plugin, { name: 'p' });
    const file = join(plugin, 'agents', 'file-name.md');
    writeAgent(file, 'front-name');

    expect(resolveClaudePluginAgent([plugin], 'p:front-name')).toEqual({ ok: true, path: file, sha256: sha256(file) });
    expect(resolveClaudePluginAgent([plugin], 'p:file-name').ok).toBe(false);
  });

  it('does not close the frontmatter on an indented ---- or ---text line inside a YAML value', () => {
    const plugin = join(root, 'p');
    writePlugin(plugin, { name: 'p' });
    const file = join(plugin, 'agents', 'd.md');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '---\ndescription: |\n  ----\n  ---rule\nname: dashed\n---\nDo the task.\n');

    expect(resolveClaudePluginAgent([plugin], 'p:dashed')).toEqual({ ok: true, path: file, sha256: sha256(file) });
  });

  it('accepts a quoted frontmatter name', () => {
    const plugin = join(root, 'p');
    writePlugin(plugin, { name: 'p' });
    const file = join(plugin, 'agents', 'q.md');
    writeAgent(file, '"quoted"');

    expect(resolveClaudePluginAgent([plugin], 'p:quoted')).toEqual({ ok: true, path: file, sha256: sha256(file) });
  });

  it('namespaces by plugin.json name, not by directory name', () => {
    const plugin = join(root, 'dir-name');
    writePlugin(plugin, { name: 'manifest-name' });
    const file = join(plugin, 'agents', 'a.md');
    writeAgent(file, 'a');

    expect(resolveClaudePluginAgent([plugin], 'manifest-name:a').ok).toBe(true);
    expect(resolveClaudePluginAgent([plugin], 'dir-name:a').ok).toBe(false);
  });

  it('also scans agent paths the manifest declares outside agents/', () => {
    const plugin = join(root, 'p');
    writePlugin(plugin, { name: 'p', agents: ['./custom/special.md'] });
    const file = join(plugin, 'custom', 'special.md');
    writeAgent(file, 'special');

    expect(resolveClaudePluginAgent([plugin], 'p:special')).toEqual({ ok: true, path: file, sha256: sha256(file) });
  });

  it('changes the hash when the agent body is edited', () => {
    const plugin = join(root, 'p');
    writePlugin(plugin, { name: 'p' });
    const file = join(plugin, 'agents', 'a.md');
    writeAgent(file, 'a', 'Body one.');
    const before = resolveClaudePluginAgent([plugin], 'p:a');
    writeAgent(file, 'a', 'Body two, edited.');
    const after = resolveClaudePluginAgent([plugin], 'p:a');

    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) expect(after.sha256).not.toBe(before.sha256);
  });

  it('fails closed on an agent no plugin dir defines, naming the agent and the dirs searched', () => {
    const plugin = join(root, 'p');
    writePlugin(plugin, { name: 'p' });
    writeAgent(join(plugin, 'agents', 'a.md'), 'a');

    const result = resolveClaudePluginAgent([plugin], 'p:missing');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('p:missing');
      expect(result.error).toContain(plugin);
    }
  });

  it('fails closed when no plugin dirs are configured at all', () => {
    const result = resolveClaudePluginAgent([], 'p:a');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('PLUGIN_DIRS');
  });

  it('never reads a file outside the plugin dirs for a path-shaped agent name, since names are matched, not joined', () => {
    const plugin = join(root, 'plugins', 'team');
    writePlugin(plugin, { name: 'team' });
    writeAgent(join(plugin, 'agents', 'coder.md'), 'coder');
    const outside = join(root, 'outside', 'secret.md');
    writeAgent(outside, 'secret');

    for (const agent of ['team:../../outside/secret.md', 'team:../../outside/secret', `team:${outside}`, 'team:secret']) {
      const result = resolveClaudePluginAgent([plugin], agent);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('has no definition file');
    }
  });

  it('rejects an agent name without a plugin namespace, since only --plugin-dir agents can be hashed', () => {
    const result = resolveClaudePluginAgent([root], 'general-purpose');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('<plugin>:<agent>');
  });

  it('fails closed when two definitions match, since the kernel cannot tell which one the CLI loads', () => {
    const dirA = join(root, 'a');
    const dirB = join(root, 'b');
    writePlugin(join(dirA, 'p'), { name: 'p' });
    writeAgent(join(dirA, 'p', 'agents', 'x.md'), 'x');
    writePlugin(join(dirB, 'p'), { name: 'p' });
    writeAgent(join(dirB, 'p', 'agents', 'x.md'), 'x');

    const result = resolveClaudePluginAgent([dirA, dirB], 'p:x');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ambiguous');
  });

  it.skipIf(isRoot)('fails closed, naming the file, when an agent file in the match loop is unreadable', () => {
    const plugin = join(root, 'p');
    writePlugin(plugin, { name: 'p' });
    const readable = join(plugin, 'agents', 'a.md');
    writeAgent(readable, 'a');
    const unreadable = join(plugin, 'agents', 'b.md');
    writeAgent(unreadable, 'b');
    chmodSync(unreadable, 0o000);

    const result = resolveClaudePluginAgent([plugin], 'p:b');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(unreadable);
  });

  it('fails closed, naming the path, instead of throwing when agents/ contains a directory named *.md', () => {
    const plugin = join(root, 'p');
    writePlugin(plugin, { name: 'p' });
    const trap = join(plugin, 'agents', 'x.md');
    mkdirSync(trap, { recursive: true });

    const result = resolveClaudePluginAgent([plugin], 'p:x');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(trap);
  });

  it('fails closed, naming the manifest, when a direct --plugin-dir entry has an unparseable plugin.json', () => {
    const plugin = join(root, 'p');
    writeMalformedManifest(plugin);
    writeAgent(join(plugin, 'agents', 'a.md'), 'a');

    const result = resolveClaudePluginAgent([plugin], 'p:a');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(join(plugin, '.claude-plugin', 'plugin.json'));
  });

  it('does not scan an entry with an unparseable plugin.json as a folder of plugins', () => {
    const plugin = join(root, 'p');
    writeMalformedManifest(plugin);
    // If the invalid-manifest root were treated as "not a plugin root" and
    // scanned as a folder of plugins, this nested child would resolve.
    writePlugin(join(plugin, 'nested'), { name: 'nested' });
    writeAgent(join(plugin, 'nested', 'agents', 'a.md'), 'a');

    const result = resolveClaudePluginAgent([plugin], 'nested:a');

    expect(result.ok).toBe(false);
  });

  it('fails closed, naming the manifest, when a child of a folder-of-plugins has an unparseable plugin.json', () => {
    writeMalformedManifest(join(root, 'broken'));
    writeAgent(join(root, 'broken', 'agents', 'a.md'), 'a');

    const result = resolveClaudePluginAgent([root], 'broken:a');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(join(root, 'broken', '.claude-plugin', 'plugin.json'));
  });

  it('still resolves a valid sibling plugin when another child of the folder has an unparseable manifest', () => {
    writeMalformedManifest(join(root, 'broken'));
    writePlugin(join(root, 'ok'), { name: 'ok' });
    const file = join(root, 'ok', 'agents', 'a.md');
    writeAgent(file, 'a');

    const result = resolveClaudePluginAgent([root], 'ok:a');

    expect(result).toEqual({ ok: true, path: file, sha256: sha256(file) });
  });
});
