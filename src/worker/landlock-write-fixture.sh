#!/bin/sh
# Stand-in binary for the write-confinement conformance cases
# (./harness-containment.conformance.ts, issue #122). It takes the place of
# `claude`, `codex` or `opencode`, ignores its arguments, and tries the writes
# an overlapped call must not be able to make. Its working directory is the
# test's project root, laid out by the suite:
#
#   cards/a/         the call's own owned dir (writable)
#   cards/b/         a sibling's owned dir (not writable)
#   cards/a/link     a symlink to cards/b
#   shared.txt       a project file no card owns
#
# It records what happened in cards/a, which it may write:
#
#   own.txt          written first; proves the own dir is writable
#   env-writes.txt   one `NAME=ok|denied` line per run-scoped dir variable
#                    that is set (TMPDIR, the config dirs, the XDG dirs)
#   setsid.done      written by a setsid child after its own sibling write
#   fixture.done     written last
#
# and then exits 0. A spawn path that cannot speak its protocol then reports
# an error, which the suite ignores: it reads only the files.
#
# Outside such a layout (codex-app-server runs its binary with --version in a
# temp dir first), it exits at once.

PATH="/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"
export PATH

[ -d cards/a ] || exit 0

echo own > cards/a/own.txt
cp cards/a/own.txt cards/b/cp.txt 2>/dev/null
echo link > cards/a/link/link.txt 2>/dev/null
echo appended >> shared.txt 2>/dev/null
mv cards/a/own.txt cards/b/moved.txt 2>/dev/null && mv cards/b/moved.txt cards/a/own.txt 2>/dev/null

: > cards/a/env-writes.txt
for name in TMPDIR CLAUDE_CONFIG_DIR CODEX_HOME HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME; do
  eval "dir=\${$name:-}"
  [ -n "$dir" ] || continue
  if echo probe > "$dir/conduit-write-probe" 2>/dev/null; then
    rm -f "$dir/conduit-write-probe"
    echo "$name=ok" >> cards/a/env-writes.txt
  else
    echo "$name=denied" >> cards/a/env-writes.txt
  fi
done

if command -v setsid >/dev/null 2>&1; then
  setsid -f sh -c 'echo setsid > cards/b/setsid.txt 2>/dev/null; echo done > cards/a/setsid.done' </dev/null >/dev/null 2>&1
  i=0
  while [ ! -f cards/a/setsid.done ] && [ "$i" -lt 50 ]; do
    i=$((i + 1))
    sleep 0.05
  done
fi

echo done > cards/a/fixture.done
exit 0
