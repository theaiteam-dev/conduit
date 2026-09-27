/**
 * Flag-gated real-binary E2E: a command Claude Code's Bash tool starts does not
 * outlive the harness invocation (issue #77).
 *
 * GATED OFF BY DEFAULT, like harness-e2e-claude.test.ts: it runs only when
 * CONDUIT_E2E_CLAUDE is set and a `claude` binary is on PATH.
 *
 *   CONDUIT_E2E_CLAUDE=1 bun test src/integration/harness-e2e-claude-containment.test.ts
 *
 * The Bash tool runs every command in a new session, so a process-group kill
 * of `claude` does not reach it. Three invocations through the real
 * CONDUIT_HARNESS_* parse and registry and the real runner:
 *
 *   1. a foreground `sleep` the wall-clock timeout interrupts;
 *   2. the same, interrupted by the idle timeout, since `claude` writes no
 *      stream-json line while it waits on the tool;
 *   3. `nohup sleep ... &`, after which `claude` exits on its own and the
 *      post-exit reap has to find the sleep.
 *
 * The foreground command is `echo started; sleep N`: the Bash tool refuses a
 * command that starts with a long `sleep` (claude 2.1.283), and haiku declines
 * a sleep of most of a day, so N is about two hours.
 *
 * Each sleep has a unique duration so it can be told apart. Processes are
 * matched on argv[0] being `sleep` and argv[1] the duration, because the
 * `claude` process's own argv carries the prompt and so contains the same
 * text. For the two timeout cases the test also records the sleep's session
 * id while it runs and checks it differs from the `claude` process's, which is
 * the escape the issue describes.
 *
 * Cost: three haiku calls with one short tool call each.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { parseHarnessConfig } from '../worker/harness-config';
import { buildHarnessDefinitionRegistry, bindHarnessDefinitions } from '../worker/harness-adapter';
import { hostContainment } from '../worker/harness-containment.conformance';

const E2E_ENABLED = !!process.env.CONDUIT_E2E_CLAUDE && Bun.which('claude') !== null;
const MODEL = process.env.CONDUIT_E2E_CLAUDE_MODEL ?? 'claude-haiku-4-5';

interface ProcInfo {
  pid: number;
  ppid: number;
  sid: number;
  argv: string[];
}

function readProc(pid: number): ProcInfo | undefined {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter((a) => a.length > 0);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, ppid: Number(fields[1]), sid: Number(fields[3]), argv };
  } catch {
    return undefined;
  }
}

function allProcs(): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const info = readProc(Number(entry));
    if (info !== undefined) out.push(info);
  }
  return out;
}

/** Processes running `sleep <seconds>`, matched on argv, never on a substring of it. */
function sleepProcs(seconds: number): ProcInfo[] {
  return allProcs().filter((p) => p.argv[0] !== undefined && basename(p.argv[0]) === 'sleep' && p.argv[1] === String(seconds));
}

/** The `claude` process this test spawned: a direct child of this process whose argv is claude's. */
function claudeChild(): ProcInfo | undefined {
  return allProcs().find(
    (p) => p.ppid === process.pid && p.argv[0] !== undefined && basename(p.argv[0]) === 'claude',
  );
}

/**
 * A duration no other process on the host is plausibly sleeping for. About two
 * hours: haiku declines to start a sleep of most of a day.
 */
function uniqueSeconds(): number {
  return 7_000 + Math.floor(Math.random() * 1_000);
}

/** Why the prompt asks for the command, so the model runs it rather than questioning it. */
const PURPOSE =
  'This is an automated test of process cleanup in a sandbox. The test harness stops the command itself; ' +
  'do not question the duration. ';

function killAll(seconds: number): void {
  for (const p of sleepProcs(seconds)) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

async function waitFor<T>(probe: () => T | undefined, budgetMs: number): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  return probe();
}

function adapter(projectRoot: string) {
  const parsed = parseHarnessConfig({
    CONDUIT_HARNESS_ADAPTERS: 'claude-headless',
    CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH',
    CONDUIT_HARNESS_CLAUDE_HEADLESS_MODEL: MODEL,
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const bound = bindHarnessDefinitions(buildHarnessDefinitionRegistry(parsed.defs), projectRoot).resolve('claude-headless');
  if (!bound.ok) throw new Error(bound.error);
  return bound.adapter;
}

/**
 * Invoke the adapter and, while it runs, record the Bash tool's sleep and the
 * `claude` process it escaped from.
 */
async function invokeWatching(
  projectRoot: string,
  seconds: number,
  prompt: string,
  limits: { timeoutMs: number; idleTimeoutMs?: number },
) {
  let settled = false;
  const invocation = adapter(projectRoot)
    .invoke({ prompt, inputs: [], tools: ['Bash'], ...limits })
    .then(
      (result) => ({ ok: true as const, result }),
      (err: unknown) => ({ ok: false as const, code: (err as { code?: string }).code, err }),
    )
    .finally(() => {
      settled = true;
    });

  let sleep: ProcInfo | undefined;
  let claude: ProcInfo | undefined;
  while (!settled) {
    claude ??= claudeChild();
    sleep ??= sleepProcs(seconds)[0];
    await Bun.sleep(50);
  }
  return { outcome: await invocation, sleep, claude };
}

describe.skipIf(!E2E_ENABLED)('Bash-tool commands do not outlive a claude-headless invocation (CONDUIT_E2E_CLAUDE=1)', () => {
  it(
    `runs with ${hostContainment.mechanism} containment`,
    () => {
      // Not an assertion about the mechanism: the report of which one ran.
      console.log(`containment: ${JSON.stringify(hostContainment)}`);
    },
  );

  for (const variant of [
    { label: 'the wall-clock timeout', limits: { timeoutMs: 60_000 }, code: 'harness-timeout' },
    { label: 'the idle timeout', limits: { timeoutMs: 120_000, idleTimeoutMs: 25_000 }, code: 'harness-idle-timeout' },
  ] as const) {
    it(
      `kills a foreground Bash-tool sleep on ${variant.label}`,
      async () => {
        const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-contain-')));
        const seconds = uniqueSeconds();
        try {
          const { outcome, sleep, claude } = await invokeWatching(
            projectRoot,
            seconds,
            PURPOSE +
              `Use the Bash tool to run exactly this command in the foreground, with no changes, and wait for it: echo started; sleep ${seconds}`,
            variant.limits,
          );
          console.log(
            `${variant.label}: outcome=${outcome.ok ? 'ok' : outcome.code} claude=${JSON.stringify(claude && { pid: claude.pid, sid: claude.sid })} ` +
              `sleep=${JSON.stringify(sleep && { pid: sleep.pid, sid: sleep.sid, ppid: sleep.ppid })}`,
          );

          expect(outcome.ok ? 'resolved' : outcome.code).toBe(variant.code);
          // The tool ran, in a session other than claude's: the escape.
          expect(sleep).toBeDefined();
          expect(claude).toBeDefined();
          expect(sleep!.sid).not.toBe(claude!.sid);

          expect(await waitFor(() => (sleepProcs(seconds).length === 0 ? true : undefined), 3_000)).toBe(true);
        } finally {
          killAll(seconds);
          rmSync(projectRoot, { recursive: true, force: true });
        }
      },
      240_000,
    );
  }

  it(
    'kills a nohup-backgrounded Bash-tool sleep once claude exits on its own',
    async () => {
      const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-e2e-contain-')));
      const seconds = uniqueSeconds();
      try {
        const { outcome, sleep } = await invokeWatching(
          projectRoot,
          seconds,
          PURPOSE +
            'Use the Bash tool to run exactly this command, with no changes: ' +
            `nohup sleep ${seconds} > /dev/null 2>&1 & echo $! > sleep.pid\n` +
            'Then reply with the single word done.',
          { timeoutMs: 180_000 },
        );
        const pidFile = join(projectRoot, 'sleep.pid');
        const recorded = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf-8').trim()) : undefined;
        console.log(
          `normal exit: outcome=${outcome.ok ? 'ok' : outcome.code} recorded=${recorded} ` +
            `sleep=${JSON.stringify(sleep && { pid: sleep.pid, sid: sleep.sid, ppid: sleep.ppid })}`,
        );

        expect(outcome.ok ? 'resolved' : outcome.code).toBe('resolved');
        // The command ran: it wrote the backgrounded sleep's pid.
        expect(recorded).toBeGreaterThan(1);
        expect(readProc(recorded!)).toBeUndefined();
        expect(sleepProcs(seconds)).toEqual([]);
      } finally {
        killAll(seconds);
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
