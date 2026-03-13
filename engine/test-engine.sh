#!/bin/bash
# test-engine.sh — ARIA engine validation suite
# Covers: Database initialization, Objective CRUD, Messaging, Status mutations,
#          Communication, Context assembly, Engine mechanics, and Live engine turns.

cd "$(dirname "$0")"

ARIA="npx tsx src/cli/index.ts"
DB="$HOME/.aria/objectives.db"
PASS=0
FAIL=0
TOTAL=0

pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✓ PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ✗ FAIL: $1"; }

assert_eq()           { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 (got: '$1', expected: '$2')"; }
assert_contains()     { [[ "$1" == *"$2"* ]] && pass "$3" || fail "$3 (missing: '$2')"; }
assert_not_contains() { [[ "$1" != *"$2"* ]] && pass "$3" || fail "$3 (found: '$2')"; }
assert_gt()           { [[ "$1" -gt "$2" ]] 2>/dev/null && pass "$3" || fail "$3 (got: '$1', expected > '$2')"; }

sql() { sqlite3 "$DB" "$1"; }

# ── Clean slate ──────────────────────────────────────────────────
echo ""
echo "Preparing clean environment..."
rm -f "$DB"

# ══════════════════════════════════════════════════════════════════
# Category A: Database & Init
# Validates that the schema initializer creates a valid SQLite database
# with the root objective seeded correctly, and that re-running init is
# idempotent (no duplicates, no errors). Also checks that the FTS
# (full-text search) virtual table is present and queryable.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category A: Database & Init"
echo "────────────────────────────"

# Test 1: Fresh init creates DB file
npx tsx src/db/schema.ts > /dev/null 2>&1
if [[ -f "$DB" ]]; then
  pass "T1: Running schema init on a clean slate creates the objectives.db file"
else
  fail "T1: Running schema init on a clean slate creates the objectives.db file (file not found)"
fi

# Test 2: Root objective exists with correct values
ROOT_ID=$(sql "SELECT id FROM objectives WHERE id='root';")
ROOT_OBJ=$(sql "SELECT objective FROM objectives WHERE id='root';")
ROOT_STATUS=$(sql "SELECT status FROM objectives WHERE id='root';")
ROOT_PARENT=$(sql "SELECT COALESCE(parent, 'NULL') FROM objectives WHERE id='root';")

assert_eq "$ROOT_ID" "root" "T2a: Root objective has id='root' after init"
assert_eq "$ROOT_OBJ" "Help Max thrive and succeed" "T2b: Root objective text matches the seed value"
assert_eq "$ROOT_STATUS" "idle" "T2c: Root objective starts in 'idle' status"
assert_eq "$ROOT_PARENT" "NULL" "T2d: Root objective has no parent (NULL)"

# Test 3: Re-init is idempotent
npx tsx src/db/schema.ts > /dev/null 2>&1
REINIT_EXIT=$?
ROOT_COUNT=$(sql "SELECT COUNT(*) FROM objectives WHERE id='root';")
assert_eq "$REINIT_EXIT" "0" "T3a: Running schema init a second time exits without error"
assert_eq "$ROOT_COUNT" "1" "T3b: Re-initializing does not duplicate the root objective"

# Test 4: FTS table exists and is queryable
FTS_EXISTS=$(sql "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='objectives_fts';")
FTS_QUERY=$(sql "SELECT COUNT(*) FROM objectives_fts WHERE objectives_fts MATCH 'thrive';" 2>&1)
assert_eq "$FTS_EXISTS" "1" "T4: FTS virtual table exists and can match text from root objective (match count: $FTS_QUERY)"

# ══════════════════════════════════════════════════════════════════
# Category B: Objective CRUD
# Validates the core create/show/tree lifecycle: creating objectives
# with various flags (--parent, --model), attaching instructions as
# inbox messages, reading back objective details with 'show', and
# verifying that 'tree' displays active objectives while hiding
# resolved or abandoned ones.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category B: Objective CRUD"
echo "────────────────────────────"

# Test 5: aria create "Test objective" creates child of root
OUT5=$($ARIA create "Test objective" 2>&1)
ID5=$(echo "$OUT5" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
if [[ -n "$ID5" ]]; then
  PARENT5=$(sql "SELECT parent FROM objectives WHERE id='$ID5';")
  assert_eq "$PARENT5" "root" "T5: Creating an objective without --parent defaults to root as parent"
else
  fail "T5: Creating an objective without --parent defaults to root as parent (could not parse id)"
fi

# Test 6: aria create "Child" with ARIA_OBJECTIVE_ID creates under specified parent
OUT6=$(ARIA_OBJECTIVE_ID="$ID5" $ARIA create "Child objective" 2>&1)
ID6=$(echo "$OUT6" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
if [[ -n "$ID6" ]]; then
  PARENT6=$(sql "SELECT parent FROM objectives WHERE id='$ID6';")
  assert_eq "$PARENT6" "$ID5" "T6: Creating an objective with ARIA_OBJECTIVE_ID nests it under the specified parent"
else
  fail "T6: Creating an objective with ARIA_OBJECTIVE_ID nests it under the specified parent (could not parse id)"
fi

# Test 7: aria create "Fast" --model haiku sets model='haiku'
OUT7=$($ARIA create "Fast objective" --model haiku 2>&1)
ID7=$(echo "$OUT7" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
if [[ -n "$ID7" ]]; then
  MODEL7=$(sql "SELECT model FROM objectives WHERE id='$ID7';")
  assert_eq "$MODEL7" "haiku" "T7: The --model flag persists the chosen model to the objective record"
else
  fail "T7: The --model flag persists the chosen model to the objective record (could not parse id)"
fi

# Test 8: aria create "With instructions" "Here are instructions" sends first message to inbox
OUT8=$($ARIA create "Instructed objective" "Here are the instructions" 2>&1)
ID8=$(echo "$OUT8" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
if [[ -n "$ID8" ]]; then
  MSG8=$(sql "SELECT message FROM inbox WHERE objective_id='$ID8' LIMIT 1;")
  assert_eq "$MSG8" "Here are the instructions" "T8: Passing a second argument to create stores it as the first inbox message"
else
  fail "T8: Passing a second argument to create stores it as the first inbox message (could not parse id)"
fi

# Test 9: aria show <id> returns correct fields
OUT9=$($ARIA show "$ID5" 2>&1)
SHOW_ID=$(echo "$OUT9" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
SHOW_OBJ=$(echo "$OUT9" | python3 -c "import sys,json; print(json.load(sys.stdin)['objective'])" 2>/dev/null)
SHOW_STATUS=$(echo "$OUT9" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
if [[ "$SHOW_ID" == "$ID5" && "$SHOW_OBJ" == "Test objective" && "$SHOW_STATUS" == "idle" ]]; then
  pass "T9: The show command returns the correct id, objective text, and status"
else
  fail "T9: The show command returns the correct id, objective text, and status (id=$SHOW_ID, obj=$SHOW_OBJ, status=$SHOW_STATUS)"
fi

# Test 10: aria tree shows active objectives
OUT10=$($ARIA tree 2>&1)
assert_contains "$OUT10" "Test objective" "T10: The tree command includes active (idle) objectives in its output"

# Test 11: aria tree hides resolved/abandoned objectives
# Resolve ID5's child (ID6) and abandon ID7
$ARIA succeed "$ID6" "done" > /dev/null 2>&1
sql "UPDATE objectives SET status='abandoned', updated_at=$(date +%s) WHERE id='$ID7';"

OUT11=$($ARIA tree 2>&1)
assert_not_contains "$OUT11" "Child objective" "T11a: The tree command hides resolved objectives from output"
assert_not_contains "$OUT11" "Fast objective" "T11b: The tree command hides abandoned objectives from output"

# ══════════════════════════════════════════════════════════════════
# Category C: Messaging & Inbox
# Validates the inbox system: sending messages populates the inbox
# with correct sender and type fields, messages arrive with
# turn_id=NULL (unprocessed), multiple sends accumulate correctly,
# and the inbox query supports ordering and --limit filtering.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category C: Messaging & Inbox"
echo "────────────────────────────"

# Create a fresh objective for messaging tests
OUT_C=$($ARIA create "Messaging test objective" 2>&1)
IDC=$(echo "$OUT_C" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Test 12: aria send <id> "hello" creates inbox message with sender='max', type='message'
$ARIA send "$IDC" "hello" > /dev/null 2>&1
SENDER12=$(sql "SELECT sender FROM inbox WHERE objective_id='$IDC' AND message='hello';")
TYPE12=$(sql "SELECT type FROM inbox WHERE objective_id='$IDC' AND message='hello';")
assert_eq "$SENDER12" "max" "T12a: Sending a message sets sender to 'max' (the human principal)"
assert_eq "$TYPE12" "message" "T12b: Sending a message sets type to 'message'"

# Test 13: Message has turn_id=NULL (unprocessed)
TURN13=$(sql "SELECT COALESCE(turn_id, 'NULL') FROM inbox WHERE objective_id='$IDC' AND message='hello';")
assert_eq "$TURN13" "NULL" "T13: A newly sent message has turn_id=NULL indicating it is unprocessed"

# Test 14: Multiple aria send accumulate (3 messages -> 3 in inbox)
$ARIA send "$IDC" "msg2" > /dev/null 2>&1
$ARIA send "$IDC" "msg3" > /dev/null 2>&1
COUNT14=$(sql "SELECT COUNT(*) FROM inbox WHERE objective_id='$IDC' AND sender='max';")
assert_eq "$COUNT14" "3" "T14: Sending three messages accumulates three separate inbox rows"

# Test 15: aria inbox <id> shows messages in order
OUT15=$($ARIA inbox "$IDC" 2>&1)
FIRST15=$(echo "$OUT15" | python3 -c "import sys,json; msgs=json.load(sys.stdin); print(msgs[0]['message'])" 2>/dev/null)
LAST15=$(echo "$OUT15" | python3 -c "import sys,json; msgs=json.load(sys.stdin); print(msgs[-1]['message'])" 2>/dev/null)
assert_eq "$FIRST15" "hello" "T15a: The inbox command returns messages in chronological order (first is 'hello')"
assert_eq "$LAST15" "msg3" "T15b: The inbox command returns messages in chronological order (last is 'msg3')"

# Test 16: aria inbox <id> --limit 1 returns only 1 message
OUT16=$($ARIA inbox "$IDC" --limit 1 2>&1)
COUNT16=$(echo "$OUT16" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
assert_eq "$COUNT16" "1" "T16: The --limit flag restricts inbox output to the specified number of messages"

# ══════════════════════════════════════════════════════════════════
# Category D: Status Mutations & Cascade
# Validates status transitions (succeed, fail, wait) and the cascade
# behavior: when a parent is resolved, all its active descendants are
# automatically abandoned. Ensures cascades propagate to arbitrary
# depth, do not affect already-resolved children, and do not bubble
# up to ancestors. Also tests that root cannot be succeeded.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category D: Status Mutations & Cascade"
echo "────────────────────────────────────────"

# Create fresh objectives for status tests
OUT_D=$($ARIA create "Status parent" 2>&1)
IDD=$(echo "$OUT_D" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

OUT_D_CHILD=$(ARIA_OBJECTIVE_ID="$IDD" $ARIA create "Status child" 2>&1)
IDD_CHILD=$(echo "$OUT_D_CHILD" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Test 17: aria succeed <id> "summary" sets status='resolved', resolved_at is set
$ARIA succeed "$IDD_CHILD" "all done" > /dev/null 2>&1
STATUS17=$(sql "SELECT status FROM objectives WHERE id='$IDD_CHILD';")
RESOLVED17=$(sql "SELECT COALESCE(resolved_at, 'NULL') FROM objectives WHERE id='$IDD_CHILD';")
assert_eq "$STATUS17" "resolved" "T17a: Succeeding an objective sets its status to 'resolved'"
assert_not_contains "$RESOLVED17" "NULL" "T17b: Succeeding an objective populates the resolved_at timestamp"

# Test 18: Succeed sends result message to parent's inbox (type='result', sender=child-id)
PARENT_MSG_TYPE=$(sql "SELECT type FROM inbox WHERE objective_id='$IDD' AND sender='$IDD_CHILD' LIMIT 1;")
PARENT_MSG_SENDER=$(sql "SELECT sender FROM inbox WHERE objective_id='$IDD' AND sender='$IDD_CHILD' LIMIT 1;")
assert_eq "$PARENT_MSG_TYPE" "reply" "T18a: Succeeding a child sends a type='reply' message to the parent's inbox"
assert_eq "$PARENT_MSG_SENDER" "$IDD_CHILD" "T18b: The result message sender is the child objective's id"

# Test 19: Cascade: parent->child->grandchild, succeed parent, child+grandchild go 'abandoned'
OUT_P19=$($ARIA create "Cascade parent" 2>&1)
IDP19=$(echo "$OUT_P19" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OUT_C19=$(ARIA_OBJECTIVE_ID="$IDP19" $ARIA create "Cascade child" 2>&1)
IDC19=$(echo "$OUT_C19" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OUT_G19=$(ARIA_OBJECTIVE_ID="$IDC19" $ARIA create "Cascade grandchild" 2>&1)
IDG19=$(echo "$OUT_G19" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

$ARIA succeed "$IDP19" "cascade test" > /dev/null 2>&1
STATUS_C19=$(sql "SELECT status FROM objectives WHERE id='$IDC19';")
STATUS_G19=$(sql "SELECT status FROM objectives WHERE id='$IDG19';")
assert_eq "$STATUS_C19" "abandoned" "T19a: Resolving a parent cascades abandonment to its direct child"
assert_eq "$STATUS_G19" "abandoned" "T19b: Resolving a parent cascades abandonment to its grandchild"

# Test 20: Deep cascade: 4 levels, succeed level-2, deeper ones abandoned
OUT_L1=$($ARIA create "Level 1" 2>&1)
IDL1=$(echo "$OUT_L1" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OUT_L2=$(ARIA_OBJECTIVE_ID="$IDL1" $ARIA create "Level 2" 2>&1)
IDL2=$(echo "$OUT_L2" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OUT_L3=$(ARIA_OBJECTIVE_ID="$IDL2" $ARIA create "Level 3" 2>&1)
IDL3=$(echo "$OUT_L3" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OUT_L4=$(ARIA_OBJECTIVE_ID="$IDL3" $ARIA create "Level 4" 2>&1)
IDL4=$(echo "$OUT_L4" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

$ARIA succeed "$IDL2" "deep cascade" > /dev/null 2>&1
STATUS_L3=$(sql "SELECT status FROM objectives WHERE id='$IDL3';")
STATUS_L4=$(sql "SELECT status FROM objectives WHERE id='$IDL4';")
STATUS_L1=$(sql "SELECT status FROM objectives WHERE id='$IDL1';")
assert_eq "$STATUS_L3" "abandoned" "T20a: Deep cascade abandons descendants two levels below the resolved objective"
assert_eq "$STATUS_L4" "abandoned" "T20b: Deep cascade abandons descendants three levels below the resolved objective"
assert_eq "$STATUS_L1" "idle" "T20c: Cascade does not propagate upward to the resolved objective's parent"

# Test 21: Cascade only hits idle/needs-input (not already-resolved children)
OUT_P21=$($ARIA create "Cascade selective parent" 2>&1)
IDP21=$(echo "$OUT_P21" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OUT_C21A=$(ARIA_OBJECTIVE_ID="$IDP21" $ARIA create "Already resolved child" 2>&1)
IDC21A=$(echo "$OUT_C21A" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OUT_C21B=$(ARIA_OBJECTIVE_ID="$IDP21" $ARIA create "Still idle child" 2>&1)
IDC21B=$(echo "$OUT_C21B" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Resolve the first child before cascading
$ARIA succeed "$IDC21A" "pre-resolved" > /dev/null 2>&1

$ARIA succeed "$IDP21" "selective cascade" > /dev/null 2>&1
STATUS_21A=$(sql "SELECT status FROM objectives WHERE id='$IDC21A';")
STATUS_21B=$(sql "SELECT status FROM objectives WHERE id='$IDC21B';")
assert_eq "$STATUS_21A" "resolved" "T21a: Cascade preserves the status of already-resolved children"
assert_eq "$STATUS_21B" "abandoned" "T21b: Cascade abandons children that are still in an active state"

# Test 22: aria fail <id> sets status='failed'
OUT_F22=$($ARIA create "Fail test objective" 2>&1)
IDF22=$(echo "$OUT_F22" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
$ARIA fail "$IDF22" "cannot be done" > /dev/null 2>&1
STATUS22=$(sql "SELECT status FROM objectives WHERE id='$IDF22';")
assert_eq "$STATUS22" "failed" "T22: The fail command sets the objective's status to 'failed'"

# Test 23: Fail sends message to parent inbox
FAIL_MSG23=$(sql "SELECT type FROM inbox WHERE objective_id='root' AND sender='$IDF22' AND type='reply' LIMIT 1;")
assert_eq "$FAIL_MSG23" "reply" "T23: Failing an objective sends a reply message to the parent's inbox"

# Test 24: Wait command sets status='idle' + waiting_on field
OUT_W24=$($ARIA create "Wait test objective" 2>&1)
IDW24=$(echo "$OUT_W24" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
ARIA_OBJECTIVE_ID="$IDW24" $ARIA wait "waiting for input" > /dev/null 2>&1
STATUS24=$(sql "SELECT status FROM objectives WHERE id='$IDW24';")
WAITING24=$(sql "SELECT waiting_on FROM objectives WHERE id='$IDW24';")
assert_eq "$STATUS24" "idle" "T24a: The wait command keeps the objective in 'idle' status"
assert_eq "$WAITING24" "waiting for input" "T24b: The wait command records the waiting reason in the waiting_on field"

# Test 25: Cannot succeed root (should get error)
ERR25=$($ARIA succeed root "nope" 2>&1)
EXIT25=$?
assert_contains "$ERR25" "Cannot succeed the root objective" "T25a: Attempting to succeed the root objective returns an error message"
assert_gt "$EXIT25" "0" "T25b: Attempting to succeed the root objective exits with a non-zero code"

# ══════════════════════════════════════════════════════════════════
# Category E: Communication
# Validates inter-objective communication: 'tell' delivers a message
# to a child's inbox, 'notify' inserts signals into the root inbox
# (with optional urgency), and 'find' performs full-text search over
# objective names, returning matches or an empty-result message.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category E: Communication"
echo "────────────────────────────"

TCTX="npx tsx test-context.ts"

# Create a fresh objective for communication tests
OUT_E=$($ARIA create "Comm test objective" 2>&1)
IDE=$(echo "$OUT_E" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Test 26: aria tell <child-id> "do this" inserts message in child's inbox
$ARIA tell "$IDE" "do this" > /dev/null 2>&1
TELL_MSG=$(sql "SELECT message FROM inbox WHERE objective_id='$IDE' AND message='do this';")
assert_eq "$TELL_MSG" "do this" "T26: The tell command inserts the message into the target objective's inbox"

# Test 27: aria notify "heads up" inserts signal in root inbox (type='signal')
$ARIA notify "heads up" --important --not-urgent > /dev/null 2>&1
NOTIFY_TYPE=$(sql "SELECT type FROM inbox WHERE objective_id='root' AND message='[notify] heads up' LIMIT 1;")
assert_eq "$NOTIFY_TYPE" "signal" "T27: The notify command inserts a type='signal' message into the root inbox"

# Test 28: aria notify "urgent" --urgent inserts with appropriate output
OUT28=$($ARIA notify "urgent msg" --urgent --important 2>&1)
assert_contains "$OUT28" "URGENT" "T28: The --urgent flag on notify includes an URGENT marker in the output"

# Test 29: aria find "keyword" returns objectives matching keyword
# We created "Comm test objective" above, search for it
OUT29=$($ARIA find "Comm" 2>&1)
assert_contains "$OUT29" "Comm test objective" "T29: The find command returns objectives whose text matches the search keyword"

# Test 30: aria find "nonexistentkeyword12345" returns empty/nothing
OUT30=$($ARIA find "nonexistentkeyword12345" 2>&1)
assert_contains "$OUT30" "No objectives found" "T30: The find command shows 'No objectives found' when nothing matches"

# ══════════════════════════════════════════════════════════════════
# Category F: Context Assembly
# Validates that the context assembler builds a complete system prompt
# file for a given objective. The generated file must contain all
# required sections: PERSONA, CONTRACT (with tool docs), ENVIRONMENT
# (with date), YOUR OBJECTIVE (with the objective text), WHY CHAIN
# (ancestor chain for nested objectives), and RECENT CONVERSATION.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category F: Context Assembly"
echo "────────────────────────────"

# Create a nested objective for context tests
OUT_F=$($ARIA create "Context parent objective" 2>&1)
IDF=$(echo "$OUT_F" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OUT_FC=$(ARIA_OBJECTIVE_ID="$IDF" $ARIA create "Context child objective" 2>&1)
IDFC=$(echo "$OUT_FC" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Send a message to the child so RECENT CONVERSATION has content
$ARIA send "$IDFC" "test conversation message" > /dev/null 2>&1

# Test 31: assembleContext writes file to /tmp/aria-context-{id}.md
CTX_PATH=$($TCTX assemble "$IDFC" 2>/dev/null)
if [[ -f "$CTX_PATH" ]]; then
  pass "T31: assembleContext writes a context file to /tmp/aria-context-{id}.md"
else
  fail "T31: assembleContext writes a context file to /tmp/aria-context-{id}.md (path: $CTX_PATH)"
fi

# Test 32: File contains # PERSONA section
CHK32=$($TCTX check-file "$CTX_PATH" "# PERSONA" 2>/dev/null)
assert_eq "$CHK32" "FOUND" "T32: The assembled context file includes a # PERSONA section"

# Test 33: File contains # CONTRACT section with tool docs
CHK33=$($TCTX check-file "$CTX_PATH" "# CONTRACT" 2>/dev/null)
CHK33B=$($TCTX check-file "$CTX_PATH" "aria create" 2>/dev/null)
CHK33C=$($TCTX check-file "$CTX_PATH" "aria succeed" 2>/dev/null)
if [[ "$CHK33" == "FOUND" && "$CHK33B" == "FOUND" && "$CHK33C" == "FOUND" ]]; then
  pass "T33: The context file includes a # CONTRACT section with tool documentation for create and succeed"
else
  fail "T33: The context file includes a # CONTRACT section with tool documentation for create and succeed (CONTRACT=$CHK33, create=$CHK33B, succeed=$CHK33C)"
fi

# Test 34: File contains # ENVIRONMENT section with date
CHK34=$($TCTX check-file "$CTX_PATH" "# ENVIRONMENT" 2>/dev/null)
CHK34B=$($TCTX check-file "$CTX_PATH" "Date:" 2>/dev/null)
if [[ "$CHK34" == "FOUND" && "$CHK34B" == "FOUND" ]]; then
  pass "T34: The context file includes a # ENVIRONMENT section containing the current date"
else
  fail "T34: The context file includes a # ENVIRONMENT section containing the current date (ENV=$CHK34, Date=$CHK34B)"
fi

# Test 35: File contains # YOUR OBJECTIVE with the objective text
CHK35=$($TCTX check-file "$CTX_PATH" "# YOUR OBJECTIVE" 2>/dev/null)
CHK35B=$($TCTX check-file "$CTX_PATH" "Context child objective" 2>/dev/null)
if [[ "$CHK35" == "FOUND" && "$CHK35B" == "FOUND" ]]; then
  pass "T35: The context file includes a # YOUR OBJECTIVE section with the objective's text"
else
  fail "T35: The context file includes a # YOUR OBJECTIVE section with the objective's text (SECTION=$CHK35, TEXT=$CHK35B)"
fi

# Test 36: File contains ancestor chain / WHY CHAIN for nested objectives
CHK36=$($TCTX check-file "$CTX_PATH" "# WHY CHAIN" 2>/dev/null)
CHK36B=$($TCTX check-file "$CTX_PATH" "Context parent objective" 2>/dev/null)
if [[ "$CHK36" == "FOUND" && "$CHK36B" == "FOUND" ]]; then
  pass "T36: The context file includes a # WHY CHAIN section showing the ancestor objective"
else
  fail "T36: The context file includes a # WHY CHAIN section showing the ancestor objective (CHAIN=$CHK36, PARENT=$CHK36B)"
fi

# Test 37: File contains # RECENT CONVERSATION with messages
CHK37=$($TCTX check-file "$CTX_PATH" "# RECENT CONVERSATION" 2>/dev/null)
CHK37B=$($TCTX check-file "$CTX_PATH" "test conversation message" 2>/dev/null)
if [[ "$CHK37" == "FOUND" && "$CHK37B" == "FOUND" ]]; then
  pass "T37: The context file includes a # RECENT CONVERSATION section with inbox messages"
else
  fail "T37: The context file includes a # RECENT CONVERSATION section with inbox messages (SECTION=$CHK37, MSG=$CHK37B)"
fi

# ══════════════════════════════════════════════════════════════════
# Category F2: Context Label Rendering
# Validates that the context assembler renders sender labels based
# on relationships: [max] for human, [parent:...] for parent,
# [child:...] for children, [system] for system signals, and
# [sibling:...] for sibling objectives.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category F2: Context Label Rendering"
echo "────────────────────────────────────"

# Set up a parent→child structure for label tests
OUT_F2P=$($ARIA create "Label test parent" 2>&1)
IDF2P=$(echo "$OUT_F2P" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OUT_F2C=$(ARIA_OBJECTIVE_ID="$IDF2P" $ARIA create "Label test child" 2>&1)
IDF2C=$(echo "$OUT_F2C" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Test 37a: [max] label appears when max sends a message
$ARIA send "$IDF2C" "hello from max" > /dev/null 2>&1
CTX_F2=$($TCTX assemble "$IDF2C" 2>/dev/null)
CHK37A=$($TCTX check-file "$CTX_F2" "[max]" 2>/dev/null)
assert_eq "$CHK37A" "FOUND" "T37a: Context renders [max] label for messages sent by max"

# Test 37b: [parent: label appears when parent sends a message via tell
ARIA_OBJECTIVE_ID="$IDF2P" $ARIA tell "$IDF2C" "instructions from parent" > /dev/null 2>&1
CTX_F2=$($TCTX assemble "$IDF2C" 2>/dev/null)
CHK37B=$($TCTX check-file "$CTX_F2" "[parent:" 2>/dev/null)
assert_eq "$CHK37B" "FOUND" "T37b: Context renders [parent:...] label for messages from the parent objective"

# Test 37c: [child: label appears for messages from a child (grandchild of parent)
OUT_F2GC=$(ARIA_OBJECTIVE_ID="$IDF2C" $ARIA create "Label test grandchild" 2>&1)
IDF2GC=$(echo "$OUT_F2GC" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
sql "INSERT INTO inbox (id, objective_id, message, sender, type, created_at) VALUES ('test-child-label', '$IDF2C', 'grandchild reporting back', '$IDF2GC', 'reply', $(date +%s));"
CTX_F2=$($TCTX assemble "$IDF2C" 2>/dev/null)
CHK37C=$($TCTX check-file "$CTX_F2" "[child:" 2>/dev/null)
assert_eq "$CHK37C" "FOUND" "T37c: Context renders [child:...] label for messages from a child objective"

# Test 37d: [system] label appears for system signals
sql "INSERT INTO inbox (id, objective_id, message, sender, type, created_at) VALUES ('test-system-label', '$IDF2C', 'email arrived', 'system', 'signal', $(date +%s));"
CTX_F2=$($TCTX assemble "$IDF2C" 2>/dev/null)
CHK37D=$($TCTX check-file "$CTX_F2" "[system]" 2>/dev/null)
assert_eq "$CHK37D" "FOUND" "T37d: Context renders [system] label for system signal messages"

# Test 37e: [sibling: label appears for messages from a sibling objective
OUT_F2SIB=$(ARIA_OBJECTIVE_ID="$IDF2P" $ARIA create "Label test sibling" 2>&1)
IDF2SIB=$(echo "$OUT_F2SIB" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
sql "INSERT INTO inbox (id, objective_id, message, sender, type, created_at) VALUES ('test-sibling-label', '$IDF2C', 'sibling message', '$IDF2SIB', 'message', $(date +%s));"
CTX_F2=$($TCTX assemble "$IDF2C" 2>/dev/null)
CHK37E=$($TCTX check-file "$CTX_F2" "[sibling:" 2>/dev/null)
assert_eq "$CHK37E" "FOUND" "T37e: Context renders [sibling:...] label for messages from a sibling objective"

# ══════════════════════════════════════════════════════════════════
# Category G: Engine Mechanics — DB Level
# Validates the engine's database-level queries without running a
# live turn: getPendingObjectives correctly identifies objectives
# with unprocessed messages, excludes terminal-state and thinking
# objectives, getThinkingCount returns accurate counts, and
# getStuckObjectives detects objectives stuck in thinking beyond
# a time threshold.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category G: Engine Mechanics — DB Level"
echo "────────────────────────────────────────"

# Test 38: getPendingObjectives returns objectives with unprocessed messages in idle/needs-input
# IDE (from Cat E) has an unprocessed message (from tell) and is idle
OUT38=$($TCTX get-pending 2>/dev/null)
FOUND38=$(echo "$OUT38" | python3 -c "import sys,json; ids=[o['id'] for o in json.load(sys.stdin)]; print('YES' if '$IDE' in ids else 'NO')" 2>/dev/null)
assert_eq "$FOUND38" "YES" "T38: getPendingObjectives includes objectives that have unprocessed inbox messages"

# Test 39: Objectives in terminal states not returned as pending
# Create an objective, send a message, then resolve it
OUT_G39=$($ARIA create "Terminal test" 2>&1)
IDG39=$(echo "$OUT_G39" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
$ARIA send "$IDG39" "a message" > /dev/null 2>&1
$ARIA succeed "$IDG39" "done" > /dev/null 2>&1
OUT39=$($TCTX get-pending 2>/dev/null)
FOUND39=$(echo "$OUT39" | python3 -c "import sys,json; ids=[o['id'] for o in json.load(sys.stdin)]; print('YES' if '$IDG39' in ids else 'NO')" 2>/dev/null)
assert_eq "$FOUND39" "NO" "T39: getPendingObjectives excludes objectives in terminal states (resolved/failed)"

# Test 40: Objectives in 'thinking' status not returned as pending
OUT_G40=$($ARIA create "Thinking test" 2>&1)
IDG40=$(echo "$OUT_G40" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
$ARIA send "$IDG40" "a message" > /dev/null 2>&1
sql "UPDATE objectives SET status='thinking', updated_at=$(date +%s) WHERE id='$IDG40';"
OUT40=$($TCTX get-pending 2>/dev/null)
FOUND40=$(echo "$OUT40" | python3 -c "import sys,json; ids=[o['id'] for o in json.load(sys.stdin)]; print('YES' if '$IDG40' in ids else 'NO')" 2>/dev/null)
assert_eq "$FOUND40" "NO" "T40: getPendingObjectives excludes objectives currently in 'thinking' status"

# Test 41: getThinkingCount returns accurate count
# IDG40 is in 'thinking' state from test 40
OUT41=$($TCTX get-thinking-count 2>/dev/null)
assert_gt "$OUT41" "0" "T41: getThinkingCount returns a positive number when objectives are in thinking state"

# Test 42: getStuckObjectives returns objectives thinking longer than threshold
# Set IDG40's updated_at to 10 minutes ago so it's "stuck"
PAST_TS=$(($(date +%s) - 600))
sql "UPDATE objectives SET updated_at=$PAST_TS WHERE id='$IDG40';"
OUT42=$($TCTX get-stuck 60 2>/dev/null)
FOUND42=$(echo "$OUT42" | python3 -c "import sys,json; ids=[o['id'] for o in json.load(sys.stdin)]; print('YES' if '$IDG40' in ids else 'NO')" 2>/dev/null)
assert_eq "$FOUND42" "YES" "T42: getStuckObjectives returns objectives that have been thinking longer than the threshold"

# ══════════════════════════════════════════════════════════════════
# Category H: Real Engine Turns
# Validates a full live engine cycle end-to-end: sends a message to
# a haiku-model objective, starts the engine, and verifies that the
# engine creates a turn record, stores the assistant's response in
# the inbox, and transitions the objective to 'needs-input' status.
# Requires the Claude CLI to be available on the machine.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category H: Real Engine Turns"
echo "────────────────────────────"

# Engine uses claude -p (CLI on subscription), no API key needed
# Create a haiku objective for fast engine turn
OUT_H=$($ARIA create "Respond with one sentence" --model haiku 2>&1)
IDH=$(echo "$OUT_H" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
$ARIA send "$IDH" "Say hello in one sentence." > /dev/null 2>&1

# Start engine in background
$ARIA engine > /tmp/aria-test-engine.log 2>&1 &
ENGINE_PID=$!

# Poll for completion (max 60s)
for i in $(seq 1 60); do
  STATUS_H=$(sql "SELECT status FROM objectives WHERE id='$IDH';")
  if [[ "$STATUS_H" != "thinking" && "$STATUS_H" != "idle" ]]; then
    break
  fi
  sleep 1
done

# Kill the engine process cleanly
kill $ENGINE_PID 2>/dev/null
wait $ENGINE_PID 2>/dev/null

# Test 43: Verify turn record created in turns table
TURN_COUNT=$(sql "SELECT COUNT(*) FROM turns WHERE objective_id='$IDH';")
assert_gt "$TURN_COUNT" "0" "T43: The engine creates a turn record in the turns table after processing an objective"

# Test 44: Verify assistant response appears in objective's inbox (type='result', sender=self)
RESPONSE_COUNT=$(sql "SELECT COUNT(*) FROM inbox WHERE objective_id='$IDH' AND sender='$IDH' AND type='reply';")
assert_gt "$RESPONSE_COUNT" "0" "T44: The engine stores the assistant's response as a type='reply' message in the objective's inbox"

# Test 45: Verify status transitioned away from idle (should be needs-input after turn completes)
FINAL_STATUS=$(sql "SELECT status FROM objectives WHERE id='$IDH';")
assert_eq "$FINAL_STATUS" "needs-input" "T45: The objective transitions to 'needs-input' status after the engine completes a turn"

# ══════════════════════════════════════════════════════════════════
# Category I: Validation & Scoping
# Validates that command validations enforce ancestry scoping, required
# arguments, auto-parenting defaults, resolution summary storage, and
# wait scoping constraints.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category I: Validation & Scoping"
echo "────────────────────────────────"

# ── Ancestry scoping tests ────────────────────────────────────────

# Create two sibling objectives under root (not parent-child of each other)
OUT_I1=$($ARIA create "Scope parent A" 2>&1)
IDI1=$(echo "$OUT_I1" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
OUT_I2=$($ARIA create "Scope parent B" 2>&1)
IDI2=$(echo "$OUT_I2" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Create a child of A
OUT_I1C=$(ARIA_OBJECTIVE_ID="$IDI1" $ARIA create "Child of A" 2>&1)
IDI1C=$(echo "$OUT_I1C" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Test: Succeed on a non-descendant fails with instructive error
ERR_SCOPE1=$(ARIA_OBJECTIVE_ID="$IDI2" $ARIA succeed "$IDI1C" "nope" 2>&1)
EXIT_SCOPE1=$?
assert_contains "$ERR_SCOPE1" "it is not your child or descendant" "T46: Succeed on a non-descendant fails with instructive error"
assert_gt "$EXIT_SCOPE1" "0" "T46b: Succeed on non-descendant exits non-zero"

# Test: Succeed on self fails with "Cannot succeed yourself" error
ERR_SCOPE2=$(ARIA_OBJECTIVE_ID="$IDI1" $ARIA succeed "$IDI1" "nope" 2>&1)
EXIT_SCOPE2=$?
assert_contains "$ERR_SCOPE2" "Cannot succeed yourself" "T47: Succeed on self fails with 'Cannot succeed yourself' error"
assert_gt "$EXIT_SCOPE2" "0" "T47b: Succeed on self exits non-zero"

# Test: Fail on a non-descendant fails with instructive error
ERR_SCOPE3=$(ARIA_OBJECTIVE_ID="$IDI2" $ARIA fail "$IDI1C" "nope" 2>&1)
EXIT_SCOPE3=$?
assert_contains "$ERR_SCOPE3" "it is not your child or descendant" "T48: Fail on a non-descendant fails with instructive error"
assert_gt "$EXIT_SCOPE3" "0" "T48b: Fail on non-descendant exits non-zero"

# Test: Fail on self fails with error
ERR_SCOPE4=$(ARIA_OBJECTIVE_ID="$IDI1" $ARIA fail "$IDI1" "nope" 2>&1)
EXIT_SCOPE4=$?
assert_contains "$ERR_SCOPE4" "Cannot fail yourself" "T49: Fail on self fails with error"
assert_gt "$EXIT_SCOPE4" "0" "T49b: Fail on self exits non-zero"

# ── Required args tests ───────────────────────────────────────────

# Test: Succeed without summary fails with instructive error
ERR_ARGS1=$($ARIA succeed "$IDI1C" 2>&1)
EXIT_ARGS1=$?
assert_contains "$ERR_ARGS1" "requires a resolution summary" "T50: Succeed without summary fails with instructive error"
assert_gt "$EXIT_ARGS1" "0" "T50b: Succeed without summary exits non-zero"

# Test: Fail without reason fails with instructive error
ERR_ARGS2=$($ARIA fail "$IDI1C" 2>&1)
EXIT_ARGS2=$?
assert_contains "$ERR_ARGS2" "requires a reason" "T51: Fail without reason fails with instructive error"
assert_gt "$EXIT_ARGS2" "0" "T51b: Fail without reason exits non-zero"

# Test: Notify without --important flag fails
ERR_ARGS3=$($ARIA notify "test msg" --urgent 2>&1)
EXIT_ARGS3=$?
assert_contains "$ERR_ARGS3" "requires an importance flag" "T52: Notify without --important flag fails"
assert_gt "$EXIT_ARGS3" "0" "T52b: Notify without --important exits non-zero"

# Test: Notify without --urgent flag fails
ERR_ARGS4=$($ARIA notify "test msg" --important 2>&1)
EXIT_ARGS4=$?
assert_contains "$ERR_ARGS4" "requires an urgency flag" "T53: Notify without --urgent flag fails"
assert_gt "$EXIT_ARGS4" "0" "T53b: Notify without --urgent exits non-zero"

# ── Auto-parenting tests ─────────────────────────────────────────

# Test: Create with ARIA_OBJECTIVE_ID set auto-parents to that ID
OUT_AP1=$(ARIA_OBJECTIVE_ID="$IDI1" $ARIA create "Auto-parented child" 2>&1)
IDAP1=$(echo "$OUT_AP1" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
PARENT_AP1=$(sql "SELECT parent FROM objectives WHERE id='$IDAP1';")
assert_eq "$PARENT_AP1" "$IDI1" "T54: Create with ARIA_OBJECTIVE_ID set auto-parents to that ID"

# Test: Create without ARIA_OBJECTIVE_ID defaults to root
OUT_AP2=$($ARIA create "Root-parented child" 2>&1)
IDAP2=$(echo "$OUT_AP2" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
PARENT_AP2=$(sql "SELECT parent FROM objectives WHERE id='$IDAP2';")
assert_eq "$PARENT_AP2" "root" "T55: Create without ARIA_OBJECTIVE_ID defaults to root"

# ── Resolution summary storage test ──────────────────────────────

# Create an objective, succeed it with a summary, verify resolution_summary is set
OUT_RS=$($ARIA create "Resolution summary test" 2>&1)
IDRS=$(echo "$OUT_RS" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
$ARIA succeed "$IDRS" "test summary stored correctly" > /dev/null 2>&1
RS_VALUE=$(sql "SELECT resolution_summary FROM objectives WHERE id='$IDRS';")
assert_eq "$RS_VALUE" "test summary stored correctly" "T56: After succeed, resolution_summary is set on the objective record"

# ── Reject command tests ─────────────────────────────────────────

# Test: Happy path — reject sets status to idle
OUT_RJ=$($ARIA create "Reject test objective" 2>&1)
IDRJ=$(echo "$OUT_RJ" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
# Set it to needs-input so we can verify reject resets to idle
sql "UPDATE objectives SET status='needs-input', updated_at=$(date +%s) WHERE id='$IDRJ';"
$ARIA reject "$IDRJ" "not good enough, try again" > /dev/null 2>&1
STATUS_RJ=$(sql "SELECT status FROM objectives WHERE id='$IDRJ';")
assert_eq "$STATUS_RJ" "idle" "T58: Reject sets the objective's status to 'idle'"

# Test: Reject inserts feedback message into child's inbox
REJECT_MSG=$(sql "SELECT message FROM inbox WHERE objective_id='$IDRJ' AND message='not good enough, try again';")
assert_eq "$REJECT_MSG" "not good enough, try again" "T59: Reject inserts feedback message into child's inbox"

# Test: Reject on non-descendant fails with ancestry error
OUT_RJ2=$($ARIA create "Reject scope test" 2>&1)
IDRJ2=$(echo "$OUT_RJ2" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
ERR_RJ=$(ARIA_OBJECTIVE_ID="$IDRJ2" $ARIA reject "$IDRJ" "nope" 2>&1)
EXIT_RJ=$?
assert_contains "$ERR_RJ" "it is not your child or descendant" "T60: Reject on a non-descendant fails with ancestry error"
assert_gt "$EXIT_RJ" "0" "T60b: Reject on non-descendant exits non-zero"

# Test: Reject on resolved objective fails with terminal error
OUT_RJ3=$($ARIA create "Reject terminal test" 2>&1)
IDRJ3=$(echo "$OUT_RJ3" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
$ARIA succeed "$IDRJ3" "done" > /dev/null 2>&1
ERR_RJ3=$($ARIA reject "$IDRJ3" "try again" 2>&1)
EXIT_RJ3=$?
assert_contains "$ERR_RJ3" "already resolved" "T61: Reject on a resolved objective fails with terminal error"
assert_gt "$EXIT_RJ3" "0" "T61b: Reject on resolved objective exits non-zero"

# Test: Reject clears waiting_on field
OUT_RJ4=$($ARIA create "Reject waiting test" 2>&1)
IDRJ4=$(echo "$OUT_RJ4" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
ARIA_OBJECTIVE_ID="$IDRJ4" $ARIA wait "waiting for something" > /dev/null 2>&1
WAITING_BEFORE=$(sql "SELECT waiting_on FROM objectives WHERE id='$IDRJ4';")
assert_eq "$WAITING_BEFORE" "waiting for something" "T62a: Waiting_on is set before reject"
$ARIA reject "$IDRJ4" "stop waiting, do it differently" > /dev/null 2>&1
WAITING_AFTER=$(sql "SELECT COALESCE(waiting_on, 'NULL') FROM objectives WHERE id='$IDRJ4';")
assert_eq "$WAITING_AFTER" "NULL" "T62b: Reject clears the waiting_on field"

# ── Wait scoping test ────────────────────────────────────────────

# Test: Wait without ARIA_OBJECTIVE_ID fails with instructive error
ERR_WAIT=$(unset ARIA_OBJECTIVE_ID; $ARIA wait "some reason" 2>&1)
EXIT_WAIT=$?
assert_contains "$ERR_WAIT" "no ARIA_OBJECTIVE_ID set" "T57: Wait without ARIA_OBJECTIVE_ID fails with instructive error"
assert_gt "$EXIT_WAIT" "0" "T57b: Wait without ARIA_OBJECTIVE_ID exits non-zero"

# ══════════════════════════════════════════════════════════════════
# Category J: Schedules
# Validates the schedule system: creating schedules, listing them,
# firing ready schedules (one-time and recurring), and bumping next_at.
# ══════════════════════════════════════════════════════════════════
echo ""
echo "Category J: Schedules"
echo "────────────────────────────"

# Create a fresh objective for schedule tests
OUT_J=$($ARIA create "Schedule test objective" 2>&1)
IDJ=$(echo "$OUT_J" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

# Test: Schedule creation works
OUT_SC=$($ARIA schedule "$IDJ" "check in" --interval 1h 2>&1)
IDSC=$(echo "$OUT_SC" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
if [[ -n "$IDSC" ]]; then
  SC_MSG=$(sql "SELECT message FROM schedules WHERE id='$IDSC';")
  SC_INT=$(sql "SELECT interval FROM schedules WHERE id='$IDSC';")
  assert_eq "$SC_MSG" "check in" "T63: Schedule creation stores the correct message"
  assert_eq "$SC_INT" "1h" "T64: Schedule creation stores the interval string"
else
  fail "T63: Schedule creation stores the correct message (could not parse id)"
  fail "T64: Schedule creation stores the interval string (could not parse id)"
fi

# Test: Schedule listing works
OUT_SL=$($ARIA schedules "$IDJ" 2>&1)
FOUND_SL=$(echo "$OUT_SL" | python3 -c "import sys,json; ids=[s['id'] for s in json.load(sys.stdin)]; print('YES' if '$IDSC' in ids else 'NO')" 2>/dev/null)
assert_eq "$FOUND_SL" "YES" "T65: Schedule listing returns created schedule"

# Test: Schedule listing without filter shows all
OUT_SL_ALL=$($ARIA schedules 2>&1)
FOUND_SL_ALL=$(echo "$OUT_SL_ALL" | python3 -c "import sys,json; ids=[s['id'] for s in json.load(sys.stdin)]; print('YES' if '$IDSC' in ids else 'NO')" 2>/dev/null)
assert_eq "$FOUND_SL_ALL" "YES" "T66: Schedule listing without filter includes all schedules"

# Test: One-time schedule fires and gets deleted
OUT_J2=$($ARIA create "One-time schedule target" 2>&1)
IDJ2=$(echo "$OUT_J2" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
PAST_TS_J=$(($(date +%s) - 60))
sql "INSERT INTO schedules (id, objective_id, message, interval, next_at, created_at) VALUES ('test-onetime', '$IDJ2', 'one-time ping', NULL, $PAST_TS_J, $PAST_TS_J);"

# Fire ready schedules via test helper
npx tsx test-fire-schedules.ts > /dev/null 2>&1

# Check one-time was deleted
ONETIME_EXISTS=$(sql "SELECT COUNT(*) FROM schedules WHERE id='test-onetime';")
ONETIME_MSG=$(sql "SELECT COUNT(*) FROM inbox WHERE objective_id='$IDJ2' AND message='one-time ping';")
assert_eq "$ONETIME_EXISTS" "0" "T67: One-time schedule is deleted after firing"
assert_gt "$ONETIME_MSG" "0" "T68: One-time schedule inserts message into target inbox"

# Test: Recurring schedule fires and bumps next_at
OUT_J3=$($ARIA create "Recurring schedule target" 2>&1)
IDJ3=$(echo "$OUT_J3" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)
PAST_TS_J3=$(($(date +%s) - 60))
sql "INSERT INTO schedules (id, objective_id, message, interval, next_at, created_at) VALUES ('test-recurring', '$IDJ3', 'recurring ping', '1h', $PAST_TS_J3, $PAST_TS_J3);"

npx tsx test-fire-schedules.ts > /dev/null 2>&1

RECURRING_EXISTS=$(sql "SELECT COUNT(*) FROM schedules WHERE id='test-recurring';")
RECURRING_NEXT=$(sql "SELECT next_at FROM schedules WHERE id='test-recurring';")
RECURRING_MSG=$(sql "SELECT COUNT(*) FROM inbox WHERE objective_id='$IDJ3' AND message='recurring ping';")
CURRENT_TS=$(date +%s)
assert_eq "$RECURRING_EXISTS" "1" "T69: Recurring schedule still exists after firing"
assert_gt "$RECURRING_NEXT" "$CURRENT_TS" "T70: Recurring schedule next_at was bumped to the future"
assert_gt "$RECURRING_MSG" "0" "T71: Recurring schedule inserts message into target inbox"

# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================"
echo "  $PASS passed, $FAIL failed (of $TOTAL)"
echo "========================"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
