#!/bin/bash
# Run memory extraction across all types, rotating through them.
# Each round: process BATCH_SIZE sessions per type, then switch.
# Keeps going until all types are done or you ctrl-c.

BATCH_SIZE=${1:-10}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

TYPES=("world" "preference" "biology" "people" "max" "friction")
ROUND=1

while true; do
    echo ""
    echo "========================================"
    echo "  ROUND $ROUND — $BATCH_SIZE per type"
    echo "========================================"

    all_done=true

    for t in "${TYPES[@]}"; do
        echo ""
        echo "--- $t ---"
        output=$(python3 batch_run.py --type "$t" --limit "$BATCH_SIZE" 2>&1)
        echo "$output"

        # Check if there's nothing left to process
        if echo "$output" | grep -q "No sessions to process"; then
            echo "  ✓ $t complete"
        else
            all_done=false
        fi
    done

    if $all_done; then
        echo ""
        echo "All types fully processed!"
        break
    fi

    ROUND=$((ROUND + 1))
done
