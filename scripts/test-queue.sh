#!/bin/sh
# Run a command (a vitest run) when it is this caller's turn: first come, first served, at most
# SEMBLANCE_SLOTS (2) at a time on the whole machine. Several agents and sessions share this
# repository and one machine; many test runs at once have exhausted its memory, and a plain lock
# wakes a random waiter, so a short run can starve an older one for half an hour.
#
# Each caller takes a ticket (a file named by the time it arrived and its process id). While its
# ticket is among the oldest SEMBLANCE_SLOTS live ones, it tries the slots' locks in turn and runs
# under the first that is free. Slot 1 is /tmp/semblance-vitest.lock, the lock callers of plain
# lockf take, so they still count against it.
#
#   scripts/test-queue.sh npx vitest run --maxWorkers=4 test/foo.test.ts
#
# SEMBLANCE_QUEUE / SEMBLANCE_LOCK override the queue directory and lock path (tests of this script).

Q="${SEMBLANCE_QUEUE:-/tmp/semblance-vitest.queue}"
LOCK="${SEMBLANCE_LOCK:-/tmp/semblance-vitest.lock}"
SLOTS="${SEMBLANCE_SLOTS:-2}"
mkdir -p "$Q"
TICKET="$(python3 -c 'import time; print(time.time_ns())')-$$"
touch "$Q/$TICKET"
trap 'rm -f "$Q/$TICKET"' EXIT
trap 'rm -f "$Q/$TICKET"; exit 130' INT TERM HUP

announced=""
while :; do
  # Forget tickets whose callers are gone (killed, timed out).
  for f in "$Q"/*; do
    [ -e "$f" ] || continue
    kill -0 "${f##*-}" 2>/dev/null || rm -f "$f"
  done
  rank="$(ls "$Q" | sort | grep -n "^$TICKET\$" | cut -d: -f1)"
  if [ "$rank" -le "$SLOTS" ]; then
    i=1
    while [ "$i" -le "$SLOTS" ]; do
      lock="$LOCK"
      [ "$i" -gt 1 ] && lock="$LOCK.$i"
      # -t 0: take the slot only if it is free; 75 (EX_TEMPFAIL) means it is not.
      lockf -t 0 "$lock" "$@"
      status=$?
      [ "$status" -ne 75 ] && exit "$status"
      i=$((i + 1))
    done
  elif [ -z "$announced" ]; then
    echo "[test-queue] waiting: $((rank - SLOTS)) ahead" >&2
    announced=1
  fi
  sleep 2
done
