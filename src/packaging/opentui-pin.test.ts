/**
 * Issue #89: `conduit watch` renders with @opentui, which is pre-1.0, so its
 * packages are pinned to one exact version. The Dockerfile installs the
 * native renderer package by hand (the image's `--omit=optional` install skips
 * it), so that version is written there too, and the two must agree.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  dependencies: Record<string, string>;
};
const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf-8');

describe('@opentui pin', () => {
  it('pins @opentui/core and @opentui/react to the same exact version', () => {
    const core = pkg.dependencies['@opentui/core'];
    expect(core).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['@opentui/react']).toBe(core);
  });

  it('installs the native renderer in the image at the pinned version', () => {
    expect(dockerfile).toMatch(/pkg="@opentui\/core-linux-/);
    const match = dockerfile.match(/bun add "\$\{pkg\}@(\d+\.\d+\.\d+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(pkg.dependencies['@opentui/core']);
  });
});
