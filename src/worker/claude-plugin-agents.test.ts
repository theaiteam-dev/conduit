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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveClaudePluginAgent } from './claude-plugin-agents';

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
});
