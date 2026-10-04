/**
 * codex-app-server adapter (issue #21).
 *
 * The adapter is driven through an injected process seam: a scripted JSON-RPC
 * peer that answers the handshake, then runs a scenario that sends approval
 * requests and notifications and records what the adapter answers. No test
 * here starts codex or calls a model.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeHarnessContainmentConformance } from './harness-containment.conformance';
import {
  CODEX_APP_SERVER_ARGS,
  createCodexAppServerHarnessAdapter,
  splitShellWords,
  unwrapShellCommand,
  UNGATED_FEATURES_CHECKED_VERSION,
  resetCodexVersionWarnings,
  runVersionCommand,
  type CodexAppServerHarnessAdapterConfig,
} from './harness-adapter-codex-app-server';
import { resolveContainment } from './cgroup-containment';
import { setsidContainmentRequired } from './containment-fixture-files';
import type { ContainedProcessHandlers, ContainedSpawn, ContainedSpawnSpec } from './harness-contained-spawn';
import {
  bindHarnessDefinitionsForIntrospection, buildHarnessDefinitionRegistry, shippedHarnessAdapterNames,
  type HarnessInvocation, type KnownUsage,
} from './harness-adapter';
import { parseHarnessConfig } from './harness-config';
import type { HarnessEvent } from './harness-events';
import {
  HARNESS_GATE_HOLD_CODE, createHarnessToolGate, type GateDecision, type GateToolCall, type HarnessToolGate,
} from './harness-gate';

describeHarnessContainmentConformance('codex-app-server', (opts) =>
  createCodexAppServerHarnessAdapter({
    ...opts,
    envAllowlist: ['OPENAI_API_KEY'],
    sourceEnv: { PATH: process.env.PATH, OPENAI_API_KEY: 'sk-conformance' },
  }),
);

const PREEXISTING_HOMES = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('conduit-codex-home-')));
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-codex-app-')));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const containment = { mechanism: 'process-group', reason: 'unit test' } as const;
const BASE_ENV = { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'sk-test', SECRET: 'must-not-leak' };

type Json = Record<string, any>;

interface Peer {
  notify(method: string, params: Json): void;
  /** Send a server request and resolve with the client's whole response message. */
  request(method: string, params: Json): Promise<Json>;
  completeTurn(status?: string, error?: Json | null, threadId?: string): void;
  exit(code?: number, signal?: string): void;
  stderr(text: string): void;
  usage(threadId: string, total: Json): void;
  started(item: Json, threadId?: string): void;
  completed(item: Json, threadId?: string): void;
}

interface FakeOptions {
  /** Never answers the handshake. */
  silent?: boolean;
  throwOnSpawn?: boolean;
}

function fakeServer(scenario: (peer: Peer) => Promise<void> | void, opts: FakeOptions = {}) {
  const sent: Json[] = [];
  const state: { spec?: ContainedSpawnSpec; kills: number; closes: number; handlers?: ContainedProcessHandlers } = { kills: 0, closes: 0 };
  const serverPending = new Map<number, (m: Json) => void>();
  let nextServerId = 100;
  const deliver = (m: Json): void => queueMicrotask(() => state.handlers?.onLine(JSON.stringify(m)));
  const notify = (method: string, params: Json): void => deliver({ method, params });
  const peer: Peer = {
    notify,
    request: (method, params) =>
      new Promise((resolve) => {
        const id = nextServerId++;
        serverPending.set(id, resolve);
        deliver({ method, id, params });
      }),
    completeTurn: (status = 'completed', error = null, threadId = 'thr-root') =>
      notify('turn/completed', { threadId, turn: { id: 'turn-1', status, error, items: [] } }),
    exit: (code, signal) => queueMicrotask(() => state.handlers?.onExit(code, signal)),
    stderr: (text) => state.handlers?.onStderr(text),
    usage: (threadId, total) => notify('thread/tokenUsage/updated', { threadId, turnId: 'turn-1', tokenUsage: { total, last: total } }),
    started: (item, threadId = 'thr-root') => notify('item/started', { item, threadId, turnId: 'turn-1' }),
    completed: (item, threadId = 'thr-root') => notify('item/completed', { item, threadId, turnId: 'turn-1' }),
  };
  const reply = (m: Json): void => {
    switch (m.method) {
      case 'initialize':
        deliver({ id: m.id, result: { userAgent: 'fake' } });
        break;
      case 'thread/start':
        deliver({ id: m.id, result: { thread: { id: 'thr-root', model: 'gpt-fake' } } });
        break;
      case 'turn/start':
        deliver({ id: m.id, result: { turn: { id: 'turn-1' } } });
        notify('turn/started', { threadId: 'thr-root', turn: { id: 'turn-1' } });
        void Promise.resolve().then(() => scenario(peer));
        break;
      case 'turn/interrupt':
        deliver({ id: m.id, result: {} });
        break;
    }
  };
  const spawn: ContainedSpawn = (spec, handlers) => {
    state.spec = spec;
    if (opts.throwOnSpawn === true) throw new Error('spawn boom');
    state.handlers = handlers;
    return {
      write(line) {
        const m = JSON.parse(line) as Json;
        sent.push(m);
        if (m.method === undefined && m.id !== undefined && serverPending.has(m.id)) {
          const resolve = serverPending.get(m.id)!;
          serverPending.delete(m.id);
          resolve(m);
          return;
        }
        if (opts.silent !== true) reply(m);
      },
      kill() {
        state.kills += 1;
      },
      async close() {
        state.closes += 1;
      },
    };
  };
  return { spawn, sent, state, peer };
}

function adapterWith(server: { spawn: ContainedSpawn }, extra: Partial<CodexAppServerHarnessAdapterConfig> = {}) {
  return createCodexAppServerHarnessAdapter({
    projectRoot: ROOT,
    envAllowlist: ['OPENAI_API_KEY', 'PATH'],
    command: process.execPath,
    sourceEnv: BASE_ENV,
    containment,
    spawn: server.spawn,
    ...extra,
  });
}

function invocation(extra: Partial<HarnessInvocation> = {}): HarnessInvocation {
  return { prompt: 'do it', inputs: [], tools: ['Bash(cat:*)', 'Write', 'Edit'], timeoutMs: 10_000, ...extra };
}

const allowAll: HarnessToolGate = () => ({ decision: 'allow' });

function spyGate(decide: (c: GateToolCall) => GateDecision = () => ({ decision: 'allow' })) {
  const calls: GateToolCall[] = [];
  const gate: HarnessToolGate = (c) => {
    calls.push(c);
    return decide(c);
  };
  return { calls, gate };
}

function collect(): { events: HarnessEvent[]; onEvent: (e: HarnessEvent) => void } {
  const events: HarnessEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

async function rejection(p: Promise<unknown>): Promise<Error & { code?: string; usage?: KnownUsage; resetAtMs?: number }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('expected the invocation to reject');
}

const deny = (code: 'not_allowlisted' | 'path_escape' = 'not_allowlisted'): GateDecision => ({ decision: 'deny', code, reason: 'nope' });
const hold: GateDecision = { decision: 'hold', code: 'needs_human', reason: 'ask a human' };

const CMD = (command: string, extra: Json = {}): Json => ({
  kind: 'command', threadId: 'thr-root', turnId: 'turn-1', itemId: 'item-1', command, cwd: ROOT, commandActions: [], ...extra,
});
const wrap = (script: string): string => `/usr/bin/zsh -lc '${script}'`;
/** Command and file-change approvals answer `{ decision }`. */
const decisionOf = (m: Json): unknown => m.result?.decision;
/** MCP elicitations answer `{ action }`. */
const actionOf = (m: Json): unknown => m.result?.action;

/** Run a scenario that sends one request per entry, records the client's answers, then completes the turn. */
async function answers(
  requests: Array<[string, Json]>,
  gate: HarnessToolGate | undefined,
  opts: { setup?: (p: Peer) => void; events?: boolean } = {},
): Promise<{ answers: Json[]; events: HarnessEvent[]; sent: Json[] }> {
  const out: Json[] = [];
  const server = fakeServer(async (p) => {
    opts.setup?.(p);
    for (const [method, params] of requests) out.push(await p.request(method, params));
    p.completeTurn();
  });
  const { events, onEvent } = collect();
  await adapterWith(server).invoke(invocation({ ...(gate !== undefined ? { gate } : {}), onEvent }));
  return { answers: out, events, sent: server.sent };
}

const USAGE_A = { totalTokens: 120, inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 };

describe('codex-app-server adapter: capabilities', () => {
  it('names itself, reports usage, restricts tools and gates per call', () => {
    const a = createCodexAppServerHarnessAdapter({ projectRoot: ROOT, envAllowlist: [] });
    expect(a.name).toBe('codex-app-server');
    expect(a.reportsUsage).toBe(true);
    expect(a.canRestrictTools).toBe(true);
    expect(a.canGatePerCall).toBe(true);
  });

  it('probes the resolved binary, and reports a missing one', async () => {
    const present = createCodexAppServerHarnessAdapter({ projectRoot: ROOT, envAllowlist: [], command: process.execPath });
    expect((await present.probeBinary()).present).toBe(true);
    const missing = createCodexAppServerHarnessAdapter({ projectRoot: ROOT, envAllowlist: [], command: 'no-such-codex-binary', sourceEnv: { PATH: '/usr/bin' } });
    const probe = await missing.probeBinary();
    expect(probe.present).toBe(false);
    expect(probe.detail).toContain('no-such-codex-binary');
  });

  it('includes the codex version in the probe detail', async () => {
    const a = createCodexAppServerHarnessAdapter({
      projectRoot: ROOT, envAllowlist: [], command: process.execPath,
      readVersion: async () => `codex-cli ${UNGATED_FEATURES_CHECKED_VERSION}`,
    });
    const probe = await a.probeBinary();
    expect(probe.detail).toBe(`${process.execPath} (codex-cli ${UNGATED_FEATURES_CHECKED_VERSION})`);
  });

  it('notes the checked version when the installed one differs', async () => {
    const a = createCodexAppServerHarnessAdapter({
      projectRoot: ROOT, envAllowlist: [], command: process.execPath, readVersion: async () => 'codex-cli 9.9.9',
    });
    expect((await a.probeBinary()).detail).toBe(
      `${process.execPath} (codex-cli 9.9.9, ungated built-ins checked against ${UNGATED_FEATURES_CHECKED_VERSION})`,
    );
  });

  it('falls back to the path when the version command fails or throws', async () => {
    for (const readVersion of [async () => undefined, async () => { throw new Error('boom'); }]) {
      const a = createCodexAppServerHarnessAdapter({ projectRoot: ROOT, envAllowlist: [], command: process.execPath, readVersion });
      const probe = await a.probeBinary();
      expect(probe).toEqual({ present: true, detail: process.execPath });
    }
  });

  it('reads a real version from the default runner', async () => {
    const a = createCodexAppServerHarnessAdapter({ projectRoot: ROOT, envAllowlist: [], command: process.execPath });
    expect((await a.probeBinary()).detail).toMatch(/^\S+ \(\d+\.\d+\.\d+/);
  });

  describe('the version command', () => {
    // A stand-in codex that prints a version, starts a backgrounded child and, where the host has
    // `setsid`, one in its own session, records their pids and its cwd under $HOME, then exits or hangs.
    const STUB = `#!/bin/sh
( while :; do sleep 0.1; done ) </dev/null >/dev/null 2>&1 &
echo "$!" > "$HOME/bg.pid"
if command -v setsid >/dev/null 2>&1; then
  setsid -f sh -c 'echo "$$" > "$HOME/setsid.pid"; while :; do sleep 0.1; done' </dev/null >/dev/null 2>&1
  while [ ! -s "$HOME/setsid.pid" ]; do sleep 0.01; done
fi
pwd > "$HOME/cwd"
echo "codex-cli 1.2.3"
[ "$MODE" = hang ] && exec sleep 60
exit 0
`;
    const alive = (pid: number): boolean => {
      try {
        // Field 3 of /proc/<pid>/stat is the state: a zombie is dead, only not yet reaped.
        return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
      } catch {
        return false;
      }
    };
    const eventuallyDead = async (pid: number): Promise<boolean> => {
      for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(50);
      return !alive(pid);
    };

    const setup = (mode: 'exit' | 'hang') => {
      const home = mkdtempSync(join(tmpdir(), 'conduit-codex-version-test-'));
      const bin = join(home, 'codex');
      writeFileSync(bin, mode === 'hang' ? STUB.replace('#!/bin/sh\n', '#!/bin/sh\nMODE=hang\n') : STUB, { mode: 0o755 });
      return { home, bin };
    };
    const pids = (home: string): number[] =>
      ['bg.pid', 'setsid.pid']
        .filter((f) => existsSync(join(home, f)))
        .map((f) => Number(readFileSync(join(home, f), 'utf8').trim()));

    it('runs outside the kernel cwd, in a directory it removes, and reaps what the binary left running', async () => {
      const hostContainment = await resolveContainment();
      const { home, bin } = setup('exit');
      try {
        const version = await runVersionCommand(bin, { PATH: '/usr/bin:/bin', HOME: home }, hostContainment);
        expect(version).toBe('codex-cli 1.2.3');
        const cwd = readFileSync(join(home, 'cwd'), 'utf8').trim();
        expect(cwd).not.toBe(process.cwd());
        expect(existsSync(cwd)).toBe(false);
        const [bg, setsid] = pids(home);
        expect(await eventuallyDead(bg!)).toBe(true);
        if (setsid !== undefined && setsidContainmentRequired(hostContainment)) expect(await eventuallyDead(setsid)).toBe(true);
      } finally {
        for (const pid of pids(home)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('reports no version and kills the whole tree when the binary hangs past the timeout', async () => {
      const hostContainment = await resolveContainment();
      const { home, bin } = setup('hang');
      try {
        const version = await runVersionCommand(bin, { PATH: '/usr/bin:/bin', HOME: home }, hostContainment, 500);
        expect(version).toBeUndefined();
        const [bg, setsid] = pids(home);
        expect(await eventuallyDead(bg!)).toBe(true);
        if (setsid !== undefined && setsidContainmentRequired(hostContainment)) expect(await eventuallyDead(setsid)).toBe(true);
      } finally {
        for (const pid of pids(home)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it('rejects an invocation before spawning when the binary is not found', async () => {
    const server = fakeServer(() => {});
    const a = adapterWith(server, { command: 'no-such-codex-binary' });
    await rejection(a.invoke(invocation()));
    expect(server.state.spec).toBeUndefined();
  });

  it('rejects a project root that does not exist', async () => {
    const server = fakeServer(() => {});
    const err = await rejection(adapterWith(server, { projectRoot: join(ROOT, 'missing') }).invoke(invocation()));
    expect(err.message).toContain('does not exist');
    expect(server.state.spec).toBeUndefined();
  });
});

describe('codex-app-server adapter: version warning', () => {
  async function stderrOf(run: () => Promise<void>): Promise<string> {
    const original = process.stderr.write;
    let out = '';
    process.stderr.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stderr.write;
    try { await run(); } finally { process.stderr.write = original; }
    return out;
  }
  const runOnce = (readVersion: () => Promise<string | undefined>) => async () => {
    const server = fakeServer((p) => p.completeTurn());
    await adapterWith(server, { readVersion }).invoke(invocation());
  };

  it('warns once per binary across two invokes when the version differs', async () => {
    resetCodexVersionWarnings();
    const out = await stderrOf(async () => {
      await runOnce(async () => 'codex-cli 9.9.9')();
      await runOnce(async () => 'codex-cli 9.9.9')();
    });
    expect(out.match(/ungated built-in list/g)?.length).toBe(1);
    expect(out).toContain(UNGATED_FEATURES_CHECKED_VERSION);
    expect(out).toContain('9.9.9');
  });

  it('does not warn when the version matches', async () => {
    resetCodexVersionWarnings();
    const out = await stderrOf(runOnce(async () => `codex-cli ${UNGATED_FEATURES_CHECKED_VERSION}`));
    expect(out).toBe('');
  });

  it('warns that the version is unknown when it cannot be read, and still runs', async () => {
    for (const readVersion of [async () => undefined, async (): Promise<string | undefined> => { throw new Error('boom'); }]) {
      resetCodexVersionWarnings();
      const out = await stderrOf(runOnce(readVersion));
      expect(out).toContain('is unknown');
    }
  });

  it('re-probes after an unreadable version and warns on the mismatch the second probe reads', async () => {
    resetCodexVersionWarnings();
    let calls = 0;
    const readVersion = async (): Promise<string | undefined> => (++calls === 1 ? undefined : 'codex-cli 9.9.9');
    const out = await stderrOf(async () => {
      await runOnce(readVersion)();
      await runOnce(readVersion)();
      await runOnce(readVersion)();
    });
    expect(calls).toBe(2);
    expect(out).toContain('is unknown');
    expect(out).toContain('is 9.9.9');
    expect(out.match(/ungated built-in list/g)?.length).toBe(2);
  });

  it('writes the unknown line once across a run of unreadable probes', async () => {
    resetCodexVersionWarnings();
    let calls = 0;
    const out = await stderrOf(async () => {
      for (let i = 0; i < 3; i++) await runOnce(async () => { calls++; return undefined; })();
    });
    expect(calls).toBe(3);
    expect(out.match(/is unknown/g)?.length).toBe(1);
  });
});

describe('codex-app-server adapter: handshake', () => {
  it('sends initialize, initialized, thread/start, turn/start in that order', async () => {
    const server = fakeServer((p) => p.completeTurn());
    await adapterWith(server).invoke(invocation({ prompt: 'hello there', model: 'gpt-x' }));
    const requests = server.sent.map((m) => m.method);
    expect(requests).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    expect(server.sent[0]!.params).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(server.sent[1]).not.toHaveProperty('id');
  });

  it('sets the untrusted approval policy on the thread and on every turn, in a workspace-write sandbox', async () => {
    const server = fakeServer((p) => p.completeTurn());
    await adapterWith(server).invoke(invocation({ prompt: 'hello there', model: 'gpt-x' }));
    const thread = server.sent.find((m) => m.method === 'thread/start')!.params;
    expect(thread).toMatchObject({ cwd: ROOT, approvalPolicy: 'untrusted', sandbox: 'workspace-write', ephemeral: true, model: 'gpt-x', approvalsReviewer: 'user' });
    const turn = server.sent.find((m) => m.method === 'turn/start')!.params;
    expect(turn).toMatchObject({ threadId: 'thr-root', approvalPolicy: 'untrusted', input: [{ type: 'text', text: 'hello there' }] });
  });

  it('never sends a message with the jsonrpc field', async () => {
    const server = fakeServer((p) => p.completeTurn());
    await adapterWith(server).invoke(invocation());
    expect(server.sent.every((m) => !('jsonrpc' in m))).toBe(true);
  });

  it('lets the call model win over the adapter default, and omits it when neither is set', async () => {
    const both = fakeServer((p) => p.completeTurn());
    await adapterWith(both, { model: 'default-model' }).invoke(invocation({ model: 'station-model' }));
    expect(both.sent.find((m) => m.method === 'thread/start')!.params.model).toBe('station-model');
    const dflt = fakeServer((p) => p.completeTurn());
    await adapterWith(dflt, { model: 'default-model' }).invoke(invocation());
    expect(dflt.sent.find((m) => m.method === 'thread/start')!.params.model).toBe('default-model');
    const none = fakeServer((p) => p.completeTurn());
    await adapterWith(none).invoke(invocation());
    expect(none.sent.find((m) => m.method === 'thread/start')!.params).not.toHaveProperty('model');
  });

  it('fails with harness-nonzero-exit when thread/start answers with an error', async () => {
    const server = fakeServer(() => {});
    const failing: ContainedSpawn = (spec, handlers) => {
      const proc = server.spawn(spec, handlers);
      return {
        ...proc,
        write(line) {
          const m = JSON.parse(line) as Json;
          if (m.method === 'thread/start') queueMicrotask(() => handlers.onLine(JSON.stringify({ id: m.id, error: { code: -1, message: 'bad thread' } })));
          else proc.write(line);
        },
      };
    };
    const err = await rejection(adapterWith({ spawn: failing }).invoke(invocation()));
    expect(err.code).toBe('harness-nonzero-exit');
    expect(err.message).toContain('bad thread');
  });
});

describe('codex-app-server adapter: process, env and CODEX_HOME', () => {
  it('starts app-server first, with web search and the login shell turned off', async () => {
    const server = fakeServer((p) => p.completeTurn());
    await adapterWith(server).invoke(invocation());
    const args = server.state.spec!.args;
    expect(args[0]).toBe('app-server');
    expect(args).toEqual([...CODEX_APP_SERVER_ARGS]);
    const pairs = args.flatMap((a, i) => (a === '-c' ? [args[i + 1]!] : []));
    expect(pairs).toContain('web_search="disabled"');
    expect(pairs).toContain('allow_login_shell=false');
    expect(pairs).toContain('sandbox_workspace_write.network_access=false');
    expect(pairs).toContain('features.view_image=false');
    expect(server.state.spec!.cwd).toBe(ROOT);
  });

  it('builds the env from the allowlist plus PATH and CODEX_HOME, and nothing else', async () => {
    const server = fakeServer((p) => p.completeTurn());
    await adapterWith(server, { envAllowlist: ['OPENAI_API_KEY'] }).invoke(invocation());
    const env = server.state.spec!.env;
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'OPENAI_API_KEY', 'PATH']);
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.SECRET).toBeUndefined();
  });

  it('replaces an allowlisted CODEX_HOME with the run-scoped one', async () => {
    const server = fakeServer((p) => p.completeTurn());
    await adapterWith(server, {
      envAllowlist: ['OPENAI_API_KEY', 'CODEX_HOME'],
      sourceEnv: { ...BASE_ENV, CODEX_HOME: '/operator/codex' },
    }).invoke(invocation());
    expect(server.state.spec!.env.CODEX_HOME).not.toBe('/operator/codex');
  });

  it('gives the child a codex home with an empty config.toml that is removed after the call', async () => {
    let home = '';
    let configText: string | undefined;
    const server = fakeServer((p) => {
      home = server.state.spec!.env.CODEX_HOME!;
      configText = readFileSync(join(home, 'config.toml'), 'utf-8');
      p.completeTurn();
    });
    await adapterWith(server).invoke(invocation());
    expect(home).toContain('conduit-codex-home-');
    expect(configText).toBe('');
    expect(existsSync(home)).toBe(false);
  });

  it('links the operator auth.json rather than copying it, and never touches the target on cleanup', async () => {
    const operator = mkdtempSync(join(tmpdir(), 'conduit-codex-operator-'));
    try {
      writeFileSync(join(operator, 'auth.json'), '{"tokens":"secret"}');
      let isLink = false;
      let target = '';
      const server = fakeServer((p) => {
        const link = join(server.state.spec!.env.CODEX_HOME!, 'auth.json');
        isLink = lstatSync(link).isSymbolicLink();
        target = realpathSync(link);
        p.completeTurn();
      });
      await adapterWith(server, { envAllowlist: ['PATH'], sourceEnv: { PATH: '/usr/bin', CODEX_HOME: operator } }).invoke(invocation());
      expect(isLink).toBe(true);
      expect(target).toBe(realpathSync(join(operator, 'auth.json')));
      expect(readFileSync(join(operator, 'auth.json'), 'utf-8')).toBe('{"tokens":"secret"}');
    } finally {
      rmSync(operator, { recursive: true, force: true });
    }
  });

  it('removes the codex home when the call fails', async () => {
    const server = fakeServer((p) => p.completeTurn('failed', { message: 'boom', codexErrorInfo: 'other' }));
    await rejection(adapterWith(server).invoke(invocation()));
    expect(existsSync(server.state.spec!.env.CODEX_HOME!)).toBe(false);
  });

  it('removes the codex home when the spawn throws', async () => {
    const server = fakeServer(() => {}, { throwOnSpawn: true });
    const err = await rejection(adapterWith(server).invoke(invocation()));
    expect(err.message).toContain('spawn boom');
    expect(existsSync(server.state.spec!.env.CODEX_HOME!)).toBe(false);
  });

  it('removes the codex home after a timeout kill', async () => {
    const server = fakeServer(() => {}, { silent: true });
    await rejection(adapterWith(server).invoke(invocation({ timeoutMs: 30 })));
    expect(existsSync(server.state.spec!.env.CODEX_HOME!)).toBe(false);
  });

  it('fails before spawning when there is nothing to authenticate with', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'conduit-codex-noauth-'));
    try {
      const server = fakeServer(() => {});
      const err = await rejection(
        adapterWith(server, { envAllowlist: ['PATH'], sourceEnv: { PATH: '/usr/bin', CODEX_HOME: empty } }).invoke(invocation()),
      );
      expect(err.message).toContain('no credentials');
      expect(server.state.spec).toBeUndefined();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('accepts an allowlisted API key when there is no auth.json', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'conduit-codex-noauth-'));
    try {
      const server = fakeServer((p) => p.completeTurn());
      await adapterWith(server, { sourceEnv: { ...BASE_ENV, CODEX_HOME: empty } }).invoke(invocation());
      expect(existsSync(join(server.state.spec!.env.CODEX_HOME!, 'auth.json'))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('kills and closes the process on every exit path', async () => {
    const ok = fakeServer((p) => p.completeTurn());
    await adapterWith(ok).invoke(invocation());
    expect(ok.state.kills).toBeGreaterThan(0);
    expect(ok.state.closes).toBe(1);
    const bad = fakeServer((p) => p.completeTurn('failed', { message: 'x', codexErrorInfo: 'other' }));
    await rejection(adapterWith(bad).invoke(invocation()));
    expect(bad.state.kills).toBeGreaterThan(0);
    expect(bad.state.closes).toBe(1);
  });
});

describe('shell command unwrapping', () => {
  it('reads plain, quoted and escaped words', () => {
    expect(splitShellWords("a 'b c' \"d e\" f\\ g")).toEqual(['a', 'b c', 'd e', 'f g']);
    expect(splitShellWords('')).toEqual([]);
  });

  it('joins adjacent quoted segments, as shlex writes an embedded single quote', () => {
    expect(splitShellWords(`'echo '"'"'hi'"'"''`)).toEqual([`echo 'hi'`]);
  });

  it('returns null for an unbalanced quote, an expansion or an operator', () => {
    expect(splitShellWords("'open")).toBeNull();
    expect(splitShellWords('"open')).toBeNull();
    expect(splitShellWords('"a $HOME"')).toBeNull();
    expect(splitShellWords('"a `x`"')).toBeNull();
    expect(splitShellWords('a; b')).toBeNull();
    expect(splitShellWords('a | b')).toBeNull();
    expect(splitShellWords('a > b')).toBeNull();
    expect(splitShellWords('a\\')).toBeNull();
  });

  it('takes the script out of -lc and -c wrappers', () => {
    expect(unwrapShellCommand("/usr/bin/zsh -lc 'cat a.txt'")).toEqual({ command: 'cat a.txt' });
    expect(unwrapShellCommand("/usr/bin/zsh -c 'cat a.txt'")).toEqual({ command: 'cat a.txt' });
    expect(unwrapShellCommand("bash -lc 'git status'")).toEqual({ command: 'git status' });
    expect(unwrapShellCommand("/bin/sh -c 'ls -la'")).toEqual({ command: 'ls -la' });
  });

  it('keeps quotes inside the script for the gate to refuse', () => {
    expect(unwrapShellCommand(`/usr/bin/zsh -lc 'echo '"'"'hi'"'"''`)).toEqual({ command: `echo 'hi'` });
    expect(unwrapShellCommand(`/usr/bin/zsh -lc "echo \\"hi\\""`)).toEqual({ command: 'echo "hi"' });
    expect(unwrapShellCommand("/usr/bin/zsh -lc 'echo hi > c.txt'")).toEqual({ command: 'echo hi > c.txt' });
  });

  it('unwraps a shell named by a bare name or a canonical system path', () => {
    expect(unwrapShellCommand("/bin/bash -lc 'cat x'")).toEqual({ command: 'cat x' });
    expect(unwrapShellCommand("/usr/bin/zsh -lc 'cat x'")).toEqual({ command: 'cat x' });
    expect(unwrapShellCommand("/usr/local/bin/bash -c 'cat x'")).toEqual({ command: 'cat x' });
    expect(unwrapShellCommand("bash -c 'cat x'")).toEqual({ command: 'cat x' });
  });

  it('returns a wrapper whose shell is at a non-canonical path unchanged, so the gate sees the real executable', () => {
    for (const shown of ["/tmp/evil/bash -c 'cat note.txt'", "./bash -c 'cat x'", "/usr/bin/../../tmp/bash -c 'cat x'", "/bin/sub/bash -c 'cat x'", "/usr/bin/notashell -c 'cat x'"]) {
      expect(unwrapShellCommand(shown)).toEqual({ command: shown });
    }
  });

  it('returns a command that is not a shell wrapper as shown', () => {
    expect(unwrapShellCommand('git status')).toEqual({ command: 'git status' });
    expect(unwrapShellCommand('/usr/bin/zsh script.sh')).toEqual({ command: '/usr/bin/zsh script.sh' });
  });

  it('refuses a wrapper that carries extra positional words, so the gate never sees the raw string', () => {
    for (const shown of ["bash -c 'cat a.txt' extra", "sh -c 'cat a.txt' name arg", "/bin/zsh -lc 'cat a.txt' x"]) {
      expect(unwrapShellCommand(shown)).toEqual({ error: expect.any(String) });
    }
  });

  it('reports a string it cannot parse', () => {
    expect(unwrapShellCommand("zsh -lc 'unterminated")).toEqual({ error: expect.any(String) });
    expect(unwrapShellCommand('   ')).toEqual({ error: expect.any(String) });
  });
});

describe('codex-app-server adapter: command approvals', () => {
  it('hands the unwrapped script to the gate as a Bash call and accepts on allow', async () => {
    const spy = spyGate();
    const r = await answers([['item/commandExecution/requestApproval', CMD(wrap('cat a.txt'))]], spy.gate);
    expect(spy.calls).toEqual([{ toolName: 'Bash', input: { command: 'cat a.txt' }, toolCallId: 'item-1' }]);
    expect(decisionOf(r.answers[0]!)).toBe('accept');
    expect(r.answers[0]!.id).toBeGreaterThanOrEqual(100);
  });

  it('gates a wrapper at a non-canonical shell path as the raw string, never the inner script', async () => {
    const spy = spyGate();
    await answers([['item/commandExecution/requestApproval', CMD("/tmp/evil/bash -c 'cat a.txt'")]], spy.gate);
    expect(spy.calls.map((c) => c.input)).toEqual([{ command: "/tmp/evil/bash -c 'cat a.txt'" }]);
  });

  it('declines on deny', async () => {
    const r = await answers([['item/commandExecution/requestApproval', CMD(wrap('rm -rf x'))]], spyGate(() => deny()).gate);
    expect(decisionOf(r.answers[0]!)).toBe('decline');
  });

  it('answers a hold with cancel', async () => {
    const answered: Json[] = [];
    const server = fakeServer(async (p) => {
      answered.push(await p.request('item/commandExecution/requestApproval', CMD(wrap('cat a.txt'))));
      p.completeTurn('interrupted');
    });
    await rejection(adapterWith(server).invoke(invocation({ gate: () => hold })));
    expect(decisionOf(answered[0]!)).toBe('cancel');
  });

  it('declines a command it cannot parse without asking the gate', async () => {
    const spy = spyGate();
    const r = await answers([['item/commandExecution/requestApproval', CMD("/usr/bin/zsh -lc 'unterminated")]], spy.gate);
    expect(spy.calls).toEqual([]);
    expect(decisionOf(r.answers[0]!)).toBe('decline');
  });

  it('declines a working directory outside the project root without asking the gate', async () => {
    const spy = spyGate();
    const r = await answers(
      [
        ['item/commandExecution/requestApproval', CMD(wrap('cat a.txt'), { cwd: '/etc' })],
        ['item/commandExecution/requestApproval', CMD(wrap('cat a.txt'), { cwd: `${ROOT}/../elsewhere` })],
      ],
      spy.gate,
    );
    expect(spy.calls).toEqual([]);
    expect(r.answers.map(decisionOf)).toEqual(['decline', 'decline']);
  });

  it('accepts a working directory inside the project root', async () => {
    mkdirSync(join(ROOT, 'sub'), { recursive: true });
    const spy = spyGate();
    const r = await answers([['item/commandExecution/requestApproval', CMD(wrap('cat a.txt'), { cwd: join(ROOT, 'sub') })]], spy.gate);
    expect(spy.calls.length).toBe(1);
    expect(decisionOf(r.answers[0]!)).toBe('accept');
  });

  it('declines a working directory that reaches outside through a symlink', async () => {
    const link = join(ROOT, 'escape-link');
    symlinkSync('/etc', link);
    const spy = spyGate();
    const r = await answers([['item/commandExecution/requestApproval', CMD(wrap('cat hostname'), { cwd: link })]], spy.gate);
    expect(spy.calls).toEqual([]);
    expect(decisionOf(r.answers[0]!)).toBe('decline');
  });

  it('declines an approval for input to a running terminal, and a managed-network request', async () => {
    const spy = spyGate();
    const r = await answers(
      [
        ['item/commandExecution/requestApproval', CMD(wrap('cat a.txt'), { kind: 'writeStdin' })],
        ['item/commandExecution/requestApproval', CMD(wrap('cat a.txt'), { networkApprovalContext: { host: 'example.com', protocol: 'https' } })],
      ],
      spy.gate,
    );
    expect(spy.calls).toEqual([]);
    expect(r.answers.map(decisionOf)).toEqual(['decline', 'decline']);
  });

  it('declines a request with no command, no cwd or no params, and never leaves it unanswered', async () => {
    const spy = spyGate();
    const noCommand = CMD('x');
    delete noCommand.command;
    const noCwd = CMD(wrap('cat a.txt'));
    delete noCwd.cwd;
    const r = await answers(
      [
        ['item/commandExecution/requestApproval', noCommand],
        ['item/commandExecution/requestApproval', noCwd],
        ['item/commandExecution/requestApproval', null as unknown as Json],
        ['item/fileChange/requestApproval', 'nonsense' as unknown as Json],
      ],
      spy.gate,
    );
    expect(spy.calls).toEqual([]);
    expect(r.answers.map(decisionOf)).toEqual(['decline', 'decline', 'decline', 'decline']);
  });

  it('declines a shell wrapper with extra words as malformed_input and never asks the gate', async () => {
    const spy = spyGate();
    const r = await answers([['item/commandExecution/requestApproval', CMD("sh -c 'cat a.txt' name arg")]], spy.gate);
    expect(spy.calls).toEqual([]);
    expect(r.answers.map(decisionOf)).toEqual(['decline']);
    expect(r.events.filter((e) => e.type === 'gate-decision')).toMatchObject([{ decision: 'deny', code: 'malformed_input' }]);
  });

  it('runs the real gate: an allowlisted read is accepted and a redirect is declined', async () => {
    const gate = createHarnessToolGate({ projectRoot: ROOT, tools: ['Bash(cat:*)'] });
    const r = await answers(
      [
        ['item/commandExecution/requestApproval', CMD(wrap('cat a.txt'))],
        ['item/commandExecution/requestApproval', CMD(wrap('echo hi > c.txt'))],
        ['item/commandExecution/requestApproval', CMD(wrap('curl -sI https://example.com'))],
      ],
      gate,
    );
    expect(r.answers.map(decisionOf)).toEqual(['accept', 'decline', 'decline']);
  });

  it('declines every request when no gate was supplied', async () => {
    const r = await answers([['item/commandExecution/requestApproval', CMD(wrap('cat a.txt'))]], undefined);
    expect(decisionOf(r.answers[0]!)).toBe('decline');
  });

  it('treats a throwing gate as a deny', async () => {
    const r = await answers([['item/commandExecution/requestApproval', CMD(wrap('cat a.txt'))]], () => {
      throw new Error('gate exploded');
    });
    expect(decisionOf(r.answers[0]!)).toBe('decline');
  });
});

describe('codex-app-server adapter: file change approvals', () => {
  const FILE_REQ = (itemId = 'fc-1', extra: Json = {}): Json => ({
    threadId: 'thr-root', turnId: 'turn-1', itemId, startedAtMs: 1, reason: null, grantRoot: null, ...extra,
  });
  const announce = (changes: Json[], itemId = 'fc-1') => (p: Peer) =>
    p.started({ type: 'fileChange', id: itemId, changes, status: 'inProgress' });
  const change = (path: string, kind: Json, diff = 'x\n'): Json => ({ path, kind, diff });

  it('gates an added file as a Write of its path', async () => {
    const spy = spyGate();
    const r = await answers([['item/fileChange/requestApproval', FILE_REQ()]], spy.gate, {
      setup: announce([change('/p/out/b.txt', { type: 'add' })]),
    });
    expect(spy.calls).toEqual([{ toolName: 'Write', input: { file_path: '/p/out/b.txt' }, toolCallId: 'fc-1' }]);
    expect(decisionOf(r.answers[0]!)).toBe('accept');
  });

  it('gates an updated file as an Edit', async () => {
    const spy = spyGate();
    await answers([['item/fileChange/requestApproval', FILE_REQ()]], spy.gate, {
      setup: announce([change('/p/out/b.txt', { type: 'update', move_path: null })]),
    });
    expect(spy.calls.map((c) => [c.toolName, (c.input as Json).file_path])).toEqual([['Edit', '/p/out/b.txt']]);
  });

  it('gates a delete as a Write', async () => {
    const spy = spyGate();
    await answers([['item/fileChange/requestApproval', FILE_REQ()]], spy.gate, {
      setup: announce([change('/p/out/b.txt', { type: 'delete' })]),
    });
    expect(spy.calls.map((c) => [c.toolName, (c.input as Json).file_path])).toEqual([['Write', '/p/out/b.txt']]);
  });

  it('gates both the source and the destination of a move', async () => {
    const spy = spyGate();
    await answers([['item/fileChange/requestApproval', FILE_REQ()]], spy.gate, {
      setup: announce([change('/p/out/a.txt', { type: 'update', move_path: '/p/elsewhere/a.txt' })]),
    });
    expect(spy.calls.map((c) => [c.toolName, (c.input as Json).file_path])).toEqual([
      ['Edit', '/p/out/a.txt'],
      ['Write', '/p/elsewhere/a.txt'],
    ]);
  });

  for (const type of ['add', 'delete']) {
    it(`declines a ${type} that carries a move_path, without asking the gate`, async () => {
      const spy = spyGate();
      const r = await answers([['item/fileChange/requestApproval', FILE_REQ()]], spy.gate, {
        setup: announce([
          change('/p/out/ok.txt', { type: 'add' }),
          change('/p/out/a.txt', { type, move_path: '/p/elsewhere/a.txt' }),
        ]),
      });
      expect(spy.calls).toEqual([]);
      expect(decisionOf(r.answers[0]!)).toBe('decline');
    });
  }

  it('declines the whole request when any one path is denied, and gates every path', async () => {
    const spy = spyGate((c) => ((c.input as Json).file_path === '/p/bad.txt' ? deny('path_escape') : { decision: 'allow' }));
    const r = await answers([['item/fileChange/requestApproval', FILE_REQ()]], spy.gate, {
      setup: announce([
        change('/p/out/a.txt', { type: 'add' }),
        change('/p/bad.txt', { type: 'add' }),
        change('/p/out/c.txt', { type: 'add' }),
      ]),
    });
    expect(spy.calls.length).toBe(3);
    expect(decisionOf(r.answers[0]!)).toBe('decline');
  });

  it('enforces owned paths through the real gate, including a move out of them', async () => {
    mkdirSync(join(ROOT, 'out'), { recursive: true });
    const gate = createHarnessToolGate({ projectRoot: ROOT, tools: ['Write', 'Edit'], ownedPaths: ['out'] });
    const inside = join(ROOT, 'out', 'b.txt');
    const r = await answers(
      [
        ['item/fileChange/requestApproval', FILE_REQ('fc-in')],
        ['item/fileChange/requestApproval', FILE_REQ('fc-out')],
        ['item/fileChange/requestApproval', FILE_REQ('fc-move')],
      ],
      gate,
      {
        setup: (p) => {
          announce([change(inside, { type: 'add' })], 'fc-in')(p);
          announce([change(join(ROOT, 'other.txt'), { type: 'add' })], 'fc-out')(p);
          announce([change(inside, { type: 'update', move_path: join(ROOT, 'moved.txt') })], 'fc-move')(p);
        },
      },
    );
    expect(r.answers.map(decisionOf)).toEqual(['accept', 'decline', 'decline']);
  });

  it('declines a request whose item/started never arrived, without asking the gate', async () => {
    const spy = spyGate();
    const r = await answers([['item/fileChange/requestApproval', FILE_REQ('never-announced')]], spy.gate);
    expect(spy.calls).toEqual([]);
    expect(decisionOf(r.answers[0]!)).toBe('decline');
  });

  it('declines a second request that reuses an item id after the first was decided', async () => {
    const spy = spyGate();
    const r = await answers(
      [
        ['item/fileChange/requestApproval', FILE_REQ('fc-1')],
        ['item/fileChange/requestApproval', FILE_REQ('fc-1')],
      ],
      spy.gate,
      { setup: announce([change('/p/out/b.txt', { type: 'add' })]) },
    );
    expect(spy.calls.length).toBe(1);
    expect(r.answers.map(decisionOf)).toEqual(['accept', 'decline']);
  });

  it('declines a request for an item that completed before the request arrived', async () => {
    const spy = spyGate();
    const r = await answers([['item/fileChange/requestApproval', FILE_REQ('fc-1')]], spy.gate, {
      setup: (p) => {
        announce([change('/p/out/b.txt', { type: 'add' })])(p);
        p.completed({ type: 'fileChange', id: 'fc-1', changes: [], status: 'completed' });
      },
    });
    expect(spy.calls).toEqual([]);
    expect(decisionOf(r.answers[0]!)).toBe('decline');
  });

  it('does not resolve an item announced on another thread', async () => {
    const spy = spyGate();
    const r = await answers([['item/fileChange/requestApproval', FILE_REQ('fc-1', { threadId: 'thr-sub' })]], spy.gate, {
      setup: announce([change('/p/out/b.txt', { type: 'add' })]),
    });
    expect(spy.calls).toEqual([]);
    expect(decisionOf(r.answers[0]!)).toBe('decline');
  });

  it('declines a request for an item with no changes or a malformed change', async () => {
    const spy = spyGate();
    const r = await answers(
      [
        ['item/fileChange/requestApproval', FILE_REQ('empty')],
        ['item/fileChange/requestApproval', FILE_REQ('bad-kind')],
        ['item/fileChange/requestApproval', FILE_REQ('no-path')],
      ],
      spy.gate,
      {
        setup: (p) => {
          announce([], 'empty')(p);
          announce([change('/p/a', { type: 'chmod' })], 'bad-kind')(p);
          announce([{ kind: { type: 'add' }, diff: '' }], 'no-path')(p);
        },
      },
    );
    expect(spy.calls).toEqual([]);
    expect(r.answers.map(decisionOf)).toEqual(['decline', 'decline', 'decline']);
  });

  it('declines a request that asks for a session-wide write grant', async () => {
    const spy = spyGate();
    const r = await answers([['item/fileChange/requestApproval', FILE_REQ('fc-1', { grantRoot: '/p' })]], spy.gate, {
      setup: announce([change('/p/out/b.txt', { type: 'add' })]),
    });
    expect(spy.calls).toEqual([]);
    expect(decisionOf(r.answers[0]!)).toBe('decline');
  });

  it('answers a hold on any path with cancel, even when an earlier path was denied', async () => {
    const spy = spyGate((c) => ((c.input as Json).file_path === '/p/a' ? deny() : hold));
    const server = fakeServer(async (p) => {
      announce([change('/p/a', { type: 'add' }), change('/p/b', { type: 'add' })])(p);
      answered.push(await p.request('item/fileChange/requestApproval', FILE_REQ()));
      p.completeTurn('interrupted');
    });
    const answered: Json[] = [];
    const err = await rejection(adapterWith(server).invoke(invocation({ gate: spy.gate })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(decisionOf(answered[0]!)).toBe('cancel');
  });
});

describe('codex-app-server adapter: MCP elicitations and unknown requests', () => {
  const ELICIT = (extra: Json = {}): Json => ({
    threadId: 'thr-root', turnId: 'turn-1', serverName: 'spike', mode: 'form', _meta: {}, message: 'Allow the spike MCP server to run tool "ping"?',
    requestedSchema: { type: 'object', properties: {} }, ...extra,
  });

  it('gates the tool as mcp__<server>__<tool> and declines when the gate denies', async () => {
    const spy = spyGate(() => deny());
    const r = await answers([['mcpServer/elicitation/request', ELICIT()]], spy.gate);
    expect(spy.calls.map((c) => c.toolName)).toEqual(['mcp__spike__ping']);
    expect(r.answers[0]!.result).toEqual({ action: 'decline' });
  });

  it('takes the tool name from the announced mcpToolCall when there is one', async () => {
    const spy = spyGate(() => deny());
    await answers([['mcpServer/elicitation/request', ELICIT({ message: 'Allow?' })]], spy.gate, {
      setup: (p) => p.started({ type: 'mcpToolCall', id: 'mcp-1', server: 'spike', tool: 'writeMarker', arguments: {} }),
    });
    expect(spy.calls.map((c) => c.toolName)).toEqual(['mcp__spike__writeMarker']);
  });

  it('ignores an mcpToolCall announced on another thread or already completed', async () => {
    const spy = spyGate(() => deny());
    await answers([['mcpServer/elicitation/request', ELICIT({ message: 'Allow?' })]], spy.gate, {
      setup: (p) => {
        p.started({ type: 'mcpToolCall', id: 'mcp-1', server: 'spike', tool: 'otherThread', arguments: {} }, 'thr-sub');
        p.started({ type: 'mcpToolCall', id: 'mcp-2', server: 'spike', tool: 'finished', arguments: {} });
        p.completed({ type: 'mcpToolCall', id: 'mcp-2', server: 'spike', tool: 'finished', status: 'completed' });
      },
    });
    expect(spy.calls.map((c) => c.toolName)).toEqual(['mcp__spike__elicitation']);
  });

  it('is denied by the real gate whatever the station lists', async () => {
    const gate = createHarnessToolGate({ projectRoot: ROOT, tools: ['Bash(cat:*)', 'mcp__spike__ping'] });
    const r = await answers([['mcpServer/elicitation/request', ELICIT()]], gate);
    expect(r.answers[0]!.result).toEqual({ action: 'decline' });
  });

  it('answers a hold with cancel', async () => {
    const answered: Json[] = [];
    const server = fakeServer(async (p) => {
      answered.push(await p.request('mcpServer/elicitation/request', ELICIT()));
      p.completeTurn('interrupted');
    });
    await rejection(adapterWith(server).invoke(invocation({ gate: () => hold })));
    expect(answered[0]!.result).toEqual({ action: 'cancel' });
  });

  it('answers every method it does not handle with a JSON-RPC error, never a result', async () => {
    const spy = spyGate();
    const methods = [
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
      'item/tool/call',
      'account/chatgptAuthTokens/refresh',
      'attestation/generate',
      'applyPatchApproval',
      'execCommandApproval',
      'something/new',
    ];
    const r = await answers(methods.map((m) => [m, { threadId: 'thr-root' }] as [string, Json]), spy.gate);
    expect(spy.calls).toEqual([]);
    for (const a of r.answers) {
      expect(a.error).toMatchObject({ code: -32601 });
      expect(a).not.toHaveProperty('result');
    }
  });

  it('journals an unhandled request as a deny decision', async () => {
    const server = fakeServer(async (p) => {
      await p.request('item/permissions/requestApproval', { threadId: 'thr-root' });
      p.completeTurn();
    });
    const { events, onEvent } = collect();
    await adapterWith(server).invoke(invocation({ gate: allowAll, onEvent }));
    expect(events.find((e) => e.type === 'gate-decision')).toMatchObject({
      toolName: 'item/permissions/requestApproval', decision: 'deny',
    });
  });
});

describe('codex-app-server adapter: only accept, decline and cancel are ever sent', () => {
  it('never sends acceptForSession or an amendment decision, whatever the gate answers', async () => {
    let n = 0;
    const gate = spyGate((c) => (c.toolName === 'Bash' && n++ % 3 === 0 ? { decision: 'allow' } : deny())).gate;
    const requestsSent: Array<[string, Json]> = [
      ['item/commandExecution/requestApproval', { ...CMD(wrap('cat a')), availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cat'] } }, 'acceptForSession'], proposedExecpolicyAmendment: ['cat'], proposedNetworkPolicyAmendments: [{ host: 'x', action: 'allow' }] }],
      ['item/commandExecution/requestApproval', CMD(wrap('rm x'))],
      ['item/fileChange/requestApproval', { threadId: 'thr-root', turnId: 'turn-1', itemId: 'fc-1', reason: null, grantRoot: null }],
      ['mcpServer/elicitation/request', { threadId: 'thr-root', serverName: 's', message: 'tool "t"' }],
      ['item/permissions/requestApproval', { threadId: 'thr-root' }],
      ['item/commandExecution/requestApproval', CMD(wrap('cat b'))],
    ];
    const server = fakeServer(async (p) => {
      p.started({ type: 'fileChange', id: 'fc-1', changes: [{ path: '/p/a', kind: { type: 'add' }, diff: '' }], status: 'inProgress' });
      for (const [m, params] of requestsSent) await p.request(m, params);
      p.completeTurn();
    });
    await adapterWith(server).invoke(invocation({ gate }));
    const responses = server.sent.filter((m) => m.method === undefined && m.id >= 100);
    expect(responses.length).toBe(6);
    const text = JSON.stringify(server.sent);
    expect(text).not.toContain('acceptForSession');
    expect(text).not.toContain('Amendment');
    expect(text).not.toContain('execpolicy');
    const kinds = requestsSent.map(([method]) => method);
    responses.forEach((m, i) => {
      if (m.error !== undefined) return;
      const d = kinds[i] === 'mcpServer/elicitation/request' ? actionOf(m) : decisionOf(m);
      expect(['accept', 'decline', 'cancel']).toContain(d as string);
    });
  });
});

describe('codex-app-server adapter: hold', () => {
  const heldScenario = (extra?: (p: Peer, answered: Json[]) => Promise<void>) => {
    const answered: Json[] = [];
    const server = fakeServer(async (p) => {
      p.usage('thr-root', USAGE_A);
      answered.push(await p.request('item/commandExecution/requestApproval', CMD(wrap('cat a.txt'))));
      if (extra !== undefined) await extra(p, answered);
      p.completeTurn('interrupted');
    });
    return { server, answered };
  };

  it('answers the held call with cancel and throws the hold code carrying the usage reported so far', async () => {
    const { server, answered } = heldScenario();
    const err = await rejection(adapterWith(server).invoke(invocation({ gate: () => hold })));
    expect(decisionOf(answered[0]!)).toBe('cancel');
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(err.message).toContain('needs_human');
    expect(err.usage).toMatchObject({ tokens: 120, cost: 0 });
  });

  it('carries no usage, and invents none, when nothing was reported before the hold', async () => {
    const answered: Json[] = [];
    const server = fakeServer(async (p) => {
      answered.push(await p.request('item/commandExecution/requestApproval', CMD(wrap('cat a.txt'))));
      p.completeTurn('interrupted');
    });
    const err = await rejection(adapterWith(server).invoke(invocation({ gate: () => hold })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(err.usage).toBeUndefined();
  });

  it('declines every later request without asking the gate, even one it would allow', async () => {
    const spy = spyGate((c) => ((c.input as Json).command === 'cat first' ? hold : { decision: 'allow' }));
    const answered: Json[] = [];
    const server = fakeServer(async (p) => {
      answered.push(await p.request('item/commandExecution/requestApproval', CMD(wrap('cat first'))));
      answered.push(await p.request('item/commandExecution/requestApproval', CMD(wrap('cat second'))));
      answered.push(await p.request('mcpServer/elicitation/request', { threadId: 'thr-root', serverName: 's', message: 'tool "t"' }));
      p.completeTurn('interrupted');
    });
    const { events, onEvent } = collect();
    const err = await rejection(adapterWith(server).invoke(invocation({ gate: spy.gate, onEvent })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(spy.calls.length).toBe(1);
    expect(answered.map((a) => a.result)).toEqual([{ decision: 'cancel' }, { decision: 'decline' }, { action: 'decline' }]);
    const decisions = events.filter((e) => e.type === 'gate-decision');
    expect(decisions.map((e) => (e as { decision: string }).decision)).toEqual(['hold', 'deny', 'deny']);
  });

  it('kills the process after the bounded wait when the turn never ends, and reports what it had', async () => {
    const server = fakeServer(async (p) => {
      p.usage('thr-root', USAGE_A);
      await p.request('item/commandExecution/requestApproval', CMD(wrap('cat a.txt')));
      // The turn is never completed.
    });
    const started = Date.now();
    const err = await rejection(adapterWith(server, { holdStopWaitMs: 60 }).invoke(invocation({ gate: () => hold })));
    // The unconfigured wait is HOLD_STOP_WAIT_MS (5s). 4.5s separates the two with room for a loaded runner.
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(err.usage).toMatchObject({ tokens: 120 });
    expect(server.state.kills).toBeGreaterThan(0);
  }, 15_000);

  it('keeps the hold ahead of the wall-clock timeout', async () => {
    const server = fakeServer(async (p) => {
      await p.request('item/commandExecution/requestApproval', CMD(wrap('cat a.txt')));
    });
    const err = await rejection(adapterWith(server, { holdStopWaitMs: 5_000 }).invoke(invocation({ gate: () => hold, timeoutMs: 500 })));
    expect(err.code).toBe(HARNESS_GATE_HOLD_CODE);
  });

  it('also interrupts the root turn when a subagent call is held', async () => {
    const { server } = heldScenario();
    const sub = fakeServer(async (p) => {
      await p.request('item/commandExecution/requestApproval', CMD(wrap('cat a.txt'), { threadId: 'thr-sub' }));
      p.completeTurn('interrupted');
    });
    await rejection(adapterWith(sub).invoke(invocation({ gate: () => hold })));
    expect(sub.sent.find((m) => m.method === 'turn/interrupt')?.params).toEqual({ threadId: 'thr-root', turnId: 'turn-1' });
    await rejection(adapterWith(server).invoke(invocation({ gate: () => hold })));
    expect(server.sent.find((m) => m.method === 'turn/interrupt')).toBeUndefined();
  });
});

describe('codex-app-server adapter: subagents', () => {
  it('passes the thread id of a subagent as agentId, and none for the root thread', async () => {
    const spy = spyGate();
    const { events, onEvent } = collect();
    const server = fakeServer(async (p) => {
      await p.request('item/commandExecution/requestApproval', CMD(wrap('cat a.txt'), { itemId: 'root-1' }));
      await p.request('item/commandExecution/requestApproval', CMD(wrap('cat b.txt'), { itemId: 'sub-1', threadId: 'thr-sub' }));
      p.completeTurn();
    });
    await adapterWith(server).invoke(invocation({ gate: spy.gate, onEvent }));
    expect(spy.calls[0]).not.toHaveProperty('agentId');
    expect(spy.calls[1]).toMatchObject({ agentId: 'thr-sub' });
    const decisions = events.filter((e) => e.type === 'gate-decision') as Array<Extract<HarnessEvent, { type: 'gate-decision' }>>;
    expect(decisions[0]).not.toHaveProperty('agentId');
    expect(decisions[1]).toMatchObject({ agentId: 'thr-sub', toolCallId: 'sub-1' });
  });

  it('does not end the invocation when a subagent turn completes', async () => {
    const spy = spyGate();
    const answered: Json[] = [];
    const server = fakeServer(async (p) => {
      p.completeTurn('completed', null, 'thr-sub');
      answered.push(await p.request('item/commandExecution/requestApproval', CMD(wrap('cat a.txt'))));
      p.completeTurn();
    });
    await adapterWith(server).invoke(invocation({ gate: spy.gate }));
    expect(answered.length).toBe(1);
  });
});

describe('codex-app-server adapter: usage', () => {
  it('sums the last total of each thread across threads', async () => {
    const server = fakeServer((p) => {
      p.usage('thr-root', { ...USAGE_A, totalTokens: 50, inputTokens: 40, outputTokens: 10, cachedInputTokens: 0 });
      p.usage('thr-sub', { totalTokens: 200, inputTokens: 150, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 9 });
      p.usage('thr-root', USAGE_A);
      p.completeTurn();
    });
    const out = await adapterWith(server).invoke(invocation());
    const usage = out.usage as KnownUsage;
    expect(usage.tokens).toBe(320);
    expect(usage.cost).toBe(0);
    expect(usage.breakdown).toEqual({ inputTokens: 90, outputTokens: 70, cacheReadInputTokens: 160, cacheCreationInputTokens: 0 });
    expect(usage.model).toBe('gpt-fake');
    expect(out.outputs).toEqual([]);
  });

  it('counts cache writes as their own class and not as fresh input', async () => {
    const server = fakeServer((p) => {
      p.usage('thr-root', { totalTokens: 130, inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 0 });
      p.completeTurn();
    });
    const usage = (await adapterWith(server).invoke(invocation())).usage as KnownUsage;
    expect(usage.breakdown).toEqual({ inputTokens: 50, outputTokens: 30, cacheReadInputTokens: 30, cacheCreationInputTokens: 20 });
    expect(usage.tokens).toBe(130);
  });

  it('ignores an update missing input or output tokens, keeping the thread\'s last complete total', async () => {
    const server = fakeServer((p) => {
      p.usage('thr-root', USAGE_A);
      p.usage('thr-root', { totalTokens: 7, inputTokens: 7, cachedInputTokens: 0 });
      p.usage('thr-root', { ...USAGE_A, outputTokens: Number.NaN });
      p.completeTurn();
    });
    const usage = (await adapterWith(server).invoke(invocation())).usage as KnownUsage;
    expect(usage.tokens).toBe(120);
    expect(usage.breakdown).toEqual({ inputTokens: 40, outputTokens: 20, cacheReadInputTokens: 60, cacheCreationInputTokens: 0 });
  });

  it('reports usage unknown when every update was incomplete', async () => {
    const server = fakeServer((p) => {
      p.usage('thr-root', { totalTokens: 7, outputTokens: 7 });
      p.completeTurn();
    });
    expect((await adapterWith(server).invoke(invocation())).usage).toEqual({ unknown: true });
  });

  it('reports usage explicitly unknown when a successful call reported none', async () => {
    const server = fakeServer((p) => p.completeTurn());
    const out = await adapterWith(server).invoke(invocation());
    expect(out.usage).toEqual({ unknown: true });
  });
});

describe('codex-app-server adapter: failures', () => {
  it('throws harness-rate-limited for a usage limit, with the binding reset and the usage', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
    const server = fakeServer((p) => {
      p.usage('thr-root', USAGE_A);
      p.notify('account/rateLimits/updated', {
        rateLimits: {
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
          secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: resetsAt + 100_000 },
          rateLimitReachedType: 'rate_limit_reached',
        },
      });
      p.notify('error', { error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false, threadId: 'thr-root', turnId: 'turn-1' });
      p.completeTurn('failed', { message: 'You hit your usage limit', codexErrorInfo: 'usageLimitExceeded' });
    });
    const err = await rejection(adapterWith(server).invoke(invocation()));
    expect(err.code).toBe('harness-rate-limited');
    expect(err.resetAtMs).toBe(resetsAt * 1000);
    expect(err.usage).toMatchObject({ tokens: 120 });
  });

  it('classifies rateLimitExceeded and serverOverloaded as rate limits too', async () => {
    for (const info of ['rateLimitExceeded', 'serverOverloaded']) {
      const server = fakeServer((p) => p.completeTurn('failed', { message: 'slow down', codexErrorInfo: info }));
      const err = await rejection(adapterWith(server).invoke(invocation()));
      expect(err.code).toBe('harness-rate-limited');
    }
  });

  it('classifies a failure as a rate limit when the last snapshot says a cap was reached', async () => {
    const server = fakeServer((p) => {
      p.notify('account/rateLimits/updated', {
        rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2_000_000_000 }, rateLimitReachedType: null },
      });
      p.completeTurn('failed', { message: 'stopped', codexErrorInfo: 'other' });
    });
    const err = await rejection(adapterWith(server).invoke(invocation()));
    expect(err.code).toBe('harness-rate-limited');
    expect(err.resetAtMs).toBe(2_000_000_000_000);
  });

  it('names the last retried error when a failed turn carries no error of its own', async () => {
    const server = fakeServer((p) => {
      p.notify('error', { error: { message: 'stream dropped', codexErrorInfo: 'other' }, willRetry: true });
      p.completeTurn('failed', null);
    });
    const err = await rejection(adapterWith(server).invoke(invocation()));
    expect(err.code).toBe('harness-nonzero-exit');
    expect(err.message).toContain('turn failed: stream dropped');
  });

  it('does not park on a warning-level snapshot when the failure has another cause', async () => {
    const server = fakeServer((p) => {
      p.notify('account/rateLimits/updated', {
        rateLimits: { primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 2_000_000_000 }, rateLimitReachedType: null },
      });
      p.completeTurn('failed', { message: 'stopped', codexErrorInfo: 'other' });
    });
    const err = await rejection(adapterWith(server).invoke(invocation()));
    expect(err.code).toBe('harness-nonzero-exit');
  });

  it('classifies an authentication failure as harness-nonzero-exit, from the retry notifications and the final error', async () => {
    const server = fakeServer((p) => {
      for (let i = 1; i <= 2; i++) {
        p.notify('error', {
          error: { message: `Reconnecting... ${i}/5`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } }, additionalDetails: 'unexpected status 401 Unauthorized' },
          willRetry: true, threadId: 'thr-root', turnId: 'turn-1',
        });
      }
      p.notify('error', { error: { message: 'unexpected status 401 Unauthorized: bad key', codexErrorInfo: 'other' }, willRetry: false, threadId: 'thr-root', turnId: 'turn-1' });
      p.completeTurn('failed', { message: 'unexpected status 401 Unauthorized: bad key', codexErrorInfo: 'other' });
    });
    const err = await rejection(adapterWith(server).invoke(invocation()));
    expect(err.code).toBe('harness-nonzero-exit');
    expect(err.message).toContain('authentication failed');
  });

  it('classifies codexErrorInfo unauthorized as an authentication failure', async () => {
    const server = fakeServer((p) => p.completeTurn('failed', { message: 'sign in again', codexErrorInfo: 'unauthorized' }));
    const err = await rejection(adapterWith(server).invoke(invocation()));
    expect(err.message).toContain('authentication failed');
  });

  it('does not classify retried 401s as a failure when the turn then completes', async () => {
    const server = fakeServer((p) => {
      p.notify('error', { error: { message: 'Reconnecting... 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }, willRetry: true, threadId: 'thr-root', turnId: 'turn-1' });
      p.completeTurn();
    });
    const out = await adapterWith(server).invoke(invocation());
    expect(out.outputs).toEqual([]);
  });

  it('throws harness-nonzero-exit with the exit signal when the process dies before the turn completes', async () => {
    const server = fakeServer((p) => {
      p.usage('thr-root', USAGE_A);
      p.exit(undefined, 'SIGKILL');
    });
    const err = await rejection(adapterWith(server).invoke(invocation()));
    expect(err.code).toBe('harness-nonzero-exit');
    expect(err.message).toContain('SIGKILL');
    expect(err.usage).toMatchObject({ tokens: 120 });
  });

  it('includes the exit code and the stderr tail when the process exits on its own', async () => {
    const server = fakeServer((p) => {
      p.stderr('codex: fatal config error');
      p.exit(2);
    });
    const err = await rejection(adapterWith(server).invoke(invocation()));
    expect(err.code).toBe('harness-nonzero-exit');
    expect(err.message).toContain('code 2');
    expect(err.message).toContain('fatal config error');
  });

  it('fails when the process exits during the handshake instead of waiting for a response', async () => {
    const server = fakeServer(() => {}, { silent: true });
    const wrapped: ContainedSpawn = (spec, handlers) => {
      const proc = server.spawn(spec, handlers);
      queueMicrotask(() => handlers.onExit(1, undefined));
      return proc;
    };
    const err = await rejection(adapterWith({ spawn: wrapped }).invoke(invocation({ timeoutMs: 5_000 })));
    expect(err.code).toBe('harness-nonzero-exit');
  });

  it('throws harness-nonzero-exit for an interrupted turn that no hold caused', async () => {
    const server = fakeServer((p) => p.completeTurn('interrupted'));
    const err = await rejection(adapterWith(server).invoke(invocation()));
    expect(err.code).toBe('harness-nonzero-exit');
    expect(err.message).toContain('interrupted');
  });
});

describe('codex-app-server adapter: timeouts', () => {
  it('kills the process and throws harness-timeout at the wall-clock bound, even during the handshake', async () => {
    const server = fakeServer(() => {}, { silent: true });
    const err = await rejection(adapterWith(server).invoke(invocation({ timeoutMs: 60 })));
    // No timing bound: a regressed timer leaves the call waiting forever on the silent server, which the
    // test timeout reports. A wall-clock bound here could only flake.
    expect(err.code).toBe('harness-timeout');
    expect(server.state.kills).toBeGreaterThan(0);
  });

  it('recovers the usage reported before a timeout', async () => {
    const server = fakeServer((p) => p.usage('thr-root', USAGE_A));
    const err = await rejection(adapterWith(server).invoke(invocation({ timeoutMs: 500 })));
    expect(err.code).toBe('harness-timeout');
    expect(err.usage).toMatchObject({ tokens: 120 });
  });

  it('throws harness-idle-timeout when no line arrives for the idle bound', async () => {
    const server = fakeServer(() => {});
    const err = await rejection(adapterWith(server).invoke(invocation({ timeoutMs: 5_000, idleTimeoutMs: 60 })));
    expect(err.code).toBe('harness-idle-timeout');
    expect(server.state.kills).toBeGreaterThan(0);
  });

  it('recovers the usage reported before an idle timeout', async () => {
    const server = fakeServer((p) => p.usage('thr-root', USAGE_A));
    const err = await rejection(adapterWith(server).invoke(invocation({ timeoutMs: 5_000, idleTimeoutMs: 200 })));
    expect(err.code).toBe('harness-idle-timeout');
    expect(err.usage).toMatchObject({ tokens: 120 });
  });

  it('resets the idle timer on every line', async () => {
    const server = fakeServer(async (p) => {
      // 40 lines x 20 ms gaps = 800 ms in all, well past one 500 ms idle window, so a timer that did not
      // reset on each line would trip. Each gap is 25x under the window, so a loaded runner cannot trip a correct one.
      for (let i = 0; i < 40; i++) {
        p.notify('thread/status/changed', { threadId: 'thr-root', status: { type: 'active' } });
        await new Promise((r) => setTimeout(r, 20));
      }
      p.completeTurn();
    });
    const out = await adapterWith(server).invoke(invocation({ timeoutMs: 5_000, idleTimeoutMs: 500 }));
    expect(out.outputs).toEqual([]);
  });

  it('calls onProgress for each line the app-server writes', async () => {
    let n = 0;
    const server = fakeServer((p) => p.completeTurn());
    await adapterWith(server).invoke(invocation({ onProgress: () => (n += 1) }));
    expect(n).toBeGreaterThanOrEqual(4);
  });
});

describe('codex-app-server adapter: events', () => {
  it('numbers events from 0, opens with lifecycle start and closes with lifecycle end', async () => {
    const server = fakeServer((p) => p.completeTurn());
    const { events, onEvent } = collect();
    await adapterWith(server).invoke(invocation({ onEvent }));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events[0]).toMatchObject({ type: 'lifecycle', phase: 'start' });
    expect(events[events.length - 1]).toMatchObject({ type: 'lifecycle', phase: 'end' });
  });

  it('closes with a timeout lifecycle phase on a wall-clock kill and idle-timeout on an idle kill', async () => {
    const a = collect();
    await rejection(adapterWith(fakeServer(() => {}, { silent: true })).invoke(invocation({ timeoutMs: 40, onEvent: a.onEvent })));
    expect(a.events[a.events.length - 1]).toMatchObject({ type: 'lifecycle', phase: 'timeout' });
    const b = collect();
    await rejection(adapterWith(fakeServer(() => {})).invoke(invocation({ timeoutMs: 5_000, idleTimeoutMs: 40, onEvent: b.onEvent })));
    expect(b.events[b.events.length - 1]).toMatchObject({ type: 'lifecycle', phase: 'idle-timeout' });
  });

  it('emits a gate-decision for every approval: allow, deny and hold, without the tool input', async () => {
    let n = 0;
    const gate: HarnessToolGate = () => (n++ === 0 ? { decision: 'allow' } : n === 2 ? deny() : hold);
    const server = fakeServer(async (p) => {
      await p.request('item/commandExecution/requestApproval', CMD(wrap('cat secret-input.txt'), { itemId: 'a' }));
      await p.request('item/commandExecution/requestApproval', CMD(wrap('cat secret-input.txt'), { itemId: 'b' }));
      await p.request('item/commandExecution/requestApproval', CMD(wrap('cat secret-input.txt'), { itemId: 'c' }));
      p.completeTurn('interrupted');
    });
    const { events, onEvent } = collect();
    await rejection(adapterWith(server).invoke(invocation({ gate, onEvent })));
    const decisions = events.filter((e) => e.type === 'gate-decision') as Array<Extract<HarnessEvent, { type: 'gate-decision' }>>;
    expect(decisions.map((d) => [d.toolCallId, d.decision, d.code])).toEqual([
      ['a', 'allow', undefined],
      ['b', 'deny', 'not_allowlisted'],
      ['c', 'hold', 'needs_human'],
    ]);
    expect(JSON.stringify(decisions)).not.toContain('secret-input');
  });

  it('maps started and completed items to tool events without carrying output bodies', async () => {
    const server = fakeServer((p) => {
      p.started({ type: 'commandExecution', id: 'cmd-1', command: wrap('cat a.txt'), status: 'inProgress', aggregatedOutput: null });
      p.completed({ type: 'commandExecution', id: 'cmd-1', command: wrap('cat a.txt'), status: 'completed', aggregatedOutput: 'SECRET-BODY', exitCode: 0 });
      p.started({ type: 'commandExecution', id: 'cmd-2', command: wrap('cat missing'), status: 'inProgress' });
      p.completed({ type: 'commandExecution', id: 'cmd-2', command: wrap('cat missing'), status: 'failed', aggregatedOutput: 'SECRET-BODY', exitCode: 1 });
      p.started({ type: 'fileChange', id: 'fc-1', changes: [{ path: '/p/out/b.txt', kind: { type: 'add' }, diff: 'SECRET-DIFF' }], status: 'inProgress' });
      p.completed({ type: 'fileChange', id: 'fc-1', changes: [], status: 'completed' });
      p.completeTurn();
    });
    const { events, onEvent } = collect();
    await adapterWith(server).invoke(invocation({ onEvent }));
    const tools = events.filter((e) => e.type === 'tool-input-available' || e.type === 'tool-output-available');
    expect(tools).toMatchObject([
      { type: 'tool-input-available', toolCallId: 'cmd-1', toolName: 'Bash', input: { command: 'cat a.txt' } },
      { type: 'tool-output-available', toolCallId: 'cmd-1', isError: false },
      { type: 'tool-input-available', toolCallId: 'cmd-2', toolName: 'Bash' },
      { type: 'tool-output-available', toolCallId: 'cmd-2', isError: true, output: 'Exit code 1' },
      { type: 'tool-input-available', toolCallId: 'fc-1', toolName: 'Write', input: { file_path: '/p/out/b.txt' } },
      { type: 'tool-output-available', toolCallId: 'fc-1', isError: false },
    ]);
    expect(JSON.stringify(events)).not.toContain('SECRET');
    expect(JSON.stringify(events)).not.toContain('do it');
  });

  it('emits one usage event and one rate-limit event for the whole call', async () => {
    const server = fakeServer((p) => {
      p.usage('thr-root', USAGE_A);
      p.notify('account/rateLimits/updated', {
        rateLimits: { primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: 1_790_705_948 }, secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1_791_154_780 } },
      });
      p.completeTurn();
    });
    const { events, onEvent } = collect();
    const out = await adapterWith(server).invoke(invocation({ onEvent }));
    expect(events.filter((e) => e.type === 'usage')).toMatchObject([{ tokens: 120, breakdown: { inputTokens: 40, outputTokens: 20, cacheReadInputTokens: 60 } }]);
    const rl = events.filter((e) => e.type === 'rate-limit');
    expect(rl).toMatchObject([
      { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.27, resetsAtMs: 1_790_705_948_000 }, { name: 'seven_day', utilization: 0.08 }] },
    ]);
    expect((out.usage as KnownUsage).rateLimit?.windows.length).toBe(2);
  });

  it('survives a throwing event sink', async () => {
    const server = fakeServer((p) => p.completeTurn());
    const out = await adapterWith(server).invoke(invocation({ onEvent: () => { throw new Error('sink'); } }));
    expect(out.outputs).toEqual([]);
  });
});

describe('codex-app-server adapter: registration', () => {
  const def = { name: 'codex-app-server', envAllowlist: ['PATH'] };

  it('is in the shipped factory map', () => {
    expect(shippedHarnessAdapterNames()).toContain('codex-app-server');
  });

  it('carries its capabilities through the definition and the introspection registry', () => {
    const registry = buildHarnessDefinitionRegistry([def]);
    const resolved = registry.resolve('codex-app-server');
    expect(resolved.ok && resolved.adapter).toMatchObject({ canGatePerCall: true, canRestrictTools: true, reportsUsage: true });
    const adapter = bindHarnessDefinitionsForIntrospection(registry).resolve('codex-app-server');
    expect(adapter.ok && adapter.adapter.canGatePerCall).toBe(true);
  });

  it('parses its engine config from CONDUIT_HARNESS_CODEX_APP_SERVER_*', () => {
    const parsed = parseHarnessConfig({
      CONDUIT_HARNESS_ADAPTERS: 'codex-app-server',
      CONDUIT_HARNESS_CODEX_APP_SERVER_ENV: 'PATH,HOME',
      CONDUIT_HARNESS_CODEX_APP_SERVER_COMMAND: '/opt/codex/bin/codex',
      CONDUIT_HARNESS_CODEX_APP_SERVER_MODEL: 'gpt-x',
    });
    expect(parsed).toEqual({ ok: true, defs: [{ name: 'codex-app-server', envAllowlist: ['PATH', 'HOME'], command: '/opt/codex/bin/codex', model: 'gpt-x' }] });
    if (!parsed.ok) throw new Error('unreachable');
    const registry = buildHarnessDefinitionRegistry(parsed.defs);
    const bound = registry.resolve('codex-app-server');
    expect(bound.ok && bound.adapter.command).toBe('/opt/codex/bin/codex');
    expect(bound.ok && bound.adapter.bind(ROOT).model).toBe('gpt-x');
  });

  it('fails registry construction for _AGENT, _PLUGIN_DIRS and _ISOLATE_CONFIG, which it does not act on', () => {
    expect(() => buildHarnessDefinitionRegistry([{ ...def, agent: 'team:coder' }])).toThrow(/_AGENT/);
    expect(() => buildHarnessDefinitionRegistry([{ ...def, pluginDirs: ['/opt/plugins'] }])).toThrow(/_PLUGIN_DIRS/);
    expect(() => buildHarnessDefinitionRegistry([{ ...def, isolateConfig: true }])).toThrow(/_ISOLATE_CONFIG/);
  });

  it('cannot run a named agent', () => {
    const registry = buildHarnessDefinitionRegistry([def]);
    const resolved = registry.resolve('codex-app-server');
    expect(resolved.ok && resolved.adapter.resolveAgentDefinition).toBeUndefined();
  });

  it('leaves no codex home behind in the temp dir after the suite has run its invocations', () => {
    // Other files and processes may hold their own live homes; only a new one is a leak from this file.
    const leftovers = readdirSync(tmpdir()).filter((n) => n.startsWith('conduit-codex-home-') && !PREEXISTING_HOMES.has(n));
    expect(leftovers).toEqual([]);
  });
});
