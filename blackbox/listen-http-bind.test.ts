/**
 * `conduit listen` HTTP bind journey (#44).
 *
 * Spawns the shipped binary's `listen` subcommand and reads which TCP sockets
 * the process is LISTENING on from /proc (the same data `ss -tlnp` reports):
 *
 *   1. A Socket-Mode-only flow: no listening socket at all, and the startup
 *      log says no HTTP listener was started.
 *   2. A webhook flow with no --bind: one listening socket, on 127.0.0.1, and
 *      the log says loopback only. A connection to a non-loopback address of
 *      this host is refused.
 *   3. A webhook flow with --bind 0.0.0.0: one listening socket on 0.0.0.0,
 *      and the log names the --bind address.
 *
 * BLACK-BOX: imports only bun:test, node builtins and the harness's port
 * helper; nothing from src/.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { reserveEphemeralPort } from "./harness/journey-harness";

const CONDUIT_ENTRY = join(import.meta.dir, "..", "src", "cli", "main.ts");
const JOURNEY_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// /proc readers
// ---------------------------------------------------------------------------

interface ListeningSocket {
  address: string;
  port: number;
}

/** Decode a /proc/net/tcp{,6} local_address field ("0100007F:0BB8"). */
function decodeAddress(field: string, v6: boolean): ListeningSocket {
  const [hex, portHex] = field.split(":") as [string, string];
  const port = parseInt(portHex, 16);
  if (!v6) {
    // Four bytes in host (little-endian) order.
    const bytes = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16)).reverse();
    return { address: bytes.join("."), port };
  }
  if (/^0+$/.test(hex)) return { address: "::", port };
  if (hex === "00000000000000000000000001000000") return { address: "::1", port };
  return { address: `ipv6:${hex}`, port };
}

/** Every TCP socket in LISTEN state (st 0A) owned by `pid`. */
function listeningSockets(pid: number): ListeningSocket[] {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (m) inodes.add(m[1]!);
    } catch {
      /* fd closed between readdir and readlink */
    }
  }
  const out: ListeningSocket[] = [];
  for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]] as const) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // no IPv6 on this host
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      if (cols[3] === "0A" && inodes.has(cols[9]!)) out.push(decodeAddress(cols[1]!, v6));
    }
  }
  return out;
}

/** A non-loopback IPv4 address of this host, if it has one. */
function nonLoopbackIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Workspace + listener process
// ---------------------------------------------------------------------------

const STATIONS = `terminal_lanes: [done, scrap, hold]

stations:
  - id: process
    next: done
    worker:
      kind: deterministic
      role: deliverer
      command: cp
      args: ["seed.txt", "out.txt"]
    wip: 1
    inputs: []
    outputs: [out.txt]

security:
  bash:
    allow: ["cp"]
    deny_shell_metachars: true
  network_egress: deny
`;

const SOCKET_INGRESS = `channels:
  ingress:
    type: slack
    transport: socket
    channel: "C_BIND"
    app_token_env: SLACK_APP_TOKEN
    event_id: { from: json_path, path: "$.event_id" }
  egress:
    - type: slack
      target: "C_BIND"
      uses: [alerts]
`;

const WEBHOOK_INGRESS = `channels:
  ingress:
    type: webhook
    route: /hooks/bind
    auth: { type: hmac, secret_env: BIND_WEBHOOK_SECRET }
    event_id: { from: json_path, path: "$.id" }
  egress:
    - type: slack
      target: "C_BIND"
      uses: [alerts]
`;

interface Listen {
  pid: number;
  stdout(): string;
  stderr(): string;
  stop(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function startListen(ingress: string, extraArgs: string[]): Promise<Listen> {
  const root = mkdtempSync(join(tmpdir(), "conduit-blackbox-bind-"));
  const flowPath = join(root, "flow.yaml");
  writeFileSync(
    flowPath,
    `flow: blackbox-bind\nproject_root: ./\nflow_version: 1\n\n${STATIONS}\n${ingress}`,
  );

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Socket Mode dials this and fails; the client retries in the background.
    // Nothing in this journey needs Slack to answer.
    SLACK_API_BASE_URL: "http://127.0.0.1:9",
    SLACK_BOT_TOKEN: "xoxb-blackbox-bind",
    SLACK_APP_TOKEN: "xapp-blackbox-bind",
    BIND_WEBHOOK_SECRET: "bind-secret",
    CONDUIT_STATE_DB: join(root, "conduit.sqlite"),
    CONDUIT_JOURNAL_DB: join(root, "journal.sqlite"),
    CONDUIT_PROJECT_ROOT: root,
    CONDUIT_API_KEY: "blackbox-bind-key",
    CONDUIT_BASE_URL: "http://127.0.0.1:9/v1",
  };

  const proc = Bun.spawn(
    [process.execPath, CONDUIT_ENTRY, "listen", "--flows", `bind=${flowPath}`, ...extraArgs],
    { env, stdout: "pipe", stderr: "pipe" },
  );

  let out = "";
  let err = "";
  const drain = async (stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* stream closed */
    }
  };
  void drain(proc.stdout, (s) => (out += s));
  void drain(proc.stderr, (s) => (err += s));

  const listen: Listen = {
    pid: proc.pid,
    stdout: () => out,
    stderr: () => err,
    stop: async () => {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(5000)]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    },
  };
  cleanups.push(listen.stop);

  // Bounded wait for the startup decision line, which is printed after boot.
  const deadline = Date.now() + 30_000;
  while (!/conduit listen: (serving ingress|no HTTP listener)/.test(out)) {
    if (proc.exitCode !== null) {
      throw new Error(`conduit listen exited with ${proc.exitCode} before serving:\n${out}\n${err}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`conduit listen printed no startup decision within 30s:\n${out}\n${err}`);
    }
    await Bun.sleep(50);
  }
  return listen;
}

/** True when a TCP connection to host:port is refused (nothing listening there). */
async function connectionRefused(host: string, port: number): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(3000) });
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "linux")("conduit listen HTTP bind (#44)", () => {
  test(
    "a Socket-Mode-only flow opens no listening port",
    async () => {
      const port = reserveEphemeralPort();
      const l = await startListen(SOCKET_INGRESS, ["--port", String(port)]);

      expect(l.stdout()).toContain("conduit listen: no HTTP listener");
      expect(l.stdout()).not.toContain("serving ingress");
      expect(listeningSockets(l.pid)).toEqual([]);
      expect(await connectionRefused("127.0.0.1", port)).toBe(true);
    },
    JOURNEY_TIMEOUT_MS,
  );

  test(
    "a webhook flow with no --bind listens on loopback only",
    async () => {
      const port = reserveEphemeralPort();
      const l = await startListen(WEBHOOK_INGRESS, ["--port", String(port)]);

      expect(l.stdout()).toContain(`conduit listen: serving ingress on http://127.0.0.1:${port}`);
      expect(l.stdout()).toContain("loopback only");
      expect(listeningSockets(l.pid)).toEqual([{ address: "127.0.0.1", port }]);

      // It is the ingress: an unsigned POST to the route is refused by auth.
      const res = await fetch(`http://127.0.0.1:${port}/hooks/bind`, {
        method: "POST",
        body: JSON.stringify({ id: "evt-1" }),
      });
      expect(res.status).toBe(401);

      const external = nonLoopbackIPv4();
      if (external !== undefined) {
        expect(await connectionRefused(external, port)).toBe(true);
      }
    },
    JOURNEY_TIMEOUT_MS,
  );

  test(
    "a webhook flow with --bind 0.0.0.0 listens on every interface",
    async () => {
      const port = reserveEphemeralPort();
      const l = await startListen(WEBHOOK_INGRESS, ["--port", String(port), "--bind", "0.0.0.0"]);

      expect(l.stdout()).toContain(`conduit listen: serving ingress on http://0.0.0.0:${port} (--bind 0.0.0.0)`);
      expect(listeningSockets(l.pid)).toEqual([{ address: "0.0.0.0", port }]);

      const external = nonLoopbackIPv4();
      if (external !== undefined) {
        expect(await connectionRefused(external, port)).toBe(false);
      }
    },
    JOURNEY_TIMEOUT_MS,
  );
});
