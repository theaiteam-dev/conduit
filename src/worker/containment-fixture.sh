#!/bin/sh
# Stand-in binary for the containment conformance suite
# (./harness-containment.conformance.ts). It takes the place of `claude`,
# `codex`, or a deterministic station's command, ignores its arguments, and
# writes only into its working directory, which every spawn path under test
# sets to the test's project root.
#
# It starts two long-lived grandchildren, then blocks until killed. It prints
# nothing, so the invocation can only end at its timeout.
#
# - The plain grandchild is backgrounded with `( ... ) &`, so it stays in the
#   fixture's session and process group. It touches `containment.sentinel`
#   every 100ms and its pid is recorded in `containment.pid`.
# - The setsid grandchild is started with `setsid -f`, so it runs in a new
#   session and process group, the way Claude Code's Bash tool runs every
#   command (issue #77). A group kill cannot reach it. It touches
#   `containment.setsid.sentinel` every 100ms and records its own pid in
#   `containment.setsid.pid`.
#
# Exit mode: `containment-fixture.sh --exit <code>` waits until both
# grandchildren have touched their sentinels once, then exits with <code>
# instead of blocking. The suite uses it for the normal-exit and nonzero-exit
# scenarios, where the invocation ends on its own and the grandchildren must
# still not outlive it. Only spawn paths that pass the suite's `fixtureArgs`
# through use this mode.
#
# The grandchildren's stdio goes to /dev/null so they do not hold the spawn
# path's stdout/stderr pipes open. A path that fails to reap them then returns
# at its timeout and fails the suite's assertions, instead of hanging.

# The harness runner hands the child a scrubbed env with no PATH.
PATH="/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"
export PATH

(
  while :; do
    touch containment.sentinel
    sleep 0.1
  done
) </dev/null >/dev/null 2>&1 &
echo "$!" > containment.pid

# `-f` forks unconditionally, so the loop always runs as a new session leader
# even if this shell happens to lead its own process group. The util-linux
# `setsid` binary is absent on macOS; the fixture then starts only the plain
# grandchild, and the suite, which requires the setsid one wherever it
# requires cgroup containment, fails on the missing pid file.
has_setsid=
if command -v setsid >/dev/null 2>&1; then
  has_setsid=1
  setsid -f sh -c '
    echo "$$" > containment.setsid.pid
    while :; do
      touch containment.setsid.sentinel
      sleep 0.1
    done
  ' </dev/null >/dev/null 2>&1
fi

if [ "$1" = "--exit" ]; then
  while [ ! -f containment.sentinel ] || { [ -n "$has_setsid" ] && [ ! -f containment.setsid.sentinel ]; }; do
    sleep 0.05
  done
  exit "${2:-0}"
fi
wait
