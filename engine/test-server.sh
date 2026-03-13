#!/bin/bash
# test-server.sh — ARIA server API + WebSocket validation suite
# Covers: Server startup, REST API (objectives, messages, search),
#          WebSocket (tree_snapshot, nudge), CORS headers, and graceful shutdown.

cd "$(dirname "$0")"

PASS=0
FAIL=0
TOTAL=0
ENGINE_PID=""
DB="$HOME/.aria/objectives.db"

pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✓ PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ✗ FAIL: $1"; }

assert_eq()           { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 (got: '$1', expected: '$2')"; }
assert_contains()     { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 (missing: '$2')"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3 (found: '$2')"; }
assert_gt()           { [[ "$1" -gt "$2" ]] 2>/dev/null && pass "$3" || fail "$3 (got: '$1', expected > '$2')"; }

cleanup() {
  if [[ -n "$ENGINE_PID" ]]; then
    kill "$ENGINE_PID" 2>/dev/null
    wait "$ENGINE_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

# ── Build & Start ────────────────────────────────────────────────
echo ""
echo "Building engine..."
npm run build > /dev/null 2>&1
if [[ $? -ne 0 ]]; then
  echo "Build failed!"
  exit 1
fi

echo "Preparing clean environment..."
rm -f "$DB"

echo "Starting engine..."
node dist/cli/index.js engine > /dev/null 2>&1 &
ENGINE_PID=$!

# Wait for port 8080 (max 10s, poll every 0.5s)
echo "Waiting for server..."
for i in $(seq 1 20); do
  if curl -s http://localhost:8080/api/objectives > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# ══════════════════════════════════════════════════════════════════
# Category A: Server Startup
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category A: Server Startup"
echo "────────────────────────────"

# T1: Engine starts and port 8080 opens within 10s
STARTUP_RESP=$(curl -s http://localhost:8080/api/objectives)
if [[ -n "$STARTUP_RESP" ]]; then
  pass "T1: Engine starts and port 8080 opens within 10s"
else
  fail "T1: Engine starts and port 8080 opens within 10s (no response)"
fi

# ══════════════════════════════════════════════════════════════════
# Category B: REST API - Objectives
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category B: REST API - Objectives"
echo "────────────────────────────────────"

# T2: GET /api/objectives returns JSON array containing root
TREE=$(curl -s http://localhost:8080/api/objectives)
TREE_LEN=$(echo "$TREE" | python3 -c "import sys,json; arr=json.load(sys.stdin); print(len(arr))" 2>/dev/null)
assert_gt "$TREE_LEN" "0" "T2a: GET /api/objectives returns a non-empty JSON array"
TREE_HAS_ROOT=$(echo "$TREE" | python3 -c "import sys,json; arr=json.load(sys.stdin); print('YES' if any(o['id']=='root' for o in arr) else 'NO')" 2>/dev/null)
assert_eq "$TREE_HAS_ROOT" "YES" "T2b: GET /api/objectives result contains the root objective"

# T3: GET /api/objectives/root returns object with id "root"
OBJ=$(curl -s http://localhost:8080/api/objectives/root)
OBJ_ID=$(echo "$OBJ" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
assert_eq "$OBJ_ID" "root" "T3a: GET /api/objectives/root returns object with id 'root'"
OBJ_HAS_CHILDREN=$(echo "$OBJ" | python3 -c "import sys,json; d=json.load(sys.stdin); print('YES' if 'children' in d else 'NO')" 2>/dev/null)
assert_eq "$OBJ_HAS_CHILDREN" "YES" "T3b: GET /api/objectives/root includes a children array"

# T4: GET /api/objectives/root/conversation returns JSON array
CONV=$(curl -s http://localhost:8080/api/objectives/root/conversation)
CONV_IS_LIST=$(echo "$CONV" | python3 -c "import sys,json; arr=json.load(sys.stdin); print('YES' if isinstance(arr, list) else 'NO')" 2>/dev/null)
assert_eq "$CONV_IS_LIST" "YES" "T4: GET /api/objectives/root/conversation returns a JSON array"

# T5: GET /api/objectives/nonexistent returns 404
STATUS5=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/objectives/nonexistent)
assert_eq "$STATUS5" "404" "T5: GET /api/objectives/nonexistent returns 404"

# ══════════════════════════════════════════════════════════════════
# Category C: REST API - Messages
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category C: REST API - Messages"
echo "────────────────────────────────"

# T6: POST /api/objectives/root/message returns 201 with message id
POST_RESPONSE=$(curl -s -X POST http://localhost:8080/api/objectives/root/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"test message from server test"}')
POST_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8080/api/objectives/root/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"test message from server test 2"}')
assert_eq "$POST_STATUS" "201" "T6a: POST /api/objectives/root/message returns 201"
POST_HAS_ID=$(echo "$POST_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('YES' if 'id' in d else 'NO')" 2>/dev/null)
assert_eq "$POST_HAS_ID" "YES" "T6b: POST /api/objectives/root/message response includes 'id' field"

# T7: Posted message appears in conversation
CONV7=$(curl -s http://localhost:8080/api/objectives/root/conversation)
assert_contains "$CONV7" "test message from server test" "T7: Posted message appears in GET /api/objectives/root/conversation"

# T8: POST without message body returns 400
STATUS8=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8080/api/objectives/root/message \
  -H 'Content-Type: application/json' \
  -d '{}')
assert_eq "$STATUS8" "400" "T8: POST /api/objectives/root/message without message body returns 400"

# T9: POST /api/message — no match creates new objective
RESP9=$(curl -s -w '\n%{http_code}' -X POST http://localhost:8080/api/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"unique zebra migration patterns"}')
STATUS9=$(echo "$RESP9" | tail -1)
BODY9=$(echo "$RESP9" | sed '$d')
ROUTED9=$(echo "$BODY9" | python3 -c "import sys,json; d=json.load(sys.stdin); print('YES' if d.get('routed') and d.get('created') else 'NO')" 2>/dev/null)
assert_eq "$STATUS9" "201" "T9a: POST /api/message with no match returns 201"
assert_eq "$ROUTED9" "YES" "T9b: POST /api/message with no match returns routed=true, created=true"
OBJ9_ID=$(echo "$BODY9" | python3 -c "import sys,json; print(json.load(sys.stdin).get('objectiveId',''))" 2>/dev/null)
assert_gt "${#OBJ9_ID}" "0" "T9c: POST /api/message returns an objectiveId for the new objective"

# T9d: POST /api/message — routes to matching objective
# Send message matching the objective we just created
RESP9D=$(curl -s -X POST http://localhost:8080/api/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"zebra migration"}')
ROUTED9D=$(echo "$RESP9D" | python3 -c "import sys,json; d=json.load(sys.stdin); print('YES' if d.get('routed') else 'NO')" 2>/dev/null)
assert_eq "$ROUTED9D" "YES" "T9d: POST /api/message routes to matching objective"

# T9e: POST /api/message without message body returns 400
STATUS9E=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8080/api/message \
  -H 'Content-Type: application/json' \
  -d '{}')
assert_eq "$STATUS9E" "400" "T9e: POST /api/message without message body returns 400"

# ══════════════════════════════════════════════════════════════════
# Category D: REST API - Search
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category D: REST API - Search"
echo "────────────────────────────────"

# T10: GET /api/search?q=thrive returns results containing root
RESULTS10=$(curl -s 'http://localhost:8080/api/search?q=thrive')
assert_contains "$RESULTS10" "root" "T10a: GET /api/search?q=thrive returns results containing root id"
assert_contains "$RESULTS10" "thrive" "T10b: GET /api/search?q=thrive response contains the search term"

# T11: GET /api/search without q returns 400
STATUS11=$(curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8080/api/search')
assert_eq "$STATUS11" "400" "T11: GET /api/search without q parameter returns 400"

# ══════════════════════════════════════════════════════════════════
# Category E: WebSocket
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category E: WebSocket"
echo "────────────────────────────────"

# T12: WebSocket connects and receives tree_snapshot within 2s
WS_RESULT=$(node -e "
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://localhost:8080/ws');
  const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 2000);
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'tree_snapshot' && Array.isArray(msg.tree) && msg.tree.length > 0) {
      console.log('OK');
      clearTimeout(timer);
      ws.close();
      process.exit(0);
    }
  });
  ws.on('error', () => { console.log('ERROR'); process.exit(1); });
" 2>/dev/null)
assert_eq "$WS_RESULT" "OK" "T12: WebSocket receives tree_snapshot on connect"

# T13: After POST message, WebSocket receives updated tree_snapshot within 4s
# The server polls tree every 500ms and emits when JSON changes.
# POSTing a message touches root's updated_at (Unix seconds), so we wait 1s
# to guarantee the timestamp differs from the prior POST in T6/T7.
sleep 1  # Ensure updated_at (Unix seconds) differs from prior POSTs
WS_NUDGE=$(node -e "
  const WebSocket = require('ws');
  const http = require('http');
  const ws = new WebSocket('ws://localhost:8080/ws');
  let gotInitial = false;
  const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 5000);
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'tree_snapshot') {
      if (!gotInitial) {
        gotInitial = true;
        // POST a message; this touches root's updated_at, changing the tree JSON
        const postData = JSON.stringify({ message: 'nudge test ws13' });
        const req = http.request('http://localhost:8080/api/objectives/root/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        });
        req.write(postData);
        req.end();
      } else {
        console.log('OK');
        clearTimeout(timer);
        ws.close();
        process.exit(0);
      }
    }
  });
  ws.on('error', () => { console.log('ERROR'); process.exit(1); });
" 2>/dev/null)
assert_eq "$WS_NUDGE" "OK" "T13: WebSocket receives updated tree_snapshot after POST message (nudge works)"

# ══════════════════════════════════════════════════════════════════
# Category F: CORS & Options
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category F: CORS & Options"
echo "────────────────────────────"

# T14: OPTIONS request returns 204 with CORS headers
STATUS14=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS http://localhost:8080/api/objectives)
assert_eq "$STATUS14" "204" "T14a: OPTIONS /api/objectives returns 204"
CORS14=$(curl -s -D- -o /dev/null -X OPTIONS http://localhost:8080/api/objectives | grep -i 'access-control-allow-origin')
assert_contains "$CORS14" "*" "T14b: OPTIONS response includes Access-Control-Allow-Origin: *"

# ══════════════════════════════════════════════════════════════════
# Category H: Worker Endpoints
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category H: Worker Endpoints"
echo "────────────────────────────"

# T16: GET /api/worker/objectives without machine param returns 400
STATUS16=$(curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8080/api/worker/objectives')
assert_eq "$STATUS16" "400" "T16: GET /api/worker/objectives without machine returns 400"

# T17: GET /api/worker/objectives?machine=macbook returns empty array when no matching work
WORKER17=$(curl -s 'http://localhost:8080/api/worker/objectives?machine=macbook')
WORKER17_LEN=$(echo "$WORKER17" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
assert_eq "$WORKER17_LEN" "0" "T17: Worker objectives returns empty array when no matching work"

# T18: Create objective with machine=macbook, send message, then worker endpoint returns it
WORKER_OBJ=$(curl -s -X POST http://localhost:8080/api/objectives \
  -H 'Content-Type: application/json' \
  -d '{"objective":"worker test task","parent":"root"}')
WORKER_OBJ_ID=$(echo "$WORKER_OBJ" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
# Set machine=macbook and insert message directly via DB to avoid engine nudge race
sqlite3 "$DB" "UPDATE objectives SET machine='macbook' WHERE id='$WORKER_OBJ_ID';"
WORKER_MSG_ID=$(python3 -c "import uuid; print(uuid.uuid4().hex[:12])")
WORKER_MSG_TS=$(python3 -c "import time; print(int(time.time()))")
sqlite3 "$DB" "INSERT INTO inbox (id, objective_id, message, sender, type, created_at) VALUES ('$WORKER_MSG_ID', '$WORKER_OBJ_ID', 'do this work on macbook', 'max', 'message', $WORKER_MSG_TS);"
WORKER18=$(curl -s 'http://localhost:8080/api/worker/objectives?machine=macbook')
WORKER18_LEN=$(echo "$WORKER18" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
assert_eq "$WORKER18_LEN" "1" "T18a: Worker endpoint returns 1 objective for machine=macbook"
WORKER18_HAS_CONTEXT=$(echo "$WORKER18" | python3 -c "import sys,json; items=json.load(sys.stdin); print('YES' if items[0].get('context') else 'NO')" 2>/dev/null)
assert_eq "$WORKER18_HAS_CONTEXT" "YES" "T18b: Worker endpoint includes assembled context"
WORKER18_HAS_MSGS=$(echo "$WORKER18" | python3 -c "import sys,json; items=json.load(sys.stdin); print('YES' if len(items[0].get('messages',[])) > 0 else 'NO')" 2>/dev/null)
assert_eq "$WORKER18_HAS_MSGS" "YES" "T18c: Worker endpoint includes unprocessed messages"

# T19: POST /api/worker/turns/:id/complete updates the objective
RESP19=$(curl -s -w '\n%{http_code}' -X POST "http://localhost:8080/api/worker/turns/$WORKER_OBJ_ID/complete" \
  -H 'Content-Type: application/json' \
  -d '{"result":"work completed successfully"}')
STATUS19=$(echo "$RESP19" | tail -1)
BODY19=$(echo "$RESP19" | sed '$d')
assert_eq "$STATUS19" "200" "T19a: POST /api/worker/turns/:id/complete returns 200"
OK19=$(echo "$BODY19" | python3 -c "import sys,json; print('YES' if json.load(sys.stdin).get('ok') else 'NO')" 2>/dev/null)
assert_eq "$OK19" "YES" "T19b: Worker complete returns {ok: true}"
# Verify objective status changed to needs-input
OBJ19_STATUS=$(sqlite3 "$DB" "SELECT status FROM objectives WHERE id='$WORKER_OBJ_ID';")
assert_eq "$OBJ19_STATUS" "needs-input" "T19c: Worker complete sets objective status to needs-input"
# Verify reply message was inserted
OBJ19_REPLY=$(sqlite3 "$DB" "SELECT COUNT(*) FROM inbox WHERE objective_id='$WORKER_OBJ_ID' AND type='reply';")
assert_gt "$OBJ19_REPLY" "0" "T19d: Worker complete inserts reply message in inbox"

# T20: POST /api/worker/turns/nonexistent/complete returns 404
STATUS20=$(curl -s -o /dev/null -w '%{http_code}' -X POST 'http://localhost:8080/api/worker/turns/nonexistent/complete' \
  -H 'Content-Type: application/json' \
  -d '{"result":"test"}')
assert_eq "$STATUS20" "404" "T20: Worker complete for nonexistent objective returns 404"

# T21: POST /api/worker/turns/:id/complete without result returns 400
STATUS21=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:8080/api/worker/turns/$WORKER_OBJ_ID/complete" \
  -H 'Content-Type: application/json' \
  -d '{}')
assert_eq "$STATUS21" "400" "T21: Worker complete without result returns 400"

# ══════════════════════════════════════════════════════════════════
# Category G: Graceful Shutdown
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category G: Graceful Shutdown"
echo "────────────────────────────────"

# T15: Engine process exits cleanly on SIGINT (must be last test)
kill -INT "$ENGINE_PID" 2>/dev/null
sleep 1
if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
  pass "T15: Engine process exits cleanly on SIGINT"
  ENGINE_PID=""  # Already gone, prevent double-kill in cleanup
else
  fail "T15: Engine process exits cleanly on SIGINT (still running after 1s)"
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
