#!/bin/sh
# Build the Landlock write-confinement helper (native/llexec/llexec.c, issue
# #122) for local runs and the test suite. The engine image builds its own copy
# in the Dockerfile's llexec stage. Output: native/llexec/build/llexec, which
# src/worker/landlock-confinement.ts finds when CONDUIT_LLEXEC is unset.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/native/llexec/build"
mkdir -p "$out"
cc="${CC:-cc}"
"$cc" -static -O2 -Wall -Wextra -Werror -o "$out/llexec" "$root/native/llexec/llexec.c"
echo "built $out/llexec"
