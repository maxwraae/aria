#!/bin/bash
# test-startup.sh — ARIA startup commands, worker API, and basic engine flow validation
# Covers: aria dev, aria up, Worker API (GET/POST), Basic objective lifecycle

cd "$(dirname "$0")"

PASS=0
FAIL=0
TOTAL=0
DB="$HOME/.aria/objectives.db"
ENGINE_PID=""
DEV_PID=""
TEST_PREFIX="TEST_STARTUP"

pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✓ PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ✗ FAIL: $1"; }

assert_eq()           { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 (got: '$1', expected: '$2')"; }
assert_contains()     { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 (missing: '$2')"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3 (found: '$2')"; }
assert_gt()           { [[ "$1" -gt "$2" ]] 2>/dev/null && pass "$3" || fail "$3 (got: '$1', expected > '$2')"; }

# Wait for a port to be ready (max 15s, poll every 0.5s)
wait_for_port() {
  local port="$1"
  local label="${2:-port $1}"
  for i in $(seq 1 30); do
    if curl -s "http://localhost:${port}/" > /dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "  [warn] Timed out waiting for ${label}"
  return 1
}

# Wait for engine API to be ready on :8080
wait_for_engine() {
  for i in $(seq 1 30); do
    if curl -s http://localhost:8080/api/objectives > /dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "  [warn] Timed out waiting for engine on :8080"
  return 1
}

# Wait for Vite surface to be ready on :5173
wait_for_surface() {
  for i in $(seq 1 40); do
    if curl -s http://localhost:5173/ > /dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "  [warn] Timed out waiting for surface on :5173"
  return 1
}

cleanup() {
  # Kill engine if still running
  if [[ -n "$ENGINE_PID" ]]; then
    kill "$ENGINE_PID" 2>/dev/null
    wait "$ENGINE_PID" 2>/dev/null
  fi
  # Kill dev process if still running
  if [[ -n "$DEV_PID" ]]; then
    kill "$DEV_PID" 2>/dev/null
    wait "$DEV_PID" 2>/dev/null
  fi
  # Nuke anything still on these ports (belt + suspenders)
  lsof -ti:8080 | xargs kill -9 2>/dev/null
  lsof -ti:5173 | xargs kill -9 2>/dev/null
}
trap cleanup EXIT

# ── Build ─────────────────────────────────────────────────────────
echo ""
echo "Building engine..."
npm run build > /dev/null 2>&1
if [[ $? -ne 0 ]]; then
  echo "Build failed!"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Section 1: aria dev
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 1: aria dev"
echo "────────────────────────────────────"

# Kill any stale processes on our ports before starting
lsof -ti:8080 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null
sleep 0.5

echo "  Starting aria dev..."
aria dev > /tmp/aria-dev.log 2>&1 &
DEV_PID=$!

echo "  Waiting for engine (:8080)..."
wait_for_engine
ENGINE_UP=$?

echo "  Waiting for surface (:5173)..."
wait_for_surface
SURFACE_UP=$?

# S1-T1: Engine responds on :8080
S1_STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/objectives)
assert_eq "$S1_STATUS" "200" "S1-T1: aria dev — engine responds on :8080 (GET /api/objectives returns 200)"

# S1-T2: Surface responds on :5173
S1_SURF=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/)
assert_eq "$S1_SURF" "200" "S1-T2: aria dev — surface responds on :5173 (returns 200)"

# S1-T3: Vite proxies /api/* to engine
S1_PROXY=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/api/objectives)
assert_eq "$S1_PROXY" "200" "S1-T3: aria dev — API proxy through Vite works (GET :5173/api/objectives returns 200)"

# S1-T4: Kill with SIGINT — both processes die cleanly
echo "  Sending SIGINT to dev process..."
kill -INT "$DEV_PID" 2>/dev/null
sleep 3

ENGINE_GONE=0
SURFACE_GONE=0
if ! lsof -ti:8080 > /dev/null 2>&1; then
  ENGINE_GONE=1
fi
if ! lsof -ti:5173 > /dev/null 2>&1; then
  SURFACE_GONE=1
fi

if [[ $ENGINE_GONE -eq 1 ]]; then
  pass "S1-T4a: aria dev — engine process exits cleanly on SIGINT"
else
  fail "S1-T4a: aria dev — engine process exits cleanly on SIGINT (port :8080 still open)"
  lsof -ti:8080 | xargs kill -9 2>/dev/null
fi

if [[ $SURFACE_GONE -eq 1 ]]; then
  pass "S1-T4b: aria dev — surface process exits cleanly on SIGINT"
else
  fail "S1-T4b: aria dev — surface process exits cleanly on SIGINT (port :5173 still open)"
  lsof -ti:5173 | xargs kill -9 2>/dev/null
fi

DEV_PID=""
sleep 0.5

# ══════════════════════════════════════════════════════════════════
# Section 2: aria up
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 2: aria up"
echo "────────────────────────────────────"

echo "  Preparing clean environment..."
rm -f "$DB"

echo "  Starting aria up..."
aria up > /tmp/aria-up.log 2>&1 &
ENGINE_PID=$!

echo "  Waiting for engine (:8080)..."
wait_for_engine

# S2-T1: Engine responds on :8080
S2_API=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/objectives)
assert_eq "$S2_API" "200" "S2-T1: aria up — engine responds on :8080 (GET /api/objectives returns 200)"

# S2-T2: Static surface is served from :8080 (index.html)
S2_HTML=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/)
assert_eq "$S2_HTML" "200" "S2-T2a: aria up — GET / returns 200"
S2_BODY=$(curl -s http://localhost:8080/ | head -1)
assert_contains "$S2_BODY" "<!DOCTYPE html>" "S2-T2b: aria up — GET / returns HTML content"

# S2-T3: Kill cleanly
kill -INT "$ENGINE_PID" 2>/dev/null
sleep 2
if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
  pass "S2-T3: aria up — engine exits cleanly on SIGINT"
  ENGINE_PID=""
else
  fail "S2-T3: aria up — engine exits cleanly on SIGINT (still running after 2s)"
  kill -9 "$ENGINE_PID" 2>/dev/null
  ENGINE_PID=""
fi
sleep 0.5

# ══════════════════════════════════════════════════════════════════
# Section 3: Worker API
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 3: Worker API"
echo "────────────────────────────────────"

echo "  Preparing clean environment..."
rm -f "$DB"

echo "  Starting engine..."
aria engine > /tmp/aria-engine-worker.log 2>&1 &
ENGINE_PID=$!

echo "  Waiting for engine..."
wait_for_engine

# S3-T1: GET /api/worker/objectives?machine=macbook — returns 200
S3_STATUS=$(curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8080/api/worker/objectives?machine=macbook')
assert_eq "$S3_STATUS" "200" "S3-T1: GET /api/worker/objectives?machine=macbook returns 200"

# S3-T2: GET /api/worker/objectives (no machine param) — returns 400
S3_NO_MACHINE=$(curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8080/api/worker/objectives')
assert_eq "$S3_NO_MACHINE" "400" "S3-T2: GET /api/worker/objectives without machine returns 400"

# S3-T3: Create a test objective with machine=macbook via API
S3_CREATE=$(curl -s -X POST http://localhost:8080/api/objectives \
  -H 'Content-Type: application/json' \
  -d "{\"objective\":\"${TEST_PREFIX} worker test objective\",\"parent\":\"root\"}")
S3_OBJ_ID=$(echo "$S3_CREATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
assert_gt "${#S3_OBJ_ID}" "0" "S3-T3a: POST /api/objectives creates objective and returns id"

# Set machine=macbook on the objective
if [[ -n "$S3_OBJ_ID" ]]; then
  PATCH_RESP=$(curl -s -X PATCH "http://localhost:8080/api/objectives/${S3_OBJ_ID}" \
    -H 'Content-Type: application/json' \
    -d '{"machine":"macbook"}')
  PATCH_MACHINE=$(echo "$PATCH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('machine',''))" 2>/dev/null)
  assert_eq "$PATCH_MACHINE" "macbook" "S3-T3b: PATCH /api/objectives/:id sets machine=macbook"
fi

# Send a message to the objective to make it appear in worker queue
if [[ -n "$S3_OBJ_ID" ]]; then
  MSG_RESP=$(curl -s -X POST "http://localhost:8080/api/objectives/${S3_OBJ_ID}/message" \
    -H 'Content-Type: application/json' \
    -d '{"message":"do this work on macbook"}')
  MSG_ID=$(echo "$MSG_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  assert_gt "${#MSG_ID}" "0" "S3-T3c: POST /api/objectives/:id/message returns message id"
fi

# S3-T4: GET /api/worker/objectives?machine=macbook — test objective appears
S3_WORKER=$(curl -s 'http://localhost:8080/api/worker/objectives?machine=macbook')
S3_WORKER_LEN=$(echo "$S3_WORKER" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
assert_gt "$S3_WORKER_LEN" "0" "S3-T4a: Worker queue includes test objective after message is sent"

S3_HAS_MSGS=$(echo "$S3_WORKER" | python3 -c "
import sys,json
items=json.load(sys.stdin)
print('YES' if items and len(items[0].get('messages',[])) > 0 else 'NO')
" 2>/dev/null)
assert_eq "$S3_HAS_MSGS" "YES" "S3-T4b: Worker response includes unprocessed messages"

# S3-T5: POST /api/worker/turns/:turnId/complete — verify 200
TEST_TURN_ID="test-turn-${TEST_PREFIX}-$(date +%s)"
if [[ -n "$S3_OBJ_ID" ]]; then
  S3_COMPLETE_RESP=$(curl -s -w '\n%{http_code}' -X POST \
    "http://localhost:8080/api/worker/turns/${TEST_TURN_ID}/complete" \
    -H 'Content-Type: application/json' \
    -d "{\"objectiveId\":\"${S3_OBJ_ID}\",\"lastAssistantText\":\"I have completed the worker test task.\",\"status\":\"needs-input\"}")
  S3_COMPLETE_STATUS=$(echo "$S3_COMPLETE_RESP" | tail -1)
  S3_COMPLETE_BODY=$(echo "$S3_COMPLETE_RESP" | sed '$d')
  assert_eq "$S3_COMPLETE_STATUS" "200" "S3-T5a: POST /api/worker/turns/:turnId/complete returns 200"
  S3_COMPLETE_OK=$(echo "$S3_COMPLETE_BODY" | python3 -c "import sys,json; print('YES' if json.load(sys.stdin).get('ok') else 'NO')" 2>/dev/null)
  assert_eq "$S3_COMPLETE_OK" "YES" "S3-T5b: Worker complete returns {ok: true}"
fi

# S3-T6: POST /api/worker/turns/:turnId/complete without required fields — 400
S3_BAD_COMPLETE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "http://localhost:8080/api/worker/turns/some-turn-id/complete" \
  -H 'Content-Type: application/json' \
  -d '{"objectiveId":"root"}')
assert_eq "$S3_BAD_COMPLETE" "400" "S3-T6: Worker complete without lastAssistantText returns 400"

# S3-T7: Verify assistant response appears in objective's conversation
if [[ -n "$S3_OBJ_ID" ]]; then
  S3_CONV=$(curl -s "http://localhost:8080/api/objectives/${S3_OBJ_ID}/conversation")
  assert_contains "$S3_CONV" "I have completed the worker test task." \
    "S3-T7: Assistant response from worker complete appears in objective conversation"
fi

# Cleanup: succeed the test objective so it doesn't pollute further tests
if [[ -n "$S3_OBJ_ID" ]]; then
  curl -s -X POST "http://localhost:8080/api/objectives/${S3_OBJ_ID}/succeed" \
    -H 'Content-Type: application/json' \
    -d "{\"summary\":\"${TEST_PREFIX} worker test cleanup\"}" > /dev/null
fi

# ══════════════════════════════════════════════════════════════════
# Section 4: Basic engine flow
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 4: Basic engine flow"
echo "────────────────────────────────────"

# (Engine already running from Section 3)

# S4-T1: Create an objective via API
S4_CREATE=$(curl -s -X POST http://localhost:8080/api/objectives \
  -H 'Content-Type: application/json' \
  -d "{\"objective\":\"${TEST_PREFIX} basic flow test objective\",\"parent\":\"root\"}")
S4_STATUS_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8080/api/objectives \
  -H 'Content-Type: application/json' \
  -d "{\"objective\":\"${TEST_PREFIX} basic flow test objective 2\",\"parent\":\"root\"}")
assert_eq "$S4_STATUS_CODE" "201" "S4-T1a: POST /api/objectives returns 201"
S4_OBJ_ID=$(echo "$S4_CREATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
assert_gt "${#S4_OBJ_ID}" "0" "S4-T1b: POST /api/objectives returns id in response"

# S4-T2: Send a message to the objective
if [[ -n "$S4_OBJ_ID" ]]; then
  S4_MSG_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://localhost:8080/api/objectives/${S4_OBJ_ID}/message" \
    -H 'Content-Type: application/json' \
    -d '{"message":"Hello from test — please do nothing"}')
  assert_eq "$S4_MSG_CODE" "201" "S4-T2: POST /api/objectives/:id/message returns 201"
fi

# S4-T3: Objective appears in tree
S4_TREE=$(curl -s http://localhost:8080/api/objectives)
assert_contains "$S4_TREE" "${TEST_PREFIX} basic flow test objective" \
  "S4-T3: Created test objective appears in GET /api/objectives tree"

# S4-T4: Conversation has the message
if [[ -n "$S4_OBJ_ID" ]]; then
  S4_CONV=$(curl -s "http://localhost:8080/api/objectives/${S4_OBJ_ID}/conversation")
  assert_contains "$S4_CONV" "Hello from test" \
    "S4-T4: Sent message appears in GET /api/objectives/:id/conversation"
fi

# S4-T5: Succeed the objective via API
if [[ -n "$S4_OBJ_ID" ]]; then
  S4_SUCCEED=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://localhost:8080/api/objectives/${S4_OBJ_ID}/succeed" \
    -H 'Content-Type: application/json' \
    -d "{\"summary\":\"${TEST_PREFIX} completed successfully\"}")
  assert_eq "$S4_SUCCEED" "200" "S4-T5: POST /api/objectives/:id/succeed returns 200"
fi

# S4-T6: Resolved objective no longer appears in tree (tree excludes resolved)
S4_TREE_AFTER=$(curl -s http://localhost:8080/api/objectives)
# The tree endpoint returns active objectives only; resolved ones are excluded.
# We check by looking for the specific test objective id NOT being present.
if [[ -n "$S4_OBJ_ID" ]]; then
  S4_ID_IN_TREE=$(echo "$S4_TREE_AFTER" | python3 -c "
import sys,json
tree=json.load(sys.stdin)
ids=[o['id'] for o in tree]
print('YES' if '${S4_OBJ_ID}' in ids else 'NO')
" 2>/dev/null)
  assert_eq "$S4_ID_IN_TREE" "NO" \
    "S4-T6: Resolved objective no longer appears in GET /api/objectives tree"
fi

# Cleanup: kill engine
kill -INT "$ENGINE_PID" 2>/dev/null
sleep 2
if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
  ENGINE_PID=""
fi

# ══════════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed (of $TOTAL)"
echo "════════════════════════════════════════"
echo ""

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
