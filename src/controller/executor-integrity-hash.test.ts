/**
 * The original integrity-hash work — the MARK_DONE owned-paths integrity gate's tree signature used
 * to be `${mtimeMs}:${size}` (see `snapshotTree` in executor.ts). Both fields
 * are attacker-forgeable: `cp -p` / `touch -r` restores a file's original
 * mtime after an out-of-bounds write, and if the replacement content happens
 * to be the same byte length the escape never enters `diffTouched`'s
 * comparison at all — the tripwire silently misses a real containment
 * breach. This is a security control (SPEC §5/§6, the Law's owned_paths
 * guard), so the signature must be sound against a hostile forger, not just
 * an accidental modification.
 *
 * The fix hashes file bytes (sha256) instead of recording mtime+size. These
 * tests drive the REAL `runExecutor` (in-memory DB, stub adapter, loader-built
 * flow) and pin:
 *
 *   1. A file OUTSIDE owned_paths whose CONTENT changes but whose mtime is
 *      forged back to its exact pre-write value (via `cp -p` + `touch -r`,
 *      the same technique `touch -d`/`utimensat` gives an attacker) is still
 *      detected as touched — the old mtime+size signature would have missed
 *      this because the byte length is unchanged and the timestamp is
 *      restored exactly.
 *   2. A brand-new file outside owned_paths still flags unconditionally —
 *      there is no baseline hash to compare a never-before-seen path against,
 *      so its mere presence in the after-snapshot is itself the violation.
 *
 * Both also check the reworded operator diagnostic (the original integrity-hash work point 3): the
 * message no longer accuses the station outright ("... at station X wrote
 * ...") — it names the undeclared write as EITHER the station escaping its
 * owned_paths OR some other process touching the project root, since the
 * station is often innocent (e.g. the project root changed underneath it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ModelAdapter, ModelCall, ModelResponse } from '../worker/adapter';
import type { RunEngineArgs } from '../cli/main';
import type { FlowConfig } from '../types/kernel';
import { openConduitDB, type ConduitDB, DEFAULT_RUN_ID } from '../persistence/db';
import { ensureCheckpointSchema } from '../checkpoint/checkpoint';
import { loadFlow } from '../flow/load';
import { runExecutor } from './executor';

function makeStubAdapter(): ModelAdapter {
  return {
    async call(_req: ModelCall): Promise<ModelResponse> {
      throw new Error('adapter should not be called by a deterministic-only flow');
    },
  };
}

function makeIO(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines };
}

/** Write an executable POSIX sh script at `<dir>/<name>`; returns its absolute path. */
function writeScript(dir: string, name: string, body: string): string {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, 'utf-8');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** Single deterministic station `corrupt` -> done, `enforce_owned_paths: true`. */
function setupFlow(dir: string, commandPath: string): FlowConfig {
  const flowYaml = `
flow: integrity-hash-test
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 10, max_tokens: 100000 }
  per_card: { max_execution_attempts: 4 }
  liveness: { no_progress_minutes: 3 }
defaults: { cap_policy: scrap, on_dep_scrap: hold, enforce_owned_paths: true }
terminal_lanes: [done, scrap, hold]
security:
  bash:
    allow: ["${commandPath}"]
stations:
  - id: corrupt
    worker: { kind: deterministic, command: "${commandPath}" }
    inputs: []
    outputs: []
    next: done
`;
  writeFileSync(join(dir, 'flow.yaml'), flowYaml);
  const loaded = loadFlow(join(dir, 'flow.yaml'));
  if (!loaded.ok) throw new Error(`fixture flow invalid: ${JSON.stringify(loaded.errors)}`);
  return loaded.flow;
}

function seedCard(db: ConduitDB, ownedPaths: string[]): void {
  db.insertCard({
    run_id: DEFAULT_RUN_ID,
    id: 'c',
    parent_id: null,
    lane: 'corrupt',
    status: 'ready',
    attempt: 0,
    wave: 0,
    owned_paths: ownedPaths,
    rework_count: 0,
  });
}

function openDb(): ConduitDB {
  const db = openConduitDB({ stateDbPath: ':memory:', journalDbPath: ':memory:' });
  ensureCheckpointSchema(db.getStateDb());
  return db;
}

function terminalReason(db: ConduitDB, id = 'c'): string | undefined {
  return db
    .getCardLog(id)
    .filter((e): e is Extract<typeof e, { kind: 'terminal' }> => e.kind === 'terminal')
    .map((e) => e.reason)[0];
}

let projectDir: string;
let originalCwd: string;
let db: ConduitDB | null;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'conduit-integrity-hash-'));
  process.chdir(projectDir);
  db = null;
});

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

describe('integrity gate — content hash vs. forged mtime (the integrity-hash work)', () => {
  it('detects a content change even when the mtime is forged back to its exact original value', async () => {
    // secret.txt is OUTSIDE the card's owned_paths — any touch to it is an
    // escape. Same byte length before/after (10 'A's -> 10 'B's) so the OLD
    // mtime+size signature would see an unchanged size; mtime is explicitly
    // restored via cp -p + touch -r (the `touch -d`/`utimensat` attacker
    // technique the issue describes) so the OLD signature would ALSO see an
    // unchanged timestamp — a complete miss under the old scheme.
    writeFileSync(join(projectDir, 'secret.txt'), 'AAAAAAAAAA');
    const script = writeScript(
      projectDir,
      'corrupt.sh',
      [
        'cp -p secret.txt secret.txt.stamp', // snapshot the ORIGINAL mtime
        "printf 'BBBBBBBBBB' > secret.txt", // same length, different bytes
        'touch -r secret.txt.stamp secret.txt', // forge the mtime back
        'rm -f secret.txt.stamp',
      ].join('\n'),
    );
    const beforeStat = statSync(join(projectDir, 'secret.txt'));

    const flow = setupFlow(projectDir, script);
    db = openDb();
    seedCard(db, ['task.json']); // does NOT own secret.txt
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter: makeStubAdapter(), io } as RunEngineArgs);

    // Sanity: the forgery actually worked at the filesystem level — content
    // changed, mtime did not.
    const afterStat = statSync(join(projectDir, 'secret.txt'));
    expect(readFileSync(join(projectDir, 'secret.txt'), 'utf-8')).toBe('BBBBBBBBBB');
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.size).toBe(beforeStat.size);

    // Despite the forged mtime and unchanged size, the content-hash signature
    // still catches the escape: the card hard-pauses to hold.
    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');
    const reason = terminalReason(db);
    expect(reason).toMatch(/path_escape/);
    expect(reason).toMatch(/secret\.txt/);
    // Reworded diagnostic (the original integrity-hash work point 3): no longer accuses the station
    // outright — names both possible causes.
    expect(reason).toMatch(/either the station escaped its owned_paths, or another process wrote/);
  });

  it('flags a brand-new file outside owned_paths unconditionally (no baseline hash to compare)', async () => {
    const script = writeScript(projectDir, 'newfile.sh', 'touch newfile.txt');
    const flow = setupFlow(projectDir, script);
    db = openDb();
    seedCard(db, ['task.json']); // does NOT own newfile.txt
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter: makeStubAdapter(), io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');
    const reason = terminalReason(db);
    expect(reason).toMatch(/path_escape/);
    expect(reason).toMatch(/newfile\.txt/);
  });
});

describe('integrity gate — deletes (SPEC §7: a delete is a write)', () => {
  it('holds when the command deletes a file outside owned_paths', async () => {
    writeFileSync(join(projectDir, 'sibling.txt'), 'owned by another card');
    const script = writeScript(projectDir, 'rm.sh', 'rm sibling.txt');
    const flow = setupFlow(projectDir, script);
    db = openDb();
    seedCard(db, ['task.json']);
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter: makeStubAdapter(), io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.status).toBe('held');
    const reason = terminalReason(db);
    expect(reason).toMatch(/path_escape/);
    expect(reason).toMatch(/sibling\.txt/);
  });

  it('does not hold when the command deletes a file inside owned_paths', async () => {
    writeFileSync(join(projectDir, 'task.json'), '{}');
    const script = writeScript(projectDir, 'rm.sh', 'rm task.json');
    const flow = setupFlow(projectDir, script);
    db = openDb();
    seedCard(db, ['task.json']);
    const { io } = makeIO();

    await runExecutor({ db, flow, now: () => 1000, adapter: makeStubAdapter(), io } as RunEngineArgs);

    expect(db.getCard(DEFAULT_RUN_ID, 'c')?.lane).toBe('done');
  });
});
