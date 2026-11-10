/**
 * State DB schema mismatch (issue #50): when the state DB's `PRAGMA
 * user_version` is one the binary cannot open, the real `conduit` CLI exits
 * nonzero with a message that says which side is newer and what to do, and
 * leaves the stamp unchanged.
 *
 * Two directions:
 * - the DB is newer than the binary (written by a newer Conduit, as after an
 *   image rollback): the message says to upgrade the binary or image and that
 *   rolling back past a migration is not supported;
 * - the DB is older than the oldest version the binary migrates (version 1):
 *   the message says no migration ran and why.
 *
 * The binary's own schema version is not imported. The newer-DB case stamps a
 * version far above any the kernel will reach, and the test reads the
 * binary's version back from the "supports up to version N" text, then checks
 * that a fresh DB opened by the CLI is stamped with that same N.
 *
 * Public surfaces asserted: exit code, stderr, and the on-disk
 * `PRAGMA user_version` (the documented way to compare versions before
 * changing an image pin, docs/installation.md).
 *
 * BLACK-BOX: imports only bun:test, bun:sqlite and node built-ins.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONDUIT_ENTRY = join(import.meta.dir, "..", "src", "cli", "main.ts");
const FAR_FUTURE_VERSION = 100_000;

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bb-schema-mismatch-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fresh pair of DB paths under the test root; the state DB is stamped when `version` is given. */
function dbPaths(name: string, version?: number): { state: string; journal: string } {
  const state = join(root, `${name}.state.db`);
  const journal = join(root, `${name}.journal.db`);
  if (version !== undefined) {
    const db = new Database(state);
    db.exec(`PRAGMA user_version = ${version}`);
    db.close();
  }
  return { state, journal };
}

function userVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

async function conduit(args: string[], paths: { state: string; journal: string }): Promise<CliResult> {
  const ambient = Object.entries(process.env).filter(
    (e): e is [string, string] => !e[0].startsWith("CONDUIT_") && e[1] !== undefined,
  );
  const proc = Bun.spawn([process.execPath, CONDUIT_ENTRY, ...args], {
    env: { ...Object.fromEntries(ambient), CONDUIT_STATE_DB: paths.state, CONDUIT_JOURNAL_DB: paths.journal },
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

describe("state DB schema mismatch: the CLI says which side is newer and what to do", () => {
  test("a DB written by a newer Conduit: upgrade the binary or image", async () => {
    const paths = dbPaths("newer", FAR_FUTURE_VERSION);
    const r = await conduit(["run", "status"], paths);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("schema mismatch");
    expect(r.stderr).toContain(paths.state);
    expect(r.stderr).toContain(`schema version ${FAR_FUTURE_VERSION},`);
    expect(r.stderr).toContain("written by a newer Conduit");
    expect(r.stderr).toContain("upgrade the conduit binary or engine image");
    expect(r.stderr).toContain("rolling back past a schema migration is not supported");
    // Not the bare-metal "cannot open the file" hint, which names the env var.
    expect(r.stderr).not.toContain("set CONDUIT_STATE_DB");
    expect(userVersion(paths.state)).toBe(FAR_FUTURE_VERSION);

    // The version the message names is the one this binary stamps on a fresh DB.
    const supported = /supports up to version (\d+)\./.exec(r.stderr);
    expect(supported).not.toBeNull();
    const fresh = dbPaths("fresh");
    const ok = await conduit(["run", "status"], fresh);
    expect(ok.stderr).not.toContain("schema mismatch");
    expect(userVersion(fresh.state)).toBe(Number(supported![1]));
  }, 60_000);

  test("a DB older than the oldest migration: no migration ran, and why", async () => {
    const paths = dbPaths("older", 1);
    const r = await conduit(["doctor"], paths);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("schema mismatch");
    expect(r.stderr).toContain(paths.state);
    expect(r.stderr).toContain("schema version 1,");
    expect(r.stderr).toContain("older than the oldest version this binary can migrate, so no migration ran");
    expect(r.stderr).toContain("start a new state DB");
    expect(userVersion(paths.state)).toBe(1);
  }, 60_000);
});
