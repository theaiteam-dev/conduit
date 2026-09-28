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
#   `containment.setsid.sentinel` every 100ms, records its own session id
#   (field 6 of /proc/self/stat) in `containment.setsid.sid`, and then its
#   pid in `containment.setsid.pid`, so the pid file implies the session file.
#
# Exit mode: `containment-fixture.sh --exit <code>` waits until both
# grandchildren have touched their sentinels once, then exits with <code>
# instead of blocking. The suite uses it for the normal-exit and nonzero-exit
# scenarios, where the invocation ends on its own and the grandchildren must
# still not outlive it. Only spawn paths that pass the suite's `fixtureArgs`
# through use this mode.
#
# That wait is bounded to about 5 seconds. If a grandchild's sentinel never
# appears, most likely because `setsid -f sh -c ...` failed to launch the
# setsid grandchild, the fixture gives up rather than spinning until the
# invocation's own timeout, names the sentinel that never showed up on
# stderr, and exits 99, so a fixture-launch failure surfaces as its own
# error instead of a confusing timeout assertion failure.
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
    cut -d" " -f6 "/proc/$$/stat" > containment.setsid.sid 2>/dev/null
    echo "$$" > containment.setsid.pid
    while :; do
      touch containment.setsid.sentinel
      sleep 0.1
    done
  ' </dev/null >/dev/null 2>&1
fi

if [ "$1" = "--exit" ]; then
  # 100 iterations * 0.05s = ~5s. Bounded so a grandchild that never starts
  # (e.g. the setsid launch above failed) surfaces as a fixture error instead
  # of spinning until the invocation's own timeout.
  wait_iterations=0
  max_wait_iterations=100
  while [ ! -f containment.sentinel ] || { [ -n "$has_setsid" ] && [ ! -f containment.setsid.sentinel ]; }; do
    wait_iterations=$((wait_iterations + 1))
    if [ "$wait_iterations" -ge "$max_wait_iterations" ]; then
      if [ ! -f containment.sentinel ]; then
        echo "containment-fixture.sh: containment.sentinel never appeared (backgrounded grandchild failed to start)" >&2
      else
        echo "containment-fixture.sh: containment.setsid.sentinel never appeared (setsid grandchild failed to start)" >&2
      fi
      exit 99
    fi
    sleep 0.05
  done
  exit "${2:-0}"
fi
wait
