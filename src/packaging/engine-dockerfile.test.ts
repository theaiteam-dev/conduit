/**
 * WI-435 — Engine Dockerfile: multi-arch, non-root, dispatching entrypoint.
 *
 * The Dockerfile (impl) is the artifact under test. There is no function to
 * import — the deliverable is the Dockerfile's declarative content plus the
 * observable behaviour of the image it produces. Accordingly:
 *
 *   - STATIC content assertions (first FROM pin, USER directive, no --compile,
 *     bun + main.ts entrypoint) run UNCONDITIONALLY. They read the Dockerfile
 *     text directly — explicitly sanctioned by the work item ("a test can assert
 *     on Dockerfile text content … regex the FROM/USER lines").
 *
 *   - BUILD / RUN / INSPECT / HISTORY assertions are gated behind a
 *     docker-availability check (`describe.skipIf(!dockerAvailable)`). When
 *     docker is present they build the real image once and exercise it; when
 *     absent they are reported as SKIPPED (not silently passed).
 *
 *   - The MULTI-ARCH (buildx) assertion is additionally gated behind buildx
 *     availability, since the multi-platform build needs a buildx-capable
 *     builder + qemu emulation.
 *
 * Behavioural contract derived from src/cli/main.ts (the dispatching entry):
 *   - `doctor` runs prereq probes → exit 0 if all pass, 1 if any fail. The probe
 *     report ("state_db_volume:", "model_api_key:", "gateway_base_url:") is
 *     printed on stdout, which is unique to the doctor path.
 *   - A bare container (no .env, no -e) has neither CONDUIT_API_KEY nor
 *     CONDUIT_BASE_URL, so doctor reports FAIL and exits 1 — this doubles as an
 *     NFR-4 guard (a baked .env would auto-load via Bun and make doctor pass).
 *   - `run examples/branching/flow.yaml` loads that flow and hits the Slack-egress
 *     boot guard ("…SLACK_BOT_TOKEN…") → exit 1, proving the example is present
 *     in the image and the path was forwarded verbatim to `conduit run`.
 *   - `run <bad path>` echoes the path verbatim in a FILE_READ_ERROR.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Paths & capability probes (computed once at module load)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const DOCKERFILE_PATH = join(REPO_ROOT, 'Dockerfile');
const IMAGE_TAG = 'conduit-engine-test:wi435';
const STATE_VOLUME = 'conduit_engine_test_data_wi435';

function commandSucceeds(argv: string[]): boolean {
  try {
    const r = Bun.spawnSync(argv, { stdout: 'ignore', stderr: 'ignore' });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

const dockerAvailable = commandSucceeds(['docker', 'info']);
const buildxAvailable = dockerAvailable && commandSucceeds(['docker', 'buildx', 'version']);

/**
 * The multi-arch build needs more than buildx being INSTALLED: the active
 * builder must be able to target linux/arm64 (QEMU/binfmt registered). GitHub
 * runners ship buildx but no arm64 emulation, so gating on `buildx version`
 * alone opens the gate and fails the build there. Probe the builder's actual
 * platform list instead.
 */
const arm64BuilderAvailable =
  buildxAvailable &&
  (() => {
    try {
      const r = Bun.spawnSync(['docker', 'buildx', 'inspect'], { stdout: 'pipe', stderr: 'ignore' });
      return r.exitCode === 0 && new TextDecoder().decode(r.stdout).includes('linux/arm64');
    } catch {
      return false;
    }
  })();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readDockerfile(): string {
  // In the RED phase (no Dockerfile yet) this throws ENOENT and the static
  // tests fail for the right reason — the impl does not exist.
  return readFileSync(DOCKERFILE_PATH, 'utf-8');
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

function runImage(args: string[]): RunResult {
  const r = Bun.spawnSync(['docker', 'run', '--rm', ...args], { cwd: REPO_ROOT });
  const stdout = r.stdout ? r.stdout.toString() : '';
  const stderr = r.stderr ? r.stderr.toString() : '';
  return { exitCode: r.exitCode ?? -1, stdout, stderr, combined: stdout + stderr };
}

// ===========================================================================
// STATIC CONTENT — unconditional (no docker required)
// ===========================================================================

describe('engine Dockerfile — static content (unconditional)', () => {
  it('pins the runtime stage (the last FROM) to exactly oven/bun:1.3.11-slim (FR-13)', () => {
    const content = readDockerfile();
    const fromLines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^FROM\s+/i.test(l));

    expect(fromLines.length).toBeGreaterThan(0);

    // Image reference is the first token after FROM (drop any `AS <stage>`).
    // The image is the last stage; earlier stages only build artifacts it
    // copies in (the llexec helper, issue #122).
    const runtimeRef = fromLines[fromLines.length - 1]!.replace(/^FROM\s+/i, '').split(/\s+/)[0];
    expect(runtimeRef).toBe('oven/bun:1.3.11-slim');
    // Every earlier stage is a named build stage, so none can become the image by accident.
    for (const line of fromLines.slice(0, -1)) {
      expect(line).toMatch(/\sAS\s+\S+$/i);
    }
  });

  it('declares no Bun version other than 1.3.11-slim (single authoritative pin)', () => {
    const content = readDockerfile();

    // Every oven/bun:<tag> reference must be the authoritative pin.
    const bunTags = [...content.matchAll(/oven\/bun:(\S+)/g)].map((m) => m[1]!);
    expect(bunTags.length).toBeGreaterThan(0);
    for (const tag of bunTags) {
      expect(tag).toBe('1.3.11-slim');
    }

    // No competing 1.3.x version pin (e.g. a stray 1.3.10 / 1.3.14 typo).
    const strayVersions = [...content.matchAll(/1\.3\.(\d+)/g)]
      .map((m) => m[0])
      .filter((v) => v !== '1.3.11');
    expect(strayVersions).toEqual([]);
  });

  it('sets a non-root default USER', () => {
    const content = readDockerfile();
    const userLines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^USER\s+/i.test(l));

    expect(userLines.length).toBeGreaterThan(0);

    // The effective default user is the last USER directive.
    const lastUser = userLines[userLines.length - 1]!.replace(/^USER\s+/i, '').trim();
    expect(lastUser.length).toBeGreaterThan(0);
    expect(lastUser).not.toBe('root');
    expect(lastUser).not.toBe('0');
    expect(lastUser).not.toBe('0:0');
  });

  it('runs src/cli/main.ts via Bun with no --compile/build step (AC6)', () => {
    const content = readDockerfile();

    // Executes the TypeScript entry directly — no ahead-of-time compile/bundle.
    expect(content).not.toMatch(/--compile/);
    expect(content).not.toMatch(/\bbun\s+build\b/);

    // The TS entry is referenced and there is a dispatching ENTRYPOINT.
    expect(content).toMatch(/src\/cli\/main\.ts/);
    const lines = content.split('\n');
    expect(lines.some((l) => /^\s*ENTRYPOINT\b/i.test(l))).toBe(true);

    // The entrypoint/cmd invokes bun (executes the .ts directly via Bun).
    const bunDispatch = lines.find(
      (l) => /^\s*(ENTRYPOINT|CMD)\b/i.test(l) && /\bbun\b/.test(l),
    );
    expect(bunDispatch).toBeDefined();
  });
});

// ===========================================================================
// BUILD / RUN / INSPECT — docker-gated
// ===========================================================================

describe.skipIf(!dockerAvailable)('engine Dockerfile — build, run & inspect (docker-gated)', () => {
  let buildExit = -1;
  let buildErr = '';

  beforeAll(() => {
    const r = Bun.spawnSync(['docker', 'build', '-t', IMAGE_TAG, '.'], { cwd: REPO_ROOT });
    buildExit = r.exitCode ?? -1;
    buildErr = r.stderr ? r.stderr.toString() : '';
  }, 300_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rmi', '-f', IMAGE_TAG], { stdout: 'ignore', stderr: 'ignore' });
    Bun.spawnSync(['docker', 'volume', 'rm', '-f', STATE_VOLUME], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
  });

  it('docker build succeeds on the host architecture (AC1)', () => {
    if (buildExit !== 0) {
      // Surface the build failure tail to make diagnosis easy without weakening
      // the assertion below.
      console.error(`docker build failed (exit ${buildExit}):\n${buildErr.slice(-800)}`);
    }
    expect(buildExit).toBe(0);
  });

  it("dispatches `doctor` and exits 0 when prereqs are satisfied (AC3)", () => {
    // Fake (non-secret) values satisfy the env-presence probes; /data must be
    // writable by the non-root user for the state_db_volume probe to pass.
    const res = runImage([
      '-v',
      `${STATE_VOLUME}:/data`,
      '-e',
      'CONDUIT_API_KEY=test-not-a-real-key',
      '-e',
      'CONDUIT_BASE_URL=http://example.invalid',
      IMAGE_TAG,
      'doctor',
    ]);
    expect(res.exitCode).toBe(0);
    // Probe report on stdout is unique to the doctor path → proves dispatch.
    expect(res.stdout).toContain('state_db_volume:');
    expect(res.stdout).toContain('model_api_key:');
    expect(res.stdout).toContain('gateway_base_url:');
  }, 60_000);

  it('fails doctor when /data is not a mounted volume, even if env probes pass (FR-7)', () => {
    const res = runImage([
      '-e',
      'CONDUIT_API_KEY=test-not-a-real-key',
      '-e',
      'CONDUIT_BASE_URL=http://example.invalid',
      IMAGE_TAG,
      'doctor',
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('state_db_volume: FAIL');
    expect(res.stdout).toContain('not a mounted volume');
  }, 60_000);

  it("dispatches `doctor` and exits with doctor's failure code in a bare container (AC3 + NFR-4)", () => {
    // No -e flags and (per NFR-4) no baked .env → key/base-url probes FAIL →
    // doctor's own exit code is 1. A baked .env would auto-load via Bun and make
    // this pass, so this also guards the secret-free-image requirement.
    const res = runImage([IMAGE_TAG, 'doctor']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('model_api_key: FAIL');
  }, 60_000);

  it('dispatches `run examples/branching/flow.yaml` with the example present (AC4)', () => {
    // The example flow loads (its prompt files must be in the image), then hits
    // the Slack-egress boot guard — proving `run` got the path verbatim and the
    // example is bundled. "unknown command" would mean dispatch failed.
    //
    // `run` now invokes the doctor pre-flight gate (WI-437, FR-2), whose base
    // probes include the env-presence checks model_api_key / gateway_base_url.
    // Supply non-secret dummy values (same pattern as the AC3 doctor test above)
    // so the gate passes and dispatch proceeds to flow loading; these are
    // existence checks, not real connectivity, so an unreachable URL is fine.
    const res = runImage([
      '-v',
      `${STATE_VOLUME}:/data`,
      '-e',
      'CONDUIT_API_KEY=test-not-a-real-key',
      '-e',
      'CONDUIT_BASE_URL=http://example.invalid',
      IMAGE_TAG,
      'run',
      'examples/branching/flow.yaml',
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.combined).toContain('SLACK_BOT_TOKEN');
    expect(res.combined).not.toContain('unknown command');
  }, 60_000);

  it('forwards the run argument verbatim to conduit run (AC4)', () => {
    const sentinel = '/nonexistent/MURDOCK_SENTINEL_flow.yaml';
    // Dummy env so the WI-437 run pre-flight gate (env-presence base probes)
    // passes and dispatch reaches flow loading — see the AC4 test above.
    const res = runImage([
      '-v',
      `${STATE_VOLUME}:/data`,
      '-e',
      'CONDUIT_API_KEY=test-not-a-real-key',
      '-e',
      'CONDUIT_BASE_URL=http://example.invalid',
      IMAGE_TAG,
      'run',
      sentinel,
    ]);
    expect(res.exitCode).toBe(1);
    // The exact path comes back in the read error → forwarded verbatim.
    expect(res.combined).toContain(sentinel);
    expect(res.combined).toContain('FILE_READ_ERROR');
  }, 60_000);

  it('default USER is a non-root user per docker inspect (AC5)', () => {
    const r = Bun.spawnSync(
      ['docker', 'inspect', '--format', '{{.Config.User}}', IMAGE_TAG],
      { cwd: REPO_ROOT },
    );
    expect(r.exitCode).toBe(0);
    const user = (r.stdout ? r.stdout.toString() : '').trim();
    expect(user.length).toBeGreaterThan(0); // empty == root
    expect(user).not.toBe('root');
    expect(user).not.toBe('0');
    expect(user).not.toBe('0:0');
  }, 60_000);

  it('docker history contains no secret material (NFR-4, AC8)', () => {
    const r = Bun.spawnSync(['docker', 'history', '--no-trunc', IMAGE_TAG], { cwd: REPO_ROOT });
    expect(r.exitCode).toBe(0);
    const history = r.stdout ? r.stdout.toString() : '';

    // No OpenAI-style API key.
    expect(history).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    // No Slack bot/app/refresh token.
    expect(history).not.toMatch(/xox[baprs]-[A-Za-z0-9-]+/);
    // No secret env var baked with a value into a layer.
    expect(history).not.toMatch(/(CONDUIT_API_KEY|OPENAI_API_KEY|SLACK_BOT_TOKEN)=\S+/);
  }, 60_000);
});

// ===========================================================================
// MULTI-ARCH — buildx-gated (needs a multi-platform-capable builder)
// ===========================================================================

describe.skipIf(!arm64BuilderAvailable)('engine Dockerfile — multi-arch (buildx-gated)', () => {
  it('buildx builds for linux/amd64 and linux/arm64 (AC7)', () => {
    const r = Bun.spawnSync(
      ['docker', 'buildx', 'build', '--platform', 'linux/amd64,linux/arm64', '.'],
      { cwd: REPO_ROOT },
    );
    expect(r.exitCode).toBe(0);
  }, 600_000);
});
