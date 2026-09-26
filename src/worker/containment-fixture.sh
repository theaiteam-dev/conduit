#!/bin/sh
# Stand-in binary for the containment conformance suite
# (./harness-containment.conformance.ts). It takes the place of `claude`,
# `codex`, or a deterministic station's command, ignores its arguments, and
# writes only into its working directory, which every spawn path under test
# sets to the test's project root.
#
# It backgrounds a long-lived grandchild that touches `containment.sentinel`
# every 100ms, records that grandchild's pid in `containment.pid`, then blocks
# until killed. It prints nothing, so the invocation can only end at its
# timeout.
#
# Exit mode: `containment-fixture.sh --exit <code>` waits until the grandchild
# has touched the sentinel once, then exits with <code> instead of blocking.
# The suite uses it for the normal-exit and nonzero-exit scenarios, where the
# invocation ends on its own and the grandchild must still not outlive it.
# Only spawn paths that pass the suite's `fixtureArgs` through use this mode.
#
# The grandchild's stdio goes to /dev/null so it does not hold the spawn
# path's stdout/stderr pipes open. A path that fails to reap it then returns
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
if [ "$1" = "--exit" ]; then
  while [ ! -f containment.sentinel ]; do
    sleep 0.05
  done
  exit "${2:-0}"
fi
wait
