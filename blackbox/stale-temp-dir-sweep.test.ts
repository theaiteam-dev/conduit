/**
 * Stale run-scoped temp dir sweep (issue #122, docs/harness-containment.md
 * "Stale run-scoped temp dirs"): the first `runExecutor` in a kernel process
 * removes the dirs under the OS temp dir named
 * `<prefix><pid>-<start time>-<random>` whose owner is gone, for the four
 * prefixes `conduit-call-tmp-`, `conduit-claude-config-`,
 * `conduit-codex-home-` and `conduit-opencode-`.
 *
 * The real `conduit run` gets a test-owned TMPDIR. Before the run, the test
 * plants, for each prefix:
 * - a dir whose owner pid cannot exist (above the kernel's pid_max): removed;
 * - a dir tagged with this test process's pid and a start time that is not
 *   its own, which is how a reused pid looks: removed;
 * - a dir tagged with this test process's pid and its real start time
 *   (field 22 of /proc/self/stat), a live owner: kept;
 * - an untagged dir, as a host without /proc names them: kept;
 * - names that start with the prefix but do not have the
 *   `<pid>-<start time>-<random>` shape: kept.
 * Plus a dir under a prefix the sweep does not cover with an otherwise
 * matching dead-owner tag: kept. A plain file and a symlink to a dir outside
 * the swept TMPDIR, each named with a swept prefix and a dead-owner tag, are
 * not dirs and are kept, and the symlink's target is untouched. A removed dir that holds a credentials link
 * loses the link and the link's target is untouched. A dead-owner dir the
 * sweep cannot fully remove (a read-only subdir) does not stop the run or the
 * rest of the sweep; that case is skipped as root, which can remove it.
 *
 * The run itself is a `claude-headless` maker with `_ISOLATE_CONFIG` on, so
 * it creates a `conduit-claude-config-` dir of its own. While the call is in
 * flight that dir is in the test-owned TMPDIR, tagged with the kernel's pid
 * and start time, and after the run no run-scoped dir the run created is
 * left behind.
 *
 * Public surfaces asserted: the run's exit code, `conduit run status`, and
 * the contents of the TMPDIR the binary was given. The sweep prints nothing
 * on a host with /proc; its one warning (untagged names on a host without
 * /proc) cannot be produced on the Linux hosts this suite runs on.
 *
 * BLACK-BOX: imports only the harness-flow module + bun:test.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_CLAUDE_STUB, startHarnessFlow, type CliResult, type HarnessFlow } from "./harness/harness-flow";

const TIMEOUT_MS = 60_000;

/** The documented prefixes, hardcoded: they are the public naming, not an import. */
const PREFIXES = ["conduit-call-tmp-", "conduit-claude-config-", "conduit-codex-home-", "conduit-opencode-"];

/** Field 22 of /proc/<pid>/stat. Field 2 (comm) may hold spaces and parens, so count from the last `)`. */
function startTimeOf(pid: number | "self"): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const field = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[22 - 3];
  if (field === undefined || !/^\d+$/.test(field)) throw new Error(`unparseable /proc/${pid}/stat: ${stat}`);
  return Number(field);
}

const PID_MAX = Number(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());
/** A pid above pid_max: no process can have it. */
const DEAD_PID = PID_MAX + 12345;
const SELF_START = startTimeOf("self");

const FLOW = `
flow: bb-stale-temp-sweep
project_root: .
flow_version: 1
budgets:
  run: { wall_clock_minutes: 2, max_tokens: 100000 }
  per_card: { max_execution_attempts: 1 }
  liveness: { no_progress_minutes: 1 }
terminal_lanes: [done, scrap, hold]
stations:
  - id: research
    worker:
      kind: harness
      harness: claude-headless
      model: claude-bb-maker-model
      tools: [Read, Write]
      prompt_file: prompts/maker.md
      prompt_version: "1"
      output_schema:
        fields:
          - { name: summary, type: string, required: true }
    inputs: [topic.md]
    outputs: [result.json]
    next: done
channels:
  ingress:
    type: cli
`;

interface Planted {
  name: string;
  /** Whether the documented contract says the sweep removes it. */
  swept: boolean;
}

describe("stale run-scoped temp dirs: the first run in a kernel sweeps dead owners' dirs only", () => {
  let tmp: string;
  let outside: string;
  let f: HarnessFlow;
  let run: CliResult;
  const planted: Planted[] = [];
  /** `conduit-claude-config-` dirs seen while the maker call was in flight, other than the planted ones. */
  let inFlight: string[] = [];
  const runAsRoot = process.getuid?.() === 0;
  const stuckName = `conduit-codex-home-${DEAD_PID}-1-stuck`;
  const credsLinkName = `conduit-claude-config-${DEAD_PID}-7-creds`;
  const fileName = `conduit-call-tmp-${DEAD_PID}-${SELF_START}-file01`;
  const linkName = `conduit-opencode-${DEAD_PID}-${SELF_START}-link01`;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "conduit-bb-sweep-tmp-"));
    outside = mkdtempSync(join(tmpdir(), "conduit-bb-sweep-outside-"));

    const plant = (name: string, swept: boolean, kind: "dir" | "file" = "dir") => {
      const p = join(tmp, name);
      if (kind === "dir") {
        mkdirSync(p);
        writeFileSync(join(p, "marker"), name);
      } else {
        writeFileSync(p, name);
      }
      planted.push({ name, swept });
    };

    for (const prefix of PREFIXES) {
      plant(`${prefix}${DEAD_PID}-${SELF_START}-dead01`, true);
      plant(`${prefix}${process.pid}-${SELF_START + 1}-reused`, true);
      plant(`${prefix}${process.pid}-${SELF_START}-live01`, false);
      // mkdtemp's output when the owner tag cannot be read.
      plant(`${prefix}Ab12Cd`, false);
      // Not the `<pid>-<start time>-<random>` shape.
      plant(`${prefix}${DEAD_PID}-${SELF_START}`, false);
      plant(`${prefix}${DEAD_PID}-${SELF_START}-a-b`, false);
      plant(`${prefix}x${DEAD_PID}-${SELF_START}-dead02`, false);
    }
    // A prefix the sweep does not cover, with a dead-owner tag.
    plant(`conduit-other-${DEAD_PID}-${SELF_START}-dead03`, false);
    plant(`conduit-claude-cfg-${DEAD_PID}-${SELF_START}-dead04`, false);

    // Matching names that are not dirs: a plain file and a symlink to a dir
    // outside the swept TMPDIR.
    writeFileSync(join(tmp, fileName), "plain file");
    mkdirSync(join(outside, "link-target"));
    writeFileSync(join(outside, "link-target", "keep"), "target contents");
    symlinkSync(join(outside, "link-target"), join(tmp, linkName));

    // A dead owner's config dir holding a credentials link, as a crashed
    // kernel leaves it. The link goes; the operator's file stays.
    const creds = join(outside, ".credentials.json");
    writeFileSync(creds, '{"operator":"secret"}');
    mkdirSync(join(tmp, credsLinkName));
    symlinkSync(creds, join(tmp, credsLinkName, ".credentials.json"));
    planted.push({ name: credsLinkName, swept: true });

    // A dead owner's dir that cannot be fully removed by a non-root user.
    const stuck = join(tmp, stuckName);
    mkdirSync(join(stuck, "ro"), { recursive: true });
    writeFileSync(join(stuck, "ro", "pinned"), "x");
    chmodSync(join(stuck, "ro"), 0o500);

    f = startHarnessFlow({
      flowYaml: FLOW,
      files: {
        "prompts/maker.md": "ROLE:MAKER Answer the question in topic.md and write result.json.\n",
        "topic.md": "What is a kanban card?\n",
      },
      entryInput: "topic.md",
      // With _ISOLATE_CONFIG on, an allowlisted API key lets the adapter build
      // the config dir without linking the operator's credentials file.
      stub: { ...FAKE_CLAUDE_STUB, allowlist: ["ANTHROPIC_API_KEY"] },
      env: {
        TMPDIR: tmp,
        ANTHROPIC_API_KEY: "blackbox-unused",
        CONDUIT_HARNESS_CLAUDE_HEADLESS_ISOLATE_CONFIG: "1",
      },
      roles: [
        {
          name: "maker",
          promptIncludes: "ROLE:MAKER",
          // Long enough to see the run's own config dir while the call runs.
          calls: [{ writeFiles: { "result.json": JSON.stringify({ summary: "a card" }) }, delayMs: 1500 }],
        },
      ],
    });

    const plantedNames = new Set(planted.map((p) => p.name));
    const ownConfigDirs = () =>
      readdirSync(tmp).filter((n) => n.startsWith("conduit-claude-config-") && !plantedNames.has(n));
    const runP = f.run();
    try {
      await f.waitFor(() => f.stubLog().length > 0, { timeoutMs: 30_000 });
      inFlight = ownConfigDirs();
      // Read the owner's start time while the kernel is still alive.
      inFlight = inFlight.map((n) => {
        const m = /^conduit-claude-config-(\d+)-(\d+)-/.exec(n);
        if (m === null) return `${n} (untagged)`;
        return startTimeOf(Number(m[1])) === Number(m[2]) ? `${n} (owner live)` : `${n} (owner mismatch)`;
      });
    } finally {
      run = await runP;
    }
  }, TIMEOUT_MS);

  afterAll(async () => {
    await f?.cleanup();
    try {
      chmodSync(join(tmp, stuckName, "ro"), 0o700);
    } catch {
      /* removed (root) or never made */
    }
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    if (outside !== undefined) rmSync(outside, { recursive: true, force: true });
  });

  test("the run completes", async () => {
    expect(run.exitCode).toBe(0);
    const status = await f.runStatus();
    expect(status.stdout).toContain(`run ${f.runId}: terminal (outcome=complete)`);
  });

  test("dirs of a dead owner and of a reused pid are removed under every prefix", () => {
    const removed = planted.filter((p) => p.swept).map((p) => p.name);
    expect(removed.length).toBe(PREFIXES.length * 2 + 1);
    expect(removed.filter((n) => existsSync(join(tmp, n)))).toEqual([]);
  });

  test("a live owner's dir, untagged names, malformed names and other prefixes are kept", () => {
    const kept = planted.filter((p) => !p.swept).map((p) => p.name);
    expect(kept.filter((n) => !existsSync(join(tmp, n, "marker")))).toEqual([]);
  });

  test("a plain file and a symlink with a swept prefix and a dead owner are kept, and the link target is untouched", () => {
    expect(readFileSync(join(tmp, fileName), "utf8")).toBe("plain file");
    expect(lstatSync(join(tmp, linkName)).isSymbolicLink()).toBe(true);
    expect(readdirSync(join(outside, "link-target"))).toEqual(["keep"]);
    expect(readFileSync(join(outside, "link-target", "keep"), "utf8")).toBe("target contents");
  });

  test("removing a dir drops its credentials link and leaves the link's target alone", () => {
    expect(existsSync(join(tmp, credsLinkName))).toBe(false);
    expect(readFileSync(join(outside, ".credentials.json"), "utf8")).toBe('{"operator":"secret"}');
  });

  test.skipIf(runAsRoot)("a dead owner's dir the sweep cannot remove is left in place", () => {
    // rm removes what it can, so the read-only subdir and its file remain.
    expect(existsSync(join(tmp, stuckName, "ro", "pinned"))).toBe(true);
  });

  test("the run's own config dir is tagged with the live kernel and removed when the run ends", () => {
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0]).toEndWith("(owner live)");
    const leftovers = readdirSync(tmp).filter(
      (n) => PREFIXES.some((p) => n.startsWith(p)) && !planted.some((p) => p.name === n) && ![stuckName, fileName, linkName].includes(n),
    );
    expect(leftovers).toEqual([]);
  });
});
