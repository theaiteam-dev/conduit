/**
 * Every shipped harness adapter has a containment conformance call (issue #27).
 *
 * The conformance suite (./harness-containment.conformance.ts) only covers the
 * adapters whose test files call `describeHarnessContainmentConformance`. This
 * test makes that call mandatory: adding an adapter to the shipped factory map
 * without one fails here, rather than shipping an adapter whose timeout kill
 * was never checked for grandchildren.
 *
 * The calls are found by parsing the test sources with the TypeScript compiler
 * API, not by collecting them at runtime, because Bun does not guarantee which
 * test files have loaded when this one runs. A call counts only when it is a
 * top-level statement of a `*.test.ts` file with a string-literal name. A call
 * in a comment, inside a function or callback body, or with a variable name
 * does not count. The suite itself checks that the adapter the factory builds
 * carries the name the call was registered under.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { shippedHarnessAdapterNames } from './harness-adapter';

const SRC_ROOT = join(import.meta.dir, '..');
const CALLEE_NAME = 'describeHarnessContainmentConformance';

/**
 * Finds top-level `describeHarnessContainmentConformance('name', ...)`
 * registrations in a single source file's text. "Top-level" means the call is
 * an ExpressionStatement directly in the source file's statement list: not
 * inside a function body, a block, an `if`, a callback passed to `it`, or any
 * other nested statement. The name only counts when the first argument is a
 * string literal or a no-substitution template literal; a variable or
 * computed expression does not count. Comments are trivia, not statements, so
 * a call written inside `//` or `/* *\/` never counts either.
 */
function conformanceRegistrations(source: string, fileName = 'source.test.ts'): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const call = statement.expression;
    if (!ts.isCallExpression(call)) continue;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== CALLEE_NAME) continue;
    const nameArg = call.arguments[0];
    if (!nameArg) continue;
    if (ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg)) {
      names.push(nameArg.text);
    }
  }
  return names;
}

function adaptersWithConformanceCalls(): Set<string> {
  const names = new Set<string>();
  for (const file of new Bun.Glob('**/*.test.ts').scanSync(SRC_ROOT)) {
    const source = readFileSync(join(SRC_ROOT, file), 'utf-8');
    for (const name of conformanceRegistrations(source, file)) names.add(name);
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

  it('does not itself register a fixture name used only in these unit tests', () => {
    // The full-repo scan reads this file too. If the AST parse regressed to a
    // text scan, the fixture strings below (which live inside string literal
    // contents, not as real top-level calls) would leak into the real result.
    const covered = adaptersWithConformanceCalls();
    expect(covered.has('fixture-adapter')).toBe(false);
  });
});

describe('conformanceRegistrations', () => {
  it('counts a top-level call', () => {
    const source = `describeHarnessContainmentConformance('fixture-adapter', (opts) => make(opts));`;
    expect(conformanceRegistrations(source)).toEqual(['fixture-adapter']);
  });

  it('ignores a call inside a line comment', () => {
    const source = `// describeHarnessContainmentConformance('fixture-adapter', make);`;
    expect(conformanceRegistrations(source)).toEqual([]);
  });

  it('ignores a call inside a block comment', () => {
    const source = `/*\ndescribeHarnessContainmentConformance('fixture-adapter', make);\n*/`;
    expect(conformanceRegistrations(source)).toEqual([]);
  });

  it('ignores a call inside a helper function that no test invokes', () => {
    const source = `
      function helper() {
        describeHarnessContainmentConformance('fixture-adapter', make);
      }
    `;
    expect(conformanceRegistrations(source)).toEqual([]);
  });

  it('ignores an indented call inside an arrow function body', () => {
    const source = `
      const register = () => {
        describeHarnessContainmentConformance('fixture-adapter', make);
      };
    `;
    expect(conformanceRegistrations(source)).toEqual([]);
  });

  it('ignores a call whose name argument is a variable, not a literal', () => {
    const source = `
      const name = 'fixture-adapter';
      describeHarnessContainmentConformance(name, make);
    `;
    expect(conformanceRegistrations(source)).toEqual([]);
  });

  it('counts a top-level call whose name is a no-substitution template literal', () => {
    const source = 'describeHarnessContainmentConformance(`fixture-adapter`, make);';
    expect(conformanceRegistrations(source)).toEqual(['fixture-adapter']);
  });
});
