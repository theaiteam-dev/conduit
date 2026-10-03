/**
 * Black-box suite scaffold smoke test (WI-675).
 *
 * Pins the plumbing that makes blackbox/ a first-class, separately-run,
 * REQUIRED test suite:
 *   - package.json exposes a `test:blackbox` script that runs this suite
 *   - the default `test` script is scoped to src/ and no longer globs blackbox/
 *   - the blackbox/ home exists (harness/ subfolder + README stub)
 *   - a dedicated .github/workflows/blackbox.yml runs on every PR in a job
 *     named `blackbox`, the name the `main` ruleset requires. The name and
 *     the unfiltered trigger are pinned because a required check that is
 *     renamed or skipped by a filter never reports, and every PR waits on it
 *
 * Black-box rule: this suite reads only from disk and public deps — NO src/
 * imports. Reading package.json / workflow YAML from the filesystem keeps it
 * compliant with the zero-internal-imports gate.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = join(import.meta.dir, "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));

describe("package.json test-script scoping", () => {
  const pkg = readJson("package.json");
  const scripts: Record<string, string> = pkg.scripts ?? {};

  test("exposes a `test:blackbox` script that runs the blackbox/ suite", () => {
    expect(scripts["test:blackbox"]).toBeDefined();
    expect(scripts["test:blackbox"]).toContain("blackbox/");
  });

  test("default `test` script is scoped to src/ and does not glob blackbox/", () => {
    expect(scripts.test).toBeDefined();
    expect(scripts.test).toContain("src/");
    expect(scripts.test).not.toContain("blackbox");
  });
});

describe("blackbox/ directory layout", () => {
  const isDir = (rel: string) => existsSync(join(repoRoot, rel)) && statSync(join(repoRoot, rel)).isDirectory();

  test("blackbox/ exists with a harness/ subfolder", () => {
    expect(isDir("blackbox")).toBe(true);
    expect(isDir("blackbox/harness")).toBe(true);
  });

  test("blackbox/README stub exists and is non-empty", () => {
    const readme = join(repoRoot, "blackbox/README.md");
    expect(existsSync(readme)).toBe(true);
    expect(readFileSync(readme, "utf8").trim().length).toBeGreaterThan(0);
  });
});

describe("release workflow runs every PR gate before it publishes", () => {
  // A release is cut from main after a squash merge, so the merged tree is a
  // tree no PR check ran on. The release job must run the same gates the
  // required PR checks run, in a step before semantic-release, or a merge that
  // breaks the black-box suite or a budget fold site ships anyway.
  const wf = parse(readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8"));
  const steps: Array<{ name?: string; run?: string; uses?: string; env?: Record<string, string> }> =
    wf.jobs?.release?.steps ?? [];
  const publishAt = steps.findIndex((s) => s.uses?.startsWith("cycjimmy/semantic-release-action"));
  // Exact script name: `bun run test` must not be satisfied by `bun run test:blackbox`.
  const runIndex = (script: string) =>
    steps.findIndex((s) => new RegExp(`bun run ${script.replace(":", "\\:")}(\\s|$)`, "m").test(s.run ?? ""));

  test("the release job has a semantic-release step", () => {
    expect(publishAt).toBeGreaterThan(-1);
  });

  for (const script of ["typecheck", "typecheck:blackbox", "test", "test:blackbox", "test:mutation"]) {
    test(`runs \`bun run ${script}\` before semantic-release`, () => {
      const at = runIndex(script);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(publishAt);
    });
  }

  for (const script of ["test", "test:blackbox"]) {
    test(`\`bun run ${script}\` requires cgroup containment, as the PR job does`, () => {
      // Without it, a runner where cgroup containment fails falls back to the
      // process-group kill, and the containment assertions skip instead of failing.
      const step = steps[runIndex(script)]!;
      expect(step.env?.CONDUIT_REQUIRE_CGROUP_CONTAINMENT).toBe("1");
      expect(step.run).toContain("/sys/fs/cgroup/conduit-ci");
    });
  }
});

describe("required blackbox CI workflow (DQ-3)", () => {
  const workflowPath = join(repoRoot, ".github/workflows/blackbox.yml");

  test(".github/workflows/blackbox.yml exists as a separate workflow", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  test("runs on every pull_request in a job named `blackbox`", () => {
    const wf = parse(readFileSync(workflowPath, "utf8"));

    // Triggers on every PR. YAML 1.1 folds a bare `on:` key to boolean `true`,
    // which becomes the string key "true" on the parsed JS object (JS object
    // keys are always strings); YAML 1.2 keeps it as "on". Read whichever the
    // parser produced — string-index "true" (never a literal boolean index).
    const on = wf.on ?? (wf as Record<string, unknown>)["true"];
    const triggers = Array.isArray(on) ? on : Object.keys(on ?? {});
    expect(triggers).toContain("pull_request");

    // A `paths:` or `branches:` filter would skip the workflow on some PRs,
    // and a skipped required check never reports.
    const pr = Array.isArray(on) ? null : (on as Record<string, unknown>)?.pull_request;
    const prFilters = pr && typeof pr === "object" ? Object.keys(pr) : [];
    for (const filter of ["paths", "paths-ignore", "branches", "branches-ignore"]) {
      expect(prFilters).not.toContain(filter);
    }

    // The ruleset requires the check context `blackbox`, which GitHub takes
    // from the job's `name:` (or its key when `name:` is absent).
    const jobs: Record<string, { name?: string }> = wf.jobs ?? {};
    const contexts = Object.entries(jobs).map(([key, job]) => job?.name ?? key);
    expect(contexts).toContain("blackbox");

    // `tests` is the other required context, owned by test.yml. A job here
    // with that name would satisfy it without running the unit suite.
    expect(Object.keys(jobs)).not.toContain("tests");
    expect(contexts).not.toContain("tests");
  });
});
