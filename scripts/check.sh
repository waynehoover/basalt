#!/usr/bin/env bash
#
# Everything CI runs, run here, in one command.
#
# This exists because of a shipped regression. `bun run test` is one of nine
# checks CI runs, and the stress suite is a separate command and a separate
# job. A release went out on a green `bun run test` while `bun run stress` had
# been failing the whole time, on this machine, catching exactly the bug that
# shipped. "The tests pass" was true and meant less than it sounded.
#
# So: one command, and a guard below that fails when CI grows a step this
# script does not know about. The two cannot drift, because drifting is itself
# a failure.
#
# Exit 0 means every check CI runs passed here. Nothing else means that. A
# check that could not run locally is a failure too, not a footnote, because
# the whole lesson is that a partial pass reads exactly like a complete one.
# Pass --skip-docker to accept that one deliberately.
set -uo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)
skip_docker=0
[ "${1:-}" = "--skip-docker" ] && skip_docker=1

pass=0 fail=0 skipped=0
failed_names=()
skipped_names=()

# Each entry is a CI step name, so the guard can compare against the workflow.
run() { # run <ci step name> <working dir> <command...>
  local name=$1 dir=$2; shift 2
  printf '\n\033[1m==> %s\033[0m (%s)\n' "$name" "${dir:-.}"
  if ( cd "$root/${dir:-.}" && "$@" ); then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); failed_names+=("$name")
  fi
}

skip() { # skip <ci step name> <why>
  printf '\n\033[1m==> %s\033[0m SKIPPED: %s\n' "$1" "$2"
  skipped=$((skipped + 1)); skipped_names+=("$1")
}

gofmt_clean() {
  local out; out=$(gofmt -l .)
  [ -z "$out" ] || { echo "not gofmt'd:"; echo "$out"; return 1; }
}

# ---- server ----------------------------------------------------------------
run "gofmt" server gofmt_clean
run "vet" server go vet ./...
run "test" server go test -race ./...
run "the systemd unit verifies" server go test -race -run 'TestService' ./cmd/basaltd/

# ---- the compose pin -------------------------------------------------------
run "the pinned image is not behind the newest server release" "" \
  bash "$root/scripts/pin-check.sh"

# ---- the restore rehearsal -------------------------------------------------
#
# Behind a build tag, so it is not one of the six hundred tests above that a
# -run filter can skip without saying so, and run here for the same reason the
# stress suite is: a recovery path tested only in docs is a rumour, and the
# runbook it executes is the one nobody finds out is wrong until the day the
# live directory is gone.
run "the backup restores, verifies and serves what it held" server \
  go test -tags rehearsal -run TestRestoreRehearsal -count=1 ./cmd/basaltd/

# ---- client ----------------------------------------------------------------
run "install" client bun install --frozen-lockfile
run "format" client bun run format:check
run "typecheck" client bun run typecheck
run "test" client bun run test
run "compression golden, under bun" client bun run src/core/compression-golden.run.ts
run "build" client bun run build

# The one that was missed. Its own command, its own job, and not part of
# `bun run test`.
run "stress" client bun run stress

# ---- docker ----------------------------------------------------------------
if [ "$skip_docker" = 1 ]; then
  skip "build the image" "asked to"
  skip "it runs" "asked to"
  skip "the compose file is valid" "asked to"
elif ! docker info >/dev/null 2>&1; then
  skip "build the image" "no docker daemon"
  skip "it runs" "no docker daemon"
  skip "the compose file is valid" "no docker daemon"
else
  run "build the image" "" docker build -t basalt:ci .
  run "it runs" "" docker run --rm basalt:ci version
  run "the compose file is valid" "" docker compose -f compose.yaml config -q
fi

# ---- the guard: CI must not grow a step this script does not know about ----
#
# Matching on step names rather than on commands, because three CI steps are
# inline shell blocks and comparing those textually would break on whitespace.
printf '\n\033[1m==> every CI step is covered here\033[0m\n'
missing=()
while IFS= read -r name; do
  grep -qF "\"$name\"" "$root/scripts/check.sh" || missing+=("$name")
done < <(sed -n 's/^ *- name: *//p' "$root/.github/workflows/ci.yml")
if [ ${#missing[@]} -gt 0 ]; then
  echo "CI runs steps this script does not:"
  printf '  %s\n' "${missing[@]}"
  echo "Add them above, or this command means less than it says."
  fail=$((fail + 1)); failed_names+=("every CI step is covered here")
else
  echo "ok"
  pass=$((pass + 1))
fi

# ---- what actually happened ------------------------------------------------
printf '\n\033[1m%d passed, %d failed, %d skipped\033[0m\n' "$pass" "$fail" "$skipped"
[ ${#failed_names[@]} -eq 0 ] || printf 'failed:  %s\n' "$(IFS=', '; echo "${failed_names[*]}")"
[ ${#skipped_names[@]} -eq 0 ] || printf 'skipped: %s\n' "$(IFS=', '; echo "${skipped_names[*]}")"

if [ "$fail" -gt 0 ]; then exit 1; fi
if [ "$skipped" -gt 0 ]; then
  echo
  echo "Not everything CI runs ran here, so this is not a green run."
  exit 2
fi
echo
echo "Everything CI runs passed here."
