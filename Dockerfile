FROM oven/bun:1.3.11-slim

# Create a non-root system group and user for least-privilege execution.
# All container processes run as `conduit` — never as root.
RUN groupadd --system conduit && \
    useradd --system --gid conduit --no-create-home --shell /bin/false conduit

# Application working directory (repo root inside the container).
# Relative paths like `examples/branching/flow.yaml` resolve from here.
WORKDIR /app

# Install runtime dependencies before copying source — this layer is cached
# as long as package.json and bun.lock are unchanged, giving faster rebuilds.
COPY package.json bun.lock ./
# --omit=optional skips the Agent SDK's bundled platform binaries (about 460 MB). The
# agent-sdk adapter runs the `claude` on PATH, not the bundled one.
# It also skips @opentui/core's native renderer, which `conduit watch` needs. That
# one package is installed for this image's platform in a scratch directory and
# copied in, because installing it in /app re-resolves the whole tree and brings
# the skipped packages back. Its version must match the @opentui/core pin in
# package.json (a packaging test checks this). The scratch install sits outside the
# frozen-lockfile check, so the integrity bun records for the package is compared with
# the one in /app/bun.lock, and the build fails on a mismatch or an empty value.
RUN bun install --frozen-lockfile --production --omit=optional && \
    pkg="@opentui/core-linux-$(uname -m | sed -e s/x86_64/x64/ -e s/aarch64/arm64/)" && \
    mkdir /tmp/opentui && cd /tmp/opentui && \
    bun add "${pkg}@0.5.12" && \
    want="$(grep -F "\"${pkg}\": [" /app/bun.lock | grep -o 'sha512-[A-Za-z0-9+/=]*' | head -n 1)" && \
    got="$(grep -F "\"${pkg}\": [" bun.lock | grep -o 'sha512-[A-Za-z0-9+/=]*' | head -n 1)" && \
    test -n "$want" && test -n "$got" && test "$want" = "$got" && \
    cp -r "node_modules/${pkg}" /app/node_modules/@opentui/ && \
    cd /app && rm -rf /tmp/opentui

# Copy the source tree. .dockerignore excludes .env, .git, node_modules, and
# local sqlite state files so no secret or local state enters any image layer.
COPY . .

# Create the /data mount point for conduit.sqlite (DEFAULT_STATE_DB in main.ts)
# and grant write access to the non-root user so the state-db probe and
# database-open succeed when a volume is mounted at runtime.
RUN mkdir -p /data && chown conduit:conduit /data

# Set CONDUIT_PROJECT_ROOT to an empty string so the project-root-present probe
# treats the engine image as a no-op (no flow baked in). Per-flow images override
# this with ENV CONDUIT_PROJECT_ROOT=/flow once the flow directory is COPYed in.
ENV CONDUIT_PROJECT_ROOT=

# Drop privileges — the application requires no root capabilities at runtime.
USER conduit

# Execute the TypeScript entry via Bun directly — no ahead-of-time build step.
# Arguments are forwarded verbatim: `docker run <img> doctor` == `conduit doctor`.
ENTRYPOINT ["bun", "src/cli/main.ts"]
