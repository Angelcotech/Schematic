#!/usr/bin/env bash
# End-to-end smoke test for claude-schematic.
#
# Runs against the currently-installed global `claude-schematic` — pair
# it with `npm i -g ./claude-schematic-<version>.tgz` to validate a pack
# before publish, or with `npm i -g claude-schematic@latest` to validate
# the published artifact.
#
# Fails loud at the first broken step. PASS lines go to stdout; FAIL
# lines abort the script with exit 1.
#
# Usage:
#   scripts/smoke.sh              # full suite
#   scripts/smoke.sh --quick      # skip the 10x race-fix repeat

set -euo pipefail

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

BASE="http://127.0.0.1:7777"
MCP_HDR='X-Schematic-Client: mcp'
JSON_HDR='Content-Type: application/json'

pass() { printf '  ✔ %s\n' "$1"; }
fail() { printf '  ✗ FAIL: %s\n' "$1" >&2; exit 1; }
section() { printf '\n=== %s ===\n' "$1"; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not installed; this smoke test needs it"
}
require curl
require jq
require schematic

# -----------------------------------------------------------------------------
section "(a) Fresh install boots the daemon"

schematic start >/dev/null 2>&1 || true
for i in 1 2 3 4 5; do
  if curl -sS "$BASE/status" >/dev/null 2>&1; then break; fi
  sleep 1
done
STATUS=$(curl -sS "$BASE/status" | jq -r '.ok // false')
[[ "$STATUS" == "true" ]] || fail "daemon /status did not return ok:true"
pass "daemon responding on $BASE"

# -----------------------------------------------------------------------------
section "Setup: ephemeral workspace + test canvas"

TMPREPO=$(mktemp -d)
(cd "$TMPREPO" && git init -q)
WS=$(curl -sS -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
  "$BASE/workspaces" -d "{\"path\":\"$TMPREPO\"}" | jq -r .id)
[[ -n "$WS" && "$WS" != "null" ]] || fail "could not create workspace for $TMPREPO"
pass "workspace: $WS"

CV=$(curl -sS -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
  "$BASE/workspaces/$WS/canvases" -d '{"name":"Smoke"}' | jq -r .canvas.id)
[[ -n "$CV" && "$CV" != "null" ]] || fail "could not create base canvas"
curl -sS -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
  "$BASE/workspaces/$WS/canvases/$CV/bulk" -d '{
    "nodes":[
      {"client_id":"a","file_path":"a.ts","x":0,"y":0,"process":"Core"},
      {"client_id":"b","file_path":"b.ts","x":200,"y":0,"process":"Core"},
      {"client_id":"c","file_path":"c.ts","x":400,"y":0}
    ],
    "edges":[{"src":"a","dst":"b","kind":"calls"},{"src":"b","dst":"c","kind":"reads"}]
  }' >/dev/null
pass "canvas populated with 3 nodes, 2 edges"

# -----------------------------------------------------------------------------
section "(b) Race fix: create+bulk appears without manual refresh"

race_once() {
  local name="$1"
  local new bulk_status
  new=$(curl -sS -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
    "$BASE/workspaces/$WS/canvases" -d "{\"name\":\"$name\"}" | jq -r .canvas.id)
  bulk_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
    "$BASE/workspaces/$WS/canvases/$new/bulk" \
    -d '{"nodes":[{"client_id":"x","file_path":"x.ts","x":10,"y":10}],"edges":[]}')
  [[ "$bulk_status" == "201" ]] || fail "bulk_populate failed with status $bulk_status"
  local n
  n=$(curl -sS "$BASE/workspaces/$WS/canvases/$new" | jq '.nodes | length')
  [[ "$n" == "1" ]] || fail "$name: expected 1 node on server, got $n"
}

if [[ "$QUICK" == "1" ]]; then
  race_once "RaceTest-1"
  pass "race-fix round-trip works (quick mode: 1 iter, server-side only)"
  printf '  (skip 10x repeat; visual browser check is user-driven — reload %s/?welcome after full mode)\n' "$BASE"
else
  for i in 1 2 3 4 5 6 7 8 9 10; do race_once "RaceTest-$i"; done
  pass "10x race-fix round-trip completed, all bulk_populate 201s"
  printf '  (browser auto-switch is user-verified: load %s and confirm RaceTest-10 shows x.ts without F5)\n' "$BASE"
fi

# -----------------------------------------------------------------------------
section "(c) move_process round-trip"

# (0,0) -> (100,50) for Core nodes; c.ts (no process) stays at (400,0)
RESULT=$(curl -sS -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
  "$BASE/workspaces/$WS/canvases/$CV/move_process" \
  -d '{"process_name":"Core","dx":100,"dy":50}')
MOVED=$(echo "$RESULT" | jq -r .nodes_moved)
[[ "$MOVED" == "2" ]] || fail "move_process moved $MOVED nodes, expected 2"
pass "moved 2 Core nodes"

A_X=$(curl -sS "$BASE/workspaces/$WS/canvases/$CV" | jq -r '.nodes[] | select(.file_path=="a.ts") | .x')
A_Y=$(curl -sS "$BASE/workspaces/$WS/canvases/$CV" | jq -r '.nodes[] | select(.file_path=="a.ts") | .y')
[[ "$A_X" == "100" && "$A_Y" == "50" ]] || fail "a.ts at ($A_X,$A_Y), expected (100,50)"
B_X=$(curl -sS "$BASE/workspaces/$WS/canvases/$CV" | jq -r '.nodes[] | select(.file_path=="b.ts") | .x')
[[ "$B_X" == "300" ]] || fail "b.ts.x=$B_X, expected 300"
C_X=$(curl -sS "$BASE/workspaces/$WS/canvases/$CV" | jq -r '.nodes[] | select(.file_path=="c.ts") | .x')
[[ "$C_X" == "400" ]] || fail "c.ts.x=$C_X, expected 400 (unchanged — no process)"
pass "positions: a.ts=(100,50), b.ts.x=300, c.ts.x=400 — unprocessed node untouched"

# Non-existent process → 404
GHOST=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
  "$BASE/workspaces/$WS/canvases/$CV/move_process" \
  -d '{"process_name":"Ghost","dx":10,"dy":10}')
[[ "$GHOST" == "404" ]] || fail "ghost process returned $GHOST, expected 404"
pass "non-existent process → 404 (no silent no-op)"

# Write guard: naked curl (no MCP header) → 403
GUARD=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "$JSON_HDR" \
  "$BASE/workspaces/$WS/canvases/$CV/move_process" \
  -d '{"process_name":"Core","dx":1,"dy":1}')
[[ "$GUARD" == "403" ]] || fail "write guard returned $GUARD, expected 403"
pass "write guard still enforced on move_process"

# -----------------------------------------------------------------------------
section "(d) auto_layout produces a valid canvas"

BEFORE=$(curl -sS "$BASE/workspaces/$WS/canvases/$CV" | jq -c '[.nodes[] | {id,x,y}] | sort_by(.id)')

AUTO=$(curl -sS -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
  "$BASE/workspaces/$WS/canvases/$CV/auto_layout" -d '{"direction":"LR"}')
LAID=$(echo "$AUTO" | jq -r .nodes_laid_out)
[[ "$LAID" == "3" ]] || fail "auto_layout laid out $LAID nodes, expected 3"
pass "auto_layout laid out all 3 nodes"

AFTER=$(curl -sS "$BASE/workspaces/$WS/canvases/$CV" | jq -c '[.nodes[] | {id,x,y}] | sort_by(.id)')
[[ "$BEFORE" != "$AFTER" ]] || fail "positions unchanged after auto_layout"
pass "positions changed from baseline"

ALL_FINITE=$(curl -sS "$BASE/workspaces/$WS/canvases/$CV" | \
  jq '[.nodes[] | (.x|type=="number") and (.y|type=="number")] | all')
[[ "$ALL_FINITE" == "true" ]] || fail "some nodes have non-numeric x or y after auto_layout"
pass "all coords finite numbers"

# Empty-canvas guard
EMPTY=$(curl -sS -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
  "$BASE/workspaces/$WS/canvases" -d '{"name":"SmokeEmpty"}' | jq -r .canvas.id)
EMPTY_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
  "$BASE/workspaces/$WS/canvases/$EMPTY/auto_layout" -d '{}')
[[ "$EMPTY_STATUS" == "400" ]] || fail "empty canvas returned $EMPTY_STATUS, expected 400"
pass "empty canvas → 400 (no silent no-op)"

# Bad direction
BAD_DIR=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "$MCP_HDR" -H "$JSON_HDR" \
  "$BASE/workspaces/$WS/canvases/$CV/auto_layout" -d '{"direction":"DIAGONAL"}')
[[ "$BAD_DIR" == "400" ]] || fail "invalid direction returned $BAD_DIR, expected 400"
pass "invalid direction → 400"

# -----------------------------------------------------------------------------
section "Cleanup"

curl -sS -X DELETE -H "$MCP_HDR" "$BASE/workspaces/$WS/canvases/$CV" >/dev/null
curl -sS -X DELETE -H "$MCP_HDR" "$BASE/workspaces/$WS/canvases/$EMPTY" >/dev/null
# Canvases created during the race-fix loop are left for the user to
# inspect visually; they'll be cleaned up when the workspace is removed.
curl -sS -X DELETE -H "$MCP_HDR" "$BASE/workspaces/$WS" >/dev/null || true
rm -rf "$TMPREPO"
pass "test canvases and workspace removed"

# -----------------------------------------------------------------------------
printf '\n'
printf 'ALL PASS — ready to publish.\n'
