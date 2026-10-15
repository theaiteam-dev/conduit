/**
 * Tests for the release-PR tooling (scripts/release.ts).
 *
 * NOT part of the required `tests` gate: `bun run test` is scoped to `src/`.
 * The advisory Docs workflow runs `bun test scripts/`, which picks this up.
 */
import { describe, expect, it } from "bun:test";
import {
  bumpPackageJson,
  compareVersions,
  latestTag,
  parseVersion,
  releaseNotes,
  rollChangelog,
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
