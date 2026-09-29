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
RUN bun install --frozen-lockfile --production --omit=optional

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
