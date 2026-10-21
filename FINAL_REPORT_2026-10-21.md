# Final Report — GST Software
**21 October 2026** · Sakar Electricals & SVN Opto · FY 2025-26

---

## Verdict in one paragraph

Code poori tarah likha hua hai aur chal raha hai — 1,117 engine tests, 444 database tests, 12 mahine ka asli data. Lekin teen reconciliations me se **sirf ek ke paas data hai**. GSTR-2B vs Purchase Register live hai aur 96.2% match kar raha hai. GSTR-1 vs Sales Register ka **filed data zero hai**, isliye wo chal hi nahi sakta. P&L vs GSTR-1 me **ek bhi entry nahi hai**. Software galat nahi hai — usko compare karne ke liye doosra side hi nahi diya gaya. Isi wajah se "kuch kaam nahi hua" mehsoos hota hai.

Iske upar 4 asli code defects mile hain, jinme ek proven hai (40% GST 28% ban raha hai).

---

## 1. Teen reconciliations — measured status

Numbers seedhe database aur real files se, aaj (21 Oct 2026) nikaale gaye:

| # | Reconciliation | Code | Data | Aaj ka result |
|---|---|---|---|---|
| 1 | **GSTR-2B vs Purchase Register** (invoice-wise + ITC) | ✅ complete | ✅ 12 months | **9,641 lines · 9,272 matched (96.2%) · 299 missing · 43 amount mismatch · 27 duplicate** |
| 2 | **GSTR-1 vs Sales Register** | ✅ complete | ⚠️ half | Books: **4,099 invoices, ₹124.55 cr** (Apr'25–Mar'26). Filed GSTR-1: **0 rows**. Draft: **443 rows, sirf Mar 2026** |
| 3 | **P&L vs GSTR-1** | ✅ complete | ❌ none | `pl_entries` = **0**, `pl_reconciliation` = **0 rows** |

### Reco 1 — 2B vs Purchase: ye chal raha hai, aur achha chal raha hai

```
24AALCS9985J1ZG  (Sakar-III)   books 217   | 2B 220    | matched 187  | 87.0%
26AALCS9985J1ZC  (Sakar-I)     books 9,424 | 2B 10,732 | matched 9,067 | 96.7%
TOTAL                          matched 9,254 | claimable ITC ₹17,27,00,997
```

12 mahine (2025-04 → 2026-03), 24 GSTR-2B files registered, 20 ITC-blocked lines portal ne khud flag kiye. Invoice-wise working sheet (`2B vs Books (invoice-wise)`), line-wise editable sheet, ITC matching, month lock, audit trail (309 entries) — sab live.

**Ye tumhara sabse mazboot hissa hai.** Isko chhedne ki zaroorat nahi.

### Reco 2 — GSTR-1 vs Sales Register: data ka aadha hissa missing hai

Books side poora load hai: **4,099 sales invoices, ₹124.55 crore, April 2025 se March 2026**, GSTIN 26AALCS9985J1ZC.

Lekin comparison ke liye jo **filed GSTR-1** chahiye, wo `source='filed'` rows me aata hai (`src/app/gstr1-store.ts:542`) — aur us table me **zero** rows hain. Jo 443 rows hain wo `draft` hain aur wo bhi **sirf March 2026** ke.

Matlab: Apr 2025 se Feb 2026 tak — 11 mahine — reconciliation chal hi nahi sakti. Screen khali dikhega, aur wo "software kharab hai" jaisa lagta hai, jabki file hi upload nahi hui.

**Fix code me nahi, data me hai.** Portal se 11 mahine ka GSTR-1 download → "Portal GSTR-1" screen se upload.

### Reco 3 — P&L vs GSTR-1: engine ready, data zero

`src/engine/pl-recon.ts` + `src/app/pl-store.ts` + P&L template + screen — sab bana hua hai. `pl_entries` khaali hai. Ek bhi trial balance / P&L import nahi hua.

---

## 2. Isliye "kuch kaam nahi hua" lagta hai — asli wajah

Teen me se do reconciliations **input data ke bina** math kar sakti hain, par tumhare paas wo input hi nahi gaya. Jis din wo do files upload ho jayengi, us din system turant kaam karta dikhega — code change ki zaroorat nahi.

Upar se: **9,641 me se 9,641 purchase lines ka ITC decision abhi bhi "Pending Review"** hai. Yaani ITC screen ek baar bhi asli decision ke liye use nahi hui. Aur wahi decision GSTR-3B padhta bhi nahi (neeche D2) — double problem.

---

## 3. Turant karna hai — sirf data, koi code nahi (~1 din)

| Kya | Kahan se | Kitna |
|---|---|---|
| GSTR-1 filed, Apr'25–Feb'26 (11 months) | GST portal → Returns → GSTR-1 → Download JSON/Excel | 11 files → "Portal GSTR-1" screen |
| Monthly P&L / Trial Balance, Apr'25–Mar'26 | Tally / SAP | 12 files → P&L import |
| ITC decisions | Apna Accounts team | 299 missing + 43 mismatch + 20 blocked = **362 lines** pe Claim / Do Not Claim / Query Vendor |
| GSTR-2B, Oct 2026 | Portal, 14 tarikh ke baad | agla mahina |

Ye 1 din ka kaam hai aur iske baad teeno reco screens me asli numbers aayenge.

---

## 4. Code me jo galat hai — 4 defects, proof ke saath

### D1 · GST 2.0 ka 40% slab missing — **proven**
`src/engine/core.ts:462` me slab list abhi bhi purani hai: `[0, 0.25, 3, 5, 12, 18, 28]`. 22 Sep 2025 se 12% aur 28% hata diye gaye, **40%** naya slab aaya (demerit/luxury goods).

```
$ npx tsx -e "import {effectiveRate} from './src/engine/core'; console.log(effectiveRate(100000, 40000))"
28        ← 40% ka invoice 28% label ho raha hai
```

`effectiveRate()` har invoice, HSN row aur GSTR-3B ke 3.1(a) rate-wise breakdown me use hota hai. Yaani ek 40% supply poore return me 28% ban ke jaati hai. Slab list **period-aware** honi chahiye — Mar 2025 ka invoice 12%/28% hi hai, Oct 2025 ka nahi.

### D2 · GSTR-3B accountant ka ITC decision padhta hi nahi
`itc_decision` aur `return_classification` sirf workbook me likhe jaate hain (`src/app/pipeline.ts:717`), `buildGstr3b` unhe kabhi nahi padhta. README khud maanta hai: *"Wiring the 3B to the user's decision is Phase 2."*

**Matlab:** "Do Not Claim" / "Ineligible" / "Reclaim Later" ka return par **zero asar**. Poore ITC workflow ka koi business result nahi. Ye sabse bada credibility gap hai.

### D3 · GSTR-1 me nil/exempt (Table 8) hi nahi hai
`src/engine/gstr1.ts:772`:
```ts
exp: [],
sect: 'B2B,B2CL,B2CS,CDNR,CDNUR,HSN',
```
Nil-rated, exempt aur non-GST outward supplies JSON me **kahin nahi** aate. Exports bhi hardcoded empty. Table 8 chhodna filing defect hai, aur baad me GSTR-9 ka turnover reconciliation isi par tootta hai.

### D4 · 2B JSON path: place of supply kho jaata hai + round-trip FAIL
`npm run verify` ne 20 pass, **1 fail** diya:

```
26AALCS9985J1ZC  excel[matched 9067]  json[matched 8938]
FAIL: portal JSON reproduces the Excel reconciliation exactly
```

Parser har B2B invoice ka `pos` **group se** padhta hai (`ingest.ts:611`), invoice ke andar se nahi — isliye JSON se aayi har line ka `place_of_supply` khaali aata hai aur `applicable_pct` `NaN` ho jaata hai. Matching par asar nahi (wo GSTIN + invoice no par hota hai), lekin data loss hai aur "JSON aur Excel bilkul same result dete hain" wala README claim aaj **proven nahi** hai.

### Aur jo bilkul nahi hai
- **IMS** — grep karne par `src/` aur `migrations/` me zero hits. Portal par no-action = deemed accepted, aur Rule 88D ka DRC-01C isi par aata hai.
- **Rule 37** (180-din payment reversal) — koi representation nahi.
- **GSTR-9 / 9C** — kuch nahi. FY 2025-26 ki due date **31 Dec 2026** hai.

---

## 5. Roadmap — tumhare bataye order me (reconciliation-first)

Tumne kaha: pehle GSTR-1 vs Sales, P&L vs GSTR-1, 2B vs Purchase / ITC. Usi hisaab se sequence badal diya ([GST_ROADMAP_2026-10.md](GST_ROADMAP_2026-10.md) me bhi update hai).

### R0 · Teeno reco live karo — 3–4 din
1. Data load (11 months GSTR-1 + 12 months P&L) — *koi code nahi*
2. D1 fix: period-aware slabs (40%)
3. D4 fix: JSON se POS/rate padhna, verify ka 21st check green
4. Har reco ke liye ek "coverage" banner: "is mahine ka filed data nahi hai" — taaki khaali screen kabhi confusion na de

**Gate:** teeno screens par Apr'25–Mar'26 ke asli numbers dikhein, aur `npm run verify` 21/21.

### R1 · Reco ki depth — 5–6 din
- Invoice-wise matching ko first-class banana (aaj line-wise hai; ek invoice ki kai lines alag alag status le leti hain)
- Possible-match par **one-click accept** (fuzzy invoice number, vendor ne `123` likha aur humne `INV-123`)
- Tolerance config (₹1 vs ₹100) per company, na ki hardcoded
- Exception aging: "ye 299 missing lines kitne din purani hain, kis vendor ki sabse zyada ITC atki hai"

### P1 · GSTR-3B ko sach banao — 6–8 din (D2 + RCM 3.1(d) + Rule 37)
### P2 · IMS + DRC-01C — 5–7 din
### P3 · GSTR-9 / 9C + FY view — 8–10 din *(31 Dec 2026 deadline)*
### P4 · Backup / auth / install — 4–5 din

Total ≈ 30–38 din. Detail [GST_ROADMAP_2026-10.md](GST_ROADMAP_2026-10.md) me.

---

## 6. Verification log (aaj chalaya gaya)

| Command | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm test` | **1,117 passed, 0 failed** |
| `npm run test:p0:test` | **444 passed, 0 failed** |
| `npm run verify` (real SAP + 2B files) | **20 passed, 1 failed** (D4) |
| DB counts | purchase_lines 9,641 · sales_invoices 4,099 · gstr1_documents 443 (draft only) · gstr1_filings 0 · pl_entries 0 · users 4 · audit_trail 309 |

---

## 7. Open risks

| Risk | Mitigation |
|---|---|
| **Git me ek bhi commit nahi hai** — 3-4 mahine ka kaam sirf disk par | R0 ka pehla step: commit + tag |
| 11 mahine ka GSTR-1 upload na hua to GSTR-1 reco hamesha khaali | R0 ka gate isi par hai |
| D1 (40%) live hai — agar koi 40% invoice already file ho chuka hai | Purane months ka rate audit karo, correction ke through theek karo |
| GSTR-9 ki 31 Dec deadline | P3 mid-November tak shuru, warna sirf 9C ka ITC part |
| GSTN schema/advisory badalte rehte hain | version + effective date config me, code me hardcode nahi |

---

## 8. Ek line me

**Software ban chuka hai. Do reconciliations ke liye data nahi diya gaya, aur 4 defects hain jinme ek aaj proof ke saath pakda gaya.** Pehla kaam: 11 GSTR-1 files + 12 P&L files upload, phir R0 ke 4 code fixes.
