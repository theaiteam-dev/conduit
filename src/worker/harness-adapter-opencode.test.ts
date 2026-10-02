/**
 * opencode adapter (issue #21).
 *
 * The adapter is driven through an injected spawn seam. The fake starts a real
 * HTTP and SSE server on a loopback port, checks HTTP Basic auth against the
 * password the adapter put in the child env, and lets each test script the
 * events an `opencode serve` would send and observe the replies it gets back.
 * No test here starts opencode or calls a model.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describeHarnessContainmentConformance } from './harness-containment.conformance';
import {
  OPENCODE_SERVE_ARGS,
  createOpenCodeHarnessAdapter,
  type OpenCodeHarnessAdapterConfig,
} from './harness-adapter-opencode';
import type { ContainedProcessHandlers, ContainedSpawn, ContainedSpawnSpec } from './harness-contained-spawn';
import {
  bindHarnessDefinitionsForIntrospection, buildHarnessDefinitionRegistry, shippedHarnessAdapterNames,
  type HarnessInvocation, type KnownUsage,
} from './harness-adapter';
import { parseHarnessConfig } from './harness-config';
import type { HarnessEvent } from './harness-events';
import {
  HARNESS_GATE_HOLD_CODE, createHarnessToolGate, type GateToolCall, type HarnessToolGate,
} from './harness-gate';

const isRunScoped = (n: string): boolean => n.startsWith('conduit-opencode-') && !n.startsWith('conduit-opencode-root-') && !n.startsWith('conduit-opencode-auth-');
/** Entries left by earlier or concurrent runs. Only entries created after this point count as leaks. */
const PREEXISTING = new Set(readdirSync(tmpdir()).filter(isRunScoped));
const leaked = (): string[] => readdirSync(tmpdir()).filter((n) => isRunScoped(n) && !PREEXISTING.has(n));
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-opencode-root-')));
mkdirSync(join(ROOT, 'out'));
writeFileSync(join(ROOT, 'a.txt'), 'one\n');

const AUTH_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-opencode-auth-')));
mkdirSync(join(AUTH_HOME, 'opencode'));
const OPENAI_SECRET = 'sk-openai-SECRETVALUE';
const ANTHROPIC_SECRET = 'sk-anthropic-OTHERSECRET';
writeFileSync(
  join(AUTH_HOME, 'opencode', 'auth.json'),
  JSON.stringify({ openai: { type: 'api', key: OPENAI_SECRET }, anthropic: { type: 'api', key: ANTHROPIC_SECRET } }),
);

afterAll(() => {
  // Registered first, so it runs after every describe block's tests in the file.
  // The fixtures are removed first so a failed leak check does not leave them behind; isRunScoped excludes them.
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(AUTH_HOME, { recursive: true, force: true });
  expect(leaked()).toEqual([]);
  // Covers every fake in the file, including invocations that bypass run().
  const kinds = allRequests.filter((r) => /^\/permission\/[^/]+\/reply$/.test(r.path)).map((r) => r.body?.reply);
  expect(kinds).not.toContain('always');
  expect(allRequests.every((r) => r.authOk)).toBe(true);
});

describeHarnessContainmentConformance('opencode', (opts) =>
  createOpenCodeHarnessAdapter({
    ...opts,
    envAllowlist: [],
    model: 'openai/gpt-conformance',
    sourceEnv: { PATH: process.env.PATH, XDG_DATA_HOME: AUTH_HOME },
  }),
);

const containment = { mechanism: 'process-group', reason: 'unit test' } as const;
const PASSWORD_VAR = 'OPENCODE_SERVER_PASSWORD';

type Json = Record<string, any>;

interface Recorded {
  directory: string | null;
  method: string;
  path: string;
  body: any;
  authOk: boolean;
}

interface Scenario {
  sessionID: string;
  emit(type: string, properties: Json): void;
  /** A tool part in the given state. */
  part(o: { callID: string; tool: string; status: 'pending' | 'running' | 'completed' | 'error'; input?: Json; metadata?: Json; sessionID?: string; messageID?: string }): void;
  /** Send permission.asked and resolve with the reply body, or undefined when the server stops first. */
  ask(o: { permission: string; patterns?: unknown; metadata?: Json; tool?: { messageID: string; callID: string } | null; sessionID?: string; always?: string[]; id?: string; raw?: Json }): Promise<Json | undefined>;
  assistant(messageID: string, o?: { cost?: number; tokens?: Json; sessionID?: string; error?: Json; providerID?: string; modelID?: string }): void;
  idle(sessionID?: string): void;
  child(id: string, parentID: string): void;
  status(status: Json, sessionID?: string): void;
  heartbeat(): void;
  exit(code?: number): void;
  mark(label: string): void;
  /** Run a bash call through its running part and its ask. */
  bash(callID: string, command: string, o?: { sessionID?: string; messageID?: string; patterns?: string[] }): Promise<Json | undefined>;
  /** Send a request with a wrong password while the server is up. Resolves with the status, rejects if the server is unreachable. */
  probeWrongPassword(): Promise<number>;
  timeline: string[];
  requests: Recorded[];
}

interface FakeOptions {
  throwOnSpawn?: boolean;
  /** Print no listening line. */
  noListen?: boolean;
  /** Print this host in the listening line instead of 127.0.0.1. */
  listenHost?: string;
  /** Status for POST prompt_async. Default 204. */
  promptStatus?: number;
  /** Body for GET /session/:id/message/:mid, else 404. */
  messageBody?: (sessionID: string, messageID: string) => Json | undefined;
  /** Do not send the scenario at all: the session stays busy. */
  noScenario?: boolean;
  /** Answer permission replies with 404, as a server does for an ask it already settled. */
  reply404?: boolean;
  /** Hold the answer to a question reject for this many ms, keyed by question id. */
  rejectDelayMs?: Record<string, number>;
}

const enc = new TextEncoder();

/** Every adapter request any fake in this file received, however the invocation was started. */
const allRequests: Recorded[] = [];

function fakeOpenCode(scenario: (s: Scenario) => Promise<void> | void, opts: FakeOptions = {}) {
  const state: {
    spec?: ContainedSpawnSpec;
    spawns: number;
    kills: number;
    closes: number;
    requests: Recorded[];
    timeline: string[];
    port?: number;
    dirsDuring?: boolean;
    promptBody?: Json;
  } = { spawns: 0, kills: 0, closes: 0, requests: [], timeline: [] };
  let server: ReturnType<typeof Bun.serve> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let handlers: ContainedProcessHandlers | undefined;
  let eventNo = 0;
  let askNo = 0;
  const waiters = new Map<string, (body: Json | undefined) => void>();

  const send = (type: string, properties: Json): void => {
    try {
      controller?.enqueue(enc.encode(`data: ${JSON.stringify({ id: `evt_${eventNo++}`, type, properties })}\n\n`));
    } catch {
      /* the stream is closed */
    }
  };
  const sessionID = 'ses_root';
  const s: Scenario = {
    sessionID,
    emit: send,
    part: (o) =>
      send('message.part.updated', {
        sessionID: o.sessionID ?? sessionID,
        part: {
          id: `prt_${o.callID}`, type: 'tool', tool: o.tool, callID: o.callID,
          messageID: o.messageID ?? 'msg_1', sessionID: o.sessionID ?? sessionID,
          state: { status: o.status, input: o.input ?? {}, ...(o.metadata !== undefined ? { metadata: o.metadata } : {}) },
        },
        time: 1,
      }),
    ask: (o) =>
      new Promise((resolve) => {
        const id = o.id ?? `per_${askNo++}`;
        waiters.set(id, resolve);
        send(
          'permission.asked',
          o.raw ?? {
            id,
            sessionID: o.sessionID ?? sessionID,
            permission: o.permission,
            patterns: o.patterns ?? [],
            metadata: o.metadata ?? {},
            always: o.always ?? ['*'],
            ...(o.tool === null ? {} : { tool: o.tool }),
          },
        );
      }),
    assistant: (messageID, o = {}) =>
      send('message.updated', {
        sessionID: o.sessionID ?? sessionID,
        info: {
          id: messageID, role: 'assistant', sessionID: o.sessionID ?? sessionID,
          providerID: o.providerID ?? 'openai', modelID: o.modelID ?? 'gpt-fake',
          cost: o.cost ?? 0,
          tokens: o.tokens ?? { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1 },
          ...(o.error !== undefined ? { error: o.error } : {}),
        },
      }),
    idle: (id) => {
      send('session.status', { sessionID: id ?? sessionID, status: { type: 'idle' } });
      send('session.idle', { sessionID: id ?? sessionID });
    },
    child: (id, parentID) => send('session.created', { sessionID: id, info: { id, parentID, title: 'child' } }),
    status: (status, id) => send('session.status', { sessionID: id ?? sessionID, status }),
    heartbeat: () => send('server.heartbeat', {}),
    exit: (code = 1) => queueMicrotask(() => handlers?.onExit(code, undefined)),
    mark: (label) => state.timeline.push(`MARK ${label}`),
    bash: async (callID, command, o = {}) => {
      s.part({ callID, tool: 'bash', status: 'running', input: { command, workdir: '' }, sessionID: o.sessionID, messageID: o.messageID });
      return s.ask({
        permission: 'bash', patterns: o.patterns ?? [command], sessionID: o.sessionID,
        tool: { messageID: o.messageID ?? 'msg_1', callID },
      });
    },
    async probeWrongPassword() {
      const res = await fetch(`http://127.0.0.1:${state.port}/session`, {
        method: 'POST',
        headers: { authorization: `Basic ${btoa('opencode:wrong')}`, 'x-test-probe': '1' },
      });
      return res.status;
    },
    timeline: state.timeline,
    requests: state.requests,
  };

  const startServer = (): void => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const password = state.spec?.env[PASSWORD_VAR];
        const authOk = req.headers.get('authorization') === `Basic ${btoa(`opencode:${password}`)}`;
        let body: any;
        const text = req.method === 'POST' ? await req.text() : '';
        try {
          body = text === '' ? undefined : JSON.parse(text);
        } catch {
          body = text;
        }
        // A probe with the header is a test's own request, not the adapter's, and is kept out of `requests`.
        if (req.headers.get('x-test-probe') === '1') return new Response('unauthorized', { status: authOk ? 200 : 401 });
        const recorded: Recorded = { directory: req.headers.get('x-opencode-directory'), method: req.method, path: url.pathname, body, authOk };
        state.requests.push(recorded);
        allRequests.push(recorded);
        state.timeline.push(`${req.method} ${url.pathname}${body !== undefined ? ` ${JSON.stringify(body)}` : ''}`);
        if (!authOk) return new Response('unauthorized', { status: 401 });

        if (req.method === 'GET' && url.pathname === '/event') {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                controller = c;
                send('server.connected', {});
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        if (req.method === 'POST' && url.pathname === '/session') return Response.json({ id: sessionID, title: 'conduit' });
        const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname);
        if (req.method === 'POST' && prompt) {
          state.promptBody = body;
          state.dirsDuring = state.spec?.env.XDG_CONFIG_HOME !== undefined && existsSync(state.spec.env.XDG_CONFIG_HOME);
          if (opts.noScenario !== true && (opts.promptStatus ?? 204) === 204) setTimeout(() => void scenario(s), 0);
          return new Response(opts.promptStatus === undefined || opts.promptStatus === 204 ? null : 'nope', { status: opts.promptStatus ?? 204 });
        }
        const reply = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname);
        if (req.method === 'POST' && reply) {
          const resolve = waiters.get(reply[1]!);
          waiters.delete(reply[1]!);
          resolve?.(body);
          return opts.reply404 === true ? new Response('gone', { status: 404 }) : Response.json(true);
        }
        const questionReject = /^\/question\/([^/]+)\/reject$/.exec(url.pathname);
        if (req.method === 'POST' && questionReject) {
          const delay = opts.rejectDelayMs?.[questionReject[1]!];
          if (delay !== undefined) await Bun.sleep(delay);
          state.timeline.push(`done ${url.pathname}`);
          return Response.json(true);
        }
        if (req.method === 'POST' && /^\/session\/[^/]+\/abort$/.test(url.pathname)) return Response.json(true);
        const message = /^\/session\/([^/]+)\/message\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'GET' && message) {
          const found = opts.messageBody?.(message[1]!, message[2]!);
          return found !== undefined ? Response.json(found) : new Response('not found', { status: 404 });
        }
        return new Response('not found', { status: 404 });
      },
    });
    state.port = server.port;
  };

  const stop = (): void => {
    for (const resolve of waiters.values()) resolve(undefined);
    waiters.clear();
    try {
      controller?.close();
    } catch {
      /* already closed */
    }
    void server?.stop(true);
    server = undefined;
  };

  const spawn: ContainedSpawn = (spec, h) => {
    state.spawns += 1;
    state.spec = spec;
    if (opts.throwOnSpawn === true) throw new Error('spawn boom');
    handlers = h;
    startServer();
    if (opts.noListen !== true) {
      queueMicrotask(() => h.onLine(`opencode server listening on http://${opts.listenHost ?? '127.0.0.1'}:${state.port}`));
    }
    return {
      write() {},
      kill() {
        state.kills += 1;
        stop();
      },
      async close() {
        state.closes += 1;
        stop();
      },
    };
  };
  return { spawn, state, scenario: s };
}

const allowAll: HarnessToolGate = () => ({ decision: 'allow' });
const gateFor = (tools: string[], ownedPaths?: string[]): HarnessToolGate =>
  createHarnessToolGate({ projectRoot: ROOT, tools, ...(ownedPaths !== undefined ? { ownedPaths } : {}) });

function adapterWith(server: { spawn: ContainedSpawn }, extra: Partial<OpenCodeHarnessAdapterConfig> = {}) {
  return createOpenCodeHarnessAdapter({
    projectRoot: ROOT,
    envAllowlist: [],
    command: process.execPath,
    model: 'openai/gpt-4.1-mini',
    sourceEnv: { PATH: '/usr/bin:/bin', XDG_DATA_HOME: AUTH_HOME, SECRET: 'must-not-leak' },
    spawn: server.spawn,
    containment,
    holdStopWaitMs: 300,
    toolPartWaitMs: 150,
    ...extra,
  });
}

function invocation(extra: Partial<HarnessInvocation> = {}): HarnessInvocation {
  return { prompt: 'do it', inputs: [], tools: [], timeoutMs: 5_000, gate: allowAll, ...extra };
}

function collect() {
  const events: HarnessEvent[] = [];
  return { events, onEvent: (e: HarnessEvent) => events.push(e) };
}

interface Outcome {
  result?: Awaited<ReturnType<ReturnType<typeof createOpenCodeHarnessAdapter>['invoke']>>;
  error?: Error & { code?: string; usage?: KnownUsage; resetAtMs?: number };
  events: HarnessEvent[];
  fake: ReturnType<typeof fakeOpenCode>;
  gateCalls: GateToolCall[];
}

const USAGE_1 = { total: 1000, input: 100, output: 50, reasoning: 10, cache: { read: 800, write: 40 } };

/** Finish the scenario the usual way: one assistant message with usage, then idle. */
const finish = (s: Scenario, id = 'msg_1'): void => {
  s.assistant(id, { cost: 0.002, tokens: USAGE_1 });
  s.idle();
};

async function run(
  scenario: (s: Scenario) => Promise<void> | void,
  o: { gate?: HarnessToolGate; fake?: FakeOptions; config?: Partial<OpenCodeHarnessAdapterConfig>; invocation?: Partial<HarnessInvocation> } = {},
): Promise<Outcome> {
  const fake = fakeOpenCode(scenario, o.fake);
  const { events, onEvent } = collect();
  const gateCalls: GateToolCall[] = [];
  const inner = o.gate ?? allowAll;
  const gate: HarnessToolGate = (c) => {
    gateCalls.push(c);
    return inner(c);
  };
  const out: Outcome = { events, fake, gateCalls };
  try {
    out.result = await adapterWith(fake, o.config).invoke(invocation({ gate, onEvent, ...o.invocation }));
  } catch (err) {
    out.error = err as Outcome['error'];
  }
  return out;
}

const replies = (o: Outcome): Json[] =>
  o.fake.state.requests.filter((r) => /^\/permission\/[^/]+\/reply$/.test(r.path)).map((r) => r.body);

const gateDecisions = (o: Outcome) => o.events.filter((e) => e.type === 'gate-decision') as Array<Extract<HarnessEvent, { type: 'gate-decision' }>>;

// ---------------------------------------------------------------------------

describe('opencode adapter: process, auth and environment', () => {
  it('starts `opencode serve` on a random loopback port and pins the arguments', async () => {
    const o = await run((s) => finish(s));
    expect(o.error).toBeUndefined();
    expect(OPENCODE_SERVE_ARGS).toEqual(['serve', '--port', '0', '--hostname', '127.0.0.1']);
    expect(o.fake.state.spec?.command).toBe(process.execPath);
    expect(o.fake.state.spec?.args).toEqual([...OPENCODE_SERVE_ARGS]);
    expect(o.fake.state.spec?.cwd).toBe(ROOT);
  });

  it('sends HTTP Basic credentials on every request, the event stream included', async () => {
    const o = await run(async (s) => {
      await s.bash('c1', 'cat a.txt');
      finish(s);
    });
    const requests = o.fake.state.requests;
    expect(requests.map((r) => r.path)).toContain('/event');
    expect(requests.length).toBeGreaterThan(3);
    expect(requests.every((r) => r.authOk)).toBe(true);
  });

  it('names the project root as the instance directory on every request', async () => {
    const o = await run((s) => finish(s));
    expect(o.fake.state.requests.every((r) => r.directory === ROOT)).toBe(true);
  });

  it('gives the fake a way to refuse a wrong password, which the adapter never sends', async () => {
    let probeStatus: number | undefined;
    let probeError: unknown;
    const o = await run(async (s) => {
      try {
        probeStatus = await s.probeWrongPassword();
      } catch (err) {
        probeError = err;
      }
      finish(s);
    });
    expect(probeError).toBeUndefined();
    expect(probeStatus).toBe(401);
    expect(o.fake.state.spec!.env[PASSWORD_VAR]!.length).toBeGreaterThanOrEqual(32);
    // The probe is not in the adapter's recorded requests.
    expect(o.fake.state.requests.every((r) => r.authOk)).toBe(true);
  });

  it('uses a different password for every invocation', async () => {
    const a = await run((s) => finish(s));
    const b = await run((s) => finish(s));
    expect(a.fake.state.spec!.env[PASSWORD_VAR]).not.toBe(b.fake.state.spec!.env[PASSWORD_VAR]);
  });

  it('refuses a server that reports a non-loopback address, and kills it', async () => {
    const o = await run(() => {}, { fake: { listenHost: '0.0.0.0' } });
    expect(o.error?.code).toBe('harness-nonzero-exit');
    expect(o.error?.message).toContain('loopback');
    expect(o.fake.state.kills).toBeGreaterThanOrEqual(1);
    expect(o.fake.state.requests.length).toBe(0);
  });

  it('asks for every tool in the config it hands the server, and enables no question tool', async () => {
    const o = await run((s) => finish(s));
    const env = o.fake.state.spec!.env;
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
    expect(config.permission).toEqual({ '*': 'ask' });
    expect(config.mcp).toEqual({});
    expect(config.plugin).toEqual([]);
    expect(env.OPENCODE_ENABLE_QUESTION_TOOL).toBeUndefined();
    for (const name of [
      'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
      'OPENCODE_PURE', 'OPENCODE_DISABLE_DEFAULT_PLUGINS',
    ]) {
      expect(env[name]).toBe('1');
    }
  });

  it('builds the child env from the allowlist, PATH and the run-scoped variables only', async () => {
    const o = await run((s) => finish(s), { config: { envAllowlist: ['LANG'], sourceEnv: { PATH: '/usr/bin', LANG: 'C', HOME: '/home/op', SECRET: 'x', XDG_DATA_HOME: AUTH_HOME } } });
    const env = o.fake.state.spec!.env;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LANG).toBe('C');
    expect(env.HOME).toBeUndefined();
    expect(env.SECRET).toBeUndefined();
    expect(Object.keys(env).filter((k) => !k.startsWith('OPENCODE_') && !k.startsWith('XDG_')).sort()).toEqual(['LANG', 'PATH']);
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
      expect(env[name]).toContain('conduit-opencode-');
      expect(env[name]).not.toBe(AUTH_HOME);
    }
  });

  it('drops every allowlisted OPENCODE_* variable that the adapter does not set itself', async () => {
    const names = ['OPENCODE_PERMISSION', 'OPENCODE_CONFIG', 'OPENCODE_SERVER_USERNAME'];
    const o = await run((s) => finish(s), {
      config: { envAllowlist: names, sourceEnv: { PATH: '/usr/bin', XDG_DATA_HOME: AUTH_HOME, OPENCODE_PERMISSION: '{"*":"allow"}', OPENCODE_CONFIG: '/x/opencode.json', OPENCODE_SERVER_USERNAME: 'root' } },
    });
    const env = o.fake.state.spec!.env;
    for (const name of names) expect(env[name]).toBeUndefined();
    expect(o.fake.state.requests.every((r) => r.authOk)).toBe(true);
  });

  it('lets the run-scoped variables win over an allowlisted name', async () => {
    const o = await run((s) => finish(s), { config: { envAllowlist: ['XDG_CONFIG_HOME', 'OPENCODE_CONFIG_CONTENT'], sourceEnv: { PATH: '/usr/bin', XDG_CONFIG_HOME: '/home/op/.config', OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"}}', XDG_DATA_HOME: AUTH_HOME } } });
    const env = o.fake.state.spec!.env;
    expect(env.XDG_CONFIG_HOME).toContain('conduit-opencode-');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).permission).toEqual({ '*': 'ask' });
  });

  it('creates the XDG directories before the call and removes them on success', async () => {
    const o = await run((s) => finish(s));
    expect(o.fake.state.dirsDuring).toBe(true);
    const root = dirname(o.fake.state.spec!.env.XDG_CONFIG_HOME!);
    expect(existsSync(root)).toBe(false);
  });

  it('removes the directories on failure, timeout, hold and a throwing spawn', async () => {
    const failed = await run((s) => s.exit(2));
    const timedOut = await run(() => {}, { invocation: { timeoutMs: 150 } });
    const held = await run(async (s) => {
      await s.bash('c1', 'rm -rf x');
    }, { gate: () => ({ decision: 'hold', code: 'needs_human', reason: 'ask' }) });
    for (const o of [failed, timedOut, held]) {
      expect(existsSync(dirname(o.fake.state.spec!.env.XDG_CONFIG_HOME!))).toBe(false);
    }
    const throwing = await run(() => {}, { fake: { throwOnSpawn: true } });
    expect(throwing.error?.message).toContain('spawn boom');
    expect(existsSync(dirname(throwing.fake.state.spec!.env.XDG_CONFIG_HOME!))).toBe(false);
  });
});

describe('opencode adapter: model and credentials', () => {
  it('sends the model as providerID and modelID, splitting at the first slash', async () => {
    const o = await run((s) => finish(s));
    expect(o.fake.state.promptBody).toMatchObject({ model: { providerID: 'openai', modelID: 'gpt-4.1-mini' }, parts: [{ type: 'text', text: 'do it' }] });
    const nested = await run((s) => finish(s), { config: { model: 'openai/ft:a/b' } });
    expect(nested.fake.state.promptBody?.model).toEqual({ providerID: 'openai', modelID: 'ft:a/b' });
  });

  it("prefers the invocation's model over the configured default", async () => {
    const o = await run((s) => finish(s), { invocation: { model: 'anthropic/claude-x' } });
    expect(o.fake.state.promptBody?.model).toEqual({ providerID: 'anthropic', modelID: 'claude-x' });
  });

  it('fails before spawning when no model is configured, or the model has no provider', async () => {
    for (const model of [undefined, '', 'gpt-4.1-mini', '/x', 'openai/']) {
      const fake = fakeOpenCode(() => {});
      const adapter = adapterWith(fake, { model });
      const err = await adapter.invoke(invocation()).catch((e) => e as Error);
      expect((err as Error).message).toMatch(/model/);
      expect(fake.state.spawns).toBe(0);
    }
  });

  it('passes only the entry for the model provider, as OPENCODE_AUTH_CONTENT', async () => {
    const o = await run((s) => finish(s));
    const content = JSON.parse(o.fake.state.spec!.env.OPENCODE_AUTH_CONTENT!);
    expect(Object.keys(content)).toEqual(['openai']);
    expect(content.openai.key).toBe(OPENAI_SECRET);
    const other = await run((s) => finish(s), { invocation: { model: 'anthropic/claude-x' } });
    expect(Object.keys(JSON.parse(other.fake.state.spec!.env.OPENCODE_AUTH_CONTENT!))).toEqual(['anthropic']);
  });

  it('never puts a credential in an event, a result or an error', async () => {
    const good = await run(async (s) => {
      await s.bash('c1', 'cat a.txt');
      finish(s);
    });
    const bad = await run((s) => {
      s.assistant('msg_1', { error: { name: 'APIError', data: { message: 'bad key', statusCode: 401 } } });
      s.idle();
    });
    for (const o of [good, bad]) {
      const dump = JSON.stringify([o.events, o.result, o.error?.message, o.error?.code, o.gateCalls]);
      expect(dump).not.toContain(OPENAI_SECRET);
      expect(dump).not.toContain(ANTHROPIC_SECRET);
      expect(dump).not.toContain(o.fake.state.spec!.env[PASSWORD_VAR]!);
    }
  });

  it('fails before spawning, naming the provider and no secret, when the provider has no credentials', async () => {
    const fake = fakeOpenCode(() => {});
    const err = await adapterWith(fake, { model: 'groq/llama' }).invoke(invocation()).catch((e) => e as Error);
    expect((err as Error).message).toContain('groq');
    expect((err as Error).message).not.toContain(OPENAI_SECRET);
    expect(fake.state.spawns).toBe(0);
    expect(leaked()).toEqual([]);
  });

  it('accepts an allowlisted provider variable in place of an auth.json entry, and passes no auth content', async () => {
    const o = await run((s) => finish(s), {
      config: { model: 'openrouter/x/y', envAllowlist: ['OPENROUTER_API_KEY'], sourceEnv: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'sk-or', XDG_DATA_HOME: AUTH_HOME } },
    });
    expect(o.error).toBeUndefined();
    expect(o.fake.state.spec!.env.OPENROUTER_API_KEY).toBe('sk-or');
    expect(o.fake.state.spec!.env.OPENCODE_AUTH_CONTENT).toBeUndefined();
  });

  it('does not accept a provider variable that is not allowlisted', async () => {
    const fake = fakeOpenCode(() => {});
    const err = await adapterWith(fake, {
      model: 'openrouter/x', sourceEnv: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'sk-or', XDG_DATA_HOME: AUTH_HOME },
    }).invoke(invocation()).catch((e) => e as Error);
    expect((err as Error).message).toContain('openrouter');
    expect(fake.state.spawns).toBe(0);
  });

  it('reports an unreadable auth.json without quoting it', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'conduit-opencode-badauth-')));
    try {
      mkdirSync(join(home, 'opencode'));
      writeFileSync(join(home, 'opencode', 'auth.json'), '{"openai": SECRETGARBAGE');
      const fake = fakeOpenCode(() => {});
      const err = await adapterWith(fake, { sourceEnv: { PATH: '/usr/bin', XDG_DATA_HOME: home } }).invoke(invocation()).catch((e) => e as Error);
      expect((err as Error).message).toContain('auth.json');
      expect((err as Error).message).not.toContain('SECRETGARBAGE');
      expect(fake.state.spawns).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('opencode adapter: mapping asks to the gate', () => {
  const tools = ['Bash(cat:*)', 'Bash(ls:*)', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Agent'];

  it('gates a bash ask with the command from the tool part and answers once for an allow', async () => {
    const o = await run(async (s) => {
      expect(await s.bash('c1', 'cat a.txt')).toEqual({ reply: 'once' });
      finish(s);
    }, { gate: gateFor(tools) });
    expect(o.gateCalls).toEqual([{ toolName: 'Bash', input: { command: 'cat a.txt' }, toolCallId: 'c1' }]);
    expect(o.result).toBeDefined();
  });

  it('rejects a compound command with the reason, using the full command from the tool part', async () => {
    const o = await run(async (s) => {
      const body = await s.bash('c1', 'cat a.txt && ls', { patterns: ['cat a.txt', 'ls'] });
      expect(body?.reply).toBe('reject');
      expect(body?.message).toContain('metacharacter');
      finish(s);
    }, { gate: gateFor(tools) });
    expect(o.gateCalls[0]?.input).toEqual({ command: 'cat a.txt && ls' });
    expect(gateDecisions(o)[0]).toMatchObject({ toolName: 'Bash', decision: 'deny', code: 'shell_metacharacter' });
  });

  it('rejects a bash ask whose pattern differs from the tool part command, without asking the gate', async () => {
    const o = await run(async (s) => {
      expect((await s.bash('c1', 'rm -rf x', { patterns: ['cat a.txt'] }))?.reply).toBe('reject');
      finish(s);
    });
    expect(o.gateCalls).toEqual([]);
    expect(gateDecisions(o)[0]).toMatchObject({ decision: 'deny', code: 'malformed_input' });
  });

  it('rejects a bash call whose working directory is outside the project root', async () => {
    const o = await run(async (s) => {
      s.part({ callID: 'c1', tool: 'bash', status: 'running', input: { command: 'ls', workdir: '/etc' } });
      expect((await s.ask({ permission: 'bash', patterns: ['ls'], tool: { messageID: 'msg_1', callID: 'c1' } }))?.reply).toBe('reject');
      s.part({ callID: 'c2', tool: 'bash', status: 'running', input: { command: 'ls', workdir: 'out' } });
      expect((await s.ask({ permission: 'bash', patterns: ['ls'], tool: { messageID: 'msg_1', callID: 'c2' } }))?.reply).toBe('once');
      finish(s);
    });
    expect(gateDecisions(o)[0]).toMatchObject({ decision: 'deny', code: 'path_escape' });
    expect(o.gateCalls.length).toBe(1);
  });

  it('maps write and edit to Write and Edit with an absolute path, and checks owned paths', async () => {
    const inside = join(ROOT, 'out', 'x.txt');
    const outside = join(ROOT, 'a.txt');
    const o = await run(async (s) => {
      s.part({ callID: 'w1', tool: 'write', status: 'running', input: { filePath: inside, content: 'BODY' } });
      expect((await s.ask({ permission: 'edit', patterns: ['out/x.txt'], metadata: { filepath: inside }, tool: { messageID: 'msg_1', callID: 'w1' } }))?.reply).toBe('once');
      s.part({ callID: 'e1', tool: 'edit', status: 'running', input: { filePath: outside, oldString: 'a', newString: 'b' } });
      expect((await s.ask({ permission: 'edit', patterns: ['a.txt'], metadata: { filepath: outside }, tool: { messageID: 'msg_1', callID: 'e1' } }))?.reply).toBe('reject');
      finish(s);
    }, { gate: gateFor(tools, ['out']) });
    expect(o.gateCalls.map((c) => [c.toolName, (c.input as any).file_path])).toEqual([['Write', inside], ['Edit', outside]]);
    expect(gateDecisions(o).map((d) => [d.toolName, d.decision, d.code])).toEqual([['Write', 'allow', undefined], ['Edit', 'deny', 'path_escape']]);
  });

  it('resolves a relative tool path against the project root', async () => {
    const o = await run(async (s) => {
      s.part({ callID: 'w1', tool: 'write', status: 'running', input: { filePath: 'out/y.txt', content: 'x' } });
      await s.ask({ permission: 'edit', patterns: ['out/y.txt'], metadata: { filepath: join(ROOT, 'out', 'y.txt') }, tool: { messageID: 'msg_1', callID: 'w1' } });
      finish(s);
    });
    expect((o.gateCalls[0]!.input as any).file_path).toBe(join(ROOT, 'out', 'y.txt'));
  });

  it('rejects a write whose path is outside the project root, without asking the gate', async () => {
    const o = await run(async (s) => {
      s.part({ callID: 'w1', tool: 'write', status: 'running', input: { filePath: '/etc/passwd', content: 'x' } });
      expect((await s.ask({ permission: 'edit', patterns: ['etc/passwd'], metadata: { filepath: '/etc/passwd' }, tool: { messageID: 'msg_1', callID: 'w1' } }))?.reply).toBe('reject');
      finish(s);
    });
    expect(o.gateCalls).toEqual([]);
    expect(gateDecisions(o)[0]).toMatchObject({ toolName: 'Write', decision: 'deny', code: 'path_escape' });
  });

  it('rejects an edit whose tool part path disagrees with the ask metadata', async () => {
    const o = await run(async (s) => {
      s.part({ callID: 'w1', tool: 'write', status: 'running', input: { filePath: join(ROOT, 'out', 'x.txt'), content: 'x' } });
      expect((await s.ask({ permission: 'edit', patterns: ['out/z.txt'], metadata: { filepath: join(ROOT, 'out', 'z.txt') }, tool: { messageID: 'msg_1', callID: 'w1' } }))?.reply).toBe('reject');
      finish(s);
    });
    expect(o.gateCalls).toEqual([]);
  });

  it('gates every file of a patch, and one denied path rejects the whole patch', async () => {
    const ok = join(ROOT, 'out', 'new.txt');
    const bad = join(ROOT, 'a.txt');
    const moved = join(ROOT, 'out', 'moved.txt');
    const o = await run(async (s) => {
      s.part({ callID: 'p1', tool: 'apply_patch', status: 'running', input: { patchText: '*** Begin Patch' } });
      const body = await s.ask({
        permission: 'edit', patterns: ['out/new.txt', 'a.txt'],
        metadata: { files: [{ filePath: ok, type: 'add' }, { filePath: bad, type: 'update' }] },
        tool: { messageID: 'msg_1', callID: 'p1' },
      });
      expect(body?.reply).toBe('reject');
      s.part({ callID: 'p2', tool: 'apply_patch', status: 'running', input: { patchText: '*** Begin Patch' } });
      const good = await s.ask({
        permission: 'edit', patterns: ['out/new.txt'],
        metadata: { files: [{ filePath: ok, type: 'add' }, { filePath: join(ROOT, 'out', 'old.txt'), type: 'move', movePath: moved }, { filePath: join(ROOT, 'out', 'gone.txt'), type: 'delete' }] },
        tool: { messageID: 'msg_1', callID: 'p2' },
      });
      expect(good?.reply).toBe('once');
      finish(s);
    }, { gate: gateFor(tools, ['out']) });
    expect(o.gateCalls.map((c) => [c.toolName, (c.input as any).file_path])).toEqual([
      ['Write', ok], ['Edit', bad],
      ['Write', ok], ['Edit', join(ROOT, 'out', 'old.txt')], ['Write', moved], ['Write', join(ROOT, 'out', 'gone.txt')],
    ]);
  });

  it('rejects a patch with no file list, an unknown file type, or a path outside the root', async () => {
    const o = await run(async (s) => {
      let n = 0;
      for (const files of [undefined, [{ filePath: join(ROOT, 'out', 'a'), type: 'chmod' }], [{ filePath: '/etc/x', type: 'add' }], [{ filePath: join(ROOT, 'out', 'a'), type: 'move' }]]) {
        const callID = `p${n++}`;
        s.part({ callID, tool: 'apply_patch', status: 'running', input: {} });
        expect((await s.ask({ permission: 'edit', patterns: [], metadata: files === undefined ? {} : { files }, tool: { messageID: 'msg_1', callID } }))?.reply).toBe('reject');
      }
      finish(s);
    });
    expect(o.gateCalls).toEqual([]);
  });

  it('rejects an edit ask for a tool name it does not know', async () => {
    const o = await run(async (s) => {
      s.part({ callID: 'x1', tool: 'notebook', status: 'running', input: { filePath: join(ROOT, 'out', 'n') } });
      expect((await s.ask({ permission: 'edit', patterns: ['out/n'], tool: { messageID: 'msg_1', callID: 'x1' } }))?.reply).toBe('reject');
      finish(s);
    });
    expect(gateDecisions(o)[0]).toMatchObject({ decision: 'deny', code: 'tool_not_allowed' });
  });

  it('maps read, glob, grep and list, and confines their paths to the project root', async () => {
    const o = await run(async (s) => {
      const ask = async (callID: string, permission: string, tool: string, input: Json) => {
        s.part({ callID, tool, status: 'running', input });
        return (await s.ask({ permission, patterns: ['p'], tool: { messageID: 'msg_1', callID } }))?.reply;
      };
      expect(await ask('r1', 'read', 'read', { filePath: join(ROOT, 'a.txt') })).toBe('once');
      expect(await ask('r2', 'read', 'read', { filePath: '/etc/passwd' })).toBe('reject');
      expect(await ask('g1', 'glob', 'glob', { pattern: '*.txt', path: '' })).toBe('once');
      expect(await ask('g2', 'grep', 'grep', { pattern: 'one', path: 'out', include: '*.txt' })).toBe('once');
      expect(await ask('g3', 'grep', 'grep', { pattern: 'root', path: '/etc' })).toBe('reject');
      expect(await ask('l1', 'list', 'list', { path: '' })).toBe('once');
      finish(s);
    }, { gate: gateFor(tools) });
    expect(o.gateCalls.map((c) => c.toolName)).toEqual(['Read', 'Glob', 'Grep', 'Glob']);
    expect(gateDecisions(o).filter((d) => d.code === 'path_escape').length).toBe(2);
  });

  it('maps webfetch and websearch to network tools that the gate denies, without waiting for a tool part', async () => {
    const o = await run(async (s) => {
      expect((await s.ask({ permission: 'webfetch', patterns: ['https://example.com'], tool: { messageID: 'msg_1', callID: 'n1' } }))?.reply).toBe('reject');
      expect((await s.ask({ permission: 'websearch', patterns: ['q'], tool: { messageID: 'msg_1', callID: 'n2' } }))?.reply).toBe('reject');
      finish(s);
    }, { gate: gateFor([...tools, 'WebFetch', 'WebSearch']) });
    expect(o.gateCalls.map((c) => c.toolName)).toEqual(['WebFetch', 'WebSearch']);
    expect(gateDecisions(o).every((d) => d.code === 'network_denied')).toBe(true);
  });

  it('maps task to Agent from the ask itself', async () => {
    const o = await run(async (s) => {
      expect((await s.ask({ permission: 'task', patterns: ['general'], metadata: { description: 'd', subagent_type: 'general' }, tool: { messageID: 'msg_1', callID: 't1' } }))?.reply).toBe('once');
      finish(s);
    }, { gate: gateFor(tools) });
    expect(o.gateCalls[0]).toMatchObject({ toolName: 'Agent', toolCallId: 't1' });
    expect(gateFor(['Read'])(o.gateCalls[0]!)).toMatchObject({ decision: 'deny', code: 'tool_not_allowed' });
  });

  it('always rejects external_directory and never asks the gate, even for an allow-all gate', async () => {
    const o = await run(async (s) => {
      expect((await s.ask({ permission: 'external_directory', patterns: ['/etc/*'], tool: { messageID: 'msg_1', callID: 'x1' } }))?.reply).toBe('reject');
      expect((await s.ask({ permission: 'external_directory', patterns: [ROOT + '/*'], tool: { messageID: 'msg_1', callID: 'x2' } }))?.reply).toBe('reject');
      finish(s);
    });
    expect(o.gateCalls).toEqual([]);
    expect(gateDecisions(o).map((d) => [d.toolName, d.decision, d.code])).toEqual([
      ['external_directory', 'deny', 'path_escape'], ['external_directory', 'deny', 'path_escape'],
    ]);
  });

  it('rejects lsp, doom_loop and an unknown category without asking the gate', async () => {
    const o = await run(async (s) => {
      for (const permission of ['lsp', 'doom_loop', 'some_new_thing', 'github_search_repos']) {
        expect((await s.ask({ permission, patterns: ['x'], tool: { messageID: 'msg_1', callID: `u-${permission}` } }))?.reply).toBe('reject');
      }
      finish(s);
    });
    expect(o.gateCalls).toEqual([]);
    expect(gateDecisions(o).map((d) => [d.toolName, d.code])).toEqual([
      ['lsp', 'tool_not_allowed'], ['doom_loop', 'tool_not_allowed'], ['some_new_thing', 'tool_not_allowed'], ['github_search_repos', 'tool_not_allowed'],
    ]);
  });

  it('gates todowrite and skill by name, so a station allows them only by listing them', async () => {
    const run1 = async (list: string[]) =>
      run(async (s) => {
        expect((await s.ask({ permission: 'todowrite', patterns: ['*'], tool: { messageID: 'msg_1', callID: 'd1' } }))?.reply).toBe(list.includes('TodoWrite') ? 'once' : 'reject');
        expect((await s.ask({ permission: 'skill', patterns: ['review'], tool: { messageID: 'msg_1', callID: 'd2' } }))?.reply).toBe(list.includes('Skill') ? 'once' : 'reject');
        finish(s);
      }, { gate: gateFor(list) });
    expect((await run1(['Read'])).gateCalls.map((c) => c.toolName)).toEqual(['TodoWrite', 'Skill']);
    await run1(['TodoWrite', 'Skill']);
  });

  it('holds on a question permission ask and never allows it, even for an allow-all gate', async () => {
    const o = await run(async (s) => {
      await s.ask({ permission: 'question', patterns: ['*'], tool: { messageID: 'msg_1', callID: 'q1' } });
      s.assistant('msg_1', { cost: 0.001, tokens: USAGE_1 });
    });
    expect(o.error?.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(replies(o)[0]).toMatchObject({ reply: 'reject' });
  });

  it('waits for a tool part that arrives after the ask, then decides', async () => {
    const o = await run(async (s) => {
      const pending = s.ask({ permission: 'bash', patterns: ['cat a.txt'], tool: { messageID: 'msg_1', callID: 'c1' } });
      s.part({ callID: 'c1', tool: 'bash', status: 'pending', input: {} });
      await Bun.sleep(150);
      s.part({ callID: 'c1', tool: 'bash', status: 'running', input: { command: 'cat a.txt' } });
      expect((await pending)?.reply).toBe('once');
      finish(s);
    }, { gate: gateFor(tools), config: { toolPartWaitMs: 5_000 } });
    expect(o.gateCalls[0]?.input).toEqual({ command: 'cat a.txt' });
  });

  it('re-fetches the message when the part does not arrive, and decides from it', async () => {
    const o = await run(async (s) => {
      expect((await s.ask({ permission: 'bash', patterns: ['cat a.txt'], tool: { messageID: 'msg_1', callID: 'c1' } }))?.reply).toBe('once');
      finish(s);
    }, {
      gate: gateFor(tools),
      fake: {
        messageBody: (_session, messageID) => ({
          info: { id: messageID },
          parts: [{ type: 'tool', tool: 'bash', callID: 'c1', messageID, sessionID: 'ses_root', state: { status: 'running', input: { command: 'cat a.txt' } } }],
        }),
      },
    });
    expect(o.fake.state.requests.some((r) => r.method === 'GET' && r.path === '/session/ses_root/message/msg_1')).toBe(true);
    expect(o.gateCalls.length).toBe(1);
  });

  it('denies, failing closed, when the tool part never arrives', async () => {
    const o = await run(async (s) => {
      expect((await s.ask({ permission: 'bash', patterns: ['cat a.txt'], tool: { messageID: 'msg_1', callID: 'c1' } }))?.reply).toBe('reject');
      expect((await s.ask({ permission: 'read', patterns: ['a.txt'], tool: null }))?.reply).toBe('reject');
      finish(s);
    });
    expect(o.gateCalls).toEqual([]);
    expect(gateDecisions(o).every((d) => d.decision === 'deny' && d.code === 'malformed_input')).toBe(true);
  });

  it('does not accept a tool part that belongs to another session or message', async () => {
    const o = await run(async (s) => {
      s.part({ callID: 'c1', tool: 'bash', status: 'running', input: { command: 'cat a.txt' }, messageID: 'msg_other' });
      expect((await s.ask({ permission: 'bash', patterns: ['cat a.txt'], tool: { messageID: 'msg_1', callID: 'c1' } }))?.reply).toBe('reject');
      finish(s);
    });
    expect(o.gateCalls).toEqual([]);
  });

  it('rejects an ask from a session outside the tree, and a malformed ask, without asking the gate', async () => {
    const o = await run(async (s) => {
      s.child('ses_stranger', 'ses_unknown_parent');
      s.part({ callID: 'c1', tool: 'bash', status: 'running', input: { command: 'cat a.txt' }, sessionID: 'ses_stranger' });
      expect((await s.ask({ permission: 'bash', patterns: ['cat a.txt'], sessionID: 'ses_stranger', tool: { messageID: 'msg_1', callID: 'c1' } }))?.reply).toBe('reject');
      expect((await s.ask({ permission: 'bash', patterns: 'cat a.txt' as any, tool: { messageID: 'msg_1', callID: 'c1' } }))?.reply).toBe('reject');
      expect((await s.ask({ permission: 'bash', id: 'per_raw', raw: { id: 'per_raw', sessionID: 'ses_root', patterns: ['x'] } }))?.reply).toBe('reject');
      finish(s);
    });
    expect(o.gateCalls).toEqual([]);
  });

  it('answers a throwing gate and a malformed gate answer with a reject', async () => {
    const throwing = await run(async (s) => {
      expect((await s.bash('c1', 'cat a.txt'))?.reply).toBe('reject');
      finish(s);
    }, { gate: () => { throw new Error('boom'); } });
    expect(gateDecisions(throwing)[0]).toMatchObject({ decision: 'deny', code: 'gate_error' });
    const garbled = await run(async (s) => {
      expect((await s.bash('c1', 'cat a.txt'))?.reply).toBe('reject');
      finish(s);
    }, { gate: (() => 'yes') as unknown as HarnessToolGate });
    expect(gateDecisions(garbled)[0]).toMatchObject({ decision: 'deny', code: 'gate_error' });
  });

  it('rejects every ask when the invocation carries no gate', async () => {
    const o = await run(async (s) => {
      expect((await s.bash('c1', 'cat a.txt'))?.reply).toBe('reject');
      finish(s);
    }, { invocation: { gate: undefined } });
    expect(gateDecisions(o)[0]).toMatchObject({ decision: 'deny', code: 'gate_error' });
  });
});

describe('opencode adapter: replies', () => {
  it('sends only once or reject, never always, and does not echo the always list back', async () => {
    const o = await run(async (s) => {
      s.part({ callID: 'c1', tool: 'bash', status: 'running', input: { command: 'cat a.txt' } });
      await s.ask({ permission: 'bash', patterns: ['cat a.txt'], always: ['cat *', '*'], tool: { messageID: 'msg_1', callID: 'c1' } });
      s.part({ callID: 'c2', tool: 'bash', status: 'running', input: { command: 'rm x' } });
      await s.ask({ permission: 'bash', patterns: ['rm x'], always: ['rm *'], tool: { messageID: 'msg_1', callID: 'c2' } });
      await s.ask({ permission: 'external_directory', patterns: ['/etc/*'], always: ['/etc/*'], tool: { messageID: 'msg_1', callID: 'c3' } });
      finish(s);
    }, { gate: gateFor(['Bash(cat:*)']) });
    const bodies = replies(o);
    expect(bodies.length).toBe(3);
    expect(bodies.map((b) => b.reply)).toEqual(['once', 'reject', 'reject']);
    for (const body of bodies) {
      expect(['once', 'reject']).toContain(body.reply);
      expect(Object.keys(body).every((k) => k === 'reply' || k === 'message')).toBe(true);
      expect(JSON.stringify(body)).not.toContain('always');
      expect(JSON.stringify(body)).not.toContain('cat *');
    }
  });

  it('gives a rejected call the reason, bounded, so the model can go another way', async () => {
    const o = await run(async (s) => {
      const body = await s.bash('c1', 'rm x');
      expect(body?.reply).toBe('reject');
      expect(typeof body?.message).toBe('string');
      expect(body!.message.length).toBeLessThanOrEqual(300);
      expect(body!.message).not.toContain('rm x');
      finish(s);
    }, { gate: gateFor(['Bash(cat:*)']) });
    expect(o.error).toBeUndefined();
  });

  it('treats a 404 on a reply as the server having already settled the ask', async () => {
    const o = await run(async (s) => {
      expect((await s.bash('c1', 'cat a.txt'))?.reply).toBe('once');
      finish(s);
    }, { fake: { reply404: true } });
    expect(o.error).toBeUndefined();
  });
});

describe('opencode adapter: question tool and hold', () => {
  it('does not mark the first hold replied when a later question is rejected first', async () => {
    const o = await run(async (s) => {
      s.assistant('msg_1', { cost: 0.001, tokens: USAGE_1 });
      s.emit('question.asked', { id: 'que_1', sessionID: s.sessionID, questions: [], tool: { messageID: 'msg_1', callID: 'q1' } });
      s.emit('question.asked', { id: 'que_2', sessionID: s.sessionID, questions: [], tool: { messageID: 'msg_1', callID: 'q2' } });
    }, { fake: { rejectDelayMs: { que_1: 400 } }, config: { holdStopWaitMs: 5_000 } });
    expect(o.error?.code).toBe(HARNESS_GATE_HOLD_CODE);
    const tl = o.fake.state.timeline;
    const firstDone = tl.indexOf('done /question/que_1/reject');
    const abort = tl.findIndex((e) => e.includes('/abort'));
    expect(firstDone).toBeGreaterThan(-1);
    expect(abort).toBeGreaterThan(firstDone);
  });

  it('rejects a question.asked and holds', async () => {
    const o = await run(async (s) => {
      s.assistant('msg_1', { cost: 0.001, tokens: USAGE_1 });
      s.emit('question.asked', { id: 'que_1', sessionID: s.sessionID, questions: [{ question: 'sure?' }], tool: { messageID: 'msg_1', callID: 'q1' } });
    });
    expect(o.error?.code).toBe(HARNESS_GATE_HOLD_CODE);
    const paths = o.fake.state.requests.map((r) => r.path);
    expect(paths).toContain('/question/que_1/reject');
    expect(paths.indexOf('/question/que_1/reject')).toBeLessThan(paths.indexOf('/session/ses_root/abort'));
    expect(gateDecisions(o)[0]).toMatchObject({ toolName: 'AskUserQuestion', decision: 'hold', code: 'needs_human' });
  });

  it('holds on a question.asked even when the gate would allow it', async () => {
    const o = await run(async (s) => {
      s.assistant('msg_1', { cost: 0.001, tokens: USAGE_1 });
      s.emit('question.asked', { id: 'que_1', sessionID: s.sessionID, questions: [] });
    }, { gate: allowAll });
    expect(o.error?.code).toBe(HARNESS_GATE_HOLD_CODE);
  });

  it('follows the hold sequence: reject, deny later asks unasked, wait for usage, then abort', async () => {
    let gateCount = 0;
    const gate: HarnessToolGate = () => {
      gateCount += 1;
      return { decision: 'hold', code: 'needs_human', reason: 'ask a person' };
    };
    let abortBeforeUsage = false;
    const o = await run(async (s) => {
      const first = await s.bash('c1', 'rm -rf x');
      expect(first?.reply).toBe('reject');
      const second = await s.bash('c2', 'cat a.txt');
      expect(second?.reply).toBe('reject');
      await Bun.sleep(300);
      abortBeforeUsage = s.requests.some((r) => r.path.endsWith('/abort'));
      s.mark('usage');
      s.assistant('msg_1', { cost: 0.003, tokens: USAGE_1 });
    }, { gate, config: { holdStopWaitMs: 5_000 } });
    expect(gateCount).toBe(1);
    expect(abortBeforeUsage).toBe(false);
    expect(o.error?.code).toBe(HARNESS_GATE_HOLD_CODE);
    const t = o.fake.state.timeline;
    const idx = (needle: string) => t.findIndex((l) => l.includes(needle));
    expect(idx('per_0/reply')).toBeLessThan(idx('per_1/reply'));
    expect(idx('per_1/reply')).toBeLessThan(idx('MARK usage'));
    expect(idx('MARK usage')).toBeLessThan(idx('/abort'));
    expect(o.error?.usage).toMatchObject({ tokens: 1000, cost: 0.003 });
    expect(gateDecisions(o).map((d) => d.decision)).toEqual(['hold', 'deny']);
    expect(gateDecisions(o)[1]).toMatchObject({ code: 'needs_human' });
    expect(o.fake.state.kills).toBeGreaterThanOrEqual(1);
  });

  it('ends the hold when the session goes idle before any usage arrives', async () => {
    const o = await run(async (s) => {
      await s.bash('c1', 'rm x');
      s.idle();
    }, { gate: () => ({ decision: 'hold', code: 'needs_human', reason: 'r' }) });
    expect(o.error?.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(o.fake.state.requests.some((r) => r.path.endsWith('/abort'))).toBe(true);
  });

  it('aborts and kills when the bounded wait for usage expires, carrying what it saw', async () => {
    const started = Date.now();
    const o = await run(async (s) => {
      s.assistant('msg_0', { cost: 0.001, tokens: { total: 50, input: 20, output: 30, reasoning: 0, cache: { read: 0, write: 0 } } });
      await s.bash('c1', 'rm x', { messageID: 'msg_2' });
    }, { gate: () => ({ decision: 'hold', code: 'needs_human', reason: 'r' }), config: { holdStopWaitMs: 200 } });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(o.error?.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(o.fake.state.requests.some((r) => r.path.endsWith('/abort'))).toBe(true);
    expect(o.error?.usage).toMatchObject({ tokens: 50 });
    expect(o.fake.state.kills).toBeGreaterThanOrEqual(1);
  });

  it('a hold with no messageID does not abort on an earlier step that already reported usage', async () => {
    let abortBeforeUsage = true;
    const o = await run(async (s) => {
      s.assistant('msg_0', { cost: 0.001, tokens: { total: 50, input: 20, output: 30, reasoning: 0, cache: { read: 0, write: 0 } } });
      await s.ask({ permission: 'question', patterns: ['*'], tool: null });
      await Bun.sleep(300);
      abortBeforeUsage = s.requests.some((r) => r.path.endsWith('/abort'));
      s.assistant('msg_1', { cost: 0.003, tokens: USAGE_1 });
      s.idle();
    }, { gate: allowAll, config: { holdStopWaitMs: 2_000 } });
    expect(abortBeforeUsage).toBe(false);
    expect(o.error?.code).toBe(HARNESS_GATE_HOLD_CODE);
    expect(o.error?.usage).toMatchObject({ tokens: 1050 });
  });

  it('a hold error message names the tool and the code', async () => {
    const o = await run(async (s) => {
      await s.bash('c1', 'rm x');
      s.assistant('msg_1', { tokens: USAGE_1 });
    }, { gate: () => ({ decision: 'hold', code: 'needs_human', reason: 'ask a person' }) });
    expect(o.error?.message).toContain('Bash');
    expect(o.error?.message).toContain('needs_human');
  });
});

describe('opencode adapter: sessions and usage', () => {
  it('gates a child session ask with the child session id as agentId', async () => {
    const o = await run(async (s) => {
      s.child('ses_child', 'ses_root');
      await s.bash('c1', 'cat a.txt', { sessionID: 'ses_child', messageID: 'msg_c' });
      await s.bash('c2', 'cat a.txt');
      s.child('ses_grand', 'ses_child');
      await s.bash('c3', 'ls', { sessionID: 'ses_grand', messageID: 'msg_g' });
      finish(s);
    }, { gate: gateFor(['Bash(cat:*)', 'Bash(ls:*)']) });
    expect(o.gateCalls.map((c) => c.agentId)).toEqual(['ses_child', undefined, 'ses_grand']);
    expect(gateDecisions(o).map((d) => d.agentId)).toEqual(['ses_child', undefined, 'ses_grand']);
    expect(o.gateCalls.every((c) => c.toolName === 'Bash')).toBe(true);
  });

  it('sums the last value per message across the whole session tree', async () => {
    const o = await run((s) => {
      s.child('ses_child', 'ses_root');
      s.assistant('m1', { cost: 0.001, tokens: { total: 10, input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } });
      s.assistant('m1', { cost: 0.002, tokens: { total: 100, input: 10, output: 20, reasoning: 5, cache: { read: 60, write: 5 } } });
      s.assistant('m2', { cost: 0.004, tokens: { total: 200, input: 30, output: 40, reasoning: 0, cache: { read: 130, write: 0 } } });
      s.assistant('mc', { sessionID: 'ses_child', cost: 0.008, tokens: { total: 400, input: 50, output: 50, reasoning: 0, cache: { read: 300, write: 0 } } });
      s.idle();
    });
    const usage = o.result!.usage as KnownUsage;
    expect(usage.tokens).toBe(700);
    expect(usage.cost).toBeCloseTo(0.014, 6);
    expect(usage.breakdown).toEqual({ inputTokens: 90, outputTokens: 115, cacheReadInputTokens: 490, cacheCreationInputTokens: 5 });
    expect(usage.model).toBe('gpt-fake');
    expect(o.events.filter((e) => e.type === 'usage')).toMatchObject([{ tokens: 700 }]);
  });

  it('ignores a user message and a message from a session outside the tree when summing usage', async () => {
    const o = await run((s) => {
      s.emit('message.updated', { sessionID: s.sessionID, info: { id: 'u1', role: 'user', sessionID: s.sessionID, time: { created: 1 } } });
      s.assistant('other', { sessionID: 'ses_stranger', tokens: { total: 9999, input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } });
      s.assistant('m1', { tokens: USAGE_1 });
      s.idle();
    });
    expect((o.result!.usage as KnownUsage).tokens).toBe(1000);
  });

  it('reports usage as unknown when no message carried any', async () => {
    const o = await run((s) => s.idle());
    expect(o.result!.usage).toEqual({ unknown: true });
    expect(o.events.some((e) => e.type === 'usage')).toBe(false);
  });

  it('falls back to summing the token classes when a message has no total', async () => {
    const o = await run((s) => {
      s.assistant('m1', { tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 1 } } });
      s.idle();
    });
    const usage = o.result!.usage as KnownUsage;
    // input excludes cache and output excludes reasoning in opencode, so the parts add up.
    expect(usage.tokens).toBe(66);
    expect(usage.breakdown).toEqual({ inputTokens: 10, outputTokens: 25, cacheReadInputTokens: 30, cacheCreationInputTokens: 1 });
  });

  it('folds reasoning into outputTokens and keeps the reported total', async () => {
    const o = await run((s) => {
      s.assistant('m1', { tokens: { total: 100, input: 10, output: 20, reasoning: 7, cache: { read: 60, write: 3 } } });
      s.idle();
    });
    const usage = o.result!.usage as KnownUsage;
    expect(usage.tokens).toBe(100);
    expect(usage.breakdown).toEqual({ inputTokens: 10, outputTokens: 27, cacheReadInputTokens: 60, cacheCreationInputTokens: 3 });
  });

  it('completes with an empty output list, as the other supervised adapters do', async () => {
    const o = await run((s) => finish(s));
    expect(o.result!.outputs).toEqual([]);
  });

  it('waits for pending asks before completing on idle', async () => {
    const o = await run(async (s) => {
      const pending = s.bash('c1', 'cat a.txt');
      s.idle();
      await pending;
    });
    expect(o.error).toBeUndefined();
    expect(replies(o).length).toBe(1);
  });
});

describe('opencode adapter: failures', () => {
  it('classifies an HTTP 401 model error as an authentication failure with billed usage', async () => {
    const o = await run((s) => {
      s.assistant('m1', { tokens: USAGE_1, error: { name: 'APIError', data: { message: 'Incorrect API key', statusCode: 401, isRetryable: false } } });
      s.idle();
    });
    expect(o.error?.code).toBe('harness-nonzero-exit');
    expect(o.error?.message).toContain('authentication failed');
    expect((o.error?.usage as KnownUsage).tokens).toBe(1000);
  });

  it('classifies a ProviderAuthError session error as an authentication failure', async () => {
    const o = await run((s) => {
      s.emit('session.error', { sessionID: s.sessionID, error: { name: 'ProviderAuthError', data: { providerID: 'openai', message: 'no key' } } });
      s.idle();
    });
    expect(o.error?.code).toBe('harness-nonzero-exit');
    expect(o.error?.message).toContain('authentication failed');
  });

  it('classifies a 429 as harness-rate-limited', async () => {
    const o = await run((s) => {
      s.emit('session.error', { sessionID: s.sessionID, error: { name: 'APIError', data: { message: 'Too many requests', statusCode: 429, isRetryable: true } } });
      s.idle();
    });
    expect(o.error?.code).toBe('harness-rate-limited');
  });

  it('classifies rate-limit wording on an error with no status as harness-rate-limited', async () => {
    const o = await run((s) => {
      s.emit('session.error', { sessionID: s.sessionID, error: { name: 'APIError', data: { message: 'You exceeded your current quota', isRetryable: true } } });
      s.idle();
    });
    expect(o.error?.code).toBe('harness-rate-limited');
  });

  it('does not park a non-429 status whose message only mentions a quota or usage limit', async () => {
    for (const statusCode of [400, 403, 500]) {
      const o = await run((s) => {
        s.emit('session.error', { sessionID: s.sessionID, error: { name: 'APIError', data: { message: 'usage limit exceeded', statusCode, isRetryable: true } } });
        s.idle();
      });
      expect(o.error).toBeDefined();
      expect(o.error?.code).not.toBe('harness-rate-limited');
    }
  });

  it('stops at a retry status that carries rate-limit wording, and aborts the session', async () => {
    const o = await run(async (s) => {
      s.assistant('m1', { tokens: USAGE_1 });
      s.status({ type: 'retry', attempt: 1, message: 'Rate limit reached for requests', next: Date.now() + 60_000 });
      await Bun.sleep(3_000);
    }, { invocation: { timeoutMs: 20_000 } });
    expect(o.error?.code).toBe('harness-rate-limited');
    expect(o.error?.resetAtMs).toBeGreaterThan(Date.now());
    expect(o.fake.state.requests.some((r) => r.path.endsWith('/abort'))).toBe(true);
    expect((o.error?.usage as KnownUsage).tokens).toBe(1000);
    expect(o.events.some((e) => e.type === 'rate-limit')).toBe(true);
  });

  it('keeps waiting through a retry status that is not a rate limit', async () => {
    const o = await run(async (s) => {
      s.status({ type: 'retry', attempt: 1, message: 'Service Unavailable', next: Date.now() + 10 });
      await Bun.sleep(100);
      finish(s);
    });
    expect(o.error).toBeUndefined();
  });

  it('is not an error when the abort is our own, and is one when it is not', async () => {
    const own = await run(async (s) => {
      await s.bash('c1', 'rm x');
      s.assistant('m1', { tokens: USAGE_1, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } });
    }, { gate: () => ({ decision: 'hold', code: 'needs_human', reason: 'r' }) });
    expect(own.error?.code).toBe(HARNESS_GATE_HOLD_CODE);
    const foreign = await run((s) => {
      s.assistant('m1', { tokens: USAGE_1, error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } });
      s.idle();
    });
    expect(foreign.error?.code).toBe('harness-nonzero-exit');
    expect(foreign.error?.message).toContain('aborted');
  });

  it('ignores a child session error when the root session still goes idle', async () => {
    const o = await run((s) => {
      s.child('ses_child', 'ses_root');
      s.assistant('mc', { sessionID: 'ses_child', tokens: USAGE_1, error: { name: 'UnknownError', data: { message: 'subagent failed' } } });
      s.emit('session.error', { sessionID: 'ses_child', error: { name: 'UnknownError', data: { message: 'subagent failed again' } } });
      finish(s);
    });
    expect(o.error).toBeUndefined();
    expect(o.result?.usage).toBeDefined();
  });

  it('still fails when the root session errors after a child error and goes idle', async () => {
    const o = await run((s) => {
      s.child('ses_child', 'ses_root');
      s.assistant('mc', { sessionID: 'ses_child', error: { name: 'UnknownError', data: { message: 'subagent failed' } } });
      s.assistant('m1', { tokens: USAGE_1, error: { name: 'UnknownError', data: { message: 'root failed' } } });
      s.idle();
    });
    expect(o.error?.code).toBe('harness-nonzero-exit');
    expect(o.error?.message).toContain('root failed');
  });

  it('treats a session error with no session id as fatal on idle', async () => {
    const o = await run((s) => {
      s.emit('session.error', { error: { name: 'UnknownError', data: { message: 'who failed' } } });
      finish(s);
    });
    expect(o.error?.code).toBe('harness-nonzero-exit');
    expect(o.error?.message).toContain('who failed');
  });

  it('classifies any other session error as a nonzero exit with its message', async () => {
    const o = await run((s) => {
      s.emit('session.error', { sessionID: s.sessionID, error: { name: 'UnknownError', data: { message: 'Model not found: openai/nope.' } } });
      s.idle();
    });
    expect(o.error?.code).toBe('harness-nonzero-exit');
    expect(o.error?.message).toContain('Model not found');
  });

  it('reports HTTP 426 from the prompt request as a nonzero exit with the status', async () => {
    const o = await run(() => {}, { fake: { promptStatus: 426 } });
    expect(o.error?.code).toBe('harness-nonzero-exit');
    expect(o.error?.message).toContain('426');
    expect(o.fake.state.kills).toBeGreaterThanOrEqual(1);
  });

  it('reports the server dying before the session is idle as a nonzero exit, with usage seen so far', async () => {
    const o = await run((s) => {
      s.assistant('m1', { tokens: USAGE_1 });
      s.exit(137);
    });
    expect(o.error?.code).toBe('harness-nonzero-exit');
    expect(o.error?.message).toContain('exited');
    expect((o.error?.usage as KnownUsage).tokens).toBe(1000);
  });

  it('reports an event stream that ends before idle as a nonzero exit', async () => {
    const o = await run((s) => {
      s.mark('ended');
      // The fake closes the stream when it is killed; stop it from inside the scenario by exiting.
      s.exit(0);
    });
    expect(o.error?.code).toBe('harness-nonzero-exit');
  });

  it('fails when the server never reports its address before the timeout', async () => {
    const o = await run(() => {}, { fake: { noListen: true }, invocation: { timeoutMs: 200 } });
    expect(o.error?.code).toBe('harness-timeout');
    expect(o.fake.state.kills).toBeGreaterThanOrEqual(1);
  });
});

describe('opencode adapter: timeouts and containment', () => {
  it('kills the server and throws harness-timeout when the wall clock expires', async () => {
    const o = await run(async (s) => {
      s.assistant('m1', { tokens: USAGE_1 });
    }, { invocation: { timeoutMs: 250 } });
    expect(o.error?.code).toBe('harness-timeout');
    expect((o.error?.usage as KnownUsage).tokens).toBe(1000);
    expect(o.fake.state.kills).toBeGreaterThanOrEqual(1);
    expect(o.events[o.events.length - 1]).toMatchObject({ type: 'lifecycle', phase: 'timeout' });
  });

  it('kills the server and throws harness-idle-timeout when only heartbeats arrive', async () => {
    const o = await run(async (s) => {
      for (let i = 0; i < 50; i++) {
        s.heartbeat();
        await Bun.sleep(20);
      }
    }, { invocation: { timeoutMs: 5_000, idleTimeoutMs: 500 } });
    expect(o.error?.code).toBe('harness-idle-timeout');
    expect(o.events[o.events.length - 1]).toMatchObject({ type: 'lifecycle', phase: 'idle-timeout' });
  });

  it('does not idle out while real events keep arriving, and reports progress', async () => {
    let progress = 0;
    const o = await run(async (s) => {
      // The run outlasts the idle timeout, so only a reset on each event lets it finish.
      for (let i = 0; i < 40; i++) {
        s.assistant('m1', { tokens: USAGE_1 });
        await Bun.sleep(20);
      }
      s.idle();
    }, { invocation: { timeoutMs: 5_000, idleTimeoutMs: 500, onProgress: () => { progress += 1; } } });
    expect(o.error).toBeUndefined();
    expect(progress).toBeGreaterThan(20);
  });

  it('kills the contained process exactly through kill and close on every exit path', async () => {
    const paths = await Promise.all([
      run((s) => finish(s)),
      run((s) => s.exit(3)),
      run(() => {}, { invocation: { timeoutMs: 150 } }),
      run(async (s) => { await s.bash('c1', 'x'); }, { gate: () => ({ decision: 'hold', code: 'needs_human', reason: 'r' }) }),
      run(() => {}, { fake: { promptStatus: 500 } }),
    ]);
    for (const o of paths) {
      expect(o.fake.state.kills).toBeGreaterThanOrEqual(1);
      expect(o.fake.state.closes).toBe(1);
    }
  });

  it('bounds an HTTP call that never answers', async () => {
    const started = Date.now();
    const o = await run(() => {}, { fake: { noScenario: true }, invocation: { timeoutMs: 300 } });
    expect(o.error?.code).toBe('harness-timeout');
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('opencode adapter: events', () => {
  it('emits lifecycle, tool, gate-decision and usage events without prompt text or tool bodies', async () => {
    const o = await run(async (s) => {
      s.part({ callID: 'c1', tool: 'bash', status: 'running', input: { command: 'cat a.txt' } });
      await s.ask({ permission: 'bash', patterns: ['cat a.txt'], tool: { messageID: 'msg_1', callID: 'c1' } });
      s.part({ callID: 'c1', tool: 'bash', status: 'completed', input: { command: 'cat a.txt' }, metadata: { output: 'SECRET-OUTPUT', exit: 0 } });
      s.emit('message.part.updated', { sessionID: s.sessionID, part: { id: 'prt_t', type: 'text', text: 'SECRET-TEXT', messageID: 'msg_1', sessionID: s.sessionID } });
      finish(s);
    }, { gate: gateFor(['Bash(cat:*)']), invocation: { prompt: 'do it SECRET-PROMPT' } });
    expect(o.events.map((e) => e.type)).toEqual([
      'lifecycle', 'tool-input-available', 'gate-decision', 'tool-output-available', 'usage', 'lifecycle',
    ]);
    expect(o.events[0]).toMatchObject({ type: 'lifecycle', phase: 'start' });
    expect(o.events[1]).toMatchObject({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'Bash', input: { command: 'cat a.txt' } });
    expect(o.events[2]).toMatchObject({ type: 'gate-decision', toolCallId: 'c1', toolName: 'Bash', decision: 'allow' });
    expect(o.events[3]).toMatchObject({ type: 'tool-output-available', toolCallId: 'c1', output: '', isError: false });
    expect(o.events[4]).toMatchObject({ type: 'usage', tokens: 1000, costUsd: 0.002 });
    expect(o.events[5]).toMatchObject({ type: 'lifecycle', phase: 'end' });
    const dump = JSON.stringify(o.events);
    for (const secret of ['SECRET-OUTPUT', 'SECRET-TEXT', 'SECRET-PROMPT', 'do it']) expect(dump).not.toContain(secret);
    expect(o.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('records a failed command by its exit code in the form the journal reads', async () => {
    const o = await run(async (s) => {
      s.part({ callID: 'c1', tool: 'bash', status: 'running', input: { command: 'ls' } });
      await s.ask({ permission: 'bash', patterns: ['ls'], tool: { messageID: 'msg_1', callID: 'c1' } });
      s.part({ callID: 'c1', tool: 'bash', status: 'completed', input: { command: 'ls' }, metadata: { output: 'no such file', exit: 2 } });
      s.part({ callID: 'c2', tool: 'read', status: 'running', input: { filePath: join(ROOT, 'a.txt') } });
      await s.ask({ permission: 'read', patterns: ['a.txt'], tool: { messageID: 'msg_1', callID: 'c2' } });
      s.part({ callID: 'c2', tool: 'read', status: 'error', input: { filePath: join(ROOT, 'a.txt') } });
      finish(s);
    });
    const outputs = o.events.filter((e) => e.type === 'tool-output-available');
    expect(outputs).toMatchObject([
      { toolCallId: 'c1', output: 'Exit code 2', isError: true },
      { toolCallId: 'c2', output: '', isError: true },
    ]);
  });

  it('emits one output, after the input, for a part already settled when its ask is processed', async () => {
    const o = await run(async (s) => {
      s.part({ callID: 'c1', tool: 'bash', status: 'error', input: { command: 'ls' }, metadata: { exit: 2 } });
      s.part({ callID: 'c2', tool: 'read', status: 'completed', input: { filePath: join(ROOT, 'a.txt') } });
      await s.ask({ permission: 'bash', patterns: ['ls'], tool: { messageID: 'msg_1', callID: 'c1' } });
      await s.ask({ permission: 'read', patterns: ['a.txt'], tool: { messageID: 'msg_1', callID: 'c2' } });
      // A later update for the same call must not emit a second output.
      s.part({ callID: 'c1', tool: 'bash', status: 'error', input: { command: 'ls' }, metadata: { exit: 2 } });
      finish(s);
    });
    for (const id of ['c1', 'c2']) {
      const mine = o.events.filter((e) => 'toolCallId' in e && e.toolCallId === id && (e.type === 'tool-input-available' || e.type === 'tool-output-available'));
      expect(mine.map((e) => e.type)).toEqual(['tool-input-available', 'tool-output-available']);
    }
    expect(o.events.filter((e) => e.type === 'tool-output-available')).toMatchObject([
      { toolCallId: 'c1', output: 'Exit code 2', isError: true },
      { toolCallId: 'c2', output: '', isError: false },
    ]);
  });

  it('emits the output for a part first seen settled through the message re-fetch', async () => {
    const o = await run(async (s) => {
      await s.ask({ permission: 'bash', patterns: ['ls'], tool: { messageID: 'msg_1', callID: 'c1' } });
      finish(s);
    }, {
      gate: gateFor(['Bash(ls:*)']),
      fake: {
        messageBody: (_session, messageID) => ({
          info: { id: messageID },
          parts: [{ type: 'tool', tool: 'bash', callID: 'c1', messageID, sessionID: 'ses_root', state: { status: 'completed', input: { command: 'ls' }, metadata: { exit: 1 } } }],
        }),
      },
    });
    const mine = o.events.filter((e) => e.type === 'tool-input-available' || e.type === 'tool-output-available');
    expect(mine).toMatchObject([
      { type: 'tool-input-available', toolCallId: 'c1' },
      { type: 'tool-output-available', toolCallId: 'c1', output: 'Exit code 1', isError: true },
    ]);
  });

  it('journals only the file path of an edit, and one input event per patched file', async () => {
    const a = join(ROOT, 'out', 'a');
    const b = join(ROOT, 'out', 'b');
    const o = await run(async (s) => {
      s.part({ callID: 'p1', tool: 'apply_patch', status: 'running', input: { patchText: 'SECRET-PATCH' } });
      await s.ask({ permission: 'edit', patterns: [], metadata: { files: [{ filePath: a, type: 'add', patch: 'SECRET-DIFF' }, { filePath: b, type: 'update' }], diff: 'SECRET-DIFF' }, tool: { messageID: 'msg_1', callID: 'p1' } });
      finish(s);
    });
    const inputs = o.events.filter((e) => e.type === 'tool-input-available');
    expect(inputs).toMatchObject([
      { toolCallId: 'p1', toolName: 'Write', input: { file_path: a } },
      { toolCallId: 'p1', toolName: 'Edit', input: { file_path: b } },
    ]);
    expect(JSON.stringify(o.events)).not.toContain('SECRET');
  });

  it('emits a gate-decision for every ask the gate sees, denies made without the gate included', async () => {
    const o = await run(async (s) => {
      await s.bash('c1', 'cat a.txt');
      await s.ask({ permission: 'external_directory', patterns: ['/x/*'], tool: { messageID: 'msg_1', callID: 'c2' } });
      await s.ask({ permission: 'webfetch', patterns: ['u'], tool: { messageID: 'msg_1', callID: 'c3' } });
      finish(s);
    }, { gate: gateFor(['Bash(cat:*)']) });
    expect(gateDecisions(o).map((d) => [d.toolName, d.decision])).toEqual([
      ['Bash', 'allow'], ['external_directory', 'deny'], ['WebFetch', 'deny'],
    ]);
  });

  it('bounds a gate reason at 200 characters in the journal and the reply', async () => {
    const long = 'x'.repeat(500);
    const o = await run(async (s) => {
      const body = await s.bash('c1', 'cat a.txt');
      expect(body!.message.length).toBeLessThanOrEqual(250);
      finish(s);
    }, { gate: () => ({ decision: 'deny', code: 'not_allowlisted', reason: long }) });
    expect(gateDecisions(o)[0]!.reason!.length).toBeLessThanOrEqual(200);
    expect(o.error).toBeUndefined();
  });

  it('survives a throwing event sink', async () => {
    const o = await run((s) => finish(s), { invocation: { onEvent: () => { throw new Error('sink'); } } });
    expect(o.result!.outputs).toEqual([]);
  });
});

describe('opencode adapter: registration', () => {
  const def = { name: 'opencode', envAllowlist: ['PATH'] };

  it('is in the shipped factory map', () => {
    expect(shippedHarnessAdapterNames()).toContain('opencode');
  });

  it('carries its capabilities through the definition and the introspection registry', () => {
    const registry = buildHarnessDefinitionRegistry([def]);
    const resolved = registry.resolve('opencode');
    expect(resolved.ok && resolved.adapter).toMatchObject({ canGatePerCall: true, canRestrictTools: true, reportsUsage: true });
    const adapter = bindHarnessDefinitionsForIntrospection(registry).resolve('opencode');
    expect(adapter.ok && adapter.adapter.canGatePerCall).toBe(true);
  });

  it('parses its engine config from CONDUIT_HARNESS_OPENCODE_*', () => {
    const parsed = parseHarnessConfig({
      CONDUIT_HARNESS_ADAPTERS: 'opencode',
      CONDUIT_HARNESS_OPENCODE_ENV: 'PATH,HOME',
      CONDUIT_HARNESS_OPENCODE_COMMAND: '/opt/opencode/bin/opencode',
      CONDUIT_HARNESS_OPENCODE_MODEL: 'openai/gpt-4.1-mini',
    });
    expect(parsed).toEqual({ ok: true, defs: [{ name: 'opencode', envAllowlist: ['PATH', 'HOME'], command: '/opt/opencode/bin/opencode', model: 'openai/gpt-4.1-mini' }] });
    if (!parsed.ok) throw new Error('unreachable');
    const registry = buildHarnessDefinitionRegistry(parsed.defs);
    const bound = registry.resolve('opencode');
    expect(bound.ok && bound.adapter.command).toBe('/opt/opencode/bin/opencode');
    expect(bound.ok && bound.adapter.bind(ROOT).model).toBe('openai/gpt-4.1-mini');
  });

  it('fails registry construction for _AGENT, _PLUGIN_DIRS and _ISOLATE_CONFIG, which it does not act on', () => {
    expect(() => buildHarnessDefinitionRegistry([{ ...def, agent: 'team:coder' }])).toThrow(/_AGENT/);
    expect(() => buildHarnessDefinitionRegistry([{ ...def, pluginDirs: ['/opt/plugins'] }])).toThrow(/_PLUGIN_DIRS/);
    expect(() => buildHarnessDefinitionRegistry([{ ...def, isolateConfig: true }])).toThrow(/_ISOLATE_CONFIG/);
  });

  it('cannot run a named agent', () => {
    const resolved = buildHarnessDefinitionRegistry([def]).resolve('opencode');
    expect(resolved.ok && resolved.adapter.resolveAgentDefinition).toBeUndefined();
  });

  it('probes the binary through the injected probe, and reports a missing one', async () => {
    const present = createOpenCodeHarnessAdapter({ projectRoot: ROOT, envAllowlist: [], probe: async () => ({ present: true, detail: '/x/opencode' }) });
    expect(await present.probeBinary()).toEqual({ present: true, detail: '/x/opencode' });
    const missing = createOpenCodeHarnessAdapter({ projectRoot: ROOT, envAllowlist: [], command: 'definitely-not-installed-opencode', sourceEnv: { PATH: '/usr/bin:/bin' } });
    expect((await missing.probeBinary()).present).toBe(false);
  });

  it('fails before creating directories or spawning when the project root cannot be sent verbatim as a header', async () => {
    const odd = mkdtempSync(join(tmpdir(), 'pct%20root-'));
    try {
      const fake = fakeOpenCode(() => {});
      const err = await adapterWith(fake, { projectRoot: odd }).invoke(invocation()).catch((e) => e as Error);
      expect((err as Error).message).toContain('project root');
      expect((err as Error).message).toContain('header');
      expect(fake.state.spawns).toBe(0);
      expect(leaked()).toEqual([]);
    } finally {
      rmSync(odd, { recursive: true, force: true });
    }
  });

  it('fails an invocation naming a missing project root, and a missing binary, before spawning', async () => {
    const fake = fakeOpenCode(() => {});
    const noRoot = await adapterWith(fake, { projectRoot: join(ROOT, 'nope') }).invoke(invocation()).catch((e) => e as Error);
    expect((noRoot as Error).message).toContain('project root');
    const noBin = await adapterWith(fake, { command: 'definitely-not-installed-opencode' }).invoke(invocation()).catch((e) => e as Error);
    expect((noBin as Error).message).toContain('opencode');
    expect(fake.state.spawns).toBe(0);
  });
});
