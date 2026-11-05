#!/bin/sh
# run-all.sh - sandbox test gate (no TV needed): every suite of the kit against its sources and a BUILT Twitch NG IPK.
#   node build/build-app.mjs --repo <SmartTwitchWebOSTV checkout> --brand twitchng --out <dir>     (build first)
#   sh tests/run-all.sh <dir>/com.twitchng.tv_1.0.0_all.ipk [logDir]
# Needs: node >= 18 + playwright (Chromium; CHROMIUM=<path> to override), ar, tar, the test media (tests/testdata/ or
# STTV_TESTDATA, see tests/_paths.mjs). Prints one line per suite; exit 1 if any suite fails (exit code or a FAIL line).
set -u
K=$(cd "$(dirname "$0")/.." && pwd)
IPK=${1:?usage: sh tests/run-all.sh <twitchng.ipk> [logDir]}
case "$IPK" in /*) ;; *) IPK=$(pwd)/$IPK ;; esac
L=${2:-$(mktemp -d)}; mkdir -p "$L"
bad=0
run() {  # run <name> <cmd...>: suite passes when it exits 0 and prints no line starting with FAIL
  name=$1; shift
  ( cd "$K" && "$@" ) > "$L/$name.log" 2>&1; rc=$?
  p=$(grep -c '^ *PASS' "$L/$name.log"); f=$(grep -c '^ *FAIL' "$L/$name.log")
  if [ "$rc" -eq 0 ] && [ "$f" -eq 0 ]; then echo "ok    $name  ($p pass)"; else echo "FAIL  $name  (exit $rc, $p pass, $f fail; $L/$name.log)"; bad=1; fi
}
run hygiene    node tests/hygiene.mjs
run unit       node tests/unit.mjs
run service    node tests/service/run.mjs
run proxy      node tests/proxy/run.mjs
run v2bhook    node tests/v2bhook/run.mjs
run e2e-m59    node tests/e2e/run_m59.mjs
run v2b-direct node tests/e2e/run_v2b.mjs direct
run v2b-luna   node tests/e2e/run_v2b.mjs luna
run v2b-cors   node tests/e2e/run_v2b.mjs cors
run smoke      node tests/app/smoke.mjs "$IPK" "$L/w-smoke"
run vod        node tests/app/vod.mjs "$IPK" "$L/w-vod"
run twitchng   node tests/app/twitchng.mjs "$IPK" "$L/w-twitchng"
run cdp-cli    node tests/probe/cdp-cli.mjs "$IPK" "$L/w-cdp"
run leak       node tests/app/leak.mjs "$IPK" "$L/w-leak" --cycles 8
run deploy     sh tests/deploy/run.sh
echo "logs: $L"
exit $bad
