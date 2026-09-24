/**
 * Every shipped harness adapter has a containment conformance call (issue #27).
 *
 * The conformance suite (./harness-containment.conformance.ts) only covers the
 * adapters whose test files call `describeHarnessContainmentConformance`. This
 * test makes that call mandatory: adding an adapter to the shipped factory map
 * without one fails here, rather than shipping an adapter whose timeout kill
 * was never checked for grandchildren.
 *
 * The calls are found by reading the test sources, not by collecting them at
 * runtime, because Bun does not guarantee which test files have loaded when
 * this one runs. Only a call at the start of a line in a `*.test.ts` file
 * counts, so a commented-out call or one in a helper that no test runs does
 * not satisfy it. The suite itself checks that the adapter the factory builds
 * carries the name the call was registered under.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shippedHarnessAdapterNames } from './harness-adapter';

const SRC_ROOT = join(import.meta.dir, '..');
const CALL = /^\s*describeHarnessContainmentConformance\(\s*['"]([^'"]+)['"]/gm;

function adaptersWithConformanceCalls(): Set<string> {
  const names = new Set<string>();
  for (const file of new Bun.Glob('**/*.test.ts').scanSync(SRC_ROOT)) {
    const source = readFileSync(join(SRC_ROOT, file), 'utf-8');
    for (const match of source.matchAll(CALL)) names.add(match[1]!);
  }
  return names;
}

describe('harness containment conformance registry (issue #27)', () => {
  it('finds the shipped adapters', () => {
    // Guards the check below against passing vacuously on an empty map.
    expect(shippedHarnessAdapterNames().length).toBeGreaterThan(0);
  });

  it('has a conformance call for every adapter in the shipped factory map', () => {
    const covered = adaptersWithConformanceCalls();
    const missing = shippedHarnessAdapterNames().filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
  });
});
