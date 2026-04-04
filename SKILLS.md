# Aria Skills

## CLI Commands

```bash
aria tree                          # Show the full objective tree
aria show <id>                     # Show details of one objective
aria inbox <id> [--limit <n>]      # Show conversation for an objective
aria find "query"                  # Search objectives by keyword
aria schedules [id]                # List active schedules
aria up                            # Start engine (production)
```

## Monitoring

```bash
aria active                        # Objectives currently thinking (agents running)
aria alive                         # All non-terminal objectives, most recent first
aria recent                        # 15 most recently updated objectives
aria unprocessed                   # Inbox messages not yet picked up
aria today                         # Objectives updated today
```

## Debugging

```bash
aria stuck                         # Failing or idle-too-long objectives
aria errors                        # Objectives with errors or fail_count > 0
aria waiting                       # Objectives parked on something external
aria cascade <cascade_id>          # Trace a full cascade chain
aria cascade                       # List 10 most recent cascade IDs
```

## Understanding

```bash
aria stats                         # Counts by status, total turns, total inbox messages
aria children <id>                 # Children of one objective with statuses
aria history <id>                  # Turn history for one objective
```

## Lifecycle (for agents)

```bash
aria spawn-child "objective" "brief" "message"          # Create a child objective
aria resolve-child <id> succeed "summary"               # Close child as done
aria resolve-child <id> fail "reason"                   # Close child as failed
aria talk-to-child <id> "message"                       # Send feedback, reset to idle
aria talk <id> "message"                                # Message any objective
aria report-to-parent "message"                         # Report results upward
aria notify-max "message" --important --urgent          # Notify Max directly
aria wait "reason"                                      # Park until something external arrives
```

## Management (Max only)

```bash
aria schedule <id> "message" --interval <interval>      # Schedule recurring message
```
