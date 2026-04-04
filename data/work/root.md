# Root Work Document

## Current State — April 4, 2026

### Splicing (AbuGoot Lab)
All computational work complete. Waiting on Max to take it to the lab.

- **PPT3 construct** — `pSL0360_PPT3.gb` ready to clone
  - EF1A intron PPT replaced with 16-U run (TTTTTTTTTTTTTTTT) at positions 1567-1582
  - MaxEntScan: PPT2 = 7.85 → PPT3 = 12.80 (+4.95, top-tier human splice site)
  - Predicted 100–1000× improvement in U2AF65 binding affinity
  - File: `Cortex/abugoot/tracks/intronic-elements/exon-recognition-improvement/`
- **Supporting docs** in Cortex: splicemap comparison, splice signal optimization reference, western blot protocol (MS2-BioTRAP)
- **Next step (Max):** Clone PPT3 and run RT-PCR comparing splicing efficiency vs PPT2

### Active Children
- **Don't go broke** — resolved. Wise (EUR→USD ACH) for BoA transfers. Revolut decision: one action for Max — check Analytics for last 3 months foreign spend. Under ~15k kr/mo → Standard. Over ~22k kr/mo → Premium.
- **Grant funding** — active. Two payout children running:
  - **Knud Højgaard (30K DKK)** — KHF child identified the process (log into khf.onlinelegat.dk via MitID → Min side → request payout to NemKonto). Blocker: forhåndsgodkendelse from KU required. Harvard offer letter is ready on NAS. Max notified — waiting on his answer about forhåndsgodkendelse status. April is the payout window — urgent.
  - **Ørsted Studielegat (25K DKK)** — submission ready. Three complete Danish answers prepared and delivered to Max (copy-paste ready for the form). Documents ready. **Only blocker: Max needs to upload a photo and submit.** Form: https://hcoersted.dk/scholarship/. Deadline May 1, 2026. Child parked, waiting on Max.
- **Quick tasks** — needs-input; stale grandchildren from infra testing, needs a cleanup sweep
  - **Meeting prep (Dev Majumdar)** — done. Found meeting in calendar: 3:00–3:30 PM EDT today. Dev Majumdar, PhD, UVM ImmunoFoundry — RNA splicing / RBP regulation, postdoc with David Baltimore at Caltech. HSRF 306 in person or Zoom uvmcom.zoom.us/j/2908724811 (ID: 290 872 4811, PW: 990495). Full prep note at Cortex/inbox/meeting-prep-dev-majumdar.md.
- **Meet people / network** — idle; 3 drafts in Mail (Churchman, Fiszbein, Morini) waiting for Max to send
- **Complete MSc thesis** — needs-input; Max flagged a deadline to check but didn't specify which one
- **Build Aria** — idle, waiting for direction

### System
- **WAL bug root-caused and fixed** — `initMemoryTables()` was calling `db.pragma("journal_mode = WAL")` at the end of every `migrateDb()` invocation, overriding the DELETE mode set at the top. Every engine startup silently re-enabled WAL, eventually causing the iCloud sync zeroing loop. Fix: removed WAL pragma from `memory/schema.ts`; also added `journal_mode = DELETE` to `openDb()` so every writable connection enforces DELETE mode. Engine rebuilt and confirmed running clean — no WAL/SHM sidecars, `PRAGMA journal_mode` returns `delete`.
- **Separate poll error** — `no such column: cascade_id` on sync from `macbook.db` — schema mismatch between mini and macbook engines. Non-blocking for now but needs attention when Max is at his MacBook.
