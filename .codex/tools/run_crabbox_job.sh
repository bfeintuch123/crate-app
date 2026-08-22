#!/bin/sh

set -eu

usage() {
  echo "usage: .codex/tools/run_crabbox_job.sh <quick-check|provenance-suite|figma-suite|package-parser-suite|full-nongui-suite>" >&2
  exit 2
}

test "$#" -eq 1 || usage
job=$1

case "$job" in
  quick-check|provenance-suite|figma-suite|package-parser-suite|full-nongui-suite)
    ;;
  *)
    usage
    ;;
esac

if test -n "${CRABBOX_BIN:-}"; then
  crabbox_bin=$CRABBOX_BIN
else
  crabbox_bin=$(command -v crabbox || true)
fi

if test -z "$crabbox_bin" || test ! -x "$crabbox_bin"; then
  echo "crabbox CLI is missing or not executable" >&2
  exit 2
fi

slug="crate-$(date -u +%Y%m%d%H%M%S)-$$"
cleanup_required=0

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if test "$cleanup_required" -eq 1; then
    "$crabbox_bin" stop "$slug" >&2 ||
      echo "warning: Crabbox lease cleanup requires manual verification: $slug" >&2
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cleanup_required=1
"$crabbox_bin" warmup --slug "$slug" --keep

# Crabbox v0.45.0 local Actions hydration invalidates the workspace fingerprint
# before creating a fresh workdir. A sync-only run creates the reviewed
# workspace; explicit hydration can then safely prepare it for the named job.
"$crabbox_bin" run --id "$slug" --sync-only
"$crabbox_bin" actions hydrate --id "$slug" --wait-timeout 30m
"$crabbox_bin" job run --id "$slug" --no-hydrate "$job"

"$crabbox_bin" stop "$slug"
cleanup_required=0
trap - EXIT HUP INT TERM
