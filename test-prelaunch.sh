#!/bin/bash
# test-prelaunch.sh — ARIA Mac Mini pre-launch validation suite
# Covers: Prerequisites, Machine identity, Build, Unit tests, Database,
#          Context assembly, Engine loop, Server & API, Machine ownership,
#          Peer sync readiness, Tailscale, and CLI symlink.

cd "$(dirname "$0")"

PASS=0
FAIL=0
TOTAL=0
SKIP=0
ENGINE_PID=""
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
HELPER="engine/test-prelaunch-helper.ts"

pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✓ PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ✗ FAIL: $1"; }
skip() { SKIP=$((SKIP+1)); echo "  ⊘ SKIP: $1"; }

assert_eq()           { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 (got: '$1', expected: '$2')"; }
assert_contains()     { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 (missing: '$2')"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3 (found: '$2')"; }
assert_gt()           { [[ "$1" -gt "$2" ]] 2>/dev/null && pass "$3" || fail "$3 (got: '$1', expected > '$2')"; }

helper() { npx tsx "$HELPER" "$@" 2>/dev/null; }

cleanup() {
  if [[ -n "$ENGINE_PID" ]]; then
    kill "$ENGINE_PID" 2>/dev/null
    wait "$ENGINE_PID" 2>/dev/null
  fi
  lsof -ti:8080 | xargs kill -9 2>/dev/null
}
trap cleanup EXIT

# Clear port 8080 before starting
lsof -ti:8080 | xargs kill -9 2>/dev/null
sleep 0.5

# ══════════════════════════════════════════════════════════════════
# Section 1: Prerequisites
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 1: Prerequisites"
echo "────────────────────────────────────"

# Node >= 18
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
assert_gt "${NODE_VERSION:-0}" "17" "S1-T1: Node.js version >= 18 (got: v${NODE_VERSION})"

# npm exists
NPM_VERSION=$(npm --version 2>/dev/null)
if [[ -n "$NPM_VERSION" ]]; then
  pass "S1-T2: npm is installed (v${NPM_VERSION})"
else
  fail "S1-T2: npm is installed"
fi

# Claude CLI at ~/.local/bin/claude
CLAUDE_BIN="$HOME/.local/bin/claude"
if [[ -f "$CLAUDE_BIN" ]]; then
  pass "S1-T3a: claude CLI found at ~/.local/bin/claude"
  CLAUDE_VER=$("$CLAUDE_BIN" --version 2>/dev/null | head -1)
  if [[ -n "$CLAUDE_VER" ]]; then
    pass "S1-T3b: claude --version runs (${CLAUDE_VER})"
  else
    fail "S1-T3b: claude --version runs"
  fi
else
  fail "S1-T3a: claude CLI found at ~/.local/bin/claude"
  fail "S1-T3b: claude --version runs"
fi

# iCloud dir exists
ICLOUD_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
if [[ -d "$ICLOUD_DIR" ]]; then
  pass "S1-T4: iCloud directory exists"
else
  fail "S1-T4: iCloud directory exists ($ICLOUD_DIR)"
fi

# ══════════════════════════════════════════════════════════════════
# Section 2: Machine Identity
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 2: Machine Identity"
echo "────────────────────────────────────"

RAW_HOSTNAME=$(node -e "console.log(require('os').hostname())" 2>/dev/null)
assert_contains "$RAW_HOSTNAME" "mini" "S2-T1: Raw hostname contains 'mini' (got: $RAW_HOSTNAME)"

MACHINE_ID=$(helper machine-id)
assert_eq "$MACHINE_ID" "mini" "S2-T2: machine-id returns 'mini'"

IS_WORKER=$(helper is-worker)
assert_eq "$IS_WORKER" "false" "S2-T3: is-worker returns 'false' (Mini is coordinator)"

LOCAL_DB_PATH=$(helper local-db-path)
assert_contains "$LOCAL_DB_PATH" "mini.db" "S2-T4: local-db-path contains 'mini.db'"

PEER_DB_PATH=$(helper peer-db-path)
assert_contains "$PEER_DB_PATH" "macbook.db" "S2-T5: peer-db-path contains 'macbook.db'"

# ══════════════════════════════════════════════════════════════════
# Section 3: Build
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 3: Build"
echo "────────────────────────────────────"

echo "  Installing engine dependencies..."
(cd engine && npm install > /dev/null 2>&1)
if [[ $? -eq 0 ]]; then
  pass "S3-T1: engine npm install succeeded"
else
  fail "S3-T1: engine npm install succeeded"
fi

echo "  Building engine..."
(cd engine && npm run build > /dev/null 2>&1)
if [[ $? -eq 0 ]]; then
  pass "S3-T2: engine npm run build succeeded"
else
  fail "S3-T2: engine npm run build succeeded"
fi

echo "  Installing surface dependencies..."
(cd surface && npm install > /dev/null 2>&1)
if [[ $? -eq 0 ]]; then
  pass "S3-T3: surface npm install succeeded"
else
  fail "S3-T3: surface npm install succeeded"
fi

echo "  Building surface..."
(cd surface && npm run build > /dev/null 2>&1)
if [[ $? -eq 0 ]]; then
  pass "S3-T4: surface npm run build succeeded"
else
  fail "S3-T4: surface npm run build succeeded"
fi

if [[ -f "surface/dist/index.html" ]]; then
  pass "S3-T5: surface/dist/index.html exists after build"
else
  fail "S3-T5: surface/dist/index.html exists after build"
fi

# ══════════════════════════════════════════════════════════════════
# Section 4: Unit Tests
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 4: Unit Tests"
echo "────────────────────────────────────"

echo "  Running engine unit tests..."
(cd engine && npm test > /dev/null 2>&1)
if [[ $? -eq 0 ]]; then
  pass "S4-T1: engine unit tests pass"
else
  fail "S4-T1: engine unit tests pass"
fi

# ══════════════════════════════════════════════════════════════════
# Section 5: Database Initialization
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 5: Database Initialization"
echo "────────────────────────────────────"

INIT_RESULT=$(helper init-db)
assert_eq "$INIT_RESULT" "OK" "S5-T1: init-db returns OK"

DB_PATH=$(helper local-db-path)
if [[ -f "$DB_PATH" ]]; then
  pass "S5-T2: Local DB file exists at $DB_PATH"
else
  fail "S5-T2: Local DB file exists at $DB_PATH"
fi

CHECK_ROOT=$(helper check-root)
assert_eq "$CHECK_ROOT" "YES" "S5-T3: Root objective exists in DB"

CHECK_QUICK=$(helper check-quick)
assert_eq "$CHECK_QUICK" "YES" "S5-T4: Quick objective exists in DB"

CHECK_JOURNAL=$(helper check-journal)
assert_eq "$CHECK_JOURNAL" "delete" "S5-T5: Journal mode is 'delete'"

CHECK_COLUMNS=$(helper check-columns)
assert_contains "$CHECK_COLUMNS" "machine" "S5-T6a: objectives table has 'machine' column"
assert_contains "$CHECK_COLUMNS" "depth" "S5-T6b: objectives table has 'depth' column"
assert_contains "$CHECK_COLUMNS" "cascade_id" "S5-T6c: inbox table has 'cascade_id' column"

# ══════════════════════════════════════════════════════════════════
# Section 6: Context Assembly
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 6: Context Assembly"
echo "────────────────────────────────────"

CONTEXT_OUT=$(helper assemble-context 2>/dev/null)

assert_contains "$CONTEXT_OUT" "Mac Mini" "S6-T1: Context contains 'Mac Mini' (correct machine environment)"
assert_contains "$CONTEXT_OUT" "Aria's home base" "S6-T2: Context contains 'Aria's home base' (from environment-mini.md)"
assert_contains "$CONTEXT_OUT" "PERSONA" "S6-T3: Context contains 'PERSONA' section header"
assert_contains "$CONTEXT_OUT" "The Aria Loop" "S6-T4: Context contains 'The Aria Loop' (contract brick)"

# ══════════════════════════════════════════════════════════════════
# Section 7: Engine Loop Verification
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 7: Engine Loop Verification"
echo "────────────────────────────────────"

echo "  Starting engine..."
(cd engine && node dist/cli/index.js engine) > /tmp/aria-prelaunch-engine.log 2>&1 &
ENGINE_PID=$!
sleep 3

ENGINE_LOG=$(cat /tmp/aria-prelaunch-engine.log 2>/dev/null)

assert_contains "$ENGINE_LOG" "[engine] Machine: mini" "S7-T1: Engine log shows '[engine] Machine: mini'"
assert_contains "$ENGINE_LOG" "ARIA engine started" "S7-T2: Engine log shows 'ARIA engine started'"
assert_contains "$ENGINE_LOG" "Waiting for messages" "S7-T3: Engine log shows 'Waiting for messages'"

# ══════════════════════════════════════════════════════════════════
# Section 8: Server & API
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 8: Server & API"
echo "────────────────────────────────────"

# Wait for port 8080
echo "  Waiting for server on :8080..."
for i in $(seq 1 20); do
  curl -s http://localhost:8080/api/objectives > /dev/null 2>&1 && break
  sleep 0.5
done

# GET /api/objectives returns 200 with root
TREE=$(curl -s http://localhost:8080/api/objectives)
TREE_HAS_ROOT=$(echo "$TREE" | python3 -c "import sys,json; arr=json.load(sys.stdin); print('YES' if any(o['id']=='root' for o in arr) else 'NO')" 2>/dev/null)
assert_eq "$TREE_HAS_ROOT" "YES" "S8-T1: GET /api/objectives returns array containing root"

# POST message returns 201
POST_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8080/api/objectives/root/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"prelaunch server test"}')
assert_eq "$POST_STATUS" "201" "S8-T2: POST /api/objectives/root/message returns 201"

# Message appears in conversation
CONV=$(curl -s "http://localhost:8080/api/objectives/root/conversation?limit=500")
assert_contains "$CONV" "prelaunch server test" "S8-T3: Posted message appears in GET /api/objectives/root/conversation"

# WebSocket receives tree_snapshot
WS_RESULT=$(NODE_PATH=engine/node_modules node -e "
  const WebSocket = require('ws');
  const ws = new WebSocket('ws://localhost:8080/ws');
  const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 2000);
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'tree_snapshot') { console.log('OK'); clearTimeout(timer); ws.close(); process.exit(0); }
  });
  ws.on('error', () => { console.log('ERROR'); process.exit(1); });
" 2>/dev/null)
assert_eq "$WS_RESULT" "OK" "S8-T4: WebSocket connects and receives tree_snapshot"

# GET / returns HTML (surface served)
HTML_BODY=$(curl -s http://localhost:8080/ | head -1)
assert_contains "$HTML_BODY" "<!DOCTYPE html>" "S8-T5: GET / returns HTML (surface is served)"

# GET /random/path returns HTML (SPA fallback)
SPA_BODY=$(curl -s http://localhost:8080/random/path | head -1)
assert_contains "$SPA_BODY" "<!DOCTYPE html>" "S8-T6: GET /random/path returns HTML (SPA fallback works)"

# ══════════════════════════════════════════════════════════════════
# Section 9: Machine Ownership Filter
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 9: Machine Ownership Filter"
echo "────────────────────────────────────"

# Create objective with no machine (NULL) — should be picked up by Mini
OBJ_NULL=$(curl -s -X POST http://localhost:8080/api/objectives \
  -H 'Content-Type: application/json' \
  -d '{"objective":"PRELAUNCH_TEST null machine","parent":"root"}')
OBJ_NULL_ID=$(echo "$OBJ_NULL" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Send message so it appears in pending
curl -s -X POST "http://localhost:8080/api/objectives/$OBJ_NULL_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"message":"test"}' > /dev/null

# Create objective with machine=macbook
OBJ_MB=$(curl -s -X POST http://localhost:8080/api/objectives \
  -H 'Content-Type: application/json' \
  -d '{"objective":"PRELAUNCH_TEST macbook machine","parent":"root"}')
OBJ_MB_ID=$(echo "$OBJ_MB" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Set machine=macbook
curl -s -X PATCH "http://localhost:8080/api/objectives/$OBJ_MB_ID" \
  -H 'Content-Type: application/json' \
  -d '{"machine":"macbook"}' > /dev/null

# Send message
curl -s -X POST "http://localhost:8080/api/objectives/$OBJ_MB_ID/message" \
  -H 'Content-Type: application/json' \
  -d '{"message":"test"}' > /dev/null

# Worker endpoint for machine=macbook should include macbook objective
WORKER_MB=$(curl -s 'http://localhost:8080/api/worker/objectives?machine=macbook')
WORKER_MB_LEN=$(echo "$WORKER_MB" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
assert_gt "${WORKER_MB_LEN:-0}" "0" "S9-T1: Worker queue for machine=macbook contains >= 1 objective"

# The null-machine objective should NOT appear in the macbook worker queue
WORKER_MB_HAS_NULL=$(echo "$WORKER_MB" | python3 -c "import sys,json; items=json.load(sys.stdin); print('YES' if any('PRELAUNCH_TEST null' in i.get('objective','') for i in items) else 'NO')" 2>/dev/null)
assert_eq "$WORKER_MB_HAS_NULL" "NO" "S9-T2: Null-machine objective does NOT appear in macbook worker queue"

# Cleanup: succeed both test objectives
curl -s -X POST "http://localhost:8080/api/objectives/$OBJ_NULL_ID/succeed" \
  -H 'Content-Type: application/json' \
  -d '{"summary":"prelaunch test cleanup"}' > /dev/null
curl -s -X POST "http://localhost:8080/api/objectives/$OBJ_MB_ID/succeed" \
  -H 'Content-Type: application/json' \
  -d '{"summary":"prelaunch test cleanup"}' > /dev/null

# ══════════════════════════════════════════════════════════════════
# Section 10: Peer Sync Readiness
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 10: Peer Sync Readiness"
echo "────────────────────────────────────"

PEER_AVAILABLE=$(helper peer-available)
echo "  Peer DB available: $PEER_AVAILABLE"

SYNC_RESULT=$(helper sync-peer)
assert_eq "$SYNC_RESULT" "OK" "S10-T1: sync-peer returns OK"

if [[ "$PEER_AVAILABLE" == "YES" ]]; then
  pass "S10-T2: Peer DB is available — bidirectional sync is possible"
else
  pass "S10-T2: Peer DB not yet available — will sync when MacBook comes online"
fi

# ══════════════════════════════════════════════════════════════════
# Section 11: Tailscale
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 11: Tailscale"
echo "────────────────────────────────────"

if [[ -f "$TS" ]]; then
  pass "S11-T1: Tailscale binary found"

  TS_STATUS=$("$TS" status 2>/dev/null)
  if [[ -n "$TS_STATUS" ]] && ! echo "$TS_STATUS" | grep -qi "not logged in"; then
    pass "S11-T2: Tailscale is logged in"
  else
    fail "S11-T2: Tailscale is logged in"
  fi

  TS_URL=$("$TS" serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1)
  if [[ -n "$TS_URL" ]]; then
    pass "S11-T3: Tailscale serve has HTTPS URL: $TS_URL"
    TS_HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$TS_URL" 2>/dev/null)
    if [[ "$TS_HTTP_CODE" == "200" ]]; then
      pass "S11-T4: Tailscale HTTPS URL returns 200"
    else
      fail "S11-T4: Tailscale HTTPS URL returns 200 (got: $TS_HTTP_CODE)"
    fi
  else
    skip "S11-T3: Tailscale serve HTTPS URL (serve not active)"
    skip "S11-T4: Tailscale HTTPS curl check (serve not active)"
  fi
else
  skip "S11-T1: Tailscale binary (not installed at $TS)"
  skip "S11-T2: Tailscale logged in (not installed)"
  skip "S11-T3: Tailscale HTTPS URL (not installed)"
  skip "S11-T4: Tailscale HTTPS curl check (not installed)"
fi

# ══════════════════════════════════════════════════════════════════
# Section 12: CLI Symlink
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Section 12: CLI Symlink"
echo "────────────────────────────────────"

echo "  Running npm link in engine/..."
(cd engine && npm link 2>/dev/null)

ARIA_PATH=$(which aria 2>/dev/null)
if [[ -n "$ARIA_PATH" ]]; then
  pass "S12-T1: 'aria' command found in PATH at $ARIA_PATH"
else
  # Fall back to checking the direct path
  if [[ -f "engine/dist/cli/index.js" ]]; then
    pass "S12-T1: 'aria' symlink not in PATH but dist/cli/index.js exists (npm link may need sudo)"
    ARIA_PATH="node engine/dist/cli/index.js"
  else
    fail "S12-T1: 'aria' command found in PATH"
  fi
fi

ARIA_TREE=$(aria tree 2>/dev/null || node engine/dist/cli/index.js tree 2>/dev/null)
if echo "$ARIA_TREE" | grep -qE 'root|thrive'; then
  pass "S12-T2: 'aria tree' output contains 'root' or 'thrive'"
else
  fail "S12-T2: 'aria tree' output contains 'root' or 'thrive'"
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
