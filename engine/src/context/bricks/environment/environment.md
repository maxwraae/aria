## Infrastructure

Aria runs across two machines, synced through iCloud.

**Mac Mini M1** (8GB, 256GB) — Home base. Always on, runs headless. Owns the coordinator, the poll loop, and overnight tasks. This is where Aria lives.

**MacBook Pro M4 Pro** (24GB, 1TB) — Max's daily driver. Runs when Max is working. Has a display. Agents can run here too.

**Synology NAS DS414+** — Cold storage. Archives, large files, datasets, backups. Mounted when connected to the home network.

**Tailscale** connects both machines on a private network, accessible from anywhere.

Both machines share the same iCloud-synced skills, agents, configuration, and Obsidian vault. The Aria database syncs between them.

Max can send messages from his MacBook, iPhone, or iPad. Messages arrive in your inbox the same way regardless of device.

## Accounts

**Email:** maxwraae@gmail.com (primary), sqr298@alumni.ku.dk (Copenhagen University)
**Email client:** Apple Mail (all email goes through Mail.app, never Gmail API)

## Obsidian vault (Cortex)

~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Cortex/

Shared workspace between you and Max. Plain markdown files. Changes visible to both in real time.

  inbox/              — drafts, outputs for Max to review
  projects/           — active project folders
  research/           — research outputs
  reference/          — reusable reference material
  ideas/              — explorations, frameworks
  writing/            — essays, posts, long-form
  protocols/          — lab protocols
  recipes/            — cooking recipes
  Aria/               — Aria system docs (persona, contract, context)
  Personas/           — persona files for review agents
  areas/              — life areas (health, relationships, etc.)
  vision/             — long-term vision docs
  system/             — system configuration (CLAUDE.md)
  templates/          — note templates

## Synology NAS

~/Library/CloudStorage/SynologyDrive-Synology/

  1 Personal/
  2 Education/
  3 Professional/
  4 Finance/
  5 Real-Estate/
  6 Archive/
  7 Aria/

## Aria

**DB:** ~/.aria/objectives.db
**Engine:** ~/Library/Mobile Documents/com~apple~CloudDocs/Aria/
**CLI:** `aria` (on PATH, knows your objective ID automatically)

## Tools

**Skills:** ~/.claude/skills/ (each has SKILL.md + scripts)
**Agents:** ~/.claude/agents/ (reusable agent prompts)
