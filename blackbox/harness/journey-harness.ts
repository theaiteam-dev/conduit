/**
 * Black-box journey harness (WI-677).
 *
 * The ONLY module in blackbox/ that owns the fakes + reusable assertions. The
 * golden journey (WI-679) and the fault variants (WI-680..683) CONSUME
 * `startJourneyHarness()` — this file is the authoritative shape of that
 * contract, pinned by ./journey-harness.smoke.test.ts.
 *
 * BLACK-BOX RULE: zero imports from src/. This harness spawns the shipped
 * binary (by file path, passed as a spawn argument — never imported) and
 * speaks HTTP/WebSocket to it, exactly like a real Slack workspace + a real
 * operator would. Only node/bun builtins are imported here.
 *
 * Scope note: the scaffolded flow.yaml wires a `deterministic` deliver
 * station followed by a `kind: rank` HITL `select` station, over a Socket
 * Mode Slack ingress/egress channel. The rank critic is backed by
 * `startFakeModelGateway()` (an OpenAI-compatible `/chat/completions` fake
 * wired to CONDUIT_BASE_URL) returning a fixed, schema-valid
 * RankCriticVerdict (`{ranking, findings}`) — sufficient today because the
 * production rank-check call site passes `candidateIds: []` (no
 * membership/length cross-check against real candidates). `sendInteractiveResponse`
 * and the Socket Mode `hello`/interactive/ack envelope plumbing complete the
 * HITL reply path.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SignedRequest {
  headers: { "X-Slack-Signature": string; "X-Slack-Request-Timestamp": string };
  timestamp: number;
  signature: string;
  rawBody: string;
}

export interface SlackPostRecord {
  channel?: string;
  text?: string;
  thread_ts?: string;
  [key: string]: unknown;
}

export interface SlackUploadRecord {
  stage: "getUploadURLExternal" | "rawUpload" | "completeUploadExternal";
  fileId?: string;
  [key: string]: unknown;
}

export interface SpawnRecord {
  pid: number;
  args: string[];
  /** Subcommand argv[2] ('run' | 'resume'), if present. */
  subcommand?: string;
  startedAt: number;
  /**
   * Always null in the ledger — a placeholder, NOT a live field. The harness
   * is not the OS parent of grandchild `conduit run`/`resume` processes the
   * listener spawns (only the listener itself wait()s on them), so no real
   * OS exit code is ever observable here, and this is never written after
   * construction. `assert.exitCode()` does NOT read this field — it derives
   * the run's actual kernel outcome fresh from the journal DB at call time
   * (see `deriveRunExitCode`), keyed off the run id parsed from `args`.
   */
  exitCode: number | null;
}

export interface Harness {
  /** Fake Slack BASE HOST (SLACK_API_BASE_URL per WI-676) — no trailing /api. */
  slackBaseUrl: string;
  /** The child's CONDUIT_SLACK_SIGNING_SECRET. */
  signingSecret: string;
  signSlackRequest(rawBody: string, timestampSec?: number): SignedRequest;
  slack: {
    posts(): SlackPostRecord[];
    uploads(): SlackUploadRecord[];
    /** Bumped ONLY on files.completeUploadExternal — the canonical 'one delivery upload' counter. */
    completeUploadCount(): number;
    verifySignedEvent(req: { headers: Record<string, string>; rawBody: string }): boolean;
  };
  /** POSTs a v0-signed event to the child's /slack/events webhook route. */
  sendSignedEvent(
    event: unknown,
    opts?: { timestampSec?: number },
  ): Promise<{ status: number; body: string }>;
  /** Pushes an 'interactive' envelope (HITL button tap) over the live Socket Mode connection. */
  sendInteractiveResponse(correlationId: string, value: string): Promise<void>;
  /**
   * Spawns `conduit <args>` as a child with the same env/DB paths as the
   * listener child, returning its real CLI output. This is the general PUBLIC
   * surface for driving any conduit subcommand against the harness's live
   * DBs/workspace — e.g. `runConduit(["journal", "inspect", "entry-<runId>", "--run", "<runId>"])`
   * for a run's ask/selection/terminal-lane narrative. `assert.explainField`
   * is a raw journal-DB read, not something a real operator can see; this is.
   */
  runConduit(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * Peak number of gateway `/chat/completions` calls in flight at once, as observed
   * by the fake model gateway. > 1 proves transform fan-out children truly OVERLAPPED
   * through the shipped binary — the load-bearing black-box proof of `--concurrency`
   * K>1. Only meaningful with the concurrent-fan-out harness (its gateway holds each
   * call briefly open so siblings actually coincide); 1 for the serial journeys.
   */
  peakConcurrency(): number;
  /** The listener child's accumulated stderr so far (continuously buffered since spawn). */
  listenerStderr(): string;
  /** Kills the current listener child (SIGKILL) and stops its spawn observer. */
  killListener(): Promise<void>;
  /**
   * Spawns a fresh listener child on the same port/flow/env and waits (bounded)
   * for both its HTTP boot AND its Socket Mode reconnect to the fake before
   * returning — a crash-recovery test can rely on the harness being fully live
   * again the moment this resolves.
   */
  restartListener(): Promise<void>;
  spawns: {
    runInvocations(): SpawnRecord[];
    resumeInvocations(): SpawnRecord[];
  };
  assert: {
    /**
     * Derives the run's kernel outcome FRESH from the journal DB (0 = reached
     * the 'done' terminal lane, 1 = reached 'scrap', throws if unresolved or
     * no run id) and compares it to `expected`. See `deriveRunExitCode`.
     */
    exitCode(record: SpawnRecord | undefined, expected: number): void;
    /** Reads a card_log field for the most recent row matching (cardId[, runId]). */
    explainField(cardId: string, field: string, opts?: { runId?: string }): unknown;
    /** Reads a file's content relative to the scaffolded project workspace. */
    artifactContent(relPath: string): string;
  };
  faults: {
    /** Hangs matching fake-Slack responses while `on`, up to a bounded cap. */
    setStall(surface: string, on: boolean): void;
    /** While `on`, every signed event / interactive response is delivered twice. */
    setDuplicateDelivery(on: boolean): void;
  };
  waitFor(cond: () => boolean | Promise<boolean>, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>;
  cleanup(): Promise<void>;
  /** The run's project root (CONDUIT_PROJECT_ROOT). */
  projectRoot: string;
  /**
   * A directory beside the project root, outside it. With
   * `fanOutOwnedPaths: "outside"`, each child's proposed owned dir is
   * `<outsideRoot>/<child dir>`, pre-created so only confinement can reject it.
   */
  outsideRoot: string;
}

/**
 * How the concurrent fan-out gateway spells each child's owned dir:
 *   - absolute: `<projectRoot>/<dir>` (the default);
 *   - relative: `<dir>`, which the kernel must resolve against the project
 *     root, not its cwd (issue #124);
 *   - outside:  `<outsideRoot>/<dir>`, an existing directory outside the
 *     project root, which the kernel must reject (issue #73).
 */
export type FanOutOwnedPaths = "absolute" | "relative" | "outside";

// ---------------------------------------------------------------------------
// Slack v0 signature scheme — mirrors src/ingress/adapters/slack-events.ts
// EXACTLY (independently reimplemented; never imported, per the black-box rule).
// ---------------------------------------------------------------------------

function computeV0Signature(secret: string, timestampSec: number, rawBody: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestampSec}:${rawBody}`).digest("hex");
}

function verifyV0Signature(
  secret: string,
  headers: Record<string, string>,
  rawBody: string,
  now: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const tsHeader = headers["X-Slack-Request-Timestamp"];
  const sigHeader = headers["X-Slack-Signature"];
  if (!tsHeader || !sigHeader) return false;
  const tsSeconds = parseInt(tsHeader, 10);
  if (isNaN(tsSeconds)) return false;
  if (Math.abs(now - tsSeconds) > toleranceSeconds) return false;
  const expected = computeV0Signature(secret, tsSeconds, rawBody);
  const expectedBuf = Buffer.from(expected, "utf8");
  const sigBuf = Buffer.from(sigHeader, "utf8");
  if (expectedBuf.length !== sigBuf.length) return false;
  return timingSafeEqual(expectedBuf, sigBuf);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  cond: () => boolean | Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const intervalMs = opts?.intervalMs ?? 50;
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

/** Binds an ephemeral port by opening then immediately closing a throwaway server. */
function reserveEphemeralPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = Number(probe.url.port);
  probe.stop(true);
  return port;
}

// ---------------------------------------------------------------------------
// Fake Slack server — HTTP (Web API) + WebSocket (Socket Mode)
// ---------------------------------------------------------------------------

interface PendingUpload {
  fileId: string;
  filename: string;
}

interface FakeSlackServer {
  baseUrl: string;
  posts: SlackPostRecord[];
  uploads: SlackUploadRecord[];
  completeUploadCount: number;
  stall: Map<string, boolean>;
  duplicateDelivery: boolean;
  sockets: Set<import("bun").ServerWebSocket<unknown>>;
  pendingAcks: Map<string, () => void>;
  stop(): void;
  sendSocketEnvelope(envelope: Record<string, unknown>): void;
  waitForAck(envelopeId: string, timeoutMs?: number): Promise<void>;
}

function startFakeSlackServer(): FakeSlackServer {
  const posts: SlackPostRecord[] = [];
  const uploads: SlackUploadRecord[] = [];
  const pendingUploads = new Map<string, PendingUpload>();
  const stall = new Map<string, boolean>();
  const sockets = new Set<import("bun").ServerWebSocket<unknown>>();
  const pendingAcks = new Map<string, () => void>();
  const state = { completeUploadCount: 0, duplicateDelivery: false };

  const maxStallMs = 10 * 60_000;
  // Amy's finding: Bun.serve().stop(true) does NOT abort in-flight async fetch
  // handlers, so a stall knob left on through teardown kept this loop alive
  // for up to maxStallMs (10 min) after cleanup() returned — a real hang,
  // masked in `bun test` only because it hard-terminates the process once the
  // file's tests finish. `stopped` is checked every iteration so stop() can
  // cut every in-flight wait short immediately, regardless of the stall map.
  let stopped = false;
  async function waitWhileStalled(surface: string): Promise<void> {
    const start = Date.now();
    while (!stopped && stall.get(surface) && Date.now() - start < maxStallMs) {
      await sleep(50);
    }
  }

  let server!: ReturnType<typeof Bun.serve>;

  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/__socket") {
        if (srv.upgrade(req, { data: undefined })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      if (url.pathname === "/api/apps.connections.open" && req.method === "POST") {
        await waitWhileStalled("apps.connections.open");
        const wsUrl = server.url.toString().replace(/^http/, "ws").replace(/\/$/, "") + "/__socket";
        return Response.json({ ok: true, url: wsUrl });
      }

      if (url.pathname === "/api/chat.postMessage" && req.method === "POST") {
        await waitWhileStalled("chat.postMessage");
        const body = (await req.json()) as SlackPostRecord;
        posts.push(body);
        return Response.json({ ok: true, ts: `${Math.floor(Date.now() / 1000)}.${posts.length}` });
      }

      if (url.pathname === "/api/files.getUploadURLExternal" && req.method === "POST") {
        await waitWhileStalled("files.getUploadURLExternal");
        const text = await req.text();
        const params = new URLSearchParams(text);
        const filename = params.get("filename") ?? "file.bin";
        const fileId = `F${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
        pendingUploads.set(fileId, { fileId, filename });
        uploads.push({ stage: "getUploadURLExternal", fileId, filename });
        const uploadUrl = server.url.toString().replace(/\/$/, "") + `/__upload/${fileId}`;
        return Response.json({ ok: true, upload_url: uploadUrl, file_id: fileId });
      }

      const uploadMatch = url.pathname.match(/^\/__upload\/(.+)$/);
      if (uploadMatch && req.method === "POST") {
        await waitWhileStalled("upload_bytes");
        const fileId = uploadMatch[1]!;
        uploads.push({ stage: "rawUpload", fileId });
        return new Response("ok", { status: 200 });
      }

      if (url.pathname === "/api/files.completeUploadExternal" && req.method === "POST") {
        await waitWhileStalled("files.completeUploadExternal");
        const body = (await req.json()) as { files?: Array<{ id: string }> };
        const files = body.files ?? [];
        state.completeUploadCount += 1;
        uploads.push({ stage: "completeUploadExternal", fileId: files[0]?.id });
        return Response.json({ ok: true, files });
      }

      if (url.pathname === "/api/files.list" && req.method === "GET") {
        return Response.json({ ok: true, files: [] });
      }
      if (url.pathname === "/api/conversations.replies" && req.method === "GET") {
        return Response.json({ ok: true, messages: [] });
      }
      if (url.pathname === "/api/files.info" && req.method === "GET") {
        return Response.json({ ok: true, file: { id: url.searchParams.get("file") ?? "" } });
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "hello" }));
      },
      message(_ws, message) {
        // Acks from the child are exactly {"envelope_id": "..."} — no `type` field.
        try {
          const parsed = JSON.parse(String(message)) as { envelope_id?: string };
          if (parsed.envelope_id && !("type" in parsed)) {
            const resolve = pendingAcks.get(parsed.envelope_id);
            if (resolve) {
              pendingAcks.delete(parsed.envelope_id);
              resolve();
            }
          }
        } catch {
          /* ignore malformed frames from the fake's own perspective */
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  return {
    baseUrl: server.url.toString().replace(/\/$/, ""),
    posts,
    uploads,
    get completeUploadCount() {
      return state.completeUploadCount;
    },
    set completeUploadCount(v: number) {
      state.completeUploadCount = v;
    },
    stall,
    get duplicateDelivery() {
      return state.duplicateDelivery;
    },
    set duplicateDelivery(v: boolean) {
      state.duplicateDelivery = v;
    },
    sockets,
    pendingAcks,
    stop() {
      stopped = true;
      server.stop(true);
    },
    sendSocketEnvelope(envelope: Record<string, unknown>) {
      const payload = JSON.stringify(envelope);
      for (const ws of sockets) ws.send(payload);
    },
    async waitForAck(envelopeId: string, timeoutMs = 10_000): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingAcks.delete(envelopeId);
          reject(new Error(`socket envelope ${envelopeId} was not acked within ${timeoutMs}ms`));
        }, timeoutMs);
        pendingAcks.set(envelopeId, () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  } satisfies FakeSlackServer;
}

// ---------------------------------------------------------------------------
// Fake model gateway — OpenAI-compatible /chat/completions (CONDUIT_BASE_URL).
//
// Serves the rank critic call the HITL station makes: always returns a
// schema-valid RankCriticVerdict ({ranking, findings} — see src/quality/rank.ts).
// The production rank-check call site currently passes candidateIds: [] (no
// membership/length cross-check against real candidates), so a fixed
// plausible verdict is sufficient for every caller today.
// ---------------------------------------------------------------------------

interface FakeModelGateway {
  baseUrl: string;
  /** Peak simultaneous in-flight /chat/completions calls observed. */
  peakConcurrency(): number;
  stop(): void;
}

/**
 * Homogeneous fan-out children for the concurrent-fan-out journey (concurrent fan-out journey). Each is a
 * distinct review "lens" that writes its OWN findings.json into its OWN owned dir
 * (`output_scope: owned_dir`), so the assertions can prove per-child artifacts by
 * lens — no clobber — and the fake gateway can hold N calls open at once to prove
 * the reviewers truly overlapped. Shared by the scaffold (which pre-creates the
 * dirs) and the gateway (which emits them in the fan-out proposal).
 */
export const CONCURRENT_FANOUT_CHILDREN: ReadonlyArray<{ id: string; dir: string; lens: string }> = [
  { id: "review-security", dir: "reviews/security", lens: "security" },
  { id: "review-perf", dir: "reviews/perf", lens: "perf" },
  { id: "review-style", dir: "reviews/style", lens: "style" },
];

/**
 * OpenAI-compatible /chat/completions fake (CONDUIT_BASE_URL). Routes by prompt:
 *   • "Propose …"      → a fan-out proposal (the N homogeneous children above),
 *                        each owning a dir spelled as `fanOutOwnedPaths` says
 *                        (absolute under projectRoot by default). With
 *                        `skipChild`, every seed carries `skip`, true only for
 *                        that child, for the flow's `skip_when` predicate.
 *   • "…findings for…" → a review child; echoes THIS child's lens (rendered into
 *                        the prompt from its per-child seed.json) so each written
 *                        findings.json is distinguishable — proof of no-clobber.
 *   • otherwise        → the golden journey's rank-critic verdict (unchanged).
 *
 * When `overlap` is set, each call is held briefly open and peak in-flight is
 * tracked, so concurrent reviewer calls genuinely coincide and `peakConcurrency()`
 * can prove real parallelism. `overlap` is off for the serial journeys, so their
 * timing and the default verdict path are byte-for-byte unchanged.
 */
function startFakeModelGateway(
  opts: {
    projectRoot?: string;
    outsideRoot?: string;
    overlap?: boolean;
    fanOutOwnedPaths?: FanOutOwnedPaths;
    skipChild?: string;
  } = {},
): FakeModelGateway {
  const holdOpenMs = opts.overlap ? 40 : 0;
  let inFlight = 0;
  let peak = 0;

  const respond = (content: string): Response =>
    Response.json({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/chat/completions" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }

      let prompt = "";
      try {
        const body = (await req.json()) as { messages?: Array<{ content?: unknown }> };
        const content = body.messages?.[0]?.content;
        prompt = typeof content === "string" ? content : "";
      } catch {
        /* unparseable → falls through to the default rank verdict */
      }

      inFlight++;
      if (inFlight > peak) peak = inFlight;
      try {
        if (holdOpenMs > 0) await sleep(holdOpenMs);

        if (prompt.includes("Propose")) {
          const ownedDir = (dir: string): string => {
            switch (opts.fanOutOwnedPaths ?? "absolute") {
              case "relative":
                return dir;
              case "outside":
                return join(opts.outsideRoot!, dir);
              default:
                return opts.projectRoot ? join(opts.projectRoot, dir) : dir;
            }
          };
          const children = CONCURRENT_FANOUT_CHILDREN.map((c) => ({
            id: c.id,
            depends_on: [] as string[],
            owned_paths: [ownedDir(c.dir)],
            seed: opts.skipChild === undefined ? { lens: c.lens } : { lens: c.lens, skip: c.id === opts.skipChild },
          }));
          return respond(JSON.stringify({ children }));
        }

        if (prompt.includes("findings for")) {
          const lens = /"lens"\s*:\s*"([^"]+)"/.exec(prompt)?.[1] ?? "unknown";
          return respond(JSON.stringify({ finding: lens }));
        }

        return respond(
          JSON.stringify({ ranking: ["candidate-1"], findings: ["blackbox fake critic verdict"] }),
        );
      } finally {
        inFlight--;
      }
    },
  });
  return {
    baseUrl: server.url.toString().replace(/\/$/, ""),
    peakConcurrency: () => peak,
    stop() {
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Workspace + flow scaffolding
// ---------------------------------------------------------------------------

const HARNESS_CHANNEL = "C_HARNESS";

/** The directory beside the project root used as an out-of-project target. */
function outsideRootOf(root: string): string {
  return join(root, "outside");
}

interface Workspace {
  root: string;
  projectRoot: string;
  flowPath: string;
  stateDbPath: string;
  journalDbPath: string;
}

function scaffoldWorkspace(opts: { failDeterministicStation?: boolean } = {}): Workspace {
  // WI-681: when set, the process station's cp source doesn't exist, so the
  // command exits nonzero -> counted toward the attempt cap and scrapped named
  // (countDeterministicFailure) before the deliver block runs. No delivery,
  // no HITL — the run terminates at scrap.
  const deliverArgs = opts.failDeterministicStation
    ? '["does-not-exist.txt", "delivery.txt"]'
    : '["seed/delivery.txt", "delivery.txt"]';

  const root = mkdtempSync(join(tmpdir(), "conduit-blackbox-"));
  const projectRoot = join(root, "workspace");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(projectRoot, "seed"), { recursive: true });
  writeFileSync(join(projectRoot, "seed", "delivery.txt"), "black-box journey harness delivery payload\n");

  const promptsDir = join(root, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(
    join(promptsDir, "select.md"),
    "Rank the single candidate delivery. Respond with JSON {\"ranking\": [...], \"findings\": [...]}.\n",
  );

  const flowPath = join(root, "flow.yaml");
  writeFileSync(
    flowPath,
    `flow: blackbox-journey
project_root: ./workspace
flow_version: 1

terminal_lanes: [done, scrap, hold]

stations:
  - id: process
    next: select
    worker:
      kind: deterministic
      role: deliverer
      command: cp
      args: ${deliverArgs}
    wip: 5
    inputs: []
    outputs: [delivery.txt]
    deliver:
      files: [delivery.txt]

  - id: select
    next: done
    check:
      kind: rank
      class: taste
      critic:
        role: selector
        model: blackbox-fake-model
        prompt_file: prompts/select.md
      on_reject: process
      rework_cap: 2
      progress_signal: findings_hash

channels:
  ingress:
    type: slack
    transport: socket
    channel: "${HARNESS_CHANNEL}"
    app_token_env: SLACK_APP_TOKEN
    event_id: { from: json_path, path: "$.event_id" }
  egress:
    - type: slack
      target: "${HARNESS_CHANNEL}"
      uses: [status, hitl, alerts, delivery]
      hold_timeout_seconds: 3600
      on_timeout: scrap

security:
  bash:
    allow: ["cp"]
    deny_shell_metachars: true
  network_egress: deny
`,
  );

  return {
    root,
    projectRoot,
    flowPath,
    stateDbPath: join(root, "state.sqlite"),
    journalDbPath: join(root, "journal.sqlite"),
  };
}

/**
 * Concurrent-fan-out journey (concurrent fan-out journey): a transform `plan` fan-out → N homogeneous
 * `review` children (`output_scope: owned_dir`, `wip: N`) → a deterministic
 * `gather` fan-in → done. `defaults.concurrency: 3` makes the ingress-spawned
 * `conduit run` parallelize the reviewers WITHOUT any listener change (the run
 * resolves concurrency as flag > flow default > 1). Each child's owned dir is
 * pre-created here so commitFanOut can seed it and the scoped output can land.
 */
function scaffoldConcurrentFanoutWorkspace(
  opts: { childStaggerSeconds?: number; skipChild?: string } = {},
): Workspace {
  const root = mkdtempSync(join(tmpdir(), "conduit-blackbox-"));
  const projectRoot = join(root, "workspace");
  mkdirSync(projectRoot, { recursive: true });
  // Pre-create each child's owned dir — commitFanOut seeds seed.json into it and
  // (output_scope: owned_dir) the review child writes findings.json there. The
  // dirs must EXIST before fan-out (same rule as the per-child seed).
  for (const c of CONCURRENT_FANOUT_CHILDREN) {
    mkdirSync(join(projectRoot, c.dir), { recursive: true });
    // The same dirs outside the project root, for the confinement journey.
    mkdirSync(join(outsideRootOf(root), c.dir), { recursive: true });
  }

  const promptsDir = join(root, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, "plan.md"), "Propose the review children.\n");
  writeFileSync(join(promptsDir, "review.md"), "Produce findings for: {{seed.json}}\n");

  const staggerLine =
    opts.childStaggerSeconds && opts.childStaggerSeconds > 0
      ? `    child_stagger_seconds: ${opts.childStaggerSeconds}\n`
      : "";
  const skipLine =
    opts.skipChild !== undefined ? `    skip_when: { source: seed, field: skip, equals: true }\n` : "";

  const flowPath = join(root, "flow.yaml");
  writeFileSync(
    flowPath,
    `flow: blackbox-concurrent-fanout
project_root: ./workspace
flow_version: 1

terminal_lanes: [done, scrap, hold]

defaults:
  concurrency: 3

stations:
  - id: plan
    next: gather
    worker:
      kind: transform
      role: planner
      model: blackbox-fake-model
      prompt_file: prompts/plan.md
      prompt_version: "1"
      output_schema: { fields: [{ name: children, type: object, required: true }] }
    inputs: []
    outputs: [children.json]
    fan_out: 3
    child_entry: review
    child_terminal: done
    resume_at: gather
${staggerLine}
  - id: review
    next: done
    worker:
      kind: transform
      role: reviewer
      model: blackbox-fake-model
      prompt_file: prompts/review.md
      prompt_version: "1"
      output_schema: { fields: [{ name: finding, type: string, required: true }] }
    inputs: [seed.json]
    outputs: [findings.json]
    output_scope: owned_dir
    wip: 3
${skipLine}
  - id: gather
    next: done
    worker:
      kind: deterministic
      role: collector
      command: "true"
    fan_in: { policy: all }
    inputs: []
    outputs: []

channels:
  ingress:
    type: slack
    transport: socket
    channel: "${HARNESS_CHANNEL}"
    app_token_env: SLACK_APP_TOKEN
    event_id: { from: json_path, path: "$.event_id" }
  egress:
    - type: slack
      target: "${HARNESS_CHANNEL}"
      uses: [status, hitl, alerts, delivery]
      hold_timeout_seconds: 3600
      on_timeout: scrap

security:
  bash:
    allow: ["true"]
    deny_shell_metachars: true
  network_egress: deny
`,
  );

  return {
    root,
    projectRoot,
    flowPath,
    stateDbPath: join(root, "state.sqlite"),
    journalDbPath: join(root, "journal.sqlite"),
  };
}

// ---------------------------------------------------------------------------
// /proc-based spawn observer (Linux) — best-effort child-process ledger.
//
// The harness is not the OS parent of `conduit run`/`resume` grandchildren
// (the listener spawns and wait()s on them directly), so real exit codes are
// not observable here. This poller instead records EXISTENCE + argv of any
// descendant process seen under the listener's pid, at a tight interval —
// short-lived invocations may still be missed between polls. See SpawnRecord.
// ---------------------------------------------------------------------------

function readCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function listChildPids(parentPid: number): number[] {
  const children: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return children;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const match = stat.match(/\)\s+\S+\s+(\d+)/);
      if (match && Number(match[1]) === parentPid) children.push(Number(entry));
    } catch {
      /* process exited mid-scan */
    }
  }
  return children;
}

function descendantPids(rootPid: number): number[] {
  const all: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const p = queue.shift()!;
    const kids = listChildPids(p);
    for (const k of kids) {
      all.push(k);
      queue.push(k);
    }
  }
  return all;
}

class SpawnObserver {
  private readonly seen = new Map<number, SpawnRecord>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly listenerPid: number) {}

  start(): void {
    this.timer = setInterval(() => this.poll(), 50);
  }

  private poll(): void {
    for (const pid of descendantPids(this.listenerPid)) {
      if (this.seen.has(pid)) continue;
      const args = readCmdline(pid);
      if (args.length === 0) continue;
      const subcommand = args[2];
      if (subcommand !== "run" && subcommand !== "resume") continue;
      this.seen.set(pid, { pid, args, subcommand, startedAt: Date.now(), exitCode: null });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  runInvocations(): SpawnRecord[] {
    return [...this.seen.values()].filter((r) => r.subcommand === "run");
  }

  resumeInvocations(): SpawnRecord[] {
    return [...this.seen.values()].filter((r) => r.subcommand === "resume");
  }
}

// ---------------------------------------------------------------------------
// Run outcome derivation — the run id is parsed from a spawn's own argv
// (`run --run-id <id>` / `resume <flowPath> --run <id>`, see spawnConduitRun/
// spawnConduitResume in src/cli/main.ts), then the journal DB's card_log is
// queried fresh for that run's most recent kernel-terminal-lane transition.
// ---------------------------------------------------------------------------

/** Extracts the run id from a spawned `run`/`resume` argv (`--run-id` or `--run`). */
function extractRunId(args: string[]): string | undefined {
  for (const flag of ["--run-id", "--run"]) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  }
  return undefined;
}

/**
 * 0 = the run's most recent entered_lane row landed on the 'done' terminal
 * lane; 1 = it landed on 'scrap'; null = not yet resolved (e.g. still
 * parked in 'hold' awaiting a HITL reply, or no matching row at all).
 */
function deriveRunExitCode(journalDbPath: string, runId: string): number | null {
  const db = new Database(journalDbPath, { readonly: true });
  try {
    const row = db
      .query(
        `SELECT dest_lane FROM card_log
         WHERE run_id = ? AND kind = 'entered_lane' AND dest_lane IN ('done', 'scrap')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(runId) as { dest_lane: string } | null;
    if (!row) return null;
    return row.dest_lane === "done" ? 0 : 1;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// startJourneyHarness
// ---------------------------------------------------------------------------

const CONDUIT_ENTRY = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

export async function startJourneyHarness(opts?: {
  failDeterministicStation?: boolean;
  /** concurrent fan-out journey: scaffold the concurrent transform fan-out flow + overlap-tracking gateway. */
  concurrentFanOut?: boolean;
  /** concurrent fan-out journey: fan-out cache-warming stagger (seconds) on the plan station; concurrentFanOut only. */
  childStaggerSeconds?: number;
  /** concurrentFanOut only: how the proposal spells each child's owned dir (issues #73, #124). */
  fanOutOwnedPaths?: FanOutOwnedPaths;
  /** concurrentFanOut only: add `skip_when: { source: seed, field: skip, equals: true }` to the review station; this child's seed has skip: true. */
  skipChild?: string;
}): Promise<Harness> {
  // Spawn observation (SpawnObserver / descendantPids) reads /proc, which only
  // exists on Linux. On any other platform readdirSync('/proc') throws, is
  // caught, and returns [] — so the observer silently records nothing and every
  // journey/fault test dies at its first `waitFor(runInvocations >= 1)` with an
  // opaque ~30s timeout. Fail fast and loud, once, at boot instead.
  if (process.platform !== "linux") {
    throw new Error(
      `blackbox journey harness requires Linux: run observation reads /proc ` +
        `(got platform '${process.platform}'; see blackbox/README.md).`,
    );
  }

  // A skipChild that names no child would skip nothing, and the journey
  // would pass on the non-skip path. Fail before starting any server.
  if (opts?.skipChild !== undefined && !CONCURRENT_FANOUT_CHILDREN.some((c) => c.id === opts.skipChild)) {
    throw new Error(
      `startJourneyHarness: skipChild '${opts.skipChild}' is not a CONCURRENT_FANOUT_CHILDREN id ` +
        `(${CONCURRENT_FANOUT_CHILDREN.map((c) => c.id).join(", ")})`,
    );
  }

  const fakeSlack = startFakeSlackServer();
  const ws = opts?.concurrentFanOut
    ? scaffoldConcurrentFanoutWorkspace(opts)
    : scaffoldWorkspace(opts);
  const fakeModel = startFakeModelGateway({
    projectRoot: ws.projectRoot,
    outsideRoot: outsideRootOf(ws.root),
    overlap: opts?.concurrentFanOut === true,
    fanOutOwnedPaths: opts?.fanOutOwnedPaths,
    skipChild: opts?.skipChild,
  });
  const signingSecret = randomUUID();
  const appToken = `xapp-test-${randomUUID()}`;
  const listenerPort = reserveEphemeralPort();
  const listenerBaseUrl = `http://127.0.0.1:${listenerPort}`;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SLACK_API_BASE_URL: fakeSlack.baseUrl,
    SLACK_BOT_TOKEN: "xoxb-blackbox-test",
    SLACK_APP_TOKEN: appToken,
    CONDUIT_SLACK_SIGNING_SECRET: signingSecret,
    CONDUIT_STATE_DB: ws.stateDbPath,
    CONDUIT_JOURNAL_DB: ws.journalDbPath,
    CONDUIT_PROJECT_ROOT: ws.projectRoot,
    CONDUIT_API_KEY: "blackbox-test-key",
    CONDUIT_BASE_URL: fakeModel.baseUrl,
  };

  let listenerProc = Bun.spawn(
    [
      process.execPath,
      CONDUIT_ENTRY,
      "listen",
      "--flows",
      `journey=${ws.flowPath}`,
      "--port",
      String(listenerPort),
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );

  let spawnObserver = new SpawnObserver(listenerProc.pid);
  spawnObserver.start();

  // Continuously drain the listener's stderr into a buffer from spawn time —
  // a ReadableStream can only be consumed once, so this MUST start before
  // anything else reads it (including the boot-error path below), or
  // listenerStderr() would race a later one-shot read for the same bytes.
  let listenerStderrBuf = "";
  (async () => {
    const reader = listenerProc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        listenerStderrBuf += decoder.decode(value, { stream: true });
      }
    } catch {
      /* stream closed/errored — stop accumulating */
    }
  })();

  // Bounded wait for the listener's HTTP server to accept connections —
  // condition-polled, no fixed sleep. A crash-on-boot surfaces as the process
  // exiting, which we detect via `exited` racing the poll.
  let bootError: string | undefined;
  await Promise.race([
    waitForCondition(
      async () => {
        try {
          await fetch(`${listenerBaseUrl}/slack/events`, { method: "GET" });
          return true;
        } catch {
          return false;
        }
      },
      { timeoutMs: 30_000, intervalMs: 100 },
    ),
    listenerProc.exited.then((code) => {
      bootError = `conduit listen exited with code ${code} before boot completed: ${listenerStderrBuf}`;
    }),
  ]);
  if (bootError) {
    spawnObserver.stop();
    fakeSlack.stop();
    fakeModel.stop();
    rmSync(ws.root, { recursive: true, force: true });
    throw new Error(bootError);
  }

  let cleaned = false;

  const harness: Harness = {
    slackBaseUrl: fakeSlack.baseUrl,
    signingSecret,
    projectRoot: ws.projectRoot,
    outsideRoot: outsideRootOf(ws.root),

    signSlackRequest(rawBody: string, timestampSec = Math.floor(Date.now() / 1000)): SignedRequest {
      const signature = computeV0Signature(signingSecret, timestampSec, rawBody);
      return {
        headers: {
          "X-Slack-Signature": signature,
          "X-Slack-Request-Timestamp": String(timestampSec),
        },
        timestamp: timestampSec,
        signature,
        rawBody,
      };
    },

    slack: {
      posts: () => fakeSlack.posts,
      uploads: () => fakeSlack.uploads,
      completeUploadCount: () => fakeSlack.completeUploadCount,
      verifySignedEvent: ({ headers, rawBody }) => verifyV0Signature(signingSecret, headers, rawBody),
    },

    async sendSignedEvent(event, opts) {
      const rawBody = JSON.stringify(event);
      const signed = harness.signSlackRequest(rawBody, opts?.timestampSec);
      const send = () =>
        fetch(`${listenerBaseUrl}/slack/events`, {
          method: "POST",
          headers: { ...signed.headers, "content-type": "application/json" },
          body: rawBody,
        });
      const res = await send();
      const body = await res.text();
      if (fakeSlack.duplicateDelivery) {
        await send().catch(() => undefined);
      }
      return { status: res.status, body };
    },

    async sendInteractiveResponse(correlationId: string, value: string) {
      const envelopeId = randomUUID();
      const envelope = {
        type: "interactive",
        envelope_id: envelopeId,
        // correlationId is ALREADY `hitl::<runId>::<cardId>::<station>::<attempt>`
        // (executor.ts's hitl correlation format) — a real Slack button carries
        // that full id verbatim as its action_id. Prefixing it again here
        // double-prefixes to `hitl::hitl::...`, which findRunForHitlCorrelation
        // never finds (a resume never spawns).
        payload: { actions: [{ action_id: correlationId, value }] },
      };
      const ackPromise = fakeSlack.waitForAck(envelopeId);
      fakeSlack.sendSocketEnvelope(envelope);
      await ackPromise;
      if (fakeSlack.duplicateDelivery) {
        const dupId = randomUUID();
        const dupEnvelope = { ...envelope, envelope_id: dupId };
        const dupAck = fakeSlack.waitForAck(dupId);
        fakeSlack.sendSocketEnvelope(dupEnvelope);
        await dupAck.catch(() => undefined);
      }
    },

    async runConduit(args: string[]) {
      const proc = Bun.spawn([process.execPath, CONDUIT_ENTRY, ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { stdout, stderr, exitCode };
    },

    peakConcurrency: () => fakeModel.peakConcurrency(),

    listenerStderr: () => listenerStderrBuf,

    async killListener() {
      spawnObserver.stop();
      try {
        listenerProc.kill("SIGKILL");
        await Promise.race([listenerProc.exited, sleep(5000)]);
      } catch {
        /* best-effort */
      }
    },

    async restartListener() {
      listenerProc = Bun.spawn(
        [
          process.execPath,
          CONDUIT_ENTRY,
          "listen",
          "--flows",
          `journey=${ws.flowPath}`,
          "--port",
          String(listenerPort),
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      spawnObserver = new SpawnObserver(listenerProc.pid);
      spawnObserver.start();

      // Same continuous-drain discipline as the initial boot (see the comment
      // at spawn time above): must start before anything else reads stderr.
      const proc = listenerProc;
      (async () => {
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            listenerStderrBuf += decoder.decode(value, { stream: true });
          }
        } catch {
          /* stream closed/errored — stop accumulating */
        }
      })();

      // Bounded wait for the restarted listener's HTTP boot — same discipline
      // as the initial boot: a crash-on-boot surfaces via `exited` racing the poll.
      let restartBootError: string | undefined;
      await Promise.race([
        waitForCondition(
          async () => {
            try {
              await fetch(`${listenerBaseUrl}/slack/events`, { method: "GET" });
              return true;
            } catch {
              return false;
            }
          },
          { timeoutMs: 30_000, intervalMs: 100 },
        ),
        proc.exited.then((code) => {
          restartBootError = `restart listen exited with code ${code}: ${listenerStderrBuf.slice(-400)}`;
        }),
      ]);
      if (restartBootError) throw new Error(restartBootError);

      // Also bounded: the Socket Mode client must reconnect to the fake before
      // the harness is considered fully live again (Amy's stall-map landmine —
      // every wait here has a timeoutMs, never an unbounded loop).
      await waitForCondition(() => fakeSlack.sockets.size >= 1, { timeoutMs: 20_000, intervalMs: 100 });
    },

    spawns: {
      runInvocations: () => spawnObserver.runInvocations(),
      resumeInvocations: () => spawnObserver.resumeInvocations(),
    },

    assert: {
      exitCode(record, expected) {
        if (!record) throw new Error(`assert.exitCode: no spawn record provided`);
        const runId = extractRunId(record.args);
        if (!runId) {
          throw new Error(
            `assert.exitCode: could not determine a run id from spawn args (${record.args.join(" ")})`,
          );
        }
        const actual = deriveRunExitCode(ws.journalDbPath, runId);
        if (actual === null) {
          throw new Error(
            `assert.exitCode: run '${runId}' has not reached a terminal (done/scrap) lane yet — pid ${record.pid} (${record.args.join(" ")})`,
          );
        }
        if (actual !== expected) {
          throw new Error(
            `assert.exitCode: expected ${expected}, got ${actual} for run '${runId}' (pid ${record.pid}, ${record.args.join(" ")})`,
          );
        }
      },
      explainField(cardId, field, opts) {
        const db = new Database(ws.journalDbPath, { readonly: true });
        try {
          const row = opts?.runId
            ? db
                .query(`SELECT * FROM card_log WHERE card_id = ? AND run_id = ? ORDER BY id DESC LIMIT 1`)
                .get(cardId, opts.runId)
            : db.query(`SELECT * FROM card_log WHERE card_id = ? ORDER BY id DESC LIMIT 1`).get(cardId);
          if (!row) return undefined;
          return (row as Record<string, unknown>)[field];
        } finally {
          db.close();
        }
      },
      artifactContent(relPath) {
        return readFileSync(join(ws.projectRoot, relPath), "utf8");
      },
    },

    faults: {
      setStall(surface, on) {
        fakeSlack.stall.set(surface, on);
      },
      setDuplicateDelivery(on) {
        fakeSlack.duplicateDelivery = on;
      },
    },

    waitFor: waitForCondition,

    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      spawnObserver.stop();
      try {
        listenerProc.kill();
        await Promise.race([listenerProc.exited, sleep(5000)]);
      } catch {
        /* best-effort */
      }
      fakeSlack.stop();
      fakeModel.stop();
      try {
        rmSync(ws.root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };

  return harness;
}
