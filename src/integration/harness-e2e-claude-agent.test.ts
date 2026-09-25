/**
 * Flag-gated real-binary E2E: a `--plugin-dir` agent runs while an identically
 * named agent exists in ambient config (issues #28 AC6, #29 AC1).
 *
 * GATED OFF BY DEFAULT, like harness-e2e-claude.test.ts: it runs only when
 * CONDUIT_E2E_CLAUDE is set, a `claude` binary is on PATH, and the operator's
 * config dir holds a `.credentials.json` (subscription auth on Linux).
 *
 *   CONDUIT_E2E_CLAUDE=1 bun test src/integration/harness-e2e-claude-agent.test.ts
 *
 * Fixture. An "ambient" config dir stands in for the operator's ~/.claude: it
 * links the real credentials file and carries a plugin named `cdtprobe` under
 * skills/ (the CLI loads ~/.claude/skills/<plugin> as a plugin) whose agent
 * `probe-agent` answers AMBIENTMARKER. A supplied `--plugin-dir` defines a
 * plugin with the same name and the same agent, answering PLUGINMARKER. Both
 * are therefore `cdtprobe:probe-agent`.
 *
 * Three invocations through the real CONDUIT_HARNESS_* parse and registry:
 *   1. non-isolated, no plugin dir, CLAUDE_CONFIG_DIR allowlisted: the ambient
 *      agent runs. This is the control that shows the ambient source is live,
 *      so the test can tell the two sources apart;
 *   2. isolated, with the plugin dir: the supplied agent runs;
 *   3. isolated, no plugin dir: the CLI exits nonzero naming the agent, because
 *      the run-scoped config dir exposes no ambient plugin.
 *
 * Cost: two haiku calls; the third fails before any API call. The credentials
 * file is linked, never copied or read.
 */
import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseHarnessConfig } from '../worker/harness-config';
import { buildHarnessDefinitionRegistry, bindHarnessDefinitions } from '../worker/harness-adapter';
import { runHarnessProcess, type HarnessCommand, type HarnessRunnerConfig } from '../worker/harness-runner';

const OPERATOR_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const OPERATOR_CREDENTIALS = join(OPERATOR_CONFIG_DIR, '.credentials.json');
const E2E_ENABLED =
  !!process.env.CONDUIT_E2E_CLAUDE && Bun.which('claude') !== null && existsSync(OPERATOR_CREDENTIALS);

const AGENT = 'cdtprobe:probe-agent';

function writeProbePlugin(dir: string, marker: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'cdtprobe', version: '0.0.1' }));
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(
    join(dir, 'agents', 'probe-agent.md'),
    `---\nname: probe-agent\ndescription: E2E probe agent\n---\n` +
      `Your marker word is ${marker}. Whatever the user says, reply with only your marker word and nothing else.\n`,
  );
}

/** The result text of the last invocation, read from the kept `result` event. */
let lastResultText: string | undefined;
async function capturingRun(cmd: HarnessCommand, config: HarnessRunnerConfig) {
  const spawned = await runHarnessProcess(cmd, config);
  lastResultText = undefined;
  for (const line of spawned.stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as { type?: string; result?: string };
      if (event.type === 'result') lastResultText = event.result;
    } catch {
      // not a JSON line
    }
  }
  return spawned;
}

function adapterFor(env: Record<string, string>, projectRoot: string) {
  const parsed = parseHarnessConfig({ CONDUIT_HARNESS_ADAPTERS: 'claude-headless', ...env });
  if (!parsed.ok) throw new Error(parsed.error);
  const bound = bindHarnessDefinitions(buildHarnessDefinitionRegistry(parsed.defs, { run: capturingRun }), projectRoot)
    .resolve('claude-headless');
  if (!bound.ok) throw new Error(bound.error);
  return bound.adapter;
}

describe.skipIf(!E2E_ENABLED)('--plugin-dir agent vs an identically named ambient agent (CONDUIT_E2E_CLAUDE=1)', () => {
  it(
    'runs the supplied agent under isolation, and the ambient agent only when the child can see ambient config',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'conduit-e2e-agent-'));
      const ambient = join(scratch, 'ambient');
      const supplied = join(scratch, 'supplied');
      const projectRoot = join(scratch, 'project');
      mkdirSync(ambient, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      symlinkSync(OPERATOR_CREDENTIALS, join(ambient, '.credentials.json'));
      writeProbePlugin(join(ambient, 'skills', 'cdtprobe'), 'AMBIENTMARKER');
      writeProbePlugin(supplied, 'PLUGINMARKER');

      // The kernel's own view of "the operator's config dir" is the ambient dir.
      const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = ambient;
      const call = { prompt: 'State your marker word.', inputs: [], tools: ['Read'], timeoutMs: 180_000, agent: AGENT };
      try {
        // 1. Control: no fence, ambient visible. The ambient agent answers.
        const leaky = adapterFor(
          { CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH,CLAUDE_CONFIG_DIR', CONDUIT_HARNESS_CLAUDE_HEADLESS_MODEL: 'haiku' },
          projectRoot,
        );
        await leaky.invoke(call);
        expect(lastResultText).toContain('AMBIENTMARKER');

        // 2. Fenced, with the plugin dir: the supplied agent answers.
        const fenced = adapterFor(
          {
            CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH',
            CONDUIT_HARNESS_CLAUDE_HEADLESS_MODEL: 'haiku',
            CONDUIT_HARNESS_CLAUDE_HEADLESS_PLUGIN_DIRS: supplied,
            CONDUIT_HARNESS_CLAUDE_HEADLESS_ISOLATE_CONFIG: '1',
          },
          projectRoot,
        );
        const definition = fenced.resolveAgentDefinition!(AGENT);
        expect(definition.ok && definition.path).toBe(join(supplied, 'agents', 'probe-agent.md'));
        await fenced.invoke(call);
        expect(lastResultText).toContain('PLUGINMARKER');
        expect(lastResultText).not.toContain('AMBIENTMARKER');

        // 3. Fenced, no plugin dir: the ambient agent is not reachable at all.
        const fencedNoPlugins = adapterFor(
          {
            CONDUIT_HARNESS_CLAUDE_HEADLESS_ENV: 'HOME,PATH',
            CONDUIT_HARNESS_CLAUDE_HEADLESS_MODEL: 'haiku',
            CONDUIT_HARNESS_CLAUDE_HEADLESS_ISOLATE_CONFIG: '1',
          },
          projectRoot,
        );
        await expect(fencedNoPlugins.invoke(call)).rejects.toThrow('not found');
      } finally {
        if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
