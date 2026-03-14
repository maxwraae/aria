#!/bin/bash
set -e

ARIA_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8080
PASS=0
FAIL=0
TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"

cleanup() {
  echo ""
  echo "── Cleanup ──"
  if [ -n "$ENGINE_PID" ]; then
    kill "$ENGINE_PID" 2>/dev/null && echo "Stopped engine (PID $ENGINE_PID)" || true
  fi
  echo ""
  echo "── Results: $PASS passed, $FAIL failed ──"
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
}
trap cleanup EXIT

check() {
  if eval "$2"; then
    echo "✓ $1"
    PASS=$((PASS + 1))
  else
    echo "✗ $1"
    FAIL=$((FAIL + 1))
  fi
}

echo "── Test: Aria Production Stack ──"
echo ""

# 1. Kill any existing process on 8080
echo "Clearing port $PORT..."
lsof -ti:$PORT | xargs kill -9 2>/dev/null || true
sleep 1

# 2. Start engine in background
echo "Starting aria up..."
cd "$ARIA_DIR"
aria up &
ENGINE_PID=$!
sleep 3

# 3. HTTP check — root returns 200
check "HTTP returns 200" \
  'curl -s -o /dev/null -w "%{http_code}" http://localhost:'"$PORT"' | grep -q 200'

# 4. API check — /api/objectives returns 200
check "API /api/objectives returns 200" \
  'curl -s -o /dev/null -w "%{http_code}" http://localhost:'"$PORT"'/api/objectives | grep -q 200'

# 5–6. WebSocket checks — requires websocat
if command -v websocat &>/dev/null; then
  # 5. WebSocket connects (ping — exit code 0 or 1 both acceptable; 124 = timeout = bad)
  check "WebSocket connects" \
    'echo "{\"type\":\"ping\"}" | timeout 3 websocat ws://localhost:'"$PORT"' 2>/dev/null; RC=$?; [ $RC -le 1 ]'

  # 6. TTS responds — send tts_request, expect tts_audio or tts_error back
  check "TTS responds to request" \
    'echo "{\"type\":\"tts_request\",\"text\":\"hello\",\"requestId\":\"test1\"}" | timeout 5 websocat ws://localhost:'"$PORT"' 2>/dev/null | head -1 | grep -q "tts_"'
else
  echo "⊘ websocat not installed — skipping WebSocket and TTS checks"
  echo "  Install with: brew install websocat"
fi

# 7. Tailscale HTTPS check
if [ -f "$TS" ]; then
  TS_URL=$("$TS" serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1)
  if [ -n "$TS_URL" ]; then
    check "Tailscale HTTPS returns 200" \
      "curl -s -o /dev/null -w '%{http_code}' '$TS_URL' | grep -q 200"
  else
    echo "⊘ Tailscale serve is not active — skipping HTTPS check"
    echo "  Enable with: tailscale serve https / http://localhost:$PORT"
  fi
else
  echo "⊘ Tailscale not installed — skipping HTTPS check"
fi
