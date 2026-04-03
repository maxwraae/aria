#!/bin/bash
# test-sync.sh — ARIA worker-push sync validation suite
# Covers: POST /api/sync (objectives, inbox, turns), POST /api/stream,
#         FTS rebuild on sync, FK ordering, body size guard, worker surface skip.

cd "$(dirname "$0")"

PASS=0
FAIL=0
TOTAL=0
ENGINE_PID=""
PORT=8181
TEST_DB="/tmp/aria-test-sync.db"

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
rm -f "$TEST_DB"

echo "Starting engine on port $PORT..."
ARIA_DB="$TEST_DB" ARIA_MACHINE=mini node -e "
  const { initDb } = require('./dist/db/schema.js');
  const { startEngine } = require('./dist/engine/loop.js');
  const { startServer } = require('./dist/server/index.js');
  const db = initDb();
  const nudge = startEngine(db);
  startServer(db, null, $PORT, nudge);
" > /dev/null 2>&1 &
ENGINE_PID=$!

echo "Waiting for server..."
for i in $(seq 1 20); do
  if curl -s http://localhost:$PORT/api/objectives > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Verify server is up
STARTUP=$(curl -s http://localhost:$PORT/api/objectives)
if [[ -z "$STARTUP" ]]; then
  echo "Server failed to start!"
  exit 1
fi

TS=$(python3 -c "import time; print(int(time.time()))")

# ══════════════════════════════════════════════════════════════════
# Category A: POST /api/sync — Objectives
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category A: POST /api/sync — Objectives"
echo "────────────────────────────────────────"

# T1: Sync a new objective
SYNC_OBJ_ID="sync-test-obj-001"
RESP1=$(curl -s -w '\n%{http_code}' -X POST http://localhost:$PORT/api/sync \
  -H 'Content-Type: application/json' \
  -d "{\"objectives\": [{\"id\":\"$SYNC_OBJ_ID\",\"objective\":\"synced test objective\",\"description\":\"from worker\",\"parent\":\"root\",\"status\":\"idle\",\"waiting_on\":null,\"resolution_summary\":null,\"important\":0,\"urgent\":0,\"model\":\"sonnet\",\"cwd\":null,\"machine\":\"macbook\",\"depth\":1,\"fail_count\":0,\"created_at\":$TS,\"updated_at\":$TS,\"resolved_at\":null}]}")
STATUS1=$(echo "$RESP1" | tail -1)
BODY1=$(echo "$RESP1" | sed '$d')
assert_eq "$STATUS1" "200" "T1a: POST /api/sync returns 200"
assert_contains "$BODY1" "true" "T1b: POST /api/sync returns ok:true"

# T2: Synced objective is readable via API
OBJ2=$(curl -s "http://localhost:$PORT/api/objectives/$SYNC_OBJ_ID")
OBJ2_ID=$(echo "$OBJ2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
assert_eq "$OBJ2_ID" "$SYNC_OBJ_ID" "T2: Synced objective is readable via GET /api/objectives/:id"

# T3: Synced objective appears in FTS search
SEARCH3=$(curl -s "http://localhost:$PORT/api/search?q=synced+test+objective")
assert_contains "$SEARCH3" "$SYNC_OBJ_ID" "T3: Synced objective appears in FTS search"

# T4: Objective update with newer timestamp
TS_NEWER=$((TS + 10))
curl -s -X POST http://localhost:$PORT/api/sync \
  -H 'Content-Type: application/json' \
  -d "{\"objectives\": [{\"id\":\"$SYNC_OBJ_ID\",\"objective\":\"updated objective name\",\"description\":\"updated desc\",\"parent\":\"root\",\"status\":\"needs-input\",\"waiting_on\":null,\"resolution_summary\":null,\"important\":1,\"urgent\":0,\"model\":\"sonnet\",\"cwd\":null,\"machine\":\"macbook\",\"depth\":1,\"fail_count\":0,\"created_at\":$TS,\"updated_at\":$TS_NEWER,\"resolved_at\":null}]}" > /dev/null

OBJ4=$(curl -s "http://localhost:$PORT/api/objectives/$SYNC_OBJ_ID")
OBJ4_STATUS=$(echo "$OBJ4" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
OBJ4_NAME=$(echo "$OBJ4" | python3 -c "import sys,json; print(json.load(sys.stdin).get('objective',''))" 2>/dev/null)
assert_eq "$OBJ4_STATUS" "needs-input" "T4a: Newer sync updates objective status"
assert_eq "$OBJ4_NAME" "updated objective name" "T4b: Newer sync updates objective name"

# T5: Objective update with older timestamp is ignored
TS_OLDER=$((TS - 10))
curl -s -X POST http://localhost:$PORT/api/sync \
  -H 'Content-Type: application/json' \
  -d "{\"objectives\": [{\"id\":\"$SYNC_OBJ_ID\",\"objective\":\"should not appear\",\"description\":\"old\",\"parent\":\"root\",\"status\":\"idle\",\"waiting_on\":null,\"resolution_summary\":null,\"important\":0,\"urgent\":0,\"model\":\"sonnet\",\"cwd\":null,\"machine\":\"macbook\",\"depth\":1,\"fail_count\":0,\"created_at\":$TS,\"updated_at\":$TS_OLDER,\"resolved_at\":null}]}" > /dev/null

OBJ5=$(curl -s "http://localhost:$PORT/api/objectives/$SYNC_OBJ_ID")
OBJ5_NAME=$(echo "$OBJ5" | python3 -c "import sys,json; print(json.load(sys.stdin).get('objective',''))" 2>/dev/null)
assert_eq "$OBJ5_NAME" "updated objective name" "T5: Older sync does NOT overwrite newer data"

# T6: Duplicate objective INSERT is ignored (idempotent)
curl -s -X POST http://localhost:$PORT/api/sync \
  -H 'Content-Type: application/json' \
  -d "{\"objectives\": [{\"id\":\"$SYNC_OBJ_ID\",\"objective\":\"synced test objective\",\"description\":\"from worker\",\"parent\":\"root\",\"status\":\"idle\",\"waiting_on\":null,\"resolution_summary\":null,\"important\":0,\"urgent\":0,\"model\":\"sonnet\",\"cwd\":null,\"machine\":\"macbook\",\"depth\":1,\"fail_count\":0,\"created_at\":$TS,\"updated_at\":$TS,\"resolved_at\":null}]}" > /dev/null
STATUS6=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/objectives/$SYNC_OBJ_ID")
assert_eq "$STATUS6" "200" "T6: Duplicate sync does not error (idempotent)"

# ══════════════════════════════════════════════════════════════════
# Category B: POST /api/sync — Inbox
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category B: POST /api/sync — Inbox"
echo "────────────────────────────────────"

# T7: Sync an inbox message for the synced objective
SYNC_MSG_ID="sync-test-msg-001"
RESP7=$(curl -s -w '\n%{http_code}' -X POST http://localhost:$PORT/api/sync \
  -H 'Content-Type: application/json' \
  -d "{\"inbox\": [{\"id\":\"$SYNC_MSG_ID\",\"objective_id\":\"$SYNC_OBJ_ID\",\"sender\":\"max\",\"type\":\"message\",\"message\":\"hello from worker\",\"turn_id\":null,\"processed_by\":null,\"cascade_id\":null,\"created_at\":$TS}]}")
STATUS7=$(echo "$RESP7" | tail -1)
assert_eq "$STATUS7" "200" "T7a: POST /api/sync with inbox returns 200"

# T8: Synced message appears in conversation
CONV8=$(curl -s "http://localhost:$PORT/api/objectives/$SYNC_OBJ_ID/conversation")
assert_contains "$CONV8" "hello from worker" "T8: Synced inbox message appears in conversation"

# T9: Duplicate inbox message is ignored
curl -s -X POST http://localhost:$PORT/api/sync \
  -H 'Content-Type: application/json' \
  -d "{\"inbox\": [{\"id\":\"$SYNC_MSG_ID\",\"objective_id\":\"$SYNC_OBJ_ID\",\"sender\":\"max\",\"type\":\"message\",\"message\":\"hello from worker\",\"turn_id\":null,\"processed_by\":null,\"cascade_id\":null,\"created_at\":$TS}]}" > /dev/null
CONV9=$(curl -s "http://localhost:$PORT/api/objectives/$SYNC_OBJ_ID/conversation")
MSG_COUNT9=$(echo "$CONV9" | python3 -c "import sys,json; msgs=json.load(sys.stdin); print(sum(1 for m in msgs if m['id']=='$SYNC_MSG_ID'))" 2>/dev/null)
assert_eq "$MSG_COUNT9" "1" "T9: Duplicate inbox sync does not create duplicate message"

# ══════════════════════════════════════════════════════════════════
# Category C: POST /api/sync — Turns
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category C: POST /api/sync — Turns"
echo "────────────────────────────────────"

# T10: Sync a turn
SYNC_TURN_ID="sync-test-turn-001"
RESP10=$(curl -s -w '\n%{http_code}' -X POST http://localhost:$PORT/api/sync \
  -H 'Content-Type: application/json' \
  -d "{\"turns\": [{\"id\":\"$SYNC_TURN_ID\",\"objective_id\":\"$SYNC_OBJ_ID\",\"turn_number\":1,\"user_message\":null,\"session_id\":null,\"created_at\":$TS}]}")
STATUS10=$(echo "$RESP10" | tail -1)
assert_eq "$STATUS10" "200" "T10: POST /api/sync with turns returns 200"

# T11: Verify turn exists in DB
TURN_EXISTS=$(sqlite3 "$TEST_DB" "SELECT COUNT(*) FROM turns WHERE id='$SYNC_TURN_ID';")
assert_eq "$TURN_EXISTS" "1" "T11: Synced turn exists in database"

# ══════════════════════════════════════════════════════════════════
# Category D: POST /api/sync — FK ordering & mixed payload
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category D: POST /api/sync — Mixed payload"
echo "────────────────────────────────────────────"

# T12: Send objectives + inbox in one payload (objectives must be processed first)
MIXED_OBJ_ID="sync-mixed-obj-001"
MIXED_MSG_ID="sync-mixed-msg-001"
TS12=$((TS + 100))
RESP12=$(curl -s -w '\n%{http_code}' -X POST http://localhost:$PORT/api/sync \
  -H 'Content-Type: application/json' \
  -d "{\"objectives\": [{\"id\":\"$MIXED_OBJ_ID\",\"objective\":\"mixed payload test\",\"description\":null,\"parent\":\"root\",\"status\":\"idle\",\"waiting_on\":null,\"resolution_summary\":null,\"important\":0,\"urgent\":0,\"model\":\"sonnet\",\"cwd\":null,\"machine\":null,\"depth\":1,\"fail_count\":0,\"created_at\":$TS12,\"updated_at\":$TS12,\"resolved_at\":null}], \"inbox\": [{\"id\":\"$MIXED_MSG_ID\",\"objective_id\":\"$MIXED_OBJ_ID\",\"sender\":\"max\",\"type\":\"message\",\"message\":\"mixed payload msg\",\"turn_id\":null,\"processed_by\":null,\"cascade_id\":null,\"created_at\":$TS12}]}")
STATUS12=$(echo "$RESP12" | tail -1)
assert_eq "$STATUS12" "200" "T12a: Mixed payload sync returns 200"

# Verify both exist
OBJ12=$(curl -s "http://localhost:$PORT/api/objectives/$MIXED_OBJ_ID")
OBJ12_ID=$(echo "$OBJ12" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
assert_eq "$OBJ12_ID" "$MIXED_OBJ_ID" "T12b: Objective from mixed payload exists"
CONV12=$(curl -s "http://localhost:$PORT/api/objectives/$MIXED_OBJ_ID/conversation")
assert_contains "$CONV12" "mixed payload msg" "T12c: Inbox from mixed payload exists"

# ══════════════════════════════════════════════════════════════════
# Category E: POST /api/stream
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category E: POST /api/stream"
echo "────────────────────────────"

# T13: Stream endpoint returns 200
RESP13=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:$PORT/api/stream \
  -H 'Content-Type: application/json' \
  -d '{"objectiveId":"root","text":"hello streaming","done":false}')
assert_eq "$RESP13" "200" "T13: POST /api/stream returns 200"

# T14: Stream with done=true returns 200
RESP14=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:$PORT/api/stream \
  -H 'Content-Type: application/json' \
  -d '{"objectiveId":"root","text":"","done":true}')
assert_eq "$RESP14" "200" "T14: POST /api/stream with done=true returns 200"

# T15: WebSocket receives streamed text via /api/stream
WS_STREAM=$(node -e "
  const WebSocket = require('ws');
  const http = require('http');
  const ws = new WebSocket('ws://localhost:$PORT');
  let gotTreeSnapshot = false;
  const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 4000);
  ws.on('open', () => {
    // Subscribe to watch root objective's stream
    ws.send(JSON.stringify({ type: 'watch_objective', objectiveId: 'root' }));
  });
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'tree_snapshot') {
      if (!gotTreeSnapshot) {
        gotTreeSnapshot = true;
        // Now POST a stream delta via /api/stream
        setTimeout(() => {
          const postData = JSON.stringify({ objectiveId: 'root', text: 'ws-stream-test-token', done: true });
          const req = http.request('http://localhost:$PORT/api/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
          });
          req.write(postData);
          req.end();
        }, 200);
      }
    }
    if (msg.type === 'turn_stream' && msg.objectiveId === 'root') {
      console.log('OK');
      clearTimeout(timer);
      ws.close();
      process.exit(0);
    }
  });
  ws.on('error', (e) => { console.log('ERROR: ' + e.message); process.exit(1); });
" 2>/dev/null)
assert_eq "$WS_STREAM" "OK" "T15: WebSocket receives turn_stream from POST /api/stream"

# ══════════════════════════════════════════════════════════════════
# Category F: Edge cases
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category F: Edge cases"
echo "────────────────────────"

# T16: Empty sync payload returns 200
RESP16=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:$PORT/api/sync \
  -H 'Content-Type: application/json' \
  -d '{}')
assert_eq "$RESP16" "200" "T16: Empty sync payload returns 200"

# T17: Sync with empty arrays returns 200
RESP17=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:$PORT/api/sync \
  -H 'Content-Type: application/json' \
  -d '{"objectives":[],"inbox":[],"turns":[]}')
assert_eq "$RESP17" "200" "T17: Sync with empty arrays returns 200"

# ══════════════════════════════════════════════════════════════════
# Shutdown
# ══════════════════════════════════════════════════════════════════
kill -INT "$ENGINE_PID" 2>/dev/null
sleep 1
ENGINE_PID=""

echo ""
echo "════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed (of $TOTAL)"
echo "════════════════════════════════════════"
echo ""

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
