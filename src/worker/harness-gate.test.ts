import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommandAllowed } from './deterministic';
import { callGateFailClosed, createHarnessToolGate, type HarnessToolGate } from './harness-gate';

const call = { toolName: 'Bash', input: { command: 'echo hi' } };

describe('callGateFailClosed', () => {
  it('passes an allow through', () => {
    expect(callGateFailClosed(() => ({ decision: 'allow' }), call)).toEqual({ decision: 'allow' });
  });

  it('passes a well-formed deny and hold through unchanged', () => {
    const deny = { decision: 'deny', code: 'not_allowlisted', reason: 'rm is not allowlisted' } as const;
    const hold = { decision: 'hold', code: 'needs_human', reason: 'asks a question' } as const;
    expect(callGateFailClosed(() => deny, call)).toEqual(deny);
    expect(callGateFailClosed(() => hold, call)).toEqual(hold);
  });

  it('turns a throw into a gate_error deny', () => {
    const gate: HarnessToolGate = () => {
      throw new Error('boom');
    };
    const out = callGateFailClosed(gate, call);
    expect(out).toMatchObject({ decision: 'deny', code: 'gate_error' });
    expect((out as { reason: string }).reason).toContain('boom');
  });

  it('bounds and cleans a thrown message, since the reason is journaled', () => {
    const gate: HarnessToolGate = () => {
      throw new Error(`bad\nline\u0000${'x'.repeat(5000)}`);
    };
    const out = callGateFailClosed(gate, call) as { reason: string };
    expect(out.reason.length).toBeLessThanOrEqual(200);
    // eslint-disable-next-line no-control-regex
    expect(out.reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'allow'],
    ['an unknown decision', { decision: 'maybe' }],
    ['a deny with no code', { decision: 'deny', reason: 'x' }],
    ['a hold with no reason', { decision: 'hold', code: 'needs_human' }],
  ])('turns %s into a gate_error deny', (_label, returned) => {
    const gate = (() => returned) as unknown as HarnessToolGate;
    expect(callGateFailClosed(gate, call)).toMatchObject({ decision: 'deny', code: 'gate_error' });
  });
});


// ---------------------------------------------------------------------------
// createHarnessToolGate
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A real project root with an owned dir, a sibling with a shared prefix, and an outside dir. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gate-')));
  dirs.push(root);
  const owned = join(root, 'owned');
  const evil = join(root, 'owned-evil');
  const outside = join(root, 'outside');
  for (const d of [owned, evil, outside, join(owned, 'sub')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'x');
  symlinkSync(outside, join(owned, 'linkdir'));
  symlinkSync(join(outside, 'secret.txt'), join(owned, 'linkfile'));
  symlinkSync(join(outside, 'not-yet'), join(owned, 'dangling'));
  return { root, owned, evil, outside };
}

const TOOLS = ['Read', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash(git:*)', 'Bash(ls)'];

function gateFor(over: Partial<Parameters<typeof createHarnessToolGate>[0]> = {}) {
  const f = fixture();
  return { f, gate: createHarnessToolGate({ projectRoot: f.root, tools: TOOLS, ownedPaths: [f.owned], ...over }) };
}

describe('createHarnessToolGate tool allowlist', () => {
  it.each([
    ['Read', 'allow'],
    ['Glob', 'allow'],
    ['Grep', 'deny'],
    ['read', 'deny'],
    ['mcp__x__y', 'deny'],
    ['', 'deny'],
  ])('%s -> %s', (toolName, want) => {
    const { gate } = gateFor();
    expect(gate({ toolName, input: {} }).decision as string).toBe(want);
  });

  it('reports tool_not_allowed for an unlisted tool', () => {
    const { gate } = gateFor();
    expect(gate({ toolName: 'Grep', input: {} })).toMatchObject({ decision: 'deny', code: 'tool_not_allowed' });
  });

  it('an mcp tool is denied even when listed', () => {
    const { gate } = gateFor({ tools: ['mcp__x__y'] });
    expect(gate({ toolName: 'mcp__x__y', input: {} })).toMatchObject({ decision: 'deny', code: 'tool_not_allowed' });
  });

  it.each(['Task', 'Agent'])('a listed %s allows the tool named Agent', (entry) => {
    const { gate } = gateFor({ tools: [entry] });
    expect(gate({ toolName: 'Agent', input: { prompt: 'x' } })).toEqual({ decision: 'allow' });
  });

  it('a non-string toolName is denied', () => {
    const { gate } = gateFor();
    for (const toolName of [undefined, null, 5, {}, ['Read']]) {
      expect(gate({ toolName, input: {} } as never).decision).toBe('deny');
    }
  });
});

describe('createHarnessToolGate Bash', () => {
  const bash = (gate: HarnessToolGate, command: unknown) => gate({ toolName: 'Bash', input: { command } });

  it.each([
    ['git status', 'allow', undefined],
    ['git', 'allow', undefined],
    ['ls -la src', 'allow', undefined],
    ['  git   log  ', 'allow', undefined],
    ['rm -rf x', 'deny', 'not_allowlisted'],
    ['gitx status', 'deny', 'not_allowlisted'],
    ['/usr/bin/git status', 'deny', 'not_allowlisted'],
    ['git status; rm x', 'deny', 'shell_metacharacter'],
    ['git status && ls', 'deny', 'shell_metacharacter'],
    ['git log | cat', 'deny', 'shell_metacharacter'],
    ['git log\nrm x', 'deny', 'shell_metacharacter'],
    ['git\tlog', 'deny', 'shell_metacharacter'],
    ['git "log"', 'deny', 'shell_metacharacter'],
    ["git 'log'", 'deny', 'shell_metacharacter'],
    ['git $HOME', 'deny', 'shell_metacharacter'],
    ['git `id`', 'deny', 'shell_metacharacter'],
    ['git log > f', 'deny', 'shell_metacharacter'],
    ['git log < f', 'deny', 'shell_metacharacter'],
    ['git (x)', 'deny', 'shell_metacharacter'],
    ['git *', 'deny', 'shell_metacharacter'],
    ['git ?', 'deny', 'shell_metacharacter'],
    ['git \\x', 'deny', 'shell_metacharacter'],
    ['git !x', 'deny', 'shell_metacharacter'],
    ['git #x', 'deny', 'shell_metacharacter'],
    ['git ~', 'deny', 'shell_metacharacter'],
    ['git {a,b}', 'deny', 'shell_metacharacter'],
    ['rm x; y', 'deny', 'shell_metacharacter'],
    ['', 'deny', 'malformed_input'],
    ['   ', 'deny', 'malformed_input'],
  ])('%j -> %s %s', (command, want, code) => {
    const { gate } = gateFor();
    const out = bash(gate, command);
    expect(out.decision as string).toBe(want as string);
    if (code) expect(out).toMatchObject({ code });
  });

  it.each([[undefined], [null], [5], [['git']], [{ a: 1 }]])('a non-string command %j is malformed_input', (command) => {
    const { gate } = gateFor();
    expect(bash(gate, command)).toMatchObject({ decision: 'deny', code: 'malformed_input' });
  });

  it('a bare Bash entry allows the tool but no executable', () => {
    const { gate } = gateFor({ tools: ['Bash'] });
    expect(bash(gate, 'git status')).toMatchObject({ decision: 'deny', code: 'not_allowlisted' });
    expect(bash(gate, 'ls')).toMatchObject({ decision: 'deny', code: 'not_allowlisted' });
  });

  it('an argument-narrowing rule is not recognised and does not widen to the executable', () => {
    const { gate } = gateFor({ tools: ['Bash(git status:*)'] });
    expect(bash(gate, 'git status')).toMatchObject({ decision: 'deny', code: 'not_allowlisted' });
    expect(bash(gate, 'git push')).toMatchObject({ decision: 'deny', code: 'not_allowlisted' });
  });

  it('is denied tool_not_allowed when Bash is not listed at all', () => {
    const { gate } = gateFor({ tools: ['Read'] });
    expect(bash(gate, 'git status')).toMatchObject({ decision: 'deny', code: 'tool_not_allowed' });
  });

  it('checks metacharacters before the allowlist, so the verdict leaks nothing', () => {
    const { gate } = gateFor();
    expect(bash(gate, 'rm; x')).toMatchObject({ code: 'shell_metacharacter' });
    expect(bash(gate, 'git; x')).toMatchObject({ code: 'shell_metacharacter' });
  });

  it('agrees with checkCommandAllowed on the split form', () => {
    const { gate } = gateFor();
    const allowlist = ['git', 'ls'];
    const samples = [
      'git status', 'ls -la', 'rm -rf /', 'git a=b,c+d@e', 'git a;b', 'ls  x', 'cat f', 'git ../x', 'git "x"',
      'git\tx', 'ls $X', 'git -C /a/b log', 'lsx', 'git a\nb',
    ];
    for (const command of samples) {
      const [exe, ...args] = command.split(' ').filter((t) => t !== '');
      const v = checkCommandAllowed({ command: exe, args }, { allowlist });
      const out = bash(gate, command);
      expect(out.decision).toBe(v.allowed ? 'allow' : 'deny');
      if (!v.allowed) expect(out).toMatchObject({ code: v.reason });
    }
  });
});

describe('createHarnessToolGate write ownership', () => {
  const write = (gate: HarnessToolGate, path: unknown, toolName = 'Write') =>
    gate({ toolName, input: toolName === 'NotebookEdit' ? { notebook_path: path } : { file_path: path } });

  it('allows inside the owned dir, including a not-yet-created leaf and nested new dirs', () => {
    const { f, gate } = gateFor();
    expect(write(gate, join(f.owned, 'sub', 'a.txt')).decision).toBe('allow');
    expect(write(gate, join(f.owned, 'new', 'deep', 'a.txt')).decision).toBe('allow');
    expect(write(gate, 'owned/rel.txt').decision).toBe('allow');
  });

  it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s is checked', (tool) => {
    const { f, gate } = gateFor();
    expect(write(gate, join(f.owned, 'a'), tool).decision).toBe('allow');
    expect(write(gate, join(f.outside, 'a'), tool)).toMatchObject({ decision: 'deny', code: 'path_escape' });
  });

  it('denies .. traversal, relative and absolute', () => {
    const { f, gate } = gateFor();
    expect(write(gate, 'owned/../outside/x')).toMatchObject({ code: 'path_escape' });
    expect(write(gate, '../x')).toMatchObject({ code: 'path_escape' });
    expect(write(gate, join(f.owned, 'new', '..', '..', 'outside', 'x'))).toMatchObject({ code: 'path_escape' });
  });

  it('denies a symlinked ancestor directory that points outside', () => {
    const { f, gate } = gateFor();
    expect(write(gate, join(f.owned, 'linkdir', 'x.txt'))).toMatchObject({ code: 'path_escape' });
    expect(write(gate, join(f.owned, 'linkdir', 'new', 'x.txt'))).toMatchObject({ code: 'path_escape' });
  });

  it('denies a symlink leaf pointing outside, existing or dangling', () => {
    const { f, gate } = gateFor();
    expect(write(gate, join(f.owned, 'linkfile'))).toMatchObject({ code: 'path_escape' });
    expect(write(gate, join(f.owned, 'dangling'))).toMatchObject({ code: 'path_escape' });
  });

  it('does not match a sibling that shares a prefix with the owned dir', () => {
    const { f, gate } = gateFor();
    expect(write(gate, join(f.evil, 'x'))).toMatchObject({ code: 'path_escape' });
  });

  it('accepts an owned path that does not exist yet', () => {
    const f = fixture();
    const gate = createHarnessToolGate({ projectRoot: f.root, tools: TOOLS, ownedPaths: ['later/dir'] });
    expect(write(gate, join(f.root, 'later', 'dir', 'x')).decision).toBe('allow');
    expect(write(gate, join(f.root, 'later', 'other')).decision).toBe('deny');
  });

  // Behavioural stand-in for a resolver spy (resolveOwnedPath is imported
  // directly, so it cannot be spied on): owned paths are canonicalized once at
  // build time, so re-pointing an owned-path symlink afterwards changes nothing.
  it('canonicalizes owned paths once, at build time', () => {
    const f = fixture();
    const alias = join(f.root, 'alias');
    symlinkSync(f.owned, alias);
    const gate = createHarnessToolGate({ projectRoot: f.root, tools: TOOLS, ownedPaths: ['alias'] });
    unlinkSync(alias);
    symlinkSync(f.outside, alias);
    expect(write(gate, join(f.owned, 'x')).decision).toBe('allow');
    expect(write(gate, join(f.outside, 'x'))).toMatchObject({ decision: 'deny', code: 'path_escape' });
    expect(write(gate, join(alias, 'x'))).toMatchObject({ decision: 'deny', code: 'path_escape' });
  });

  it('resolves a symlinked owned path the same way as the target', () => {
    const f = fixture();
    symlinkSync(f.owned, join(f.root, 'alias'));
    const gate = createHarnessToolGate({ projectRoot: f.root, tools: TOOLS, ownedPaths: ['alias'] });
    expect(write(gate, join(f.owned, 'x')).decision).toBe('allow');
    expect(write(gate, join(f.root, 'alias', 'x')).decision).toBe('allow');
    expect(write(gate, join(f.outside, 'x')).decision).toBe('deny');
  });

  it('denies every write when ownedPaths is empty', () => {
    const { f, gate } = gateFor({ ownedPaths: [] });
    expect(write(gate, join(f.owned, 'x'))).toMatchObject({ decision: 'deny', code: 'path_escape' });
  });

  it('confines writes to the project root when ownedPaths is undefined, and still enforces the tool allowlist', () => {
    const f = fixture();
    const gate = createHarnessToolGate({ projectRoot: f.root, tools: ['Write'] });
    // Not enforcing ownership opens the whole project root, not the host.
    expect(write(gate, join(f.outside, 'x')).decision).toBe('allow');
    expect(write(gate, 'relative/new.txt').decision).toBe('allow');
    expect(write(gate, join(f.outside, 'x'), 'Edit')).toMatchObject({ code: 'tool_not_allowed' });
  });

  it('denies a write outside the project root when ownedPaths is undefined', () => {
    const f = fixture();
    const host = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gate-host-')));
    dirs.push(host);
    const gate = createHarnessToolGate({ projectRoot: f.root, tools: ['Write'] });
    for (const path of [join(host, 'x'), '../escape.txt', `${f.root}-sibling/x`, '/etc/passwd']) {
      expect(write(gate, path)).toMatchObject({ decision: 'deny', code: 'path_escape' });
    }
  });

  it('follows symlinks, dangling ones included, when confining to the project root', () => {
    const f = fixture();
    const host = realpathSync(mkdtempSync(join(tmpdir(), 'harness-gate-host-')));
    dirs.push(host);
    symlinkSync(host, join(f.root, 'hostlink'));
    symlinkSync(join(host, 'not-yet'), join(f.root, 'hostdangling'));
    const gate = createHarnessToolGate({ projectRoot: f.root, tools: ['Write'] });
    expect(write(gate, join(f.root, 'hostlink', 'x'))).toMatchObject({ decision: 'deny', code: 'path_escape' });
    expect(write(gate, join(f.root, 'hostdangling'))).toMatchObject({ decision: 'deny', code: 'path_escape' });
    // A link that stays inside the root is fine.
    expect(write(gate, join(f.owned, 'linkdir', 'x')).decision).toBe('allow');
  });

  it.each([[undefined], [null], [5], [''], [{}], [['a']], ['a\0b']])('a non-usable path %j is malformed_input', (path) => {
    const { gate } = gateFor();
    expect(write(gate, path)).toMatchObject({ decision: 'deny', code: 'malformed_input' });
  });

  it('NotebookEdit reads notebook_path, not file_path', () => {
    const { f, gate } = gateFor();
    expect(gate({ toolName: 'NotebookEdit', input: { file_path: join(f.owned, 'a') } })).toMatchObject({
      code: 'malformed_input',
    });
  });

  it('names the requested path but no other input text in a path_escape reason', () => {
    const { f, gate } = gateFor();
    const out = gate({ toolName: 'Write', input: { file_path: join(f.outside, 'x'), content: 'TOPSECRETBODY' } });
    expect((out as { reason: string }).reason).toContain(join(f.outside, 'x'));
    expect((out as { reason: string }).reason).not.toContain('TOPSECRETBODY');
  });
});

describe('createHarnessToolGate network, human and read tools', () => {
  it.each(['WebFetch', 'WebSearch'])('%s is denied network_denied even when listed', (tool) => {
    const { gate } = gateFor({ tools: [...TOOLS, tool] });
    expect(gate({ toolName: tool, input: { url: 'https://x' } })).toMatchObject({
      decision: 'deny',
      code: 'network_denied',
    });
  });

  it('AskUserQuestion holds regardless of tools', () => {
    for (const tools of [[], ['AskUserQuestion'], TOOLS]) {
      const { gate } = gateFor({ tools });
      expect(gate({ toolName: 'AskUserQuestion', input: { questions: [] } })).toMatchObject({
        decision: 'hold',
        code: 'needs_human',
      });
    }
  });

  it.each(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'Agent'])('a listed %s is allowed', (tool) => {
    const { gate } = gateFor({ tools: [tool] });
    expect(gate({ toolName: tool, input: { file_path: '/etc/passwd' } })).toEqual({ decision: 'allow' });
  });
});

describe('createHarnessToolGate subagents', () => {
  it('applies the same checks to a call with agentId as to a main-thread call', () => {
    const { f, gate } = gateFor();
    const calls = [
      { toolName: 'Bash', input: { command: 'rm -rf x' } },
      { toolName: 'Bash', input: { command: 'git status; id' } },
      { toolName: 'Bash', input: { command: 'git status' } },
      { toolName: 'Write', input: { file_path: join(f.outside, 'x') } },
      { toolName: 'Write', input: { file_path: join(f.owned, 'x') } },
      { toolName: 'WebFetch', input: {} },
      { toolName: 'AskUserQuestion', input: {} },
      { toolName: 'Grep', input: {} },
    ];
    for (const c of calls) {
      const main = gate(c);
      const sub = gate({ ...c, agentId: 'agent-1', agentType: 'general-purpose', toolCallId: 't1' });
      expect(sub).toEqual(main);
    }
    expect(gate({ toolName: 'Bash', input: { command: 'rm x' }, agentId: 'a' }).decision).toBe('deny');
  });
});

describe('createHarnessToolGate reasons', () => {
  it('never contains the Bash command string, stays within 200 characters and has no control characters', () => {
    const { gate } = gateFor();
    const secret = 'SECRETTOKEN';
    const commands = [
      `rm ${secret}`,
      `git ${secret};id`,
      `${secret}\n\x01`,
      `${'a'.repeat(5000)} ${secret}`,
      `git ${secret} ${'b'.repeat(5000)};`,
    ];
    for (const command of commands) {
      const out = gate({ toolName: 'Bash', input: { command } });
      expect(out.decision).toBe('deny');
      const r = (out as { reason: string }).reason;
      expect(r).not.toContain(secret);
      expect(r.length).toBeLessThanOrEqual(200);
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(r)).toBe(false);
    }
  });

  it('bounds and cleans a hostile tool name and path', () => {
    const { gate } = gateFor();
    const name = 'X\n'.repeat(500);
    const a = gate({ toolName: name, input: {} }) as { reason: string };
    expect(a.reason.length).toBeLessThanOrEqual(200);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f]/.test(a.reason)).toBe(false);
    const b = gate({ toolName: 'Write', input: { file_path: '/x\n' + 'y'.repeat(5000) } }) as { reason: string };
    expect(b.reason.length).toBeLessThanOrEqual(200);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f]/.test(b.reason)).toBe(false);
  });
});

describe('createHarnessToolGate totality', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  cyclic.command = cyclic;
  cyclic.file_path = cyclic;
  const throwing = {
    get command(): string {
      throw new Error('getter');
    },
    get file_path(): string {
      throw new Error('getter');
    },
    get notebook_path(): string {
      throw new Error('getter');
    },
  };
  const hostile: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['array', ['git', 'status']],
    ['number', 42],
    ['string', 'git status'],
    ['boolean', true],
    ['huge string', 'a'.repeat(2_000_000)],
    ['throwing getters', throwing],
    ['cyclic', cyclic],
    ['proxy that throws', new Proxy({}, { get: () => { throw new Error('proxy'); } })],
    ['symbol keys', { [Symbol('x')]: 1 }],
    ['huge command', { command: 'git ' + 'a;'.repeat(500_000), file_path: 'x'.repeat(1_000_000) }],
  ];

  it.each(hostile)('never throws and denies for %s input', (_label, input) => {
    const { gate } = gateFor();
    for (const toolName of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Read', 'Agent', 'AskUserQuestion', 'WebFetch', 'Nope']) {
      let out: ReturnType<HarnessToolGate> | undefined;
      expect(() => {
        out = gate({ toolName, input });
      }).not.toThrow();
      expect(['allow', 'deny', 'hold']).toContain(out?.decision as string);
      if (toolName === 'Bash' || toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
        expect(out?.decision).toBe('deny');
      }
    }
  });

  it('never throws when the call itself is hostile', () => {
    const { gate } = gateFor();
    for (const c of [null, undefined, 5, {}, { toolName: 'Bash' }]) {
      expect(callGateFailClosed(gate, c as never).decision).not.toBe('allow');
    }
  });
});
