/**
 * WI-440 — docker-compose.operator.yml: reference operator stack
 * (long-lived listener + per-run kernel + model sidecar + shared state volume).
 *
 * The compose file (impl) is the artifact under test; it doubles as living docs
 * of the operator topology (FR-10/FR-12b). The deliverable is the file's parsed
 * structure plus its validity as a compose file, so:
 *
 *   - TOPOLOGY assertions parse the YAML (via the `yaml` dep already in
 *     package.json) and assert the documented services/volume/env wiring. They
 *     run UNCONDITIONALLY — no docker required.
 *
 *   - The `docker compose config` validity assertion is gated behind a
 *     compose-availability check (`describe.skipIf(!composeAvailable)`); when
 *     compose is absent it is reported SKIPPED, not silently passed.
 *
 * Wiring facts (from the Dockerfile + src/cli/main.ts):
 *   - Per-flow images inherit ENTRYPOINT ["bun", "src/cli/main.ts"], so the
 *     SUBCOMMAND is forwarded as the compose `command`: the listener runs
 *     `listen`, the kernel runs `run`.
 *   - The model-endpoint env var is CONDUIT_BASE_URL (FR-9): both engine services
 *     reach the sidecar through it, never a baked-in endpoint or key.
 *   - DEFAULT_STATE_DB is /data/conduit.sqlite (FR-6) → the shared named state
 *     volume mounts at /data in BOTH engine services (FR-10 shared state).
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

// ---------------------------------------------------------------------------
// Paths & capability probe
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const COMPOSE_PATH = join(REPO_ROOT, 'docker-compose.operator.yml');

function commandSucceeds(argv: string[]): boolean {
  try {
    return Bun.spawnSync(argv, { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
  } catch {
    return false;
  }
}

const composeAvailable = commandSucceeds(['docker', 'compose', 'version']);

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface ComposeFile {
  services?: Record<string, ServiceDef>;
  volumes?: Record<string, unknown>;
}
interface ServiceDef {
  image?: string;
  build?: unknown;
  command?: string | string[];
  entrypoint?: string | string[];
  environment?: Record<string, unknown> | string[];
  env_file?: string | string[];
  profiles?: string[];
  volumes?: Array<string | { type?: string; source?: string; target?: string }>;
}
interface VolumeMount {
  source?: string;
  target: string;
  type?: string;
}

function rawCompose(): string {
  // RED phase (no file yet): ENOENT → tests fail for the right reason.
  return readFileSync(COMPOSE_PATH, 'utf-8');
}

function loadCompose(): ComposeFile {
  return parse(rawCompose()) as ComposeFile;
}

function parseEnv(svc: ServiceDef | undefined): Record<string, string | null> {
  const env = svc?.environment;
  const out: Record<string, string | null> = {};
  if (!env) return out;
  if (Array.isArray(env)) {
    for (const entry of env) {
      const s = String(entry);
      const eq = s.indexOf('=');
      if (eq === -1) out[s] = null;
      else out[s.slice(0, eq)] = s.slice(eq + 1);
    }
  } else {
    for (const [k, v] of Object.entries(env)) out[k] = v === null ? null : String(v);
  }
  return out;
}

function parseVolumes(svc: ServiceDef | undefined): VolumeMount[] {
  const vols = svc?.volumes;
  if (!Array.isArray(vols)) return [];
  return vols.map((v) => {
    if (typeof v === 'string') {
      const parts = v.split(':');
      if (parts.length === 1) return { target: parts[0]! };
      return { source: parts[0], target: parts[1]! };
    }
    return { source: v.source, target: v.target ?? '', type: v.type };
  });
}

/** Flatten entrypoint+command into a token list (handles string or list forms). */
function commandTokens(svc: ServiceDef | undefined): string[] {
  const toToks = (v: string | string[] | undefined): string[] =>
    v == null ? [] : Array.isArray(v) ? v.map(String) : String(v).split(/\s+/).filter(Boolean);
  return [...toToks(svc?.entrypoint), ...toToks(svc?.command)];
}

function isPathSource(src?: string): boolean {
  return !!src && (src.includes('/') || src.startsWith('.') || src.startsWith('$') || src.startsWith('~'));
}

/** A managed (named) volume reference — a bare identifier, not a host path. */
function isNamedVolumeSource(src?: string): boolean {
  return !!src && !isPathSource(src) && /^[A-Za-z0-9][\w.-]*$/.test(src);
}

/** All services whose command is a Conduit runtime subcommand. */
function conduitRuntimeServices(compose: ComposeFile): Array<[string, ServiceDef]> {
  return Object.entries(compose.services ?? {}).filter(
    ([, svc]) => commandTokens(svc).some((tok) => tok === 'listen' || tok === 'run'),
  );
}

/** The engine service whose forwarded subcommand is `sub` ('listen' | 'run'). */
function engineServiceWithSubcommand(
  compose: ComposeFile,
  sub: string,
): [string | undefined, ServiceDef | undefined] {
  for (const [name, svc] of conduitRuntimeServices(compose)) {
    if (commandTokens(svc).includes(sub)) return [name, svc];
  }
  return [undefined, undefined];
}

function isFlowImageRef(image: string | undefined): boolean {
  return typeof image === 'string' && /CONDUIT_FLOW_IMAGE|branching-flow|conduit-engine/.test(image);
}

/** The source name of the /data mount on a service, if any. */
function dataVolumeSource(svc: ServiceDef | undefined): string | undefined {
  return parseVolumes(svc).find((m) => m.target === '/data')?.source;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return new URL('http://' + url).hostname;
  }
}

const SECRET_ENV_KEYS = [
  'CONDUIT_API_KEY',
  'OPENAI_API_KEY',
  'SLACK_BOT_TOKEN',
  'CONDUIT_SLACK_SIGNING_SECRET',
];

// ===========================================================================
// TOPOLOGY — unconditional (parse only, no docker)
// ===========================================================================

describe('docker-compose.operator.yml — topology (static, unconditional)', () => {
  it('parses as YAML and declares the operator services and a named volume (AC1)', () => {
    const compose = loadCompose();
    expect(compose.services).toBeDefined();
    // listener + per-run kernel + model sidecar.
    expect(Object.keys(compose.services ?? {}).length).toBeGreaterThanOrEqual(3);
    // FR-6 named state volume must be declared at the top level.
    expect(compose.volumes).toBeDefined();
    expect(Object.keys(compose.volumes ?? {}).length).toBeGreaterThanOrEqual(1);
  });

  it('declares a listener service: engine image + the `listen` subcommand (AC2, FR-10)', () => {
    const compose = loadCompose();
    const [name, listener] = engineServiceWithSubcommand(compose, 'listen');
    expect(name).toBeDefined();
    expect(isFlowImageRef(listener!.image)).toBe(true);
    // The long-lived listener mode IS the `listen` subcommand (cmdListen blocks
    // serving HTTP); a per-run kernel uses `run`. Pin that distinction.
    expect(commandTokens(listener)).toContain('listen');
    expect(commandTokens(listener)).not.toContain('run');
    expect(commandTokens(listener)).toContain('--flows');
    expect(commandTokens(listener)).toContain('--port');
  });

  it('binds the listener to 0.0.0.0 so its published port reaches it (#44)', () => {
    const compose = loadCompose();
    const [, listener] = engineServiceWithSubcommand(compose, 'listen');
    // `conduit listen` binds 127.0.0.1 by default, which a published port
    // cannot reach inside a container.
    const tokens = commandTokens(listener);
    const i = tokens.indexOf('--bind');
    expect(i).toBeGreaterThan(-1);
    expect(tokens[i + 1]).toBe('0.0.0.0');
  });

  it('declares a per-run kernel service: engine image + the `run` subcommand (AC3, FR-10)', () => {
    const compose = loadCompose();
    const [name, kernel] = engineServiceWithSubcommand(compose, 'run');
    expect(name).toBeDefined();
    expect(isFlowImageRef(kernel!.image)).toBe(true);
    expect(commandTokens(kernel)).toContain('run');
    expect(commandTokens(kernel)).not.toContain('listen');
    expect(commandTokens(kernel)).toEqual(['run', '/flow/flow.yaml']);
    expect(kernel!.profiles ?? []).toContain('run');
  });

  it('mounts the SAME named conduit.sqlite volume at /data in BOTH engine services (AC3/AC4, FR-6/FR-10)', () => {
    const compose = loadCompose();
    const [, listener] = engineServiceWithSubcommand(compose, 'listen');
    const [, kernel] = engineServiceWithSubcommand(compose, 'run');
    expect(listener).toBeDefined();
    expect(kernel).toBeDefined();

    const listenerSrc = dataVolumeSource(listener);
    const kernelSrc = dataVolumeSource(kernel);

    // Both mount something at /data...
    expect(listenerSrc).toBeDefined();
    expect(kernelSrc).toBeDefined();
    // ...the SAME source (shared state)...
    expect(kernelSrc).toBe(listenerSrc);
    // ...which is a managed named volume (not a bind to the ephemeral FS)...
    expect(isNamedVolumeSource(listenerSrc)).toBe(true);
    // ...declared in the top-level volumes section.
    expect(Object.keys(compose.volumes ?? {})).toContain(listenerSrc!);
  });

  it('declares a model sidecar both engine services reference via CONDUIT_BASE_URL (AC5, FR-9)', () => {
    const compose = loadCompose();
    const [listenerName, listener] = engineServiceWithSubcommand(compose, 'listen');
    const [kernelName, kernel] = engineServiceWithSubcommand(compose, 'run');
    expect(listenerName).toBeDefined();
    expect(kernelName).toBeDefined();

    const listenerUrl = parseEnv(listener)['CONDUIT_BASE_URL'];
    const kernelUrl = parseEnv(kernel)['CONDUIT_BASE_URL'];
    expect(typeof listenerUrl).toBe('string');
    expect(typeof kernelUrl).toBe('string');

    // Both endpoints name the SAME declared sidecar service — not an engine svc.
    const listenerSidecar = hostOf(listenerUrl!);
    const kernelSidecar = hostOf(kernelUrl!);
    expect(kernelSidecar).toBe(listenerSidecar);
    expect(listenerSidecar).not.toBe(listenerName);
    expect(listenerSidecar).not.toBe(kernelName);
    expect(Object.keys(compose.services ?? {})).toContain(listenerSidecar);
    expect(compose.services![listenerSidecar]).toBeDefined();
  });

  it('hard-codes no secret values (AC6, FR-5)', () => {
    const raw = rawCompose();
    const compose = loadCompose();

    // No raw provider/Slack tokens anywhere in the file.
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(raw).not.toMatch(/xox[baprs]-[A-Za-z0-9-]+/);

    // Secret-named env values must be interpolated (${VAR}/$VAR) or empty —
    // never a baked literal.
    for (const svc of Object.values(compose.services ?? {})) {
      const env = parseEnv(svc);
      for (const key of SECRET_ENV_KEYS) {
        if (!(key in env)) continue;
        const value = env[key];
        if (value === null || value === '') continue; // passthrough / empty is fine
        expect(value.startsWith('$')).toBe(true);
      }
      // Any env_file must be a .env-style file (covered by .gitignore/.dockerignore).
      const envFiles = svc?.env_file;
      const list = Array.isArray(envFiles) ? envFiles : envFiles ? [envFiles] : [];
      for (const f of list) {
        expect(String(f)).toMatch(/\.env(\.|$)/);
      }
    }
  });
});

// ===========================================================================
// COMPOSE VALIDATION — docker-gated
// ===========================================================================

describe.skipIf(!composeAvailable)(
  'docker-compose.operator.yml — compose validation (docker-gated)',
  () => {
    it('docker compose config validates the file (AC1)', () => {
      const r = Bun.spawnSync(['docker', 'compose', '-f', COMPOSE_PATH, 'config', '-q'], {
        cwd: REPO_ROOT,
      });
      if (r.exitCode !== 0) {
        console.error(
          `docker compose config failed:\n${r.stderr ? r.stderr.toString().slice(-800) : ''}`,
        );
      }
      expect(r.exitCode).toBe(0);
    }, 60_000);
  },
);
