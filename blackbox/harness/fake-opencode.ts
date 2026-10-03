#!/usr/bin/env bun
/**
 * fake-opencode: a scenario-driven stand-in for `opencode serve`.
 *
 * The black-box opencode journeys point the shipped `opencode` adapter at this
 * script through engine config (`CONDUIT_HARNESS_OPENCODE_COMMAND`), so the
 * real `conduit run` spawns it exactly as it would spawn
 * `opencode serve --port 0 --hostname 127.0.0.1`. Nothing here is imported
 * from src/: the HTTP routes, the SSE event shapes and the listening line are
 * copied from the adapter (src/worker/harness-adapter-opencode.ts) and its
 * unit tests' in-process fake.
 *
 * As the server it binds 127.0.0.1 on a free port, prints the listening line
 * the adapter waits for, and checks HTTP Basic auth (`opencode` and the
 * OPENCODE_SERVER_PASSWORD it was started with) on every request, the event
 * stream included. A wrong password gets 401 and an `auth-rejected` log line.
 *
 * The scenario arrives through one allowlisted variable,
 * FAKE_OPENCODE_SCENARIO, in the same file shape as fake-claude's. When the
 * adapter posts the prompt, the fake picks the role whose `promptIncludes`
 * appears in it, bumps that role's counter file, and plays `calls[n]` over the
 * event stream: each step is a running tool part plus a `permission.asked`
 * (or a `question.asked`), and the fake waits for the adapter's answer before
 * the next step. A step's effect (running the bash command, writing the file)
 * happens only when the answer is `once`. Then it reports the message's token
 * usage and goes idle.
 *
 * Every line of the log carries fake-claude's FakeClaudeLogEntry fields (so
 * harness-flow's stubLog() and orphan reaper work) plus a `kind`: `serve` at
 * start, `prompt` when the prompt arrives, `answer` for every permission
 * reply, `question-reject`, `abort` and `auth-rejected`.
 *
 * Launched through a generated `#!/bin/sh` wrapper that execs the running bun
 * binary on this file (see harness-flow.ts).
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FakeClaudeLogEntry } from "./fake-claude";

/** One tool call the fake asks permission for. */
export type FakeOpenCodeStep =
  /** A bash tool part and a `bash` ask. On `once` the command runs under `sh -c` in the cwd. */
  | { type: "bash"; command: string; /** The ask's parsed sub-commands. Default: [command]. */ patterns?: string[] }
  /** A write tool part and an `edit` ask. On `once` the file is written. `path` is relative to the cwd. */
  | { type: "write"; path: string; content: string }
  /** A read tool part for an absolute path outside the project, and an `external_directory` ask. */
  | { type: "external_directory"; path: string }
  /** A `question.asked` event, answered by POST /question/:id/reject. */
  | { type: "question"; text: string };

/** One invocation's behaviour. */
export interface FakeOpenCodeCall {
  steps: FakeOpenCodeStep[];
  /** Token usage on the assistant message, reported after the last step. */
  tokens?: { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
  /** `cost` on the assistant message. Default 0.001. */
  cost?: number;
}

export interface FakeOpenCodeRole {
  name: string;
  /** Substring of the prompt text that selects this role. */
  promptIncludes: string;
  calls: FakeOpenCodeCall[];
}

export interface FakeOpenCodeScenario {
  stateDir: string;
  logPath: string;
  roles: FakeOpenCodeRole[];
}

export type FakeOpenCodeLogEntry = FakeClaudeLogEntry &
  (
    | { kind: "serve"; askAll: boolean }
    | { kind: "prompt" }
    | {
        kind: "answer";
        step: number;
        permission: string;
        callID: string;
        reply: string;
        message: string | null;
        /** Whether the step's effect ran (only on `once`). */
        performed: boolean;
      }
    | { kind: "question-reject"; step: number; callID: string }
    | { kind: "abort"; sessionID: string }
    | { kind: "auth-rejected"; method: string; path: string }
  );

type Json = Record<string, unknown>;

const SESSION_ID = "ses_fake_root";
const MESSAGE_ID = "msg_fake_1";
const enc = new TextEncoder();

/** Next 1-based call number for `role`, claimed with an exclusive create (as fake-claude does). */
function nextCallNumber(stateDir: string, role: string): number {
  mkdirSync(stateDir, { recursive: true });
  for (let n = 1; ; n++) {
    try {
      closeSync(openSync(join(stateDir, `${role}.${n}`), "wx"));
      return n;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const scenarioPath = process.env.FAKE_OPENCODE_SCENARIO;
  if (!scenarioPath) {
    process.stderr.write("fake-opencode: FAKE_OPENCODE_SCENARIO is not set (is it on the adapter env allowlist?)\n");
    process.exit(64);
  }
  if (argv[0] !== "serve") {
    process.stderr.write(`fake-opencode: only \`serve\` is implemented, got ${JSON.stringify(argv)}\n`);
    process.exit(64);
  }
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    process.stderr.write("fake-opencode: OPENCODE_SERVER_PASSWORD is not set\n");
    process.exit(64);
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as FakeOpenCodeScenario;
  const cwd = process.cwd();
  const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

  let role = "";
  let callNumber = 0;
  let prompt = "";
  let model: string | null = null;
  const log = (fields: Json): void => {
    const entry = { role, call: callNumber, argv, cwd, pid: process.pid, prompt, model, startedAt: Date.now(), ...fields };
    appendFileSync(scenario.logPath, JSON.stringify(entry) + "\n");
  };

  let askAll = false;
  try {
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}") as { permission?: Json };
    askAll = config.permission?.["*"] === "ask";
  } catch {
    /* askAll stays false, which the log reports */
  }
  log({ kind: "serve", askAll });

  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let eventNo = 0;
  const send = (type: string, properties: Json): void => {
    try {
      stream?.enqueue(enc.encode(`data: ${JSON.stringify({ id: `evt_${eventNo++}`, type, properties })}\n\n`));
    } catch {
      /* the adapter closed the stream */
    }
  };

  const part = (callID: string, tool: string, state: Json): void =>
    send("message.part.updated", {
      sessionID: SESSION_ID,
      part: { id: `prt_${callID}`, type: "tool", tool, callID, messageID: MESSAGE_ID, sessionID: SESSION_ID, state },
    });

  /** Answers the adapter has posted, by permission or question id. */
  const waiters = new Map<string, (body: Json) => void>();
  const answerOf = (id: string): Promise<Json> => new Promise((r) => waiters.set(id, r));

  const usageInfo = (call: FakeOpenCodeCall): Json => {
    const t = call.tokens ?? { input: 100, output: 50 };
    const reasoning = t.reasoning ?? 0;
    const cacheRead = t.cacheRead ?? 0;
    const cacheWrite = t.cacheWrite ?? 0;
    const [providerID, ...rest] = (model ?? "openai/gpt-fake").split("/");
    return {
      id: MESSAGE_ID,
      role: "assistant",
      sessionID: SESSION_ID,
      providerID,
      modelID: rest.join("/"),
      cost: call.cost ?? 0.001,
      tokens: {
        total: t.input + t.output + reasoning + cacheRead + cacheWrite,
        input: t.input,
        output: t.output,
        reasoning,
        cache: { read: cacheRead, write: cacheWrite },
      },
      time: { created: Date.now() },
    };
  };

  async function runStep(step: FakeOpenCodeStep, i: number, call: FakeOpenCodeCall): Promise<void> {
    const callID = `call_${i}`;
    const id = `per_${i}`;
    switch (step.type) {
      case "bash": {
        const input = { command: step.command, description: "run a command" };
        part(callID, "bash", { status: "running", input, time: { start: Date.now() } });
        const answer = answerOf(id);
        send("permission.asked", {
          id, sessionID: SESSION_ID, permission: "bash", patterns: step.patterns ?? [step.command],
          metadata: {}, always: [`${step.command.split(" ")[0]} *`], tool: { messageID: MESSAGE_ID, callID },
        });
        const body = await answer;
        let performed = false;
        if (body.reply === "once") {
          const proc = Bun.spawn(["sh", "-c", step.command], { cwd, stdout: "pipe", stderr: "pipe" });
          const [output, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
          performed = true;
          part(callID, "bash", { status: "completed", input, output, metadata: { exit }, title: step.command, time: { start: 0, end: 1 } });
        } else {
          part(callID, "bash", { status: "error", input, error: String(body.message ?? "rejected"), time: { start: 0, end: 1 } });
        }
        log({ kind: "answer", step: i, permission: "bash", callID, reply: body.reply, message: body.message ?? null, performed });
        return;
      }
      case "write": {
        const filePath = resolve(cwd, step.path);
        const input = { filePath, content: step.content };
        part(callID, "write", { status: "running", input, time: { start: Date.now() } });
        const answer = answerOf(id);
        send("permission.asked", {
          id, sessionID: SESSION_ID, permission: "edit", patterns: [step.path],
          metadata: { filepath: filePath, diff: "" }, always: ["*"], tool: { messageID: MESSAGE_ID, callID },
        });
        const body = await answer;
        let performed = false;
        if (body.reply === "once") {
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, step.content);
          performed = true;
          part(callID, "write", { status: "completed", input, output: "", metadata: {}, title: step.path, time: { start: 0, end: 1 } });
        } else {
          part(callID, "write", { status: "error", input, error: String(body.message ?? "rejected"), time: { start: 0, end: 1 } });
        }
        log({ kind: "answer", step: i, permission: "edit", callID, reply: body.reply, message: body.message ?? null, performed });
        return;
      }
      case "external_directory": {
        const input = { filePath: step.path };
        part(callID, "read", { status: "running", input, time: { start: Date.now() } });
        const answer = answerOf(id);
        const parentDir = dirname(step.path);
        send("permission.asked", {
          id, sessionID: SESSION_ID, permission: "external_directory", patterns: [`${parentDir}/*`],
          metadata: { filepath: step.path, parentDir }, always: [`${parentDir}/*`], tool: { messageID: MESSAGE_ID, callID },
        });
        const body = await answer;
        // The effect would be the read itself; the file is never opened here either way.
        const performed = body.reply === "once";
        part(callID, "read", performed
          ? { status: "completed", input, output: "", metadata: {}, title: step.path, time: { start: 0, end: 1 } }
          : { status: "error", input, error: String(body.message ?? "rejected"), time: { start: 0, end: 1 } });
        log({ kind: "answer", step: i, permission: "external_directory", callID, reply: body.reply, message: body.message ?? null, performed });
        return;
      }
      case "question": {
        const qid = `que_${i}`;
        const input = { questions: [{ question: step.text, options: [] }] };
        part(callID, "question", { status: "running", input, time: { start: Date.now() } });
        const answer = answerOf(qid);
        send("question.asked", {
          id: qid, sessionID: SESSION_ID, questions: input.questions, tool: { messageID: MESSAGE_ID, callID },
        });
        await answer;
        log({ kind: "question-reject", step: i, callID });
        part(callID, "question", { status: "error", input, error: "dismissed", time: { start: 0, end: 1 } });
        // The step in flight reports its tokens, which the adapter waits for before it aborts.
        send("message.updated", { sessionID: SESSION_ID, info: usageInfo(call) });
        return;
      }
    }
  }

  async function play(call: FakeOpenCodeCall): Promise<void> {
    send("session.status", { sessionID: SESSION_ID, status: { type: "busy" } });
    for (const [i, step] of call.steps.entries()) {
      await runStep(step, i, call);
      if (step.type === "question") return; // a held call is aborted by the adapter
    }
    send("message.updated", { sessionID: SESSION_ID, info: usageInfo(call) });
    send("session.status", { sessionID: SESSION_ID, status: { type: "idle" } });
    send("session.idle", { sessionID: SESSION_ID });
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== expectedAuth) {
        log({ kind: "auth-rejected", method: req.method, path: url.pathname });
        return new Response("unauthorized", { status: 401 });
      }
      const text = req.method === "POST" ? await req.text() : "";
      const body = (text === "" ? {} : JSON.parse(text)) as Json;

      if (req.method === "GET" && url.pathname === "/event") {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              stream = c;
              send("server.connected", {});
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (req.method === "POST" && url.pathname === "/session") {
        return Response.json({ id: SESSION_ID, title: String(body.title ?? "") });
      }
      if (req.method === "POST" && url.pathname === `/session/${SESSION_ID}/prompt_async`) {
        const m = body.model as { providerID?: string; modelID?: string } | undefined;
        model = m?.providerID !== undefined ? `${m.providerID}/${m.modelID}` : null;
        prompt = ((body.parts as Array<{ text?: string }> | undefined) ?? []).map((p) => p.text ?? "").join("\n");
        const matches = scenario.roles.filter((r) => prompt.includes(r.promptIncludes));
        if (matches.length !== 1) {
          process.stderr.write(`fake-opencode: the prompt matches ${matches.length} roles: ${prompt.slice(0, 200)}\n`);
          return new Response("no unique role", { status: 400 });
        }
        const chosen = matches[0]!;
        role = chosen.name;
        callNumber = nextCallNumber(scenario.stateDir, role);
        log({ kind: "prompt" });
        const call = chosen.calls[Math.min(callNumber, chosen.calls.length) - 1] ?? { steps: [] };
        setTimeout(() => void play(call), 0);
        return new Response(null, { status: 204 });
      }
      const reply = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname);
      if (req.method === "POST" && reply) {
        const wake = waiters.get(reply[1]!);
        waiters.delete(reply[1]!);
        if (wake === undefined) return new Response("unknown permission", { status: 404 });
        wake(body);
        return Response.json(true);
      }
      const question = /^\/question\/([^/]+)\/reject$/.exec(url.pathname);
      if (req.method === "POST" && question) {
        const wake = waiters.get(question[1]!);
        waiters.delete(question[1]!);
        if (wake === undefined) return new Response("unknown question", { status: 404 });
        wake({});
        return Response.json(true);
      }
      const abort = /^\/session\/([^/]+)\/abort$/.exec(url.pathname);
      if (req.method === "POST" && abort) {
        log({ kind: "abort", sessionID: abort[1]! });
        return Response.json(true);
      }
      // GET /session/:id/message/:mid and anything else: every tool part was already sent on the stream.
      return new Response("not found", { status: 404 });
    },
  });

  process.stdout.write(`opencode server listening on http://127.0.0.1:${server.port}\n`);
}

main();
