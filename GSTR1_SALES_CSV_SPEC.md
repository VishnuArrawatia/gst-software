# GSTR-1 Sales CSV — FINAL Format (approval ke liye)

**Status: proposal — koi source code, database, configuration ya business data badla nahi gaya.**
Read-only: `src/engine/*`, `src/app/pipeline.ts`, `migrations/*`, `gstins`/`units` masters par `SELECT`,
`test-input/` ki SAP file ka header. Temporary scripts use ke baad delete.

Do sample files (dono 32 column, har row verified):

- `templates/Sales CSV GSTR1 - Sakar Units 1 and 3 (sample).csv` — Unit-1 + Unit-3 ek file me
- `templates/Sales CSV GSTR1 - SVN (sample).csv` — SVN (Unit-I + Unit-II, ek GSTIN)

---

## 1. Aapke 4 jawab (mandat, format inhi par bana hai)

| Aapka jawab | Format par asar |
|---|---|
| SAP se **item-wise rows** nikal sakte hain | Ek row = ek item/rate line; software invoice par group karega (§4) |
| **Place of Supply CSV me state ka naam** likhenge | `Place of Supply` column; `Rajasthan` / `Other Country` — leading-zero trap se bacha |
| Outward me sirf **credit/debit note** aate hain | Export / SEZ / Nil-Exempt / Advance ke columns **hata diye** (5 kam) |
| Freight **alag dikhta hai aur GST uspar bhi lagta hai** | Freight ka apna **item row** banta hai (taxable), koi derived tax nahi (§4.2) |

---

## 2. Live data (4,099 sales rows — aaj ka asli shape)

| GSTIN | Unit | Rows | Period | Type | Customer GSTIN blank | HSN | POS | Note ref |
|---|---|---|---|---|---|---|---|---|
| `26AALCS9985J1ZC` | Unit-1 | 4,099 | 2025-04 → 2026-03 | sab `R` | 0 | 100% khaali | 100% khaali | 0 |
| `24AALCS9985J1ZG` | Unit-3 | 0 | — | — | — | — | — | — |
| `26ABFCS9511H1Z7` | SVN | 0 | — | — | — | — | — | — |

Aaj: sirf Unit-1, **sab B2B regular**, na HSN, na place of supply, na ek bhi note/export/B2C.
`gstr1_documents` me sirf B2B rows hain. Matlab B2C / CN / multi-item raaste **sirf samples se**
verify ho sakte hain, asli data se nahi.

---

## 2b. SAP ka ASLI export (SAP Sales Register Apr25-Mar26.xlsx) — 2026-10-11 measured

Upar ka 32/34-column template ye hai jo SAP B1 ko dena chahiye. SAP aaj jo
register deta hai (`test-input/SAP Sales Register Apr25-Mar26.xlsx`) wo is
11-column, ek-row-per-INVOICE shape me aata hai — aur ye ab poora parse hota hai:

| Header | Engine field | Note |
|---|---|---|
| `Invoice Date` (Excel serial) | `invoice_date` | mahina isi se banta hai |
| `Invoice No` | `invoice_no` | |
| `CardCode Name` | `card_code` | SAP ka party CODE (C00001…), legal naam NAHI — ab `SalesInvoice.card_code` me aata hai |
| `Customer Name` | `customer_name` | party ka asli naam |
| `GSTIN` | `customer_gstin` | sales file me bare "GSTIN" ka matlab RECIPIENT hai |
| `ToLocation` | `place_of_supply` | city ka naam (Bhiwandi, Kasaba Hobli…) — jaisa hai waisa rakha jaata hai, state par guess nahi |
| `Taxable Amount` | `taxable_value` | |
| `IGST AMT` / `CGST AMT` | `igst` / `cgst` | |
| `UTGST AMT` | `sgst` | usi column me jaata hai — pehle ye drop hota tha aur 823 intra-state invoice V7 se UTGST ke barabar fail ho rahe the |
| `Invoice Value` | `invoice_value` | |

File me hi nahi hai: `Our GSTIN`, `Invoice Type`, item columns (HSN/UQC/Qty/Rate) aur `CESS`.

- **4,099 rows, 0 skipped, 0 issues** (aliases fix ke baad); FY totals sheet ke apne
  TOTAL row se paisa-barabar milte hain (taxable ₹1,05,59,73,954.19;
  invoice value ₹1,24,55,10,693.84).
- Rows me `Our GSTIN` hota hi nahi — pipeline inhe `--sales-gstin <GSTIN>` se
  attribute karta hai (ya UI ki company selection se). Har registration ka apna
  export dein, ya CLI har GSTIN ke liye dobara chalayein.
- Ek row = ek invoice: item columns nahi, isliye `itemLevel=false`. Is file se
  bana HSN summary rate-wise hai aur qty 0 hai — imaandaar, par item-grade nahi.
  Quantity wala HSN summary chahiye to upar wala 34-column template export karein.
- POS ek CITY hai, state nahi. B2B rows customer-GSTIN se classify hote hain
  (safe); B2C ke liye SAP se ToLocation ke saath STATE ka naam bhi maangna hoga.

Ye 11 header alias ke through hamesha padhe jayenge, chahe SAP B1 34-column
template adopt na kare.

---

| # | Header | Kya | Zaroori? | Aaj padha jaata? |
|---|---|---|---|---|
| 1 | `Our GSTIN` | Kis registration ki sale (3 me se ek) | HAAN | ✅ |
| 2 | `Unit` | Sakar-I / Sakar-III / SVN Unit-I / SVN Unit-II | Nahi | ✅ |
| 3 | `Customer Code` | SAP card code (master mapping) | Nahi | ✅* |
| 4 | `Customer Name` | Party ka naam | HAAN (B2B) | ✅ |
| 5 | `Customer GSTIN` | 15-char recipient GSTIN; khaali = B2C | Nahi | ✅ |
| 6 | `Recipient Type` | Registered / Unregistered | Nahi | ❌ naya |
| 7 | `Place of Supply` | **State ka naam** (`Rajasthan`, `Other Country`) ya 2-digit code | B2C me HAAN | ✅ |
| 8 | `Reverse Charge` | Yes / No | Nahi | ✅ |
| 9 | `Invoice Type` | `R` = invoice, `CN` = credit note, `DN` = debit note | Nahi (=R) | ✅ |
| 10 | `Invoice No` | Invoice / note ka apna number | HAAN | ✅ |
| 11 | `Invoice Date` | `YYYY-MM-DD` — **mahina isi se banta hai** | HAAN | ✅ |
| 12 | `Line No` | Invoice ke andar item ka serial (1,2,3…) | HAAN | ❌ naya |
| 13 | `Invoice Value` | Pura invoice amount; **har line par same** | HAAN | ✅ |
| 14 | `Original Invoice No` | CN/DN kis invoice ko correct kar raha hai | CN/DN par HAAN (registered) | ✅ |
| 15 | `Original Invoice Date` | Us original invoice ki date | CN/DN par HAAN | ✅ |
| 16 | `Item Description` | Item ka naam (="Freight and other charges" bhi) | HAAN | ❌ naya |
| 17 | `HSN` | HSN / SAC | HAAN | ✅ |
| 18 | `UQC` | PCS / KGS / MTR / NOS… | HAAN | ❌ naya |
| 19 | `Quantity` | Line ki qty (CN/freight row me 0) | HAAN | ❌ naya |
| 20 | `GST Rate` | 0 / 0.25 / 3 / 5 / 12 / 18 / 28 | HAAN | ❌ naya |
| 21 | `Taxable Value` | Line ka taxable | HAAN | ✅ |
| 22 | `IGST` | Inter-state tax | Nahi | ✅ |
| 23 | `CGST` | Central tax | Nahi | ✅ |
| 24 | `SGST` | State/UT tax — **UTGST bhi isi column me** | Nahi | ✅ |
| 25 | `CESS` | Compensation cess | Nahi | ✅ |
| 26 | `Amendment Of Invoice No` | Pehle file kiye invoice ka number (B2BA/CDNRA) | Nahi | ❌ naya |
| 27 | `Amendment Of Invoice Date` | Us filed invoice ki date | Nahi | ❌ naya |
| 28 | `E-Commerce GSTIN` | E-com operator ka GSTIN (agar sale e-com se) | Nahi | ❌ naya |
| 29 | `Doc Nature` | "Invoices for outward supply" | Nahi (per-series) | ❌ naya |
| 30 | `Doc Series From` | Series ka pehla serial (digits) | Nahi | ❌ naya |
| 31 | `Doc Series To` | Series ka aakhri serial | Nahi | ❌ naya |
| 32 | `Doc Series Cancelled` | Cancel hue invoice ki ginti | Nahi | ❌ naya |

\* `Customer Code` alias `card_code` se map hota hai; sales parser aaj ise uthata nahi (harmless).
**Aaj 32 me se 13 columns ignore hote hain** (measured) — aur sales file ke liye "ignored columns"
ka warning **log hi nahi hota** (sirf purchase/2B ke liye hota hai).

---

## 4. Invoice-versus-item handling (aapka key requirement)

### 4.1 Row = item line, software invoice par group karta hai

| Kya | Rule |
|---|---|
| Group key | `Our GSTIN` + `Invoice No` + `Invoice Date` |
| Money | line-wise **sum**: `Taxable Value`, `IGST`, `CGST`, `SGST`, `CESS` |
| `Invoice Value` | **ek hi baar** ginti (baaki lines par same hona zaroori) |
| `itms` | har distinct `GST Rate` (+HSN) ek `itm_det` line |
| HSN summary | har line se: HSN + rate + qty + uqc |
| B2CS | group by `Place of Supply` + rate (invoice number matter nahi karta) |

Isi wajah se **aaj ka engine ye file sahi nahi padh sakta**: `sales_invoices` aur
`gstr1_documents` dono par UNIQUE index `(gstin_id, invoice_number_norm, invoice_date)` hai —
identity **invoice** hai, item nahi. Grouping pehle honi zaroori hai, warna `ON CONFLICT`
dusri line ko pehli par likh dega.

**Measured (final samples, aaj ka engine):**

| GSTIN | `Invoice Value` engine | Sahi (ek baar) | Farq | Error |
|---|---|---|---|---|
| `26AALCS9985J1ZC` | 4,07,640 | **3,50,140** | **+57,500** | duplicate ERROR (INV-1002) |
| `24AALCS9985J1ZG` | 1,31,452 | **95,226** | **+36,226** | duplicate ERROR (INV-3002) |
| `26ABFCS9511H1Z7` | 2,30,100 | 2,30,100 | 0 | — |

Taxable side aaj hi sahi hai (line-wise sum hota hai) — sirf `Invoice Value` repeat hoti hai.

### 4.2 Freight / other charges (aapke jawab ke hisaab se)

Freight par GST lagta hai, isliye wo **usi invoice ka ek item row** hai:

```
Invoice No INV-3002 | Line 1 | goods   | HSN 8536 | 18% | taxable 30,000 | CGST 2,700 | SGST 2,700
Invoice No INV-3002 | Line 2 | "Freight and other charges (taxable)" | HSN 8536 | 18% | taxable 700 | CGST 63 | SGST 63
Invoice Value dono par: 36,226.00        (30,000+2,700+2,700 + 700+63+63 = 36,226 ✔)
```

Fayda: invoice ka arithmetic line-by-line sach rehta hai, engine ko tax **derive** nahi karna padta,
aur GSTR-1 (jisme freight ka koi field hi nahi hai) bina kisi extra column ke bharta hai.
Chahें to freight ko goods line ki taxable value me mila bhi sakte hain — return same aayega.

---

## 5. Column mapping (CSV → engine → GSTR-1 JSON → DB)

| CSV header | Engine field | JSON | Table | DB column |
|---|---|---|---|---|
| `Our GSTIN` | `our_gstin` | `gstin` | — | `gstins.gstin_number` |
| `Unit` | `unit_name` | — | — | `units.name` |
| `Customer Code` | `card_code` (aaj unused) | — | — | master map |
| `Customer Name` | `customer_name` | counterparty | — | `recipient_name` |
| `Customer GSTIN` | `customer_gstin` | `ctin` | 4A, 9A grouping | `recipient_gstin_*` |
| `Recipient Type` | *naya* | — (validation) | — | *naya* |
| `Place of Supply` | `place_of_supply` | `pos` (4A, 5A, 5B, 9B) | routing + B2CL | `place_of_supply`, `pos_code` |
| `Reverse Charge` | `reverse_charge` | `rchrg` Y/N | 4A/5A/9A/9B | `reverse_charge` |
| `Invoice Type` | `invoice_type` | `inv_typ` / `ntty` C\|D | routing | `invoice_type` |
| `Invoice No` | `invoice_no` | `inum` / `nt_num` | 4A/5A/5B/9A/9B | `invoice_number_raw/norm` |
| `Invoice Date` | `invoice_date` → `period` | `idt` / `nt_dt` (DD-MM-YYYY) | saare | `invoice_date`, `period` |
| `Line No` | *naya* | `itms[].num` | 4A/5A/9A/9B | *naya* (`sales_invoice_items`) |
| `Invoice Value` | `invoice_value` | `val` | 4A/5A/9A/9B | `invoice_value` |
| `Original Invoice No/Date` | `note_ref_no` / `note_ref_date` | `inum` / `idt` (9A/9B) | 9A/9B | `note_ref_number/date` |
| `Item Description` | *naya* | `hsn.data[].desc` | 12 | *naya* |
| `HSN` | `hsn` | `hsn_sc` | 12 + `itms` | `hsn` |
| `UQC` / `Quantity` | *naya* | `uqc` / `qty` | 12 | *naya* |
| `GST Rate` | *naya* (aaj derive) | `itms[].itm_det.rt`, `hsn.data[].rt` | 4A/5A/9A/9B/12 | `rate` |
| `Taxable Value` | `taxable_value` | `itm_det.txval` | saare | `taxable_value` |
| `IGST` / `CGST` / `SGST` / `CESS` | same naam | `iamt` / `camt` / `samt` / `csamt` | saare | `igst`/`cgst`/`sgst`/`cess` |
| `Amendment Of Invoice No/Date` | *naya* | `oinum` / `oidt` | 4A-amend / 9A-amend | *naya* |
| `E-Commerce GSTIN` | *naya* | `etin` | 4A | *naya* |
| `Doc Nature/From/To/Cancelled` | *naya* | `doc_issue.doc_det[].docs[].{from,to,cancel}` | DOC_ISSUED | *naya* |

`SGST` column me UTGST ka amount bhi likhein (GSTR-1 me ek hi `samt` field hai).

---

## 6. GSTIN separation aur outputs (ye aaj hi kaam karta hai)

`Our GSTIN` column se hi separation hoti hai — file ek hi rakhein, return alag banegi:

```
output/returns/26AALCS9985J1ZC_2026-04_GSTR1.json     <- Sakar Unit-1
output/returns/24AALCS9985J1ZG_2026-04_GSTR1.json     <- Sakar Unit-3
output/returns/26ABFCS9511H1Z7_2026-04_GSTR1.json     <- SVN
        ... har GSTIN ke liye _GSTR3B.json bhi
output/GST Monthly <date>.xlsx  -> GSTR-1 aur GSTR-3B sheets, GSTIN-wise blocks
```

`SVN Unit-II` ka alag GSTIN nahi hai, isliye uske rows usi SVN file me `Unit = SVN Unit-II`
ke saath aate hain (sample me dikhaya hai). Upload ke liye UI me alag sales screen **abhi nahi hai**
(Sales Register tab Phase 3 me hai) — file **run ke input folder** me daali jaati hai
(Data Intake & Run screen, ya `npm run cli`).

---

## 7. Validation rules (final set)

| # | Rule | Level |
|---|---|---|
| V1 | `Our GSTIN` teen registrations me se ek ho aur valid 15-char | ERROR |
| V2 | `Invoice No` non-empty; `(Our GSTIN, Invoice No, Invoice Date)` = ek invoice | ERROR |
| V3 | `Invoice Date` `YYYY-MM-DD` (ya Excel serial) | ERROR |
| V4 | Ek invoice ki saari lines par `Invoice Value` **same** (±0.01) | ERROR |
| V5 | `Invoice Value` blank na ho (iske bina file sales register hi nahi pehchani jaati) | ERROR |
| V6 | `(Our GSTIN, Invoice No, Invoice Date, Line No)` duplicate na ho | ERROR |
| V7 | `Invoice Value = Σ Taxable + Σ IGST + Σ CGST + Σ SGST + Σ CESS` (±1) per invoice | ERROR |
| V8 | Har line: `Taxable Value`, `GST Rate`, `Quantity` numeric (khaali → 0 nahi, reject) | ERROR |
| V9 | `GST Rate` legal slab me aur `|derived − printed|` ≤ 0.01 | ERROR |
| V10 | Intra-state (POS state = Our GSTIN state) ⇒ `IGST = 0`, `CGST = SGST` | ERROR |
| V11 | Inter-state ⇒ `CGST = SGST = 0`, `IGST > 0` | ERROR |
| V12 | `Customer GSTIN` diya ho to valid 15-char **aur** uska state = `Place of Supply` | ERROR |
| V13 | `Customer GSTIN` khaali ⇒ `Place of Supply` **zaroori** (warna `b2cs` bina `pos`) | ERROR |
| V14 | `Customer GSTIN` khaali + inter-state + `Invoice Value` > ₹1,00,000 ⇒ B2CL, warna B2CS | INFO |
| V15 | `Invoice Type` = CN/DN ⇒ registered customer par `Original Invoice No` + `Date` zaroori | ERROR |
| V16 | CN/DN ke amounts **negative** (taxable ≤ 0, tax ≤ 0) | ERROR |
| V17 | Har line par `HSN`, `UQC`, `Item Description` bhare ho (freight row bhी) | ERROR |
| V18 | `HSN` 4/6/8 digit; `UQC` valid code; `Quantity` ≥ 0 | ERROR |
| V19 | `Amendment Of Invoice No` bhara ho ⇒ us invoice ka period **pichhle** mahine ka ho | ERROR |
| V20 | `Total`/`Grand Total` jaisi row na ho (na invoice no, na GSTIN) | ERROR |
| V21 | `Place of Supply` 1-digit ho gaya (leading zero gaya) ⇒ pad karke 2-digit, warna reject | WARN |
| V22 | Jo column engine use nahi karta, use chupchaap na chhodo — report me "ignored columns" likho | WARN |

### Duplicate total rokne ka guard
1. `Our GSTIN + Invoice No + Invoice Date` par group.
2. `Invoice Value` **ek baar**; ek invoice par do alag value → V4 ERROR.
3. Money lines se **sum**, repeat nahi.
4. Cross-check: `Σ distinct Invoice Value == Σ lines (taxable + tax)` (±₹1 per invoice),
   `totals.invoices == distinct invoice count`, `Σ B2CS taxable == B2C lines ka taxable`.
5. Koi bhi difference → run **fail**, chup na rahe. Aaj measured farq: ₹57,500 aur ₹36,226.

---

## 8. Sample files me kya-kya dikhaya gaya

### SAKAR (Unit-1 + Unit-3, 10 rows → 8 invoices)

| Invoice | Dikhata hai |
|---|---|
| `INV-1001` (Unit-1, B2B inter-state 18%) | saada B2B + Doc series columns |
| `INV-1002` **2 lines** (18% + 12%) | multi-item invoice, `Invoice Value 57500.00` dono par |
| `INV-1003` (B2C inter-state ₹1,41,600) | **B2CL** (POS "Rajasthan") |
| `INV-1004`, `INV-1005` (B2C intra-state) | **B2CS** (POS "26") |
| `CN-0007` + Original Invoice No/Date | **CDNR**, negative amounts |
| `INV-3001` (Unit-3 intra-state) | Unit-3 ka apna return |
| `INV-3002` **2 lines** (goods + freight) | freight taxable item row, `Invoice Value 36226.00` |

### SVN (4 rows, `26ABFCS9511H1Z7`)

B2B inter-state, B2B intra-state (`Unit = SVN Unit-II` — **same** `SVN/2526/...` series aur same
GSTIN, kyunki ek registration ki ek hi series hoti hai; Unit-II ki alag sales series ho to bataiye),
ek credit note (registered), aur ek B2C → B2CS. Sab ek hi GSTIN par.

---

## 9. Acceptance numbers (implementation in par test hogi)

| File | GSTIN | Invoices | Taxable | IGST | CGST | SGST | Invoice Value |
|---|---|---|---|---|---|---|---|
| SAKAR | `26AALCS9985J1ZC` | 6 | 2,98,000 | 46,200 | 2,970 | 2,970 | **3,50,140** |
| SAKAR | `24AALCS9985J1ZG` | 2 | 80,700 | 0 | 7,263 | 7,263 | **95,226** |
| SAKAR file total | — | 8 | 3,78,700 | 46,200 | 10,233 | 10,233 | **4,45,366** |
| SVN | `26ABFCS9511H1Z7` | 4 | 1,95,000 | 25,200 | 4,950 | 4,950 | **2,30,100** |

Unit-1 ka GSTR-1: **B2B 2 invoice** (INV-1002 me 2 `itm_det`), **B2CL 1** (INV-1003),
**B2CS 1 line** `(POS 26, INTRA, 18%, OE) = 33,000 taxable / 2,970+2,970`, **CDNR 1**,
**HSN 3 row** (8536@18 = 1,53,000; 8537@12 = 25,000; 8537@18 = 1,20,000).
Unit-1 ka 3B: 3.1(a) 2,98,000, output tax **52,140** (46,200+2,970+2,970).
Unit-3 ka 3B: 3.1(a) 80,700, output tax **14,526**. SVN: 3.1(a) 1,95,000, output tax **35,100**.

---

## 10. Existing software me kya badalna padega (5 steps)

1. **Parser me item grouping** — `src/engine/ingest.ts`: `(our_gstin, invoice_no, invoice_date)`
   par group, money sum, `Invoice Value` ek baar, `SalesInvoice.items: ReturnItem[]` (har rate/HSN
   ek item). Purana invoice-level input waise hi chalta rahe.
2. **Model + items** — `src/engine/gstr1.ts`: `itemsOf()` ab `inv.items` use kare (aaj ek blended
   rate banata hai); HSN bucket key me `qty`/`uqc`/`desc` jode.
3. **Portal JSON** — `b2cs` me `pos` (aur `sply_ty` sahi), HSN me `qty`/`uqc`/`desc`,
   `doc_issue` series se, `gt`/`cur_gt`. `doc_issued` naam GSTN schema me `doc_issue` hai — **verify**.
4. **Storage** — `sales_invoices` par naye nullable columns (line-level ke liye nayi
   `sales_invoice_items` table: line_no, hsn, qty, uqc, rate, amounts). Purana unique index waise hi.
5. **Template + validation report** — yahi 32 columns ka template, aur upload par wahi
   "preview + har reject ki wajah" report jo purchase register me hai (aaj sales ke liye nahi hai).

**Phase-2 (aaj zaroori nahi):** amendment tables (`b2ba`/`cdnra`) — `Amendment Of Invoice No`
bhara ho tab file ko amendment table me bhejna. Columns aaj se CSV me rahenge taaki file dobara
change na karni pade.

**Verify nahi ho saka (offline utility chahiye):** `b2cs.pos`, HSN `qty`, aur CN/DN ka sign
(portal positive value leta hai ya negative). Ye "expected" hain, "proven" nahi.

---

## 11. Aapki requirement vs ye format

| Requirement | Kahan |
|---|---|
| Ek SAKAR CSV (Unit-1 + Unit-3) | column 1 + 2, ek file |
| Alag SVN CSV | dusri file, ek GSTIN |
| Teen alag GSTR-1 | §6 (aaj bhi banta hai) |
| GSTIN-wise GSTR-3B summary | §6 (aaj bhi banta hai) |
| Invoice / customer / item / HSN / rate / tax / cess | columns 1–25 |
| Freight + other charges | §4.2 (taxable item row) |
| Place of supply | column 7 + V13/V21 |
| Credit / debit notes | columns 9, 14, 15 + V15/V16 |
| Amendments | columns 26–27 (phase-2 me use) |
| Duplicate invoice total rokna | §4.1 + §7 guard + V4/V6/V7 |
