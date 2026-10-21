# GST ERP

Purchase reconciliation against GSTR-2B, GSTR-3B and GSTR-1 generation, and ITC
control — for Sakar Electricals and SVN Opto.

This is a standalone application. It is deliberately **not** part of the VETAN
payroll ERP; nothing here reads from or writes to it.

---

## What it does

| Piece | What it answers |
|---|---|
| **Reconciliation** | Which purchase invoices are missing from GSTR-2B, which 2B lines are not booked, which amounts disagree, and which are duplicated. |
| **GSTR-3B** | A full table 3.1(a) / 3.2 / 4A-4C / 5 / 6 / 7 draft per GSTIN per month, as a working sheet *and* as portal JSON. |
| **GSTR-1** | B2B, B2CL, B2CS, CDNR, HSN summary and portal JSON, built from the SAP sales register. |
| **ITC control** | The running credit balance month by month, blocked credit, 4A(i) pending, and the cl.16(4)(d) lapse deadline. |

### The two rules that matter most

**1. GSTR-2B is the authority on input credit.**
Under cl.16(2)(b) credit exists only for invoices the supplier actually reported,
and cl.16(4) blocks it where the portal marks it unavailable. So ITC is taken from
the *reconciled* view, never from the purchase books alone. A vendor line the
portal blocked goes to table 4(B), never 4(A).

**2. Books-only ITC is quarantined, not silently claimed.**
An invoice in the books with no GSTR-2B counterpart is still claimable, but only
by declaring it in table 4A(i). Adding it to 4(A) quietly would overstate the
return. It is therefore reported as a separate memo line.

---

## Setup

```bash
npm install
copy .env.example .env      # then fill in PGPASSWORD
npm run migrate             # creates the schema
npm run seed                # loads the company / unit / GSTIN masters
```

The database itself:

```bat
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d postgres -c "CREATE DATABASE gst_erp;"
```

### Masters

`npm run seed` is idempotent (upserts on the natural key). The registrations it
writes were read out of the source files, not typed from memory:

| Company | Unit | GSTIN | State | Evidence |
|---|---|---|---|---|
| Sakar (PAN AALCS9985J) | Sakar-I | `26AALCS9985J1ZC` | 26 | "GSTIN of Company" column, 10,732 lines of the 2B download |
| Sakar (PAN AALCS9985J) | Sakar-III | `24AALCS9985J1ZG` | 24 | same column, 220 lines |
| SVN Opto (PAN ABFCS9511H) | SVN Unit-I | `26ABFCS9511H1Z7` | 26 | supplier GSTIN on 2,919 purchase lines / 2,929 2B lines, always "SVN OPTO ELECTRONICS PVT.LTD." |
| SVN Opto | SVN Unit-II | *(no separate GSTIN)* | — | both units are billed under the one GSTIN: invoice series `SVN/2526/xxxx` and `SVN2/25/xxxxxx` ("UNIT- II (PURCHASE)") |

Both Sakar GSTINs carry the same PAN, so they are two registrations of **one**
company, not two companies. SVN's two units share **one** GSTIN, so Unit-II
deliberately has no row in `gstins` (that column is UNIQUE) — it is the same
registration.

Financial years 2024-25 and 2025-26 with their 12 periods each are seeded too.

---

## Team ke liye — local web server

```bash
npm run serve          # http://localhost:4310 aur http://<office-IP>:4310
```

Poori team apne browser se kaam kar sakti hai: files drag-and-drop karke upload,
reconciliation run, exceptions filter, CSV download, workbook download aur vendor
follow-up list (print karke bhejne layak).

| | |
|---|---|
| Port | 4310 (`--port 4400` se badal sakte ho) |
| Bind | `0.0.0.0` — office LAN ke andar ke liye |
| Uploads | `output/uploads/` (asli source folder chhoota nahi) |
| Output | `output/` — workbook + `returns/*.json` |

Server wahi pipeline chalata hai jo CLI (`src/app/pipeline.ts`), isliye screen pe
aur disk pe wahi numbers aate hain. Run server ke andar **child process** me
chalta hai: pipeline synchronous hai aur 20,000 rows par ~2–3 minute leta hai —
same process me chala to har HTTP request freeze ho jati. Child process se log
live aata hai aur ek run ka crash server nahi ghaata.

```bash
npm run serve -- --port 4400 --input "D:\c drive\Desktop\GST Monthly Input"
```

**Security.** Server bina login ke chalega aur `0.0.0.0` par sunta hai — matlab
jo bhi is machine tak pahunch sakta hai, GST data padh sakta hai aur run start
kar sakta hai. Band office network par theek hai; ghar par ya Wi-Fi par nahi.
Passcode lagana ho to `.env` me `GST_WEB_PASSWORD=...` daal do — page pe ek baar
puchhega aur uske baad har request check hoga.

---

## Monthly run

Put the source files in one folder — the names do not matter, the file type is
detected from the content:

- SAP **purchase register** (`.xlsx`)
- **GSTR-2B** from the portal — either the `.xlsx` download **or the JSON**
- SAP **sales register** (optional; needed for GSTR-1)

### GSTR-2B as JSON

On the portal: *Returns Dashboard → Auto-drafted ITC Statement → GSTR-2B →
Download → JSON*. Drop that `.json` into the same folder; the run picks it up
alongside the spreadsheets and both forms reconcile identically.

The portal JSON is a tree, not a table, so it has its own parser
(`parseGstr2bJson`). It reads `b2b` / `b2cl` / `cdnr` / `isd`, sums each
invoice's `itms` tax lines into one row, and honours the per-invoice ITC flag
(`itc_elg`), falling back to the `section` summary when the invoice carries
none. Every key is read through a list of accepted spellings, because the portal
has renamed them between releases.

Three things it deliberately does **not** do:

- **B2CS rows are not ingested.** They are summary rows with no invoice number,
  so they cannot be matched to the books. They are counted and reported.
- **Invoices without a supplier GSTIN are not ingested** — typically B2CL from
  unregistered suppliers. Reconciliation matches on GSTIN + invoice number, so
  there is nothing to match them on. Also counted and reported.
- **ITC availability is never silently assumed.** If the JSON contains no ITC
  flag at all, the rows still load but the run prints a warning: assumed "Yes".

`npm run verify` proves the two paths agree — it rebuilds all 10,952 real 2B
lines as portal JSON and asserts the reconciliation summary is identical.

```bash
npm run cli -- --input "D:\c drive\Desktop\GST Monthly Input" --out "F:\GST-SOFTWARE\output"
```

Useful flags:

| Flag | Purpose |
|---|---|
| `--period 2025-04` | Restrict the run to one period |
| `--sales-gstin <GSTIN>` | Attribute sales rows when the export has no "Our GSTIN" column |

### Output

`GST Monthly <date>.xlsx` with these sheets:

| Sheet | Contents |
|---|---|
| `Summary` | Every GSTIN × period: matched count, exceptions, claimable ITC, output tax, 3B payable |
| `Missing in 2B` | Vendor follow-up list — invoices to chase |
| `Amount Mismatch` | Found on both sides, amounts disagree |
| `ITC Blocked` | Portal says the credit is unavailable |
| `Duplicates` | Same GSTIN + invoice booked twice |
| `Not Booked in Purchase` | In 2B, absent from the books |
| `Purchase Detail` / `GSTR-2B Detail` | Full data with status per row |
| `ITC Control` | Running credit balance and lapse deadline per month, plus the worst vendors |
| `GSTR-3B` / `GSTR-1` | Working sheets, one block per GSTIN per period |
| `Vendor Follow-up` | A ready-to-send list with the exact amount at stake per invoice |

`returns/<GSTIN>_<period>_GSTR1.json` and `_GSTR3B.json` — portal offline-utility
files, one per period.

### Sales register → GSTR-1

GSTR-1 is built from the **sales register**. The template is downloadable from
the app (`/api/template/sales-register.xlsx` and `.csv`), or generated into
`templates/` with:

```bash
npm run template:sales
```

18 columns; five are compulsory. The table (B2B / B2CL / B2CS / CDNR / CDNUR) is
**derived, not typed** — there is deliberately no "table" column, because a
typed table can contradict the data and a return filed on a contradicted
classification is the error the template exists to prevent.

| | Columns |
|---|---|
| Compulsory | `Our GSTIN`, `Invoice No`, `Invoice Date`, `Taxable Value`, `Invoice Value` |
| Decides the table | `Customer GSTIN`, `Place of Supply`, `Invoice Type` |
| Money | `IGST`, `CGST`, `SGST`, `CESS` |
| Rest | `Our Location No.`, `Customer Name`, `HSN`, `Note No`, `Note Date`, `Reverse Charge` |

How the table is decided:

| Condition | Table |
|---|---|
| Customer GSTIN is a valid 15-character GSTIN | B2B (4A) |
| No GSTIN, inter-state, invoice value over ₹1,00,000 (₹2,50,000 before Aug 2024) | B2CL |
| Everything else unregistered | B2CS, summarised by rate |
| `Invoice Type` = CN / DN, registered customer | CDNR (9A) — original invoice number is mandatory |
| `Invoice Type` = CN / DN, unregistered customer | CDNUR (9B) — note type derived, not typed |

A run needs **only the sales register** to produce GSTR-1: reconciliation is
skipped and the run says so. `Invoice Date` decides the period (there is no
period column), so a wrong date files the invoice in the wrong month.

`Invoice Value` is compulsory for a reason worth knowing: drop that column and
the file is sniffed as a **purchase register** — "Customer GSTIN" is remapped to
the supplier side and the whole sales register is filed as purchase data.

---

## Verifying

```bash
npm test          # 129 unit tests over the engine rules
npm run verify    # runs the engine against your real SAP + GSTR-2B files
```

`npm run verify` is the one that matters after any change to the parsers: it
parses the actual files and prints row counts, period coverage and reconciliation
rates, so a regression in column detection is visible immediately.

---

## Layout

```
src/engine/       pure logic, no database, no filesystem
  core.ts         types + normalisation (dates, GSTIN, invoice numbers, periods)
  columns.ts      alias-based header detection
  ingest.ts       parsers for purchase / 2B / sales (incl. the portal's 2B JSON),
                  with file-type sniffing
  match.ts        purchase reconciliation
  gstr3b.ts       GSTR-3B builder + portal JSON
  gstr1.ts        GSTR-1 builder + portal JSON
  control.ts      ITC running balance and lapse risk
src/cli/          monthly run (flags + console report only)
src/app/          the monthly pipeline (shared by CLI + server) and the Phase-0
                  store: purchase lines, 2B lines, file registry, corrections,
                  ITC decisions, month locks, audit trail
src/server/       LAN web server + the single-page UI
src/config/       .env loading and the PostgreSQL connection
migrations/       PostgreSQL schema
tests/            unit tests + real-data verification + Phase-0 acceptance tests
```

The engine has no dependencies beyond the standard library. That is deliberate:
it can be lifted into the web app or run in a browser without dragging a
database along.

---

## Notes on the schema

`migrations/01_initialize_schema.sql` was a draft that had never been applied,
and it did not parse as PostgreSQL. The fixes applied:

| Problem | Fix |
|---|---|
| Trailing commas before `)` and between table elements | Corrected — a comma separates two table elements and is mandatory there, but may never precede the closing paren. |
| `CONSTRAINT uq_roles_name UNIQUE (LOWER(name))` inside `CREATE TABLE` | Removed. PostgreSQL cannot express an expression UNIQUE in a table constraint; the file already creates the correct `CREATE UNIQUE INDEX ... (LOWER(name))`. |
| `CHECK (fy IN (SELECT year_code FROM financial_years))` | Replaced with a real `FOREIGN KEY`. PostgreSQL forbids sub-queries in CHECK constraints. |
| `CHECK (period IN (SELECT ... FROM periods WHERE ...))` | Replaced with a `BEFORE INSERT OR UPDATE` trigger; `periods` is keyed by `financial_year_id` and is unreachable by a plain FK. |
| `idx_pr_match_key` on columns that do not exist | Re-pointed. The match key lives on `purchase_bills` / `gstr2b_records`; duplicating it on `purchase_reconciliation` would let the two drift apart. |

### `migrations/03_period_code_width.sql`

Every period column was declared `VARCHAR(6)`, which fits `202504` but **not**
`2025-04`. The engine uses `YYYY-MM` everywhere, so the first real write into
`purchase_bills` or `gstr2b_records` failed with a bare

```
ERROR:  value too long for type character varying(6)
```

pointing at the column rather than at the format. Eleven columns are widened to
`VARCHAR(7)`. `v_itc_control` is dropped and rebuilt in the same migration —
PostgreSQL refuses to alter the type of a column a view reads.

`npm run migrate` runs each file in its own transaction and records it in
`schema_migrations`, so a failure leaves no half-applied schema and a re-run is
a no-op.

---

# Phase 0 — the editable record

Phase 0 adds the part the file-based pipeline could not hold: what the books
said, what was corrected to match the portal, what the Accounts team decided
about the ITC, and who decided it. Nothing was rewritten — the engine, the
parser, the workbook and the returns are exactly as they were, and the
regression baseline is unchanged (502 exceptions, 438 missing, 37 mismatch,
27 duplicates, ₹48,00,130.79 pending in 4(A)(i)).

## The golden rule

```
BOOK DATA                RECONCILIATION DATA           HUMAN DECISION
book_supplier_gstin  →   recon_supplier_gstin     →   itc_decision
book_invoice_no          recon_invoice_no              itc_decision_month
book_invoice_date        recon_invoice_date            return_classification
book_*amounts            (matched against the 2B)      decision_by/_at/_reason
```

The `book_*` columns are written once at import and are **immutable**. That is
not a convention: `trg_book_values_immutable` raises on any UPDATE that touches
them, so even a bad migration cannot rewrite the accountant's evidence. Only the
three `recon_*` fields can be edited, and matching always uses the `recon_*`
values while the `book_*` values are what the report and the audit proof show.

## What a run does now

`npm run cli` / the Run button, after the workbook is written:

1. upserts the purchase lines into `purchase_lines` (keyed `GSTIN|period|file|row`)
2. upserts the 2B lines into `gstr2b_lines`
3. registers each GSTR-2B file in `gstr2b_files` — the same portal file cannot be
   registered twice, the SHA-256 is the fingerprint
4. writes an **ITC Working** sheet into the same workbook

A re-run refreshes the match result but **never** overwrites a human edit: the
`recon_*` columns are only reset while `recon_edited` is false, and the ITC
decision is never reset. A locked month is skipped and reported.

If PostgreSQL is unreachable the run still completes and the workbook is still
written; the Phase-0 report just says why storage was skipped.

## The screens

| Screen | What it is for |
|---|---|
| Run & Exceptions | unchanged — files, log, tiles, 5 exception tabs, CSV, vendor follow-up |
| Purchase Register | book vs recon columns, filters, `EDIT RECONCILIATION` per row |
| Copy / Paste | paste a block straight from Excel, preview it, confirm, and it reconciles |
| ITC Working | the spec's §14 report, with the decision columns, Excel and CSV |
| 2B Files | which portal file is registered, for which GSTIN and month |
| Audit Trail | every change, filterable by company, month, field, user, invoice, date |
| Month Lock | lock a closed month; unlock needs an admin confirmation and a reason |
| Reports | all 34 reports, preview + Excel + CSV, filters flow into the file |
| Supplier Follow-up | who costs us ITC, ranked, with what the vendor last said |
| Upload Report | send a worked-on Excel back in, with full validation first |

The reconciliation editor shows the proof table (BOOKS / RECONCILIATION /
GSTR-2B side by side), the three editable fields with a mandatory reason, the
ITC decision with its month and reason, the separate return classification, and
the full correction history including whether each edit has been re-reconciled.

## Save & Re-reconcile

`POST /api/lines/:id/recon` writes the three fields, records the change, and
re-runs the pure engine over the stored data for that GSTIN + month. The 2B side
is loaded from **every** 2B month the portal has published, not just the book
period — an invoice booked in March can legitimately match in the April 2B, and
restricting to the book month is how "Missing in 2B" becomes a permanent lie.
The response carries the before/after status counts so the screen can show what
the correction actually did.

## The ITC decision is never automatic

`itc_decision` starts at `Pending Review` for every line and the software never
moves it. The allowed values are `Claim`, `Do Not Claim`, `Reclaim Later`,
`Query Vendor`, `Ineligible`, `Reversed`, plus `Pending Review`.

`return_classification` (4(A) / 4(A)(i) / 4(B) / not in 3B / ineligible) is a
**separate** field, also human-owned. The GSTR-3B calculation is unchanged in
Phase 0 — it still derives 4(A) and 4(A)(i) the way it always did. Wiring the
3B to the user's decision is Phase 2, and it is deliberately not done here: doing
it now would mean re-deriving a filed return on untested logic.

## Month lock

`month_locks` + `block_write_to_locked_month()` refuse every INSERT, UPDATE and
DELETE on a locked month's lines — from the API, from the pipeline, and from raw
SQL. Unlock requires an explicit admin confirmation **and** a reason, and both
the lock and the unlock are written to the audit trail.

## Tests

```bash
npm test        # 191 pure engine tests (section 13 covers the recon overrides)
npm run test:p0 # 113 acceptance tests against the live database
npm run verify  # 21 checks on the team's real files
npm run test:all
```

`tests/phase0-db.ts` writes into a synthetic period (2019-01) under a real GSTIN
and deletes it again, so the company's own data is never touched. It proves the
paste path, Save & Re-reconcile, the correction history surviving a second edit,
the ITC decision history, the lock refusing every write, the admin unlock, the
audit trail filters, that a re-import neither duplicates lines nor clobbers human
work, and the whole export → edit → upload loop including its rejections.

## Rollback point

Phase 0 started from a snapshot of the code and a full database dump:

```bash
backup/src, backup/migrations …        # source snapshot
backup/gst_erp_phase0_pre.dump          # pg_dump -Fc of gst_erp before Phase 0
```

To roll back: restore the source from `backup/` and
`pg_restore --clean -d gst_erp backup/gst_erp_phase0_pre.dump`.

---

# Reports, export and re-import

Every screen exports, and the filters on the screen are the filters in the file.

## The catalogue

34 reports, all defined once in [src/app/reports.ts](src/app/reports.ts) — a name, a column
list and one SQL statement each. The screen, the CSV, the single-report Excel and the
15-sheet workbook are four views of the same definition, so they cannot disagree.

**Purchase** — Purchase Register · Purchase Reconciliation · Invoice-wise · Supplier-wise ·
GSTIN-wise · Matched · Missing in 2B · 2B Not in Books · GST Mismatch · Taxable Value
Mismatch · GST Amount Mismatch · Date Mismatch · Invoice Number Mismatch · Possible Match ·
Duplicates · ITC Blocked · Credit Notes · Debit Notes · Amendments

**ITC** — ITC Working · ITC Decision Report · ITC Pending · ITC Claimed · ITC Do Not Claim ·
Query Vendor · Reclaim Later · Ineligible · Reversed · ITC by 2B Month · ITC by Claim Month

**Control** — Audit Trail · Month Locks · GSTR-2B File Registry

### Reports for categories that do not exist yet

`Possible Match`, `Amendments` and `GST Mismatch` depend on matching features that are not
built. They run and return real counts (today: 362 / 0 / 0) rather than disappearing, and
`Possible Match` carries a note explaining its definition:

> booked but absent from 2B, while the same supplier appears in a 2B month within two
> months either side — a review list, never an auto-match.

## Excel formatting

SheetJS community cannot write cell styles or frozen panes, so
[src/app/xlsx-format.ts](src/app/xlsx-format.ts) patches them into the XML afterwards:
a `<pane>` freezes the header, and a bold dark header style is appended to the workbook's
style table. It also contains a small ZIP reader/writer for the job. Every exported
workbook carries:

- a **Report** cover sheet — title, generation time, the filters that produced it, row count
- a **Data** sheet — header row, frozen header, autofilter, sized columns
- money as real numbers with `#,##0.00`, dates as `dd-mmm-yyyy`
- GSTIN / invoice no / taxable / IGST / CGST / SGST / UTGST / CESS as separate columns, plus
  the difference columns and the status and the suggested action

`UTGST` is always zero and is shown as zero. The SAP register carries a single "State/UT
Tax" column, so splitting it would be inventing a number.

## Filters flow into the export

The screen, the CSV, the Excel and the combined workbook all read the same filter set:
GSTIN, month, from/to, supplier GSTIN, vendor, status, ITC decision, return classification,
2B month, decision month, follow-up state and a free-text search. `Download All` is the same
call with the filters cleared, and the file name says what is inside
(`missing_in_2b_2026-03_26AALCS9985J1ZC.xlsx`).

## Download Complete Reconciliation

`GET /api/report/complete.xlsx` builds one workbook with a Dashboard cover and fifteen
sheets: Purchase Summary, Invoice Reconciliation, Supplier Wise, GSTIN Wise, Matched,
Missing in 2B, 2B Not in Books, GST Mismatch, Date Mismatch, Duplicate, ITC Working,
ITC Claim Month, ITC 2B Month, Exceptions, Audit Trail.

## The export → work → upload loop

The Accounts team downloads "Missing in 2B", chases the vendors in Excel, fills in
`Vendor Response`, `Follow-up Date`, `Expected Correction` and `Action Taken` (plus any
reconciliation correction or ITC decision), and uploads the file back from the
**Upload Report** screen.

Rows are matched by **`Line ID`**, which every exported report carries. A file without one is
refused outright — guessing which invoice a row meant is how an audit trail goes quietly
wrong.

**A workbook is read from the sheet that carries a `Line ID`, not from `SheetNames[0]`.**
Every multi-sheet file this system produces put something in front of the data — the report
exports carry a `Report` cover, and the working sheet below carries `Instructions` and the
invoice-wise view — so reading the first sheet refused a file that plainly had a `Line ID` in
it, and the loop only ever worked as CSV. When no sheet carries one, the first sheet is still
the one read, so the "no Line ID" message keeps pointing at a sheet that is really there.

### The invoice-to-invoice working sheet

`/api/template/twob-recon.xlsx` — the button **2B vs Books reco sheet** on the Purchase
Register and Reports screens — is the reconciliation itself as a working file, built from the
run's own rows for the GSTIN and month in the context bar. Three sheets:

| Sheet | What it is |
|---|---|
| Instructions | the how, the rules, and what an upload may change |
| 2B vs Books (invoice-wise) | one row per **invoice** — books total against the 2B invoice, the difference, the status, what to do |
| Line-wise (working) | one row per **purchase line**, with `Line ID` and the fillable columns; this is the sheet that goes back in |

One row per invoice means the **2B side is counted once**, never summed across an invoice's
item lines: every line of a multi-line invoice matched the same 2B invoice and carries the
same 2B figures, so adding them up would count one 2B invoice once per item. The books side is
summed, because those lines really are parts of that invoice's value.

An invoice is identified by **supplier GSTIN + invoice number** — the identity `match.ts`
itself matches on, which is why a duplicate booking is *one* row with `Lines` > 1 and its
`Duplicate Lines` count, rather than two rows where the Duplicate report shows one finding.
The period is part of the identity too: the same invoice number in April and May is two rows,
because those are two months of ITC.

A difference column is **blank** when the invoice never reached 2B. `0` means "compared, no
difference"; blank means "there was nothing on the other side to compare".

`?blank=1` returns the empty skeleton — the file shipped in `templates/`, byte-identical to
what the server sends — and `npm run template:twob-recon` regenerates it.

**May be written:** `recon_supplier_gstin`, `recon_invoice_no`, `recon_invoice_date`,
`itc_decision`, `itc_decision_month`, `decision_reason`, `return_classification`, `remarks`,
`vendor_response`, `follow_up_date`, `expected_correction`, `action_taken`.

**Ignored, and listed as ignored in the preview:** every `book_*` column and every amount. A
file that arrives with "Taxable Value" changed in it cannot alter what the books said.

Validation before anything is written:

| Shown on screen | What it means |
|---|---|
| Records | data rows in the file |
| Matched to a line | rows whose Line ID exists here |
| Valid | rows that can be applied |
| Invalid | rows with a problem — unknown id, duplicate id, unreadable date, unknown decision, locked month |
| Rows with changes | rows where at least one writable field actually differs |
| Unchanged | rows that would write nothing at all |
| Locked month rows | rows refused because the month is locked |

A blank cell means "no opinion" and leaves the current value alone — so re-uploading an
untouched export writes nothing and creates no history (test H34).

## Supplier follow-up

Ranked by ITC at risk: invoices, missing, mismatch, blocked, duplicates, ITC at risk, book
ITC, pending decisions, times chased, last follow-up date and what the vendor said.
Exportable to Excel/CSV with the same filters.

---

## Known gaps

- **GSTR-1 EXP (exports) and ISD** are modelled as empty arrays. The current
  data has no export supplies, but if that changes the tables need filling in.
- **Reverse charge (RCM)** is captured on both registers but not yet pushed into
  GSTR-3B table 3.1(d) as RCM liability.
- **GSTR-9 / annual return** is out of scope.
- Portal `hash` fields in the JSON are `null` — they require a GSTIN login to
  compute, so the offline utility must be used to finish the upload.

---

# PHASE 1 — GST CONTROL CENTRE (system shell)

The application is now a **GST Control ERP shell** rather than a single working
screen. The first screen is the **GST Control Centre** dashboard; the full GST
module tree lives in the left sidebar and every module has its place, whether or
not it is built yet.

## What the shell gives you

| Piece | Where |
|---|---|
| GST Control Centre dashboard | landing screen, `/` |
| Full module sidebar (10 groups, 58 modules) | `.side`, driven by `MODULES` in `index.html` |
| Company / GSTIN / FY / GST Month context bar | `.topbar .ctx` |
| 6 KPI cards (Purchase GST, 2B ITC, ITC Claimed, ITC Pending, Output GST, Net GST Payable) | `#kpiRow` |
| GST month control strip with lifecycle status | `#monthStrip` |
| Monthly GST control checklist (✓ / ● / ○) | `#checklist` |
| GST control scoreboard for the Accounts Head | `#scoreboard` |
| GST exception centre | `#exceptionCentre` |
| GST report centre (live reports + later-phase tiles) | `#reportCentre` |
| Module placeholders | `#viewSoon` — "COMING IN PHASE n" |

## Month lifecycle

A GST month is always exactly one of these, derived in `monthControl()`
(`src/app/store.ts`) and never stored as a hand-set flag:

```
Not Started → Data Imported → Reconciliation Pending → Under Review
            → Ready for Filing → Filed → Locked
```

## The context bar drives everything

`CTX` (company / GSTIN / FY / month) is the single context. Every module screen
inherits it: `loadPhase0()` seeds each screen's own GSTIN/month filters from
`CTX`, so a screen can never contradict the month the Control Centre says is
selected. A screen's own filter still wins when set by hand, and ITC Working
asks for its decision counts with **its own** filters rather than trusting a
global — that mismatch was a real bug, now fixed.

## New endpoint

```
GET /api/control/months?gstin=<GSTIN>
  -> { ready, rows: MonthControlRow[], fys: string[] }
```

One row per GST month: lines, taxable, purchase GST, matched, matched ITC,
missing, mismatch, duplicate, blocked, pending decisions, claimed, follow-ups
open, 2B files/records, lock state, filing state and the derived status.
Read-only — nothing writes from it. Months that exist only as a 2B upload still
appear, so "Not Started" is never invisible.

The aggregates are the regression baseline restated: **9,641** lines,
**438** missing, **37** mismatch, **27** duplicates, and per GSTIN
9,424 / 217 / 0 — summing exactly back to 9,641.

## Deliberately not built yet

- **Output GST / Net GST Payable** show `—` until a pipeline run happens in the
  same server process. They come from the last `MonthlyRun` summary because
  sales data is not persisted like purchases; driving them from the user's ITC
  decisions is Phase 4 (GSTR-3B).
- **Exception counts** come from the month aggregate, so only the six that are
  per-month aggregates carry a number. "2B Not in Books" and "GSTIN wise" show
  `—` and drill into their reports, which count in the records themselves.

## Rollback

`backup/store.ts.pre-shell` and `backup/server.ts.pre-shell` hold the pre-shell
server and store. The pre-shell `index.html` is **not** separately archived —
`backup/src/server/public/index.html` is an older pre-Phase-0 snapshot. The
shell keeps every pre-existing screen and function, so restoring the old file is
not required to run, only to see the old single-page UI again.

---

# USERS AND BRANDING

## Powered by

The sidebar carries **Powered by Vishnu Intelligence Services** in the bottom
corner of the navigation rail, above the input-folder line.

## The team

`migrations/07_users_and_roles.sql` seeds the accounts team, idempotently:

| Username | Display name | Role | Email |
|---|---|---|---|
| `master` | Master User | Master Administrator | master@sakar.local |
| `user-1` | User-1 | Accounts User | user1@sakar.local |
| `user-2` | User-2 | Accounts User | user2@sakar.local |
| `user-3` | User-3 | Accounts User | user3@sakar.local |

**No password is set.** Login does not exist yet, so every row carries the
sentinel `LOGIN_NOT_ENABLED` in `password_hash` rather than a hash that could be
mistaken for a working one. Enabling login must replace that value — it is not a
usable credential today.

## Working as

The top bar has a **Working as** picker. The chosen user is what `actor()`
returns, and therefore what gets written into the audit trail for every
reconciliation edit, ITC decision, return classification, supplier follow-up and
month lock. The choice is remembered in `localStorage` under `gstUser` and
defaults to the master user.

A name typed explicitly into a screen's own "your name" field still wins — an
explicit override beats the default.

`GET /api/users` returns the team with roles and an `isMaster` flag. Read-only:
user administration is a later phase, so this lists what the migration seeded.

## Users screen

`Settings → Users` is now a working screen (no longer "Coming in Phase 3"): the
four accounts with their roles, tiles for user count / master count / who is
working, and a role panel explaining what each role may do.

## Audit-trigger fix (migration 07)

`fn_audit_log()` from migration 01 assumed every audited table has an `id`
column. `user_roles` and `role_permissions` have composite keys, so the first
insert into them failed with `record "new" has no field "id"`. The function now
resolves `entity_id` from the row JSON with a fallback to `user_id`/`role_id`.
The trigger was already attached to those tables, so this was a latent failure
that only surfaced once users were actually assigned roles.

---

## Identity, branding and company logos

The application is now a **GST CONTROL ERP** with a real login, role-based access
and per-company branding. Nothing about the database architecture changed; every
table in `migrations/08_identity_and_logos.sql` and `09_restore_accounts_user_role.sql`
is additive.

### Signing in

`GET /` shows a login card. Nothing loads until `/api/auth/me` confirms a live
session, so no reconciliation data is fetched outside a session. The session is an
`HttpOnly; SameSite=Strict` cookie (`gst_session`), 12 hours, and the token is
stored server-side in `login_sessions` so it can be revoked.

Passwords are hashed with scrypt (`src/app/auth.ts`). Plain text is never stored
and never returned by an API. Expired sessions are purged on boot.

### The accounts team

| Login ID | Display name | Role |
|---|---|---|
| `MASTER` | Vishnu | SUPER ADMIN |
| `USER-1` | User-1 | ACCOUNTS USER |
| `USER-2` | User-2 | ACCOUNTS USER |
| `USER-3` | User-3 | ACCOUNTS USER |

`USER-1..3` are login IDs, not employee names — MASTER can change any display
name from **Settings → Users** without touching the login ID. A third role,
**ACCOUNTS REVIEWER**, is read-and-review only. Roles are extensible: insert a row
into `roles` and grant it rows in `role_permissions`.

`npm run seed:team` (re)issues passwords and prints them once.

### MASTER is protected

The server refuses to disable, rename or re-role the `MASTER` account, no matter
who asks — it can only be managed from the reset path (`npm run seed:team`). There
is deliberately no "delete user" operation: accounts are disabled, so their audit
history stays intact.

### Enforcement is server-side

`requirePerm('control','unlock')` guards the route; the UI's `can()` only decides
what to *show*. Verified: an unauthenticated call to `/api/unlock` is `401`, and
`USER-1` calling it is `403` with `{"error":"Your role (ACCOUNTS USER) cannot
unlock control."}`. Every write route is guarded the same way.

Company and GSTIN access is filtered **in SQL**, not in the browser:
`/api/companies` and `/api/gstins` intersect with `req.user.companyIds` /
`gstinIds`, and `SUPER ADMIN` (null = all) bypasses the filter.

### Company logos

Company Master carries name, short name, PAN, legal name, address, status and
logo. Upload accepts **PNG / JPG / JPEG / SVG** up to 4 MB; the server verifies
the magic bytes, not just the extension, so a renamed `.exe` is rejected. The
selected company's logo appears in the header, the login card, the dashboard and
the sidebar rail. **Without a logo a clean initials plate is shown** — no screen
ever breaks.

Both real logos are installed: Sakar (`company-3-seed.png`) and SVN Opto
(`company-4-*.png`, uploaded through the live endpoint).

### Report branding

Every CSV and xlsx export now opens with the same identity block:

```
GST CONTROL ERP
Company: Sakar
GSTIN: 26AALCS9985J1ZC
Financial Year: 2025-26
Tax Period: 2025-04
Report: Purchase Register (as booked)
Generated On: 2026-10-02 20:34
Generated By: Vishnu (MASTER)
Powered by Vishnu Intelligence Services
```

Built in one place (`reportMeta()` in `src/server/server.ts`) so a CSV and an
xlsx of the same report always agree. CSV carries it as text lines because CSV
cannot hold an image.

### Audit trail

13 action classes are now audited from `src/server/server.ts` (previously the
identity work audited only its own routes): `LOGIN`, `LOGOUT`, `LOGIN_FAILED`,
`PASSWORD_CHANGE`, `PURCHASE_IMPORT`, `REPORT_IMPORT`, `GSTR2B_UPLOAD`,
`RECONCILIATION_RUN`, `RECON_EDIT`, `RETURN_CLASSIFICATION`, `RECONCILE`,
`ITC_DECISION`, `SUPPLIER_FOLLOWUP`, `SUPPLIER_RESPONSE`, `MONTH_LOCK`,
`MONTH_UNLOCK`, `REPORT_EXPORT`, plus company/user/role/access changes.
Audit rows are written by trigger and are not editable through the application.

### Regression status

Unchanged and re-verified after this work: engine **191 passed**, Phase 0
live-DB **113 passed**, real-data verify **21 passed**, `tsc --noEmit` clean.
Baseline reproduced exactly — purchase 9,641 · 2B 10,952 · exceptions 502 ·
blocked 0 · 4A(i) pending ₹48,00,130.79.
