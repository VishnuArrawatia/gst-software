# GST Software — Gap Analysis & Plan
**Date:** 21 October 2026
**Scope:** Sakar Electricals (2 GSTINs) + SVN Opto (1 GSTIN) — purchase reconciliation vs GSTR-2B, outward GSTR-1, GSTR-3B, ITC control
**Codebase:** 18,126 lines TypeScript · 25 migrations · 1,117 engine tests · 444 DB acceptance tests

---

## 0. Honest starting point

This is not a prototype. Verified on 21 Oct 2026:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm test` (engine) | 1,117 passed |
| `npm run test:p0:test` (live DB) | 444 passed |
| Migrations applied | 25 / 25 |
| Real data in DB | 4,099 sales invoices, 10,952 2B lines reconciled |
| Server | boots, login works, 10 screens |
| Templates in `templates/` | purchase, sales, 2B-vs-books — xlsx + csv |

What genuinely exists and is well built: header-alias detection across SAP exports, 2B JSON tree parser, credit/debit note sign logic, immutable `book_*` columns + `recon_*` corrections, month lock enforced by DB trigger, 34 reports from one SQL definition, export→edit→upload loop.

**So the remaining work is not "build the software". It is "close the compliance holes".** That is a much smaller, much more finishable job — and it is where the real risk sits.

---

## 1. Gaps I found in the code (with evidence)

Ordered by **compliance risk**, not by lines of code.

### 🔴 G1 — GSTR-3B ignores the accountant's ITC decision
`src/engine/gstr3b.ts` computes 4(A) / 4(A)(i) from the reconciliation alone. `itc_decision` and `return_classification` are written to the workbook (`src/app/pipeline.ts:717`) but never read by the 3B builder. README admits it: *"Wiring the 3B to the user's decision is Phase 2, and it is deliberately not done here."*

**Why it matters:** the whole point of the ITC screen is that a human decides "Do Not Claim" / "Reclaim Later" / "Ineligible". Today that decision changes nothing in the return. So the filed 3B can claim credit the accountant explicitly refused, and the ITC workflow is decorative. This is the single biggest credibility gap.

### 🔴 G2 — GST 2.0 rate slabs are missing
`src/engine/core.ts:462`:
```ts
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;
```
Since **22 Sep 2025** the slabs are effectively `0 / 0.25 / 3 / 5 / 18 / 40` (12% and 28% abolished for most goods; demerit/luxury moved to **40%**). The array has no 40%.

`nearestRate()` snaps a computed effective rate to the nearest slab in this array, and `effectiveRate()` is the function that decides the rate on every invoice, HSN row and 3B 3.1(a) breakdown. Proven on the current code:

```
$ npx tsx -e "import {effectiveRate} from './src/engine/core'; console.log(effectiveRate(100000, 40000))"
28          # a genuine 40% supply is reported as 28%
```

So the exact error is: **a 40% invoice is labelled 28%**, and the 3.1(a) rate-wise breakdown in GSTR-3B inherits that label. Rate slabs must also be **period-aware**, not a single global list: an invoice dated 2025-03 is legally 12%/28%, one dated 2025-10 is not.

**Why it matters:** a rate printed wrong on the working sheet becomes a rate computed wrong in B2CS buckets and HSN summary. This is a silent, data-dependent error — the worst kind.

### 🔴 G3 — GSTR-1 never declares nil/exempt supplies, and exports are hardcoded empty
`src/engine/gstr1.ts:772`:
```ts
exp: [],
...
sect: 'B2B,B2CL,B2CS,CDNR,CDNUR,HSN',
```
There is no Table 8 (`nil` — nil-rated / exempted / non-GST outward). No export section. Nil-rated and exempt outward supplies therefore appear **nowhere** in the JSON.

**Why it matters:** Table 8 is not optional — exempt and nil-rated turnover must be declared even when tax is zero. An unreported nil/exempt block also breaks the GSTR-9 turnover reconciliation later (see G8). For a lighting company with exempt/SEZ/export lines this is a filing defect, not a cosmetic one.

### 🟠 G4 — GSTR-3B JSON hardcodes "ITC not available" to zero
`src/engine/gstr3b.ts:448`: `itcNtAvail: 0` — while the engine does compute blocked credit (4B(2)) separately. The JSON therefore under-reports ineligible/blocked ITC even when the working sheet shows it.

Also hardcoded: `exp: []`, `itcCash: 0`, all `uti*` utilisation arrays empty. Some of that is legitimate (payment is entered on the portal), but `itcNtAvail` is return data, not payment data.

### 🟠 G5 — Reverse charge (3.1(d)) is a permanent zero
`src/engine/gstr3b.ts:357`:
```ts
push('3.1(d)', '3.1(d)', 'Inward supplies liable to reverse charge (not modelled)', 0);
```
**Why it matters for these two companies:** RCM hits freight (GTA), rent from an unregistered landlord, legal/professional fees, and import of services. All of these are normal for a distributor. A 3B that always shows zero RCM liability is under-reporting tax and, worse, under-claiming the offsetting ITC. Same for Table 5 (exempt/nil inward) and 5.1 (interest/late fee) — both absent.

### 🟠 G6 — IMS is not modelled at all
Grep for IMS across `src/` and `migrations/`: **zero hits.** The app reads whatever GSTR-2B file is dropped in.

Current portal reality (researched 21 Oct 2026): IMS is live on the portal; **no action = deemed accepted**, so a 2B silently includes invoices the recipient never reviewed. Accept / Reject / Pending are real states that change what lands in 2B and therefore in 3B Table 4.

**Why it matters:** Rule 88D (DRC-01C) compares 3B ITC against 2B ITC and triggers an intimation on material difference. Without IMS state in the model there is no defensible written position when DRC-01C arrives — you cannot show which invoices you disputed and when.

### 🟡 G7 — Rule 37 (180-day payment) absent
`cl.16(4)(d)` lapse is implemented in `src/engine/control.ts` (good). The **180-day non-payment reversal** (Rule 37) has no representation: no payment date, no reversal, no re-avail. For a distributor with credit-period vendors this is a live exposure, and re-avail is easy money to lose track of.

### 🟡 G8 — No GSTR-9 / 9C
No table, no report, no screen. GSTR-9 for **FY 2025-26 is due 31 Dec 2026** — roughly 10 weeks from today. Exemption is up to ₹2 cr turnover; 9C applies above ₹5 cr. Both companies here very likely file 9C (9C needs turnover and ITC reconciliation against books, which this system already holds).

### 🟡 G9 — Everything is single-month
Upload and reconciliation are multi-month (just fixed), but every screen, report and context bar is scoped to one GSTIN × one month. There is no FY view: no liability-vs-ITC trend, no exception ageing, no vendor scorecard across months. The CA's first question in a review meeting is a trend question.

### 🟡 G10 — Operational gaps
- **Zero git commits.** Months of work exists only on disk. Single highest-probability catastrophe.
- No automated DB backup, no tested restore runbook.
- Server binds `0.0.0.0`, password optional, roles exist in DB but enforcement depth on every API route is unverified.
- No packaging: a colleague cannot install this without you.
- Re-running a past month can change numbers that were already filed — there is no immutable "filed return" snapshot.

---

## 2. What I deliberately will NOT build

Stating this up front so scope cannot drift again.

| Not building | Why |
|---|---|
| Full accounting / billing / inventory | Tally/SAP already own it. Two systems of record always disagree. This system's job is *compliance output*, not bookkeeping. |
| IRP/e-invoice API from scratch | Needs a GSP/IRP contract, credentials, uptime SLA. Exception reporting first; integration only if the volume justifies the fee. |
| Multi-tenant SaaS | Three GSTINs, one office. Tenancy adds auth, isolation and migration cost for zero business value today. |
| Engine rewrite | 1,117 tests pass. Rebuilding a working engine is how the last 4 months disappear again. |

---

## 3. The plan

Sequenced so that **each phase leaves the system more trustworthy than it found it**, and nothing depends on a later phase to be correct.

### Approved sequencing (21 Oct 2026) — reconciliation first

The owner's priority is the three reconciliations: **GSTR-1 vs Sales Register**, **P&L vs GSTR-1**, and **GSTR-2B vs Purchase Register / ITC matching**. They come first. Measured state (see [FINAL_REPORT_2026-10-21.md](FINAL_REPORT_2026-10-21.md)): only the 2B-vs-purchase recon has real data; GSTR-1 has 0 filed rows; P&L has 0 entries.

#### R0 — Activate all three reconciliations · 3–4 agent-days
| # | Work | Done when |
|---|---|---|
| R0.1 | **Data, not code:** 11 months of filed GSTR-1 (Apr'25–Feb'26) and 12 months of P&L / trial balance | `gstr1_documents` has `source='filed'` rows for all 12 months; `pl_entries` non-empty |
| R0.2 | Period-aware rate slabs (was P0.2) | 40% invoice stays 40% |
| R0.3 | 2B JSON parser reads per-invoice `pos` and `rt`; `npm run verify` back to 21/21 | verify green |
| R0.4 | Coverage banner on each recon screen: "filed data missing for this month" instead of an empty table | no screen can be mistaken for a broken feature |

#### R1 — Reconciliation depth · 5–6 agent-days
| # | Work | Done when |
|---|---|---|
| R1.1 | Invoice-wise matching as a first-class result (today a status sits per line, so one invoice can be half-matched) | one status per invoice, with its lines underneath |
| R1.2 | One-click accept on a possible match (vendor wrote `123`, books say `INV-123`) | accepted match recorded with reason + audit row |
| R1.3 | Tolerance per company (₹1 / ₹100), not hardcoded | configurable, shown on screen |
| R1.4 | Exception ageing: days outstanding per exception, vendor-wise ITC at stake | aged list drives the follow-up letter |

Everything below keeps its original order but starts **after** R1.

### P0 — Stop the silent errors · 3–4 agent-days
*No new screens. Pure correctness. Every item has a failing-case test first.*

| # | Work | Done when |
|---|---|---|
| P0.1 | `git init` hygiene: verify `.gitignore` covers `.env`, `output/`, `node_modules`; commit everything; tag `v0.9-baseline` | `git log` non-empty, working tree clean |
| P0.3 | GSTR-1 Table 8 (`nil`) + export section from the register instead of `exp: []` | JSON carries nil/exempt/non-GST; `sect` updated; validation flags unmapped exempt lines |
| P0.4 | 3B JSON `itcNtAvail` from blocked ITC, not 0 | test: blocked ₹10,000 appears as 4D(2) in JSON |
| P0.5 | Field-level tests proving nothing above regressed | full suite still green |

*(P0.2, the rate slabs, moved to R0.2 because it blocks the reconciliation screens.)*

**Gate:** all green + `npm run verify` on the team's real files produces the same reconciliation baseline as measured on 21 Oct 2026: **matched 9,254 · exceptions 387 · books ITC ₹17,64,60,617.18 · claimable ITC ₹17,27,00,997.33** (and 21/21 checks, not 20/21).

### P1 — Make GSTR-3B the truth · 6–8 agent-days
*This is the phase that makes the ITC screen worth using.*

| # | Work | Done when |
|---|---|---|
| P1.1 | Wire `itc_decision` + `return_classification` into 3B 4(A)/4(A)(i)/4(B)/4(D)(2) | 3B draft uses human decisions; screen shows **engine number vs decision number vs delta** |
| P1.2 | RCM engine: 3.1(d) liability + matching ITC, flagged per line (`reverse charge` already exists on purchase lines) | a GTA freight line produces RCM liability + eligible credit, not zero |
| P1.3 | Table 5 (exempt/nil inward) + 5.1 (interest/late fee input) | 3B working sheet complete across all live tables |
| P1.4 | Rule 37: payment-due date per invoice, 180-day breach list, reversal and re-avail records | exception report "Rule 37 reversal due" with amount and vendor |
| P1.5 | Immutable filed-return snapshot: once a month is locked and filed, the 3B/1 numbers are frozen | re-running a filed month cannot change its numbers; diff shown and refused |

**Gate:** for one real month (say Aug 2026), the 3B draft matches the return actually filed on the portal, table by table, or every difference is explained.

### P2 — IMS + Rule 88D · 5–7 agent-days
| # | Work | Done when |
|---|---|---|
| P2.1 | IMS import (portal JSON/Excel) → per-record state: Accepted / Rejected / Pending / No action | IMS status stored per (supplier, invoice, period) |
| P2.2 | IMS worklist screen: rejections and pendings with amount at stake, and "what 3B would show with/without" | accountant can clear a month's pendings in one sitting |
| P2.3 | 2B recompute awareness: after IMS actions, ITC delta is visible per month | delta report: "IMS changed eligible ITC by ₹X" |
| P2.4 | DRC-01C (Rule 88D) worksheet: 3B ITC vs 2B ITC, difference, per-invoice reason, response draft | exportable response pack for a DRC-01C |

**Gate:** a synthetic 2B with 5 rejected + 3 pending invoices produces ITC that excludes them, and the DRC-01C worksheet explains every rupee.

### P3 — GSTR-9 / 9C + FY view · 8–10 agent-days
| # | Work | Done when |
|---|---|---|
| P3.1 | FY aggregation layer: 12 months → one row set, from filed snapshots not live data | FY totals rebuild identically from snapshots |
| P3.2 | GSTR-9 worksheet: tables 4/5/6 (outward, ITC, tax paid), turnover reconciliation vs books | numbers trace to monthly 3B + 1, each cell with a drill-down |
| P3.3 | GSTR-9C: turnover and ITC reconciliation vs audited books, unreconciled differences | 9C bridge with every difference explained |
| P3.4 | FY dashboard: liability vs ITC trend, exception ageing, vendor-wise ITC leakage, 16(4) lapse countdown | CA can run a review meeting from one screen |

**Calendar pressure:** 9 due 31 Dec 2026 → P3 must start by mid-November to be useful for FY 2025-26. If it slips, at minimum 9C's ITC reconciliation (P3.3) must land, because that is the part the auditor asks for.

### P4 — Operate it without you in the room · 4–5 agent-days
| # | Work |
|---|---|
| P4.1 | Nightly `pg_dump -Fc`, retention, **restore tested end-to-end** and documented |
| P4.2 | Auth: forced password when binding LAN, server-side role checks on every mutating route, session expiry, login audit |
| P4.3 | One-command install/bootstrap (Postgres check → migrations → seed → open browser) + team onboarding doc |
| P4.4 | Health/monitor page: last run, last backup, DB size, failed logins |

### P5 — Only after P0–P4 (decide later)
- e-invoice IRN generation via GSP/IRP (threshold ₹5 cr; 30-day reporting for AATO ≥ ₹10 cr) — recommend the **missing-IRN exception list** now, integration only if volume justifies it.
- GSTR-1 JSON offline-utility round-trip validation before upload.
- Automated vendor follow-up email from the follow-up list.
- QRMP / GSTR-1A handling if either company opts in.

---

## 4. Sequence and effort

```
R0  3–4 d   ██        ← activate the three reconciliations (mostly data)
R1  5–6 d   ████      ← invoice-wise matching, possible-match accept, ageing
P0  3–4 d       ██        ← silent errors: 40% slab, Table 8, 3B JSON
P1  6–8 d         ████    ← 3B obeys ITC decisions, RCM, Rule 37
P2  5–7 d           ███   ← IMS + DRC-01C
P3  8–10 d              █████  ← calendar-bound (31 Dec 2026)
P4  4–5 d                  ███
                        ≈ 34–44 agent-days
```

**Ordering logic:**
- **R0 first** because two of the three reconciliations the owner cares about have no input data, and no amount of code fixes an empty table. R0 also carries the two defects that touch those screens (rate slabs, 2B JSON).
- **R1 next** because reconciliation quality — not the returns — is what the accounts team touches every day.
- **P0 then** removes the remaining silent errors (Table 8, 3B JSON ITC), which are filing defects rather than reconciliation defects.
- **P1 before P2** because IMS changes ITC, and ITC only *means* something once the 3B consumes decisions.
- **P3 is calendar-driven**, not logic-driven: it can jump the queue if the 31 Dec deadline becomes tight.
- **P4 last** because it is about resilience, not correctness — but it decides whether the team actually uses the system.

---

## 5. How we will know it worked

Not "tests pass". These are the outcomes:

1. **One full real month** — files in, 3B draft out — matches the return actually filed on the portal, table by table.
2. **One DRC-01C** can be answered from the system without opening Excel.
3. **The accountant's "Do Not Claim"** decision visibly changes the filed ITC number.
4. **FY 2025-26 GSTR-9C** is generated from stored data, not retyped.
5. **A second person** can install, run and back up the system from the docs alone.
6. **`git log` has history**, and restoring from backup has been done once, for real.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| GSTN changes schema/utility again (happened repeatedly in 2025–26) | schema version + effective-date kept in data/config, not hardcoded (`GST1.1` / `GST3B.1` today) |
| Rate-slab change mid-FY corrupts historical months | period-aware slabs (P0.2) + immutable filed snapshots (P1.5) |
| Scope creep back into accounting/inventory | §2 list is binding; new asks go to a backlog, not into the current phase |
| Single machine dies | P0.1 + P4.1 before anything else |
| Rules verified from secondary sources | every legal rule implemented from the bare Act/Rule text or a portal advisory, cited in the code comment |
