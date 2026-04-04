# Don't Go Broke — Finance Overview

## Status: April 4, 2026

### NAS Finance Map (`4 Finance/`)
- **Budget/** — budget.json + "maxed-out" Vue app (in development)
- **Banking/** — Currency conversion PDF, confirmation of funds
- **Legater/** — 15+ grant folders with all application docs
- **Insurance/** — IDA accident + travel (2025)
- **Student-Aid/** — SU docs + SU.xlsx
- **Taxes/** — 2020-2021 records, "Udregn skat.xlsx"
- **Archive/** — Harvard financial archive

### Cortex Grant Pipeline (`projects/legater/`)
- 2,538 grants scraped from legatbogen.dk, AI-screened in 51 batches
- Priority CSV at `data/grants-priority.csv`
- Per-fund strategy docs + drafts (Ørsted, Fulbright, Rudolf Als, etc.)

### Gaps
- **No financial overview document** — brief says maintain one, doesn't exist yet
- **No Legater 2026 Tracker.xlsx** — referenced but not found on NAS
- **No live budget/cashflow tracking** — no current income, expenses, or runway projection
- **budget.json** — stale NAS file handle, needs re-sync or check

### Resolved Previously

**BoA Transfer** — Solved. Use Wise to move EUR from Danish Revolut → BofA via ACH. No $15 SWIFT fee. Wise charges ~0.4–0.5% instead of a flat $15.

**Revolut Standard vs Premium** — Researched. Decision comes down to monthly foreign spend:
- Under ~15,000 kr/month abroad → **Standard** (save 900 kr/year)
- Over ~25,000 kr/month → **Premium** pays for itself in avoided fees
- Break fee: 75 kr (1 month), legal under EU law, not worth worrying about

**US Revolut** — Not possible. One account per person globally. Switching would mean closing EU account. Wouldn't help anyway — EUR→USD funding problem stays the same.

**Max's action:** Check Revolut Analytics → last 3 months foreign spend → decide.

### Active Accounts
- Revolut EU (Danish) — primary spending card, especially abroad/US
- Bank of America — US account
- Wise — transfer intermediary (EUR→USD via ACH)

### Known Issues / Watch
- BofA Advantage SafeBalance: needs $500 minimum daily balance to avoid $4.95/mo fee, or stay under 25 years old
- BofA Advantage Plus: $12/mo fee waived with qualifying direct deposits
- Revolut free exchange limit: ~7,400 kr/mo on Standard (0.5% + 1% weekend surcharge above that)
