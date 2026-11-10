/**
 * Tests for the release-PR tooling (scripts/release.ts).
 *
 * NOT part of the required `tests` gate: `bun run test` is scoped to `src/`.
 * The advisory Docs workflow runs `bun test scripts/`, and both release
 * workflows run this file before they use the script, so a broken script
 * fails the release run instead of producing a malformed release PR.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bumpPackageJson,
  compareVersions,
  latestTag,
  parseVersion,
  releaseNotes,
  rollChangelog,
  run,
} from "./release";

const REPO = "https://github.com/theaiteam-dev/conduit";

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Breaking

- Bind loopback by default.

### Added

- A thing.

## [1.0.0] - 2026-08-27

### Added

- First release.

[Unreleased]: ${REPO}/compare/v1.0.0...HEAD
[1.0.0]: ${REPO}/releases/tag/v1.0.0
`;

describe("parseVersion", () => {
  it("accepts MAJOR.MINOR.PATCH", () => {
    expect(parseVersion("2.0.0")).toEqual([2, 0, 0]);
    expect(parseVersion("10.20.30")).toEqual([10, 20, 30]);
  });

  for (const bad of ["v2.0.0", "2.0", "2.0.0-rc.1", "2.0.0+build", "02.0.0", " 2.0.0", "2.0.0\n", ""]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => parseVersion(bad)).toThrow();
    });
  }
});

describe("compareVersions / latestTag", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions([1, 10, 0], [1, 9, 0])).toBeGreaterThan(0);
    expect(compareVersions([2, 0, 0], [2, 0, 0])).toBe(0);
  });

  it("picks the highest plain v-tag and ignores the rest", () => {
    expect(latestTag(["v1.0.4", "v1.1.2", "v1.10.0-rc.1", "v1.9.0", "nightly", ""])).toBe("v1.9.0");
    expect(latestTag([])).toBeUndefined();
  });
});

describe("bumpPackageJson", () => {
  it("changes only the version field", () => {
    const before = `{\n  "name": "conduit",\n  "version": "1.1.2",\n  "deps": { "x": "1.1.2" }\n}\n`;
    expect(bumpPackageJson(before, "2.0.0")).toBe(
      `{\n  "name": "conduit",\n  "version": "2.0.0",\n  "deps": { "x": "1.1.2" }\n}\n`,
    );
  });

  it("throws when there is no top-level version field", () => {
    expect(() => bumpPackageJson(`{\n  "name": "x"\n}\n`, "2.0.0")).toThrow(/no top-level "version"/);
    expect(() => bumpPackageJson(`{\n  "engines": {\n    "version": "9.9.9"\n  }\n}\n`, "2.0.0")).toThrow(
      /no top-level "version"/,
    );
  });

  it("skips a nested version key that comes before the top-level one", () => {
    const before = `{\n  "engines": {\n    "version": "9.9.9"\n  },\n  "version": "1.1.2"\n}\n`;
    expect(bumpPackageJson(before, "2.0.0")).toBe(
      `{\n  "engines": {\n    "version": "9.9.9"\n  },\n  "version": "2.0.0"\n}\n`,
    );
  });
});

describe("rollChangelog", () => {
  const rolled = rollChangelog(CHANGELOG, { version: "2.0.0", date: "2026-10-15", previousTag: "v1.1.2" });

  it("moves the Unreleased body under the new version and leaves Unreleased empty", () => {
    expect(rolled).toContain(
      "## [Unreleased]\n\n## [2.0.0] - 2026-10-15\n\n### Breaking\n\n- Bind loopback by default.\n\n### Added\n\n- A thing.\n\n## [1.0.0] - 2026-08-27",
    );
  });

  it("points Unreleased at the new tag and adds a compare link from the previous tag", () => {
    expect(rolled).toContain(
      `[Unreleased]: ${REPO}/compare/v2.0.0...HEAD\n[2.0.0]: ${REPO}/compare/v1.1.2...v2.0.0\n[1.0.0]: ${REPO}/releases/tag/v1.0.0\n`,
    );
  });

  it("round-trips with releaseNotes", () => {
    expect(releaseNotes(rolled, "2.0.0")).toBe("### Breaking\n\n- Bind loopback by default.\n\n### Added\n\n- A thing.");
  });

  it("refuses a previous tag that is not a plain v-tag, so the compare link never dangles", () => {
    for (const previousTag of ["1.1.2", "v1.1", "v1.1.2-rc.1"]) {
      expect(() => rollChangelog(CHANGELOG, { version: "2.0.0", date: "2026-10-15", previousTag })).toThrow(
        /not a vMAJOR.MINOR.PATCH tag/,
      );
    }
  });

  it("throws without an Unreleased heading or its link reference", () => {
    const opts = { version: "2.0.0", date: "2026-10-15", previousTag: "v1.1.2" };
    expect(() => rollChangelog(CHANGELOG.replace("## [Unreleased]", "## Next"), opts)).toThrow(/no `## \[Unreleased\]`/);
    expect(() => rollChangelog(CHANGELOG.replace(/^\[Unreleased\]: .*\n/m, ""), opts)).toThrow(/no `\[Unreleased\]: `/);
  });

  it("keeps a link reference written inside the body as part of the section", () => {
    const withRef = CHANGELOG.replace("- A thing.\n", "- A thing, see [the RFC][rfc].\n\n[rfc]: https://example.com/rfc\n\n- Another thing.\n");
    const out = rollChangelog(withRef, { version: "2.0.0", date: "2026-10-15", previousTag: "v1.1.2" });
    expect(releaseNotes(out, "2.0.0")).toEndWith("[rfc]: https://example.com/rfc\n\n- Another thing.");
  });

  it("refuses an empty Unreleased section", () => {
    expect(() => rollChangelog(rolled, { version: "2.0.1", date: "2026-10-16", previousTag: "v2.0.0" })).toThrow(
      /empty/,
    );
  });

  it("refuses a version that already has a section", () => {
    expect(() => rollChangelog(CHANGELOG, { version: "1.0.0", date: "2026-10-15", previousTag: "v1.1.2" })).toThrow(
      /already has a section/,
    );
  });

  it("handles a changelog whose only section is Unreleased", () => {
    const only = `# Changelog\n\n## [Unreleased]\n\n- New.\n\n[Unreleased]: ${REPO}/compare/v0.1.0...HEAD\n`;
    expect(rollChangelog(only, { version: "0.2.0", date: "2026-10-15", previousTag: "v0.1.0" })).toBe(
      `# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-15\n\n- New.\n\n[Unreleased]: ${REPO}/compare/v0.2.0...HEAD\n[0.2.0]: ${REPO}/compare/v0.1.0...v0.2.0\n`,
    );
  });
});

describe("releaseNotes", () => {
  it("returns the last section up to the link references", () => {
    expect(releaseNotes(CHANGELOG, "1.0.0")).toBe("### Added\n\n- First release.");
  });

  it("does not match a version that only shares a prefix", () => {
    const withTen = CHANGELOG.replace("## [1.0.0]", "## [1.0.10]");
    expect(() => releaseNotes(withTen, "1.0.1")).toThrow(/no section/);
  });

  it("fails when the version has no section", () => {
    expect(() => releaseNotes(CHANGELOG, "9.9.9")).toThrow(/no section/);
  });
});

describe("run (CLI) against a fixture repo", () => {
  let root: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const PKG = `{\n  "name": "fixture",\n  "version": "1.1.2"\n}\n`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "release-test-"));
    writeFileSync(join(root, "package.json"), PKG);
    writeFileSync(join(root, "CHANGELOG.md"), CHANGELOG);
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    for (const tag of ["v1.0.0", "v1.1.2", "v1.9.0-rc.1"]) git("tag", tag);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("prepare writes both files, taking the previous tag from git", () => {
    expect(run(["prepare", "2.0.0", "--date", "2026-10-15"], root)).toBe(
      "Prepared 2.0.0 (previous tag v1.1.2, dated 2026-10-15).",
    );
    expect(JSON.parse(read("package.json")).version).toBe("2.0.0");
    expect(read("CHANGELOG.md")).toContain("## [2.0.0] - 2026-10-15");
    expect(read("CHANGELOG.md")).toContain(`[2.0.0]: ${REPO}/compare/v1.1.2...v2.0.0`);
    expect(run(["notes", "2.0.0"], root)).toStartWith("### Breaking");
  });

  for (const [why, argv, message] of [
    ["the version equals the latest tag", ["prepare", "1.1.2"], /not greater than the latest tag v1.1.2/],
    ["the version is below the latest tag", ["prepare", "1.0.9"], /not greater than the latest tag/],
    ["--previous-tag lacks its v", ["prepare", "2.0.0", "--previous-tag", "1.1.2"], /needs its leading v/],
    ["--date is malformed", ["prepare", "2.0.0", "--date", "15/10/2026"], /not YYYY-MM-DD/],
    ["a flag has no value", ["prepare", "2.0.0", "--previous-tag", "--date", "2026-10-15"], /--previous-tag needs a value/],
    ["the command is unknown", ["publish", "2.0.0"], /unknown command/],
  ] as const) {
    it(`refuses when ${why}, writing nothing`, () => {
      expect(() => run([...argv], root)).toThrow(message);
      expect(read("package.json")).toBe(PKG);
      expect(read("CHANGELOG.md")).toBe(CHANGELOG);
    });
  }

  it("refuses a version not greater than package.json even when the tags allow it", () => {
    writeFileSync(join(root, "package.json"), PKG.replace("1.1.2", "2.0.0"));
    expect(() => run(["prepare", "2.0.0"], root)).toThrow(/not greater than the package.json version 2.0.0/);
  });

  it("leaves package.json untouched when the CHANGELOG cannot be rolled", () => {
    const empty = CHANGELOG.replace(/## \[Unreleased\][\s\S]*?(?=## \[1\.0\.0\])/, "## [Unreleased]\n\n");
    writeFileSync(join(root, "CHANGELOG.md"), empty);
    expect(() => run(["prepare", "2.0.0"], root)).toThrow(/Unreleased section is empty/);
    expect(read("package.json")).toBe(PKG);
    expect(read("CHANGELOG.md")).toBe(empty);
  });
});
