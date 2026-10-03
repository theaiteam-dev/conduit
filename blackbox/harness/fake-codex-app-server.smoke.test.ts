/**
 * fake-codex-app-server: smoke test.
 *
 * Drives the fake directly over stdio, as a JSON-RPC client, so a journey
 * failure can be told apart from a broken fake: `--version` answers without a
 * scenario (the adapter's probe passes only PATH and HOME), and inside a turn
 * the fake performs a step's effect only when the client answers `accept`,
 * logging every decision it received.
 *
 * BLACK-BOX RULE: zero imports from src/.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeCodexLogEntry } from "./fake-codex-app-server";

const FAKE = join(import.meta.dir, "fake-codex-app-server.ts");

type Json = Record<string, any>;

describe("fake-codex-app-server", () => {
  const root = mkdtempSync(join(tmpdir(), "conduit-bb-fake-codex-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("--version prints a codex version with no scenario in the env", async () => {
    const proc = Bun.spawn([process.execPath, FAKE, "--version"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^codex-cli \d+\.\d+\.\d+$/);
  });

  test("an accepted write happens, a declined one does not, and both decisions are logged", async () => {
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    const logPath = join(root, "invocations.ndjson");
    const scenarioPath = join(root, "scenario.json");
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        stateDir: join(root, "counters"),
        logPath,
        roles: [
          {
            name: "maker",
            promptIncludes: "ROLE:MAKER",
            calls: [
              {
                steps: [
                  { label: "yes", write: { path: "a.txt", content: "a" } },
                  { label: "no", write: { path: "b.txt", content: "b" } },
                ],
                usage: { inputTokens: 10, outputTokens: 2 },
              },
            ],
          },
        ],
      }),
    );
    const proc = Bun.spawn([process.execPath, FAKE, "app-server"], {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_CODEX_SCENARIO: scenarioPath },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const write = (m: Json): void => {
      proc.stdin.write(JSON.stringify(m) + "\n");
      proc.stdin.flush();
    };

    // The client side of the protocol: the handshake, then accept the first approval and decline the rest.
    const received: Json[] = [];
    let approvals = 0;
    write({ method: "initialize", id: 1, params: {} });
    write({ method: "thread/start", id: 2, params: { model: "m" } });
    write({ method: "turn/start", id: 3, params: { threadId: "thr-fake-root", input: [{ type: "text", text: "ROLE:MAKER go" }] } });
    const decoder = new TextDecoder();
    let carry = "";
    outer: for await (const chunk of proc.stdout) {
      carry += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const m = JSON.parse(carry.slice(0, nl)) as Json;
        carry = carry.slice(nl + 1);
        received.push(m);
        if (m.method === "item/fileChange/requestApproval") {
          write({ id: m.id, result: { decision: approvals++ === 0 ? "accept" : "decline" } });
        }
        if (m.method === "turn/completed") break outer;
      }
    }
    proc.stdin.end();
    expect(await proc.exited).toBe(0);

    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(cwd, "b.txt"))).toBe(false);
    expect(received.find((m) => m.method === "thread/tokenUsage/updated")?.params.tokenUsage.total).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
    const log = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as FakeCodexLogEntry);
    expect(log).toHaveLength(1);
    expect(log[0]!.decisions.map((d) => [d.label, d.decision])).toEqual([
      ["yes", "accept"],
      ["no", "decline"],
    ]);
    expect(log[0]!.threadStart).toEqual({ model: "m" });
  });
});
