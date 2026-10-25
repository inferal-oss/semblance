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
#   scripts/test-queue.sh npx vitest run --maxWorkers=2 test/foo.test.ts
#
# A run holds its slot for at most SEMBLANCE_RUN_LIMIT seconds (default 1800, enough for the full
# suite with both slots busy): past that it and every process it started are stopped (exit 124), so
# a stuck run cannot hold a slot for the others. Each test also has its own limit (vite.config.ts).
#
# SEMBLANCE_QUEUE / SEMBLANCE_LOCK override the queue directory and lock path (tests of this script).

Q="${SEMBLANCE_QUEUE:-/tmp/semblance-vitest.queue}"
LOCK="${SEMBLANCE_LOCK:-/tmp/semblance-vitest.lock}"
SLOTS="${SEMBLANCE_SLOTS:-2}"
LIMIT="${SEMBLANCE_RUN_LIMIT:-1800}"
# Workers per run, at most: a whole-app test worker holds 1-2 GB, and two runs of four had the machine
# swapping (everything ten times slower). A larger --maxWorkers=N in the command is lowered to this.
WORKERS="${SEMBLANCE_MAX_WORKERS:-2}"
args=""
for a in "$@"; do
  case "$a" in
    --maxWorkers=*) n="${a#--maxWorkers=}"; [ "$n" -gt "$WORKERS" ] 2>/dev/null && a="--maxWorkers=$WORKERS" ;;
  esac
  args="$args$(printf '%s' "$a" | sed "s/'/'\\\\''/g; s/^/'/; s/\$/'/") "
done
eval "set -- $args"
mkdir -p "$Q"
TICKET="$(python3 -c 'import time; print(time.time_ns())')-$$"
touch "$Q/$TICKET"
STARTED="${TMPDIR:-/tmp}/semblance-vitest.started-$TICKET"
trap 'rm -f "$Q/$TICKET" "$STARTED"' EXIT
trap 'rm -f "$Q/$TICKET" "$STARTED"; exit 130' INT TERM HUP

announced=""
while :; do
  # Forget tickets whose callers are gone (killed, timed out). Ask ps, not kill -0: kill -0 also fails
  # with EPERM for a live caller this one may not signal (a sandboxed session), which dropped live
  # tickets and left their callers waiting forever.
  for f in "$Q"/*; do
    [ -e "$f" ] || continue
    ps -p "${f##*-}" >/dev/null 2>&1 || rm -f "$f"
  done
  # A ticket removed by someone else anyway comes back under its own name, so its place is kept.
  [ -e "$Q/$TICKET" ] || touch "$Q/$TICKET"
  rank="$(ls "$Q" | sort | grep -n "^$TICKET\$" | cut -d: -f1)"
  [ -n "$rank" ] || rank=999999
  if [ "$rank" -le "$SLOTS" ]; then
    i=1
    while [ "$i" -le "$SLOTS" ]; do
      lock="$LOCK"
      [ "$i" -gt 1 ] && lock="$LOCK.$i"
      # -t 0: take the slot only if it is free. lockf exits 75 (EX_TEMPFAIL) when it is not; the
      # marker tells that apart from a command that itself exits 75.
      rm -f "$STARTED"
      # The command runs in a process group of its own, so the limit stops all of it.
      lockf -s -t 0 "$lock" sh -c ': > "$0"; limit="$1"; shift
        exec perl -e '"'"'
          my $limit = shift; setpgrp(0, 0);
          my $pid = fork() // die; if (!$pid) { exec @ARGV or die "$ARGV[0]: $!\n" }
          local $SIG{ALRM} = sub {
            print STDERR "[test-queue] stopped: the run took more than $limit s\n";
            $SIG{TERM} = "IGNORE"; kill "TERM", -$$; sleep 5; kill "KILL", grep { $_ && $_ != $$ } split /\s+/, `pgrep -g $$`; exit 124 };
          alarm $limit; waitpid($pid, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)
        '"'"' "$limit" "$@"' "$STARTED" "$LIMIT" "$@"
      status=$?
      if [ "$status" -ne 75 ] || [ -e "$STARTED" ]; then rm -f "$STARTED"; exit "$status"; fi
      i=$((i + 1))
    done
  elif [ -z "$announced" ]; then
    echo "[test-queue] waiting: $((rank - SLOTS)) ahead" >&2
    announced=1
  fi
  sleep 2
done
