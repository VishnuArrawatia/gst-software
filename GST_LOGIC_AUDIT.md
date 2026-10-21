# GST ERP — Logic aur GST Rules Audit

**Date:** 2026-10-08
**Scope:** poore software ka logic + GST ke rules/regulation/formula ki correctness
**Data:** live DB `gst_erp` (PostgreSQL 18) — 9,641 purchase lines, 10,952 GSTR-2B lines, 4,099 sales rows

---

## 1. Seedha jawab — "GST ke rules aur formula sahi hain ya nahi?"

**90% formulas sahi hain, aur do jagah GALAT the — dono aaj theek kiye gaye.**

| GST rule (section / table) | Software me kahan | Verdict |
|---|---|---|
| ITC sirf GSTR-2B me mile invoice par — **cl. 16(2)(aa)** | `src/engine/match.ts` `reconcilePurchases` | ✅ SAHI |
| Blocked/ineligible credit **4(B) me REVERSE**, kabhi 4(A) me add nahi — **cl. 16(4)** | `src/engine/gstr3b.ts` `itcDetailFromRecon` | ✅ SAHI (pehle bug tha, theek kiya) |
| Double booking = double claim, isliye Duplicate ko 4(A) se bahar | `gstr3b.ts` `case 'Duplicate'` | ✅ SAHI |
| **4(C) = 4(A) − 4(B)** | `gstr3b.ts:282` `itcAvailed = itcAvailable − itcReversed` | ✅ SAHI (pehle JOD raha tha — galat tha) |
| Amount mismatch par **portal (2B) ka amount** hi claim hoga, books ka nahi | `gstr3b.ts` `case 'Amount Mismatch'` | ✅ SAHI — 2B hi authority hai |
| Books me hai par 2B me nahi → **4(A)(i) pending**, 4(A) me nahi | `gstr3b.ts` `case 'Missing in 2B'` | ✅ SAHI (conservative, portal-safe) |
| ITC claim ki **deadline 30 November** (agle FY) — **cl. 16(4)(d)** | `src/engine/control.ts` `lapseRisk()` | ✅ SAHI (`startYear + 1`, 30 Nov 23:59) |
| GSTR-3B 3.1 numbering — (a) taxable (b) zero-rated (c) nil+exempt (d) inward RCM (e) non-GST | `gstr3b.ts` | ✅ SAHI (pehle invented table numbers the; theek kiya) |
| Zero-rated ko 3.1(c) me **nahi** ginna (double count) | `gstr3b.ts` `exempt` filter | ✅ SAHI (pehle export dono jagah aa raha tha) |
| Credit note par claim nahi — **REVERSE** karna hota hai | `match.ts:320`, `gstr3b.ts` | ✅ SAHI |
| **B2CL threshold** — inter-state B2C invoice jiski value threshold se zyada | `src/engine/gstr1.ts` | ⚠️ **GALAT THA → AAJ FIX** (dekho Defect 2) |
| B2CS intra vs inter (`sply_ty` INTRA/INTER) | `gstr1.ts` portal JSON | ✅ SAHI |
| B2B recipient GSTIN ke hisaab se group (portal schema) | `gstr1.ts` `grouped()` | ✅ SAHI |
| CDNR me debit note `DN`, credit note `CN`, `nt_num`/`nt_dt`/`inum`/`idt` | `gstr1.ts` | ✅ SAHI |
| **CDNUR (table 9B)** — unregistered recipient ke credit/debit notes, `typ` (B2CL/B2CS/EXPWP/EXPWOP) ke saath | `gstr1.ts`, `gstr1-recon.ts`, migration 20 | ✅ **AAJ ADD HUA** |
| HSN summary `hsn_sc` + rate ke saath | `gstr1.ts` | ✅ SAHI |
| Amendment tables (b2ba/b2cla/…) khaali — har invoice **do baar** declare nahi hona chahiye | `gstr1.ts` | ✅ SAHI (pehle poora copy bhar deta tha — portal par double declaration) |
| Sale register / filed GSTR-1 reconciliation (duplicate detect pehle, phir match) | `src/engine/gstr1-recon.ts` | ✅ SAHI |
| P&L vs GSTR-1: taxable-basis compare, latest amendment wins | `src/engine/pl-recon.ts` | ✅ SAHI |

---

## 2. Aaj ke session me mile 2 REAL defect (dono fix + test)

### Defect 1 — Reports ka filter system har non-purchase report ko 500 kar deta tha 🔴 HIGH

**Kya galat tha:** Screen ka ek hi filter bar hai, lekin reports **paanch alag tables** padhti hain. `buildWhere()` har filter ko `purchase_lines` ke column naam se likh raha tha, poori table ko ek hi dhaancha maan kar:

- `period` → `t.period` (par 2B table me wo **`twob_month`** kehlata hai)
- `supplier` → `t.book_supplier_gstin` (2B me **`supplier_gstin`**)
- audit-trail / month-locks / twob-files me `party_name`, `match_status` **exist hi nahi karte**

Aur UI context bar se month khud bhar deta hai (`index.html` ~4263), to Reports screen kholte hi **har non-purchase report** toot jati thi.

**Live proof (curl, purane code par):**
```
twob-not-in-books?period=2025-04      → {"error":"column t.period does not exist"}
credit-notes?period=2025-04           → {"error":"column t.period does not exist"}
debit-notes?vendor=SHIVAM             → {"error":"column t.party_name does not exist"}
audit-trail?q=invoice                 → {"error":"column \"party_name\" does not exist"}
month-locks?status=Matched            → same
/api/report/complete.xlsx?period=...  → HTTP 500   ← flagship "Download Complete Reconciliation"
```

**Fix:** `src/app/reports.ts` me **profile-aware `buildWhere()`**. Har report ab batati hai ki wo kaunsi table padhti hai (`ReportDef.profile`), aur filter sirf us table ke asli column par lagta hai. Jo filter us table par lag hi nahi sakta (jaise 2B report par "match status") use SQL me galat column ke roop me nahi badla jata — **"Not applicable to this report (ignored)"** likh kar file ke filter echo me bata diya jata hai.

**Fix ke baad (live):** neeche sab **200**:
```
twob-not-in-books?period=2025-04 → total 79 ✔   credit-notes?period=2025-04 → 48
debit-notes?vendor=SHIVAM → 0      audit-trail?q=invoice → 90
audit-trail?status=Matched → 241   month-locks?q=test → 0        twob-files?period=2025-04 → 2
/api/report/complete.xlsx?period=2025-04 → HTTP 200, 296 KB
```

**Positive control:** `twob-not-in-books?period=2025-04` = **79 rows**, jo ground-truth SQL se exactly match karta hai — matlab month filter sach me lag raha hai, ignore nahi ho raha.

**Tests:** [tests/run.ts](tests/run.ts) section **26** (buildWhere per profile, unknown status → `false`, ignored-filter echo) + [tests/phase0-db.ts](tests/phase0-db.ts) section **L** (har report × 5 filter set = live schema par 135 checks + ground-truth control).

---

### Defect 2 — B2CL threshold purana tha (₹2,50,000 → ₹1,00,000) 🔴 HIGH (GST RULE)

**Kya galat tha:** `src/engine/gstr1.ts` me `B2CL_THRESHOLD = 250000` hardcoded tha.

**Asli rule:** B2CL = inter-state supply, unregistered recipient, **invoice value > threshold**. 53rd GST Council (22 June 2024) ne threshold **₹2.5 lakh se ₹1 lakh** kar diya, **1 August 2024** ke tax period se (Notification 12/2024-Central Tax). Multiple sources se verify kiya (GST portal FAQ, Tally, Cashflo, Aditya Birla, india-compliance issue #2413).

**Impact:** FY 2025-26 ke data par ₹1 lakh se ₹2.5 lakh ke beech ki inter-state B2C invoice **B2CS (consolidated) me chali jaati thi** B2CL (invoice-wise) ke bajaye — matlab GSTR-1 ka **galat table**. Ye rounding ka masla nahi, liability kis table me declare hogi wo badal jata hai.

**Fix:** threshold ab **period-aware** hai —
```ts
export const B2CL_THRESHOLD = 100000;          // 2024-08 se aage
export const B2CL_THRESHOLD_LEGACY = 250000;   // 2024-07 tak
export function b2clThresholdFor(period: string) {
  return period && period < '2024-08' ? B2CL_THRESHOLD_LEGACY : B2CL_THRESHOLD;
}
```
`buildGstr1()` ab `b2clThresholdFor(period)` use karta hai.

**Tests:** [tests/run.ts](tests/run.ts) section **27** — ₹1.5L inter-state B2C 2025-04 me B2CL (aur B2CS me nahi), wahi sale Jan-2024 me B2CS, boundary (exactly ₹1,00,000 = B2CL nahi, kyunki rule "more than" hai).

---

### Feature 3 — CDNUR (GSTR-1 table 9B) ab supported 🟢

**Pehle kya hota tha:** Unregistered customer ka credit/debit note bhi **CDNR (9A)** me daal diya jaata tha. 9A portal par recipient GSTIN se group hota hai — unregistered note me GSTIN hi nahi hota — isliye aisi file **reject** hoti. Aur DB ke `gstr1_table_type` enum me `'CDNUR'` hi nahi tha, to row **store bhi nahi** hoti thi.

**Ab kya hota hai:**
- Note **registered** customer ka → **CDNR (9A)**, original invoice reference mandatory (missing = ERROR).
- Note **unregistered** customer ka → **CDNUR (9B)**, aur `typ` set hota hai: inter-state + is period ka threshold cross → `B2CL`, warna `B2CS`. Export/SEZ note → `EXPWP`/`EXPWOP` **plus** ek warning ki CA confirm kare (export proceeds aaye ya nahi, ye books se pata nahi chalta).
- Portal JSON me `cdnur` ek **flat array** hai (koi `ctin` nahi — group karne ke liye GSTIN hi nahi hai), fields: `typ`, `ntty`, `nt_num`, `nt_dt`, `val`, `pos`, `rchrg`, `inum`, `idt`, `itms`. `inv_typ` **jaan-boojh kar nahi** bhejte kyunki 9B record me wo field nahi hai.
- 9B me original invoice reference **optional** hai (portal explicitly allow karta hai), isliye wo sirf WARNING hai, ERROR nahi.
- Debit note apni identity rakhta hai (`ntty` = `D`).

**Files:** [gstr1.ts](src/engine/gstr1.ts) (routing + `noteType` + portal `cdnur` + sheet + `sect`), [gstr1-recon.ts](src/engine/gstr1-recon.ts) (table type, draft documents, filed classification), [gstr1-import.ts](src/engine/gstr1-import.ts) (cdnur sheet), [pl-recon.ts](src/engine/pl-recon.ts) (credit-note head me CDNUR bhi), [migrations/20_gstr1_cdnur_table_type.sql](migrations/20_gstr1_cdnur_table_type.sql).

**Tests:** engine section **28** (routing, `typ` threshold se, portal schema, flat-not-grouped, `sect`, WARNING vs ERROR, `parseTableType`, `classifyFiled`, summary row) + live DB section **M** (CDNUR row sach me insert hota hai; **aur 9A ka "no original invoice" rule abhi bhi refuse karta hai** — migration ne purana rule dheela nahi kiya).

**Live proof:** enum me `CDNUR` aa gaya (`pg_enum` se confirm), `schema_migrations` me file recorded, server restart ke baad saare report endpoints 200.

**Ek honest caveat:** live data me aaj tak ek bhi unregistered note nahi hai (saari 4,099 sales rows registered hain), isliye asli books se banne wala draft abhi khaali `cdnur` bhejega. Ye raasta **tests se proven** hai, asli unregistered note ke aane par hi live dikhega.

---

## 3. Jo areas SUPPORTED HI NAHI hain (honest list — yahan report aayegi hi nahi)

Ye galti nahi hai, ye **missing feature** hai. In par bharosa mat karo:

| Missing | Detail |
|---|---|
| **EXP / SEZ / Exempt outward ka reconciliation** | Filed GSTR-1 rows DB me nahi hain, isliye outward reconciliation sirf books par chalti hai. |
| **Rule 42 / 43** | Common credit (input + capital goods) ka apportionment nahi hai. |
| **Table 4(A)(5) capital goods, 4(D)(2)** | Model nahi kiya gaya. |
| **3.1.1 interest + late fee** | Calculate nahi hota. |
| **Rule 37 — 180 din me payment nahi to ITC reverse** | Enforce nahi hota. |
| **HSN digit rule (turnover ke hisaab se 4/6 digit)** | Book ka HSN as-is use hota hai, validate nahi hota. |
| **Portal JSON schema ka REAL proof** | Sirf engine ke apne round-trip se verify kiya gaya hai, asli offline-utility/portal par upload karke nahi. Ye sabse bada **unverified** area hai. |

---

## 4. Purane (pehle ke sessions me fix) defects — record ke liye

1. GSTR-3B **4(C)** = 4(A) + 4(B) kar raha tha → ab **4(A) − 4(B)**.
2. Blocked ITC `itcAvailed` me add ho raha tha → ab 4(B) me reverse, carry-forward se bahar.
3. `claimable_itc` face value le raha tha → ab 2B tax (min(tax, taxable) nahi).
4. 2B lines ko invoice-level par group nahi kar raha tha (ek invoice = ek line per rate) → 4 lines live data me falsely "Amount Mismatch".
5. GSTR-1 me amendment tables me poori copy — double declaration.
6. "Not Booked" report apne naam ka **ulta** la rahi thi (`NOT EXISTS … matched_2b_key = <key>`).
7. 3B 3.1 me invented table numbers (5/6/7/8–12) — hata diye.
8. Credit note ko "claim karo" advise kar raha tha → ab REVERSE.
9. `verify-real-data.ts` harness bug: 12 mahine ki 2B ek hi `fp='042025'` me pack kar raha tha (engine bug nahi, harness bug) — per-period documents banaye.

---

## 5. Verification log (aaj, sab green)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | **0 errors** |
| Engine tests | `npm test` | **710 passed, 0 failed** (pehle 545) |
| Live DB tests | `npm run test:p0` | **337 passed, 0 failed** (pehle 156) |
| Real-data verify | `npm run verify` | **21 passed, 0 failed** |
| Live HTTP | 14 purane-500 report URLs + `complete.xlsx` | **sab 200** |

**Files changed aaj:** [src/app/reports.ts](src/app/reports.ts), [src/server/server.ts](src/server/server.ts), [src/engine/gstr1.ts](src/engine/gstr1.ts), [src/engine/gstr1-recon.ts](src/engine/gstr1-recon.ts), [src/engine/gstr1-import.ts](src/engine/gstr1-import.ts), [src/engine/pl-recon.ts](src/engine/pl-recon.ts), [migrations/20_gstr1_cdnur_table_type.sql](migrations/20_gstr1_cdnur_table_type.sql), [tests/run.ts](tests/run.ts), [tests/phase0-db.ts](tests/phase0-db.ts).

---

## 6. Dobara verify karne ka tarika

```bash
cd /f/GST-SOFTWARE
npx tsc --noEmit && npm test && npm run test:p0 && npm run verify
# server
npx tsx src/server/server.ts        # http://localhost:4310
```

Report filter dobara test karne ke liye: login `MASTER` / `sakar@123`, phir
`GET /api/report/twob-not-in-books?period=2025-04` → **79 rows** aane chahiye.

---

## 7. Bottom line

- **Formulas:** GSTR-3B (3.1, 4(A)/4(B)/4(C)), ITC eligibility, cl.16(4), 30-Nov deadline, credit-note reversal, HSN, CDNR, duplicate ITC — **sab sahi**.
- **Aaj 2 defect mile aur fix hue:** report filters ka 500 (high), aur **B2CL threshold ka purana ₹2.5L** (GST rule violation).
- **Aaj ek feature add hua:** **CDNUR (table 9B)** — unregistered recipient ke credit/debit notes ab alag table me jaate hain (pehle CDNR me daal diye jaate the, jise portal reject karta hai).
- **Missing/unsupported:** Rule 42/43, capital goods, interest/late fee, 180-din rule, EXP reconciliation.
- **Sabse bada unverified:** generated portal JSON ko asli portal/offline-utility par upload karke test **nahi** kiya gaya. Isse pehle waha file upload karke ek baar verify karna zaroori hai.
