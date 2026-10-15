/**
 * Release-PR tooling. See docs/releasing.md for the process.
 *
 *   bun scripts/release.ts prepare <X.Y.Z> [--date YYYY-MM-DD] [--previous-tag vA.B.C]
 *     Bumps package.json and moves the CHANGELOG "Unreleased" section to
 *     `## [X.Y.Z] - date` under a fresh, empty Unreleased heading. The version
 *     must be greater than the newest v* tag and the current package.json
 *     version. The Prepare release workflow runs this and opens the PR.
 *
 *   bun scripts/release.ts notes <X.Y.Z>
 *     Prints the body of the `## [X.Y.Z]` CHANGELOG section. The Release
 *     workflow uses it as the GitHub release notes.
 *
 * The CHANGELOG is hand-curated, so this script only moves text. It never
 * writes an entry.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Semver = readonly [number, number, number];

/** Strict MAJOR.MINOR.PATCH, no leading `v`, no pre-release or build suffix. */
export function parseVersion(input: string): Semver {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(input);
  if (!m) throw new Error(`"${input}" is not a MAJOR.MINOR.PATCH version (no leading v, no suffix)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** The highest `vX.Y.Z` tag, ignoring tags that are not plain versions. */
export function latestTag(tags: readonly string[]): string | undefined {
  let best: { tag: string; v: Semver } | undefined;
  for (const tag of tags) {
    if (!tag.startsWith("v")) continue;
    let v: Semver;
    try {
      v = parseVersion(tag.slice(1));
    } catch {
      continue;
    }
    if (!best || compareVersions(v, best.v) > 0) best = { tag, v };
  }
  return best?.tag;
}

const HEADING = /^## \[/;
const UNRELEASED = /^## \[Unreleased\]\s*$/;

/**
 * Rewrites only the top-level `"version"` field so the rest of package.json
 * keeps its formatting. A nested `"version"` key is skipped: each candidate
 * line is tried, and the one whose rewrite parses to the expected object wins.
 */
export function bumpPackageJson(text: string, version: string): string {
  const expected = JSON.stringify({ ...JSON.parse(text), version });
  for (const m of text.matchAll(/^(\s*"version"\s*:\s*)"[^"]*"/gm)) {
    const candidate = text.slice(0, m.index) + `${m[1]}"${version}"` + text.slice(m.index! + m[0].length);
    if (JSON.stringify(JSON.parse(candidate)) === expected) return candidate;
  }
  throw new Error('package.json has no top-level "version" field on a line of its own');
}

export interface RollOptions {
  version: string;
  date: string;
  previousTag: string;
}

/**
 * Moves the Unreleased body under `## [version] - date`, leaves an empty
 * Unreleased heading above it, and updates the link references at the foot.
 */
export function rollChangelog(text: string, { version, date, previousTag }: RollOptions): string {
  // The tag goes into the compare link verbatim, so it must be a real tag name.
  if (!previousTag.startsWith("v") || !/^\d+\.\d+\.\d+$/.test(previousTag.slice(1))) {
    throw new Error(`previous tag "${previousTag}" is not a vMAJOR.MINOR.PATCH tag`);
  }
  const lines = text.split("\n");
  const start = lines.findIndex((l) => UNRELEASED.test(l));
  if (start === -1) throw new Error("CHANGELOG.md has no `## [Unreleased]` heading");
  if (lines.some((l) => l.startsWith(`## [${version}]`))) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }

  let end = lines.findIndex((l, i) => i > start && HEADING.test(l));
  // No later release section: the body runs to the link references.
  if (end === -1) end = lines.findIndex((l, i) => i > start && /^\[[^\]]+\]: /.test(l));
  if (end === -1) end = lines.length;

  const body = lines.slice(start + 1, end).join("\n").trim();
  if (body === "") throw new Error("the Unreleased section is empty: there is nothing to release");

  const rolled = [
    ...lines.slice(0, start),
    "## [Unreleased]",
    "",
    `## [${version}] - ${date}`,
    "",
    body,
    "",
    ...lines.slice(end),
  ];

  const linkAt = rolled.findIndex((l) => l.startsWith("[Unreleased]: "));
  if (linkAt === -1) throw new Error("CHANGELOG.md has no `[Unreleased]: ` link reference");
  const base = /^\[Unreleased\]: (\S+)\/compare\//.exec(rolled[linkAt]!)?.[1];
  if (!base) throw new Error("the `[Unreleased]` link reference is not a .../compare/... URL");
  rolled.splice(
    linkAt,
    1,
    `[Unreleased]: ${base}/compare/v${version}...HEAD`,
    `[${version}]: ${base}/compare/${previousTag}...v${version}`,
  );
  return rolled.join("\n");
}

/** The body of the `## [version]` section, without its heading. */
export function releaseNotes(text: string, version: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `## [${version}]` || l.startsWith(`## [${version}] `));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);
  let end = lines.findIndex((l, i) => i > start && (HEADING.test(l) || /^\[[^\]]+\]: /.test(l)));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (body === "") throw new Error(`the ${version} section of CHANGELOG.md is empty`);
  return body;
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  return value;
}

function main(argv: string[]): void {
  const [command, version, ...rest] = argv;
  const root = join(import.meta.dir, "..");
  const changelogPath = join(root, "CHANGELOG.md");
  if (!version) throw new Error("usage: bun scripts/release.ts <prepare|notes> <X.Y.Z> [options]");
  const next = parseVersion(version);

  if (command === "notes") {
    process.stdout.write(releaseNotes(readFileSync(changelogPath, "utf8"), version) + "\n");
    return;
  }
  if (command !== "prepare") throw new Error(`unknown command "${command}"`);

  const previousTag =
    flag(rest, "--previous-tag") ??
    latestTag(execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" }).split("\n"));
  if (!previousTag) throw new Error("no v* tag found; pass --previous-tag");
  if (!previousTag.startsWith("v")) throw new Error(`--previous-tag "${previousTag}" needs its leading v`);
  if (compareVersions(next, parseVersion(previousTag.slice(1))) <= 0) {
    throw new Error(`${version} is not greater than the latest tag ${previousTag}`);
  }

  const pkgPath = join(root, "package.json");
  const pkgText = readFileSync(pkgPath, "utf8");
  const current = JSON.parse(pkgText).version as string;
  if (compareVersions(next, parseVersion(current)) <= 0) {
    throw new Error(`${version} is not greater than the package.json version ${current}`);
  }

  const date = flag(rest, "--date") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date "${date}" is not YYYY-MM-DD`);

  // Compute both before writing either, so a CHANGELOG error leaves package.json untouched.
  const changelog = rollChangelog(readFileSync(changelogPath, "utf8"), { version, date, previousTag });
  const pkg = bumpPackageJson(pkgText, version);
  writeFileSync(changelogPath, changelog);
  writeFileSync(pkgPath, pkg);
  console.log(`Prepared ${version} (previous tag ${previousTag}, dated ${date}).`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`release: ${(err as Error).message}`);
    process.exit(1);
  }
}
