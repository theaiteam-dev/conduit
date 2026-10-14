/**
 * Issue #52: a duplicate webhook delivery names the run the original started.
 *
 * Boots a real `conduit listen` with two webhook flows, one unkeyed and one
 * keyed on a `run_key`, and POSTs the same HMAC-signed event to each route
 * twice. The first answer is `202 {"outcome":"accepted","run_id":X}`; the
 * redelivery, which is what a caller sends when that 202 was lost in transit,
 * must answer `200 {"outcome":"duplicate","run_id":X}`. `conduit run status
 * --run X` then proves X names a real run.
 *
 * BLACK-BOX: no imports from src/. The listener and its `conduit run`
 * children are the shipped CLI, driven over HTTP and argv only.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONDUIT_ENTRY = join(import.meta.dir, "..", "src", "cli", "main.ts");
const SECRET_ENV = "BLACKBOX_WEBHOOK_SECRET";
const JOURNEY_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number; what: string },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(opts.intervalMs ?? 100);
  }
  throw new Error(`timed out after ${opts.timeoutMs}ms waiting for ${opts.what}`);
}

/** A free TCP port on 127.0.0.1, released before the listener binds it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * A one-station deterministic flow whose ingress is a webhook on `route`. The
 * listener takes one project root (CONDUIT_PROJECT_ROOT), so both flows share
 * ./workspace and each writes its own output file.
 */
function writeFlow(root: string, name: string, route: string, runKey: boolean): string {
  const flowPath = join(root, `${name}.yaml`);
  writeFileSync(
    flowPath,
    `flow: ${name}
project_root: ./workspace
flow_version: 1

terminal_lanes: [done, scrap, hold]

stations:
  - id: copy
    next: done
    worker:
      kind: deterministic
      role: copier
      command: cp
      args: ["seed.txt", "${name}-out.txt"]
    wip: 1
    inputs: []
    outputs: [${name}-out.txt]

channels:
  ingress:
    type: webhook
    route: ${route}
    auth: { type: hmac, secret_env: ${SECRET_ENV} }
    event_id: { from: header, name: x-delivery }
${runKey ? '    run_key:\n      - { json_path: "$.pr" }\n' : ""}
security:
  bash:
    allow: ["cp"]
    deny_shell_metachars: true
  network_egress: deny
`,
  );
  return flowPath;
}

describe("issue #52: a duplicate webhook delivery carries the original run_id", () => {
  const secret = randomUUID();
  let root: string;
  let baseUrl: string;
  let env: Record<string, string>;
  let listener: ReturnType<typeof Bun.spawn> | undefined;
  let stderr = "";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "conduit-blackbox-webhook-dup-"));
    const projectRoot = join(root, "workspace");
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(join(projectRoot, "seed.txt"), "webhook duplicate journey\n");
    const plain = writeFlow(root, "plain", "/hooks/plain", false);
    const keyed = writeFlow(root, "keyed", "/hooks/keyed", true);
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    env = {
      ...(process.env as Record<string, string>),
      [SECRET_ENV]: secret,
      CONDUIT_STATE_DB: join(root, "state.sqlite"),
      CONDUIT_JOURNAL_DB: join(root, "journal.sqlite"),
      CONDUIT_PROJECT_ROOT: projectRoot,
      // The listener's boot check requires a model gateway. No station here
      // calls a model, so nothing ever connects to this address.
      CONDUIT_API_KEY: "blackbox-test-key",
      CONDUIT_BASE_URL: "http://127.0.0.1:9",
    };

    const proc = Bun.spawn(
      [
        process.execPath,
        CONDUIT_ENTRY,
        "listen",
        "--flows",
        `plain=${plain},keyed=${keyed}`,
        "--port",
        String(port),
        "--global-alert-channel",
        "#blackbox",
      ],
      { env, stdout: "ignore", stderr: "pipe" },
    );
    listener = proc;
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stderr) stderr += decoder.decode(chunk, { stream: true });
      } catch {
        // stream closed
      }
    })();

    let exited: number | undefined;
    void proc.exited.then((code) => {
      exited = code;
    });
    await waitFor(
      async () => {
        if (exited !== undefined) throw new Error(`conduit listen exited ${exited} during boot: ${stderr}`);
        try {
          await fetch(`${baseUrl}/`, { method: "GET" });
          return true;
        } catch {
          return false;
        }
      },
      { timeoutMs: 30_000, what: "conduit listen to serve HTTP" },
    );
  }, JOURNEY_TIMEOUT_MS);

  afterAll(async () => {
    if (listener !== undefined) {
      listener.kill();
      await Promise.race([listener.exited, sleep(5_000)]);
    }
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  /** POST one HMAC-signed delivery, as a GitHub-style provider would. */
  async function deliver(route: string, deliveryId: string, body: unknown) {
    const rawBody = JSON.stringify(body);
    const signature = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
    const res = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-delivery": deliveryId,
        "X-Hub-Signature-256": signature,
      },
      body: rawBody,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function runStatus(runId: string) {
    const proc = Bun.spawn([process.execPath, CONDUIT_ENTRY, "run", "status", "--run", runId], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr: err, exitCode };
  }

  for (const variant of [
    { name: "unkeyed", route: "/hooks/plain", runIdPrefix: "ig" },
    { name: "keyed (run_key)", route: "/hooks/keyed", runIdPrefix: "igk-" },
  ]) {
    test(
      `${variant.name}: the redelivery answers 200 duplicate with the first 202's run_id`,
      async () => {
        const deliveryId = `delivery-${randomUUID()}`;
        const event = { action: "submitted", pr: 52 };

        const first = await deliver(variant.route, deliveryId, event);
        expect(first.status).toBe(202);
        expect(first.body.outcome).toBe("accepted");
        const runId = first.body.run_id;
        expect(typeof runId).toBe("string");
        expect(runId as string).toStartWith(variant.runIdPrefix);

        const second = await deliver(variant.route, deliveryId, event);
        expect(second.status).toBe(200);
        expect(second.body).toEqual({ outcome: "duplicate", run_id: runId });

        // The id names a real run on the public status surface.
        let last = { stdout: "", stderr: "", exitCode: -1 };
        await waitFor(
          async () => {
            last = await runStatus(runId as string);
            return last.exitCode === 0 && last.stdout.includes(runId as string);
          },
          { timeoutMs: 30_000, intervalMs: 250, what: `conduit run status --run ${runId}` },
        ).catch((err: Error) => {
          throw new Error(`${err.message}; last status: ${JSON.stringify(last)}; listener stderr: ${stderr}`);
        });
      },
      JOURNEY_TIMEOUT_MS,
    );
  }
});
