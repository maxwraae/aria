#!/bin/bash
# test-slice2.sh — ARIA Slice 2 end-to-end integration test (server + surface)
# Covers: Surface build, engine serving static files, SPA fallback,
#          API alongside surface, POST message, WebSocket tree_snapshot,
#          nudge after POST, and graceful shutdown.

cd "$(dirname "$0")"

PASS=0
FAIL=0
TOTAL=0
ENGINE_PID=""
DB="$HOME/.aria/objectives.db"
SURFACE_DIR="$HOME/aria/surface"

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

# ══════════════════════════════════════════════════════════════════
# Category A: Surface Build
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category A: Surface Build"
echo "────────────────────────────"

echo "Building surface..."
(cd "$SURFACE_DIR" && npm run build > /dev/null 2>&1)
BUILD_EXIT=$?
assert_eq "$BUILD_EXIT" "0" "T1a: npm run build in ~/aria/surface exits 0"

if [[ -f "$SURFACE_DIR/dist/index.html" ]]; then
  pass "T1b: dist/index.html exists after build"
else
  fail "T1b: dist/index.html exists after build"
  echo "Surface build did not produce dist/index.html — aborting."
  exit 1
fi

# ── Engine start ─────────────────────────────────────────────────
echo ""
echo "Preparing clean environment..."
rm -f "$DB"

echo "Starting engine..."
npx tsx src/cli/index.ts engine > /dev/null 2>&1 &
ENGINE_PID=$!

# Wait for port 8080 (max 15s, poll every 0.5s)
echo "Waiting for server..."
for i in $(seq 1 30); do
  if curl -s http://localhost:8080/api/objectives > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# ══════════════════════════════════════════════════════════════════
# Category B: Engine Startup & Surface Serving
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category B: Engine Startup & Surface Serving"
echo "─────────────────────────────────────────────"

# T2: Engine starts and port 8080 opens
STARTUP_RESP=$(curl -s http://localhost:8080/api/objectives)
if [[ -n "$STARTUP_RESP" ]]; then
  pass "T2: Engine starts and port 8080 opens within 15s"
else
  fail "T2: Engine starts and port 8080 opens within 15s (no response)"
fi

# T3: GET / returns HTML (surface is served)
ROOT_RESP=$(curl -s http://localhost:8080/)
ROOT_STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/)
assert_eq "$ROOT_STATUS" "200" "T3a: GET / returns HTTP 200"
assert_contains "$ROOT_RESP" "<html" "T3b: GET / response contains HTML"

# ══════════════════════════════════════════════════════════════════
# Category C: SPA Fallback
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category C: SPA Fallback"
echo "────────────────────────────"

# T4: GET /some/random/path returns index.html (not a 404)
SPA_STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/some/random/path)
SPA_BODY=$(curl -s http://localhost:8080/some/random/path)
assert_eq "$SPA_STATUS" "200" "T4a: GET /some/random/path returns 200 (SPA fallback)"
assert_contains "$SPA_BODY" "<html" "T4b: SPA fallback response contains HTML (not 404 JSON)"
assert_not_contains "$SPA_BODY" '"error"' "T4c: SPA fallback response is not a JSON error"

# ══════════════════════════════════════════════════════════════════
# Category D: API Works Alongside Surface
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category D: API Works Alongside Surface"
echo "────────────────────────────────────────"

# T5: GET /api/objectives returns JSON array with root
TREE=$(curl -s http://localhost:8080/api/objectives)
TREE_LEN=$(echo "$TREE" | python3 -c "import sys,json; arr=json.load(sys.stdin); print(len(arr))" 2>/dev/null)
assert_gt "$TREE_LEN" "0" "T5a: GET /api/objectives returns a non-empty JSON array"
TREE_HAS_ROOT=$(echo "$TREE" | python3 -c "import sys,json; arr=json.load(sys.stdin); print('YES' if any(o['id']=='root' for o in arr) else 'NO')" 2>/dev/null)
assert_eq "$TREE_HAS_ROOT" "YES" "T5b: GET /api/objectives result contains the root objective"

# ══════════════════════════════════════════════════════════════════
# Category E: POST Message
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category E: POST Message"
echo "────────────────────────────"

# T6: POST /api/objectives/root/message returns 201
POST_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8080/api/objectives/root/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"slice2 integration test message"}')
assert_eq "$POST_STATUS" "201" "T6: POST /api/objectives/root/message returns 201"

# T7: Posted message appears in conversation
CONV=$(curl -s http://localhost:8080/api/objectives/root/conversation)
assert_contains "$CONV" "slice2 integration test message" "T7: Posted message appears in GET /api/objectives/root/conversation"

# ══════════════════════════════════════════════════════════════════
# Category F: WebSocket
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category F: WebSocket"
echo "────────────────────────────────"

# T8: WebSocket connects and receives tree_snapshot within 2s
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
assert_eq "$WS_RESULT" "OK" "T8: WebSocket receives tree_snapshot on connect"

# T9: After POST message, WebSocket receives updated tree_snapshot within 2s (nudge works)
# Wait 1s to ensure updated_at (Unix seconds) differs from prior POSTs
sleep 1
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
        const postData = JSON.stringify({ message: 'nudge test slice2' });
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
assert_eq "$WS_NUDGE" "OK" "T9: WebSocket receives updated tree_snapshot after POST message (nudge works)"

# ══════════════════════════════════════════════════════════════════
# Category G: Graceful Shutdown
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category G: Graceful Shutdown"
echo "────────────────────────────────"

# T10: Engine process exits cleanly on SIGINT (must be last test)
kill -INT "$ENGINE_PID" 2>/dev/null
sleep 1
if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
  pass "T10: Engine process exits cleanly on SIGINT"
  ENGINE_PID=""  # Already gone, prevent double-kill in cleanup
else
  fail "T10: Engine process exits cleanly on SIGINT (still running after 1s)"
fi

# ══════════════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed (of $TOTAL)"
echo "════════════════════════════════════════"
echo ""
echo "For remote access: tailscale serve --bg 8080"
echo ""

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
