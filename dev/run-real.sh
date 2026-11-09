#!/bin/sh
# Boot the real dsh with this plugin mounted, against an isolated DSH_HOME.
#
#   ./dev/run-real.sh "hello, reply with just OK"
#
# This is the end-to-end check the harnesses cannot do: a real dsh process, a
# real session, a real model. It never touches ~/.dsh — it builds a throwaway
# DSH_HOME under the workspace with only dsh-base + dsh-headless, overlays this
# checkout's plugin, and uses the model route from dev/verify-profile/.
#
# Requirements:
#   - `dsh` on PATH
#   - a model credential for the route in dev/verify-profile/model.patch.yml
#     (by default: `export DEEPSEEK_API_KEY=...`)
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
HOME_DIR="$REPO/.dsh-verify-home"
PROFILE="$HOME_DIR/profiles/verify"
TASK=${1:-"hello, reply with just OK"}

mkdir -p "$PROFILE"
cp "$REPO/dev/verify-profile/package.json" "$PROFILE/package.json"
cp "$REPO/dev/verify-profile/cordis.yml" "$PROFILE/cordis.yml"
cp "$REPO/dev/verify-profile/model.patch.yml" "$PROFILE/model.patch.yml"

DSH_HOME="$HOME_DIR" exec dsh --profile verify \
  --patch "$PROFILE/model.patch.yml" \
  --patch "$REPO/dev/dev.insert.patch.yml" \
  "$TASK"
