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

  it('checks the scratch install integrity against /app/bun.lock and fails the build on mismatch', () => {
    // Read both integrities, require them non-empty, and require equality, all
    // before the package is copied into /app/node_modules.
    expect(dockerfile).toMatch(/want="\$\(grep[^\n]*\/app\/bun\.lock[^\n]*sha512-/);
    expect(dockerfile).toMatch(/got="\$\(grep[^\n]*\bbun\.lock[^\n]*sha512-/);
    expect(dockerfile).toMatch(/test -n "\$want" && test -n "\$got" && test "\$want" = "\$got"/);
    const check = dockerfile.indexOf('test "$want" = "$got"');
    const copy = dockerfile.indexOf('cp -r "node_modules/${pkg}"');
    expect(check).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(check);
  });

  it('records an integrity for the linux native packages in bun.lock', () => {
    const lock = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf-8');
    for (const arch of ['x64', 'arm64']) {
      expect(lock).toMatch(
        new RegExp(`"@opentui/core-linux-${arch}": \\["@opentui/core-linux-${arch}@[^"]+", "", \\{[^}]*\\}, "sha512-[A-Za-z0-9+/=]+"\\]`),
      );
    }
  });
});
