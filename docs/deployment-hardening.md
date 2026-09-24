# Deployment Hardening

How to run a Conduit engine so that a hostile input compromises as little as possible.
[`installation.md`](installation.md) is the *how to run it*; this is the *how to run it
safely*. It complements [`harness-containment.md`](harness-containment.md): that document
covers what the kernel can and cannot contain *inside* a station's tool loop; this one
covers the outer wall — the container, the user, and the host — which
[ADR-0003](../adr/0003-packaging-and-distribution.md) names as the real containment
boundary.

None of this requires special hardware or a dedicated box. Every rule below is achievable
on one shared machine; that is the point.

---

## Start from the honest threat model

A flow's ingress **is** untrusted input reaching code you run. A photo posted to a channel
travels through image parsers (PIL, HEIF decoders, OpenCV, ML runtimes) with a deep CVE
history — treat "a file arrived" as "arbitrary code may execute, as whatever user the
engine runs as." Message text is injection surface into anything that interpolates it —
prompts, YAML, shell, API calls. A private workspace shrinks the attacker set to "a member,
a guest, or a compromised member"; it does not shrink it to zero.

So the question that shapes everything below is not *"will the parser be exploited?"* but
*"when it is, what does the process it runs in reach?"* The answer should be: **an empty
account, an immutable filesystem, and an allowlisted network.**

---

## The rules

### 1. Run as a dedicated, locked service user — never your own account

Create a system account used for nothing else: `nologin` shell, locked password, its own
primary group and **no supplementary groups** (no `sudo`, no `docker`, no `adm`), home
`0700`. The account's defining property is that it is **empty**: no SSH keys, no API
tokens, no dotfiles, no credentials for anything. An RCE that lands in it finds nothing to
steal and nowhere to pivot.

Then *prove* the isolation, don't assume it — from the service account, attempt to read
the things that matter (your real home directory, key files, token files) and confirm
`Permission denied` on every one. Re-verify after system changes; group membership drifts.

The single most common deployment mistake is running the engine as your interactive user
"for now." Every credential in your home directory is then one image-parser CVE away from
an attacker. If the container work has to wait, even a bare `sudo -u <svcuser>` process is
the bulk of the win — the user switch is the security boundary; the container is the
better home for it.

### 2. Prefer rootless Podman over root Docker

The engine image already drops to a non-root user *inside* the container, but the runtime
around it matters just as much:

- **The `docker` group is root-equivalent.** Any account in it can
  `docker run -v /:/host …` and own the machine. Running the engine via a docker daemon
  means the account that manages it holds root in all but name.
- **Rootless Podman has no daemon and no privileged group.** Run it *as the service
  user* (subuid/subgid range + lingering so the unit survives logout/boot). The user
  namespace means even a container escape lands as the unprivileged service user, not
  root.
- **The mount namespace turns "unreadable" into "absent."** File permissions protect
  secrets that are on the filesystem; a container only *has* the paths you mount. Your
  home directory isn't merely `Permission denied` — it does not exist in the flow's world.

Quadlet `.container` units under the service user's systemd manager give you one
supervised process with restart policy — and structurally prevent the classic operational
failure of a second, forgotten listener started by hand.

### 3. The flow's code is read-only to the flow

Whatever executes must not be writable by the thing executing it. Two compliant shapes:

- **Baked-in** (`conduit build` per-flow images): the flow directory is a `COPY`d image
  layer — immutable by construction.
- **Mounted checkout** (engine image + external flow directory): mount it **`:ro`**, owned
  by root or the deploy user on the host — never by the service user.

Either way, a compromised run cannot rewrite its own `flow.yaml`, prompts, or scripts to
persist across the per-event fresh process. The **only writable path is the state volume**
(`/data`) — one named volume, nothing else.

Two constraints in the current engine affect this rule:

- With `defaults.workspace: per_run`, each run's workspace is created at
  `<project_root>/.conduit/runs/<run-id>/`, inside the flow directory. A `:ro` checkout
  therefore needs a writable volume mounted over `.conduit/runs` for each served flow, plus
  one for any other path the flow writes. Station `command`/`args` resolve relative to that
  workspace, so the runs root cannot simply be moved elsewhere
  ([#56](https://github.com/theaiteam-dev/conduit/issues/56),
  [#54](https://github.com/theaiteam-dev/conduit/issues/54)).
- Do not mount a flow checkout at `/app`. The engine image keeps the kernel source there,
  and a mount over it fails at startup with `Module not found "src/cli/main.ts"`. Use a
  path such as `/flows` ([#55](https://github.com/theaiteam-dev/conduit/issues/55)).

### 4. Pin images by immutable reference

Deploy `<image>:git-<sha>` (or a digest), never `:latest`, and never enable auto-update on
a floating tag. A version bump is a deliberate, reviewable act: change the pin in the
config that is your source of truth, redeploy, and "which engine vintage is running" stops
being a forensic question. This is an operational rule with a security payoff — an
unreproducible deployment is one you cannot reason about after an incident.

### 5. Publish no ports you don't serve

Socket-Mode ingress is outbound-only: the listener needs **zero** inbound ports, so a
Socket-Mode deployment should publish none (`PublishPort=`/`-p` absent entirely). Anything
the engine binds on `0.0.0.0` then stays inside the container network, unreachable from
the LAN. If you do run webhook ingress, publish exactly that one port and terminate it
behind a reverse proxy you already trust — nothing else.

`conduit listen` currently starts its HTTP ingress server on `0.0.0.0:3000` even when
every binding uses Socket Mode ([#44](https://github.com/theaiteam-dev/conduit/issues/44)).
In a container that port is harmless as long as it is not published. On a bare-metal
install it is reachable from the host's network, so block it with the host firewall.

### 6. Secrets are a runtime seam, not a file in the repo

The unit reads its environment from **one** injected source (an `EnvironmentFile=` or an
agent-templated equivalent) with allowlisted variable names — the same allowlist
discipline [`harness-containment.md`](harness-containment.md) applies to harness children.
Consequences:

- No secret in any git repo, image layer, or flow directory (`.dockerignore` already
  excludes `.env` from the engine image — keep it that way in per-flow images too).
- The env file lives outside the flow mount, owned root:servicegroup, mode `0640` or
  tighter.
- The *backend* that maintains the file (hand-placed, vault agent, secrets manager) is
  swappable behind the seam without touching the unit.

### 7. One credential domain per flow

Scope each flow's identity to exactly what it touches — and keep **effectful credentials
out of the ingress-facing container entirely**. The flow that receives untrusted input
should hold only what it needs to read and respond; the flow that writes to an external
system (publishes, charges, ships) runs as a **separate unit with a separate env file and
separate identity**, ideally provably unable to read the other's secrets. The two hand off
through the shared state volume — a selection file, a journal row — **never through a
shared secret.** Build this split *before* the first effectful integration goes live, not
after.

### 8. Bound untrusted input before the parsers

Cheap guards, in order, before bytes reach a decoder: mimetype allowlist → byte-size cap →
decoded-dimension ceiling (decompression bombs are a parser attack, not a bandwidth
problem). And when untrusted strings are written back into anything parseable — YAML,
JSON, shell, prompts — use a safe serializer (`yaml.safe_dump`, `json.dumps`), never
f-string interpolation, and length-cap free-text fields at ingress.

### 9. Default-deny egress

The mount namespace hides the filesystem; it does nothing to stop a popped container from
reaching the rest of your network. Add a host firewall rule (nftables or equivalent) that
default-denies egress from the container network and allowlists only what the flow
actually calls: the chat platform, the model endpoint, and — for the effectful container
only — its target API. Lateral movement from a compromised flow should be a firewall drop,
not a discovery.

### 10. Name the residual risk

No single-host deployment closes everything: a *root* compromise of the host still reaches
whatever the host can reach, and no container defends against it. Write down, in your
deployment's own docs, exactly what remains open and why it's accepted — a named residual
risk gets re-examined when circumstances change; a pretended-closed one gets rediscovered
during an incident.

---

## Checklist

| # | Rule | Verify with |
|---|------|-------------|
| 1 | Locked, empty service user; no extra groups | `id <svcuser>`; `sudo -u <svcuser> cat <your-secrets>` → denied |
| 2 | Rootless Podman, Quadlet-managed, lingering on | `podman info --format '{{.Host.Security.Rootless}}'`; `loginctl show-user <svcuser>` |
| 3 | Flow code baked-in or mounted `:ro`; only `/data` writable | inspect mounts; write-probe from inside the container |
| 4 | Image pinned by SHA/digest; no auto-update | unit file `Image=` line |
| 5 | No published ports (Socket Mode) | `podman port <ctr>` → empty; scan from another host |
| 6 | Secrets via one injected seam; none in repo/image | `podman image inspect` layers; git history |
| 7 | Effectful credentials in a separate unit/identity | ingress container env lacks them |
| 8 | Size/dimension caps + safe serializers at ingress | test with an oversized/hostile input |
| 9 | Default-deny container egress with allowlist | probe an unrelated host from inside the container |
| 10 | Residual risk written down | it's in your deployment docs |
