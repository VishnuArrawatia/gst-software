/**
 * GST ERP — file ingestion.
 *
 * Turns the three source files the team already produces into normalised rows:
 *
 *   1. Purchase Register (SAP export)  -> PurchaseBill[]   (ITC books side)
 *   2. GSTR-2B download (portal)       -> Gstr2bRecord[]
 *   3. Sales Register (SAP export)     -> SalesInvoice[]   (outward books)
 *
 * Column matching is alias-based (see columns.ts). Rows are also scanned for
 * the trap that silently corrupts a GST return: a totals row sitting inside
 * the data block. SAP exports end with "Grand Total"; the portal does not, but
 * a human-made copy-and-paste often does. Both are rejected here.
 */

import { findHeaderRow, mapHeaders, pick, type HeaderContext } from './columns';
import {
  docAmount,
  docSign,
  docTypeOrNull,
  inferDocType,
  isBlankish,
  isCreditNote,
  normDate,
  normGstin,
  normInvoice,
  normInvoiceType,
  normPos,
  periodFromAny,
  signCheckOf,
  periodOf,
  isValidGstin,
  r2,
  stateOf,
  taxOf,
  type Gstr2bRecord,
  type PurchaseBill,
  type SalesInvoice,
  type SalesItem,
} from './core';

export interface IngestResult<T> {
  rows: T[];
  /** Data rows the parser skipped, with the reason — surfaced in the UI. */
  skipped: Array<{ row: number; reason: string; raw?: string }>;
  /** Column headers present in the file that we did not understand. */
  unmappedHeaders: string[];
  headerRowIndex: number;
  sourceFile: string;
  /** Things the parser had to assume. Empty for the tabular parsers. */
  warnings?: string[];
}

const TOTALS_RE = /^\s*(grand\s*total|total|subtotal|sub\s*total|grand total)\s*$/i;

function looksLikeTotals(row: unknown[]): boolean {
  const first = String(row[0] ?? '').trim();
  if (TOTALS_RE.test(first)) return true;
  // A row with no invoice number and no GSTIN is not a transaction.
  return false;
}

function toNum(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) ? r2(n) : 0;
}

function toBool(v: unknown): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'y' || s === 'yes' || s === 'true' || s === '1' || s === 'r';
}

/**
 * Yes / No / anything else, as three states.
 *
 * An answer nobody gave has to stay `undefined` rather than becoming `false`:
 * "not checked" and "checked, and there is none" are different facts, and the
 * exception report counts on telling them apart.
 */
function ynTri(v: unknown): boolean | undefined {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return undefined;
  if (s === 'y' || s === 'yes' || s === 'true' || s === '1') return true;
  if (s === 'n' || s === 'no' || s === 'false' || s === '0') return false;
  return undefined;
}

/**
 * Build a parser for one file shape.
 *
 * `required` are the fields without which a row is meaningless — they drive
 * header-row detection and the "this is not a purchase register" guard.
 */
function makeParser<T>(
  rows: unknown[][],
  sourceFile: string,
  required: string[],
  build: (row: unknown[], map: Map<number, string>, rowNo: number) => T | null,
  ctx?: HeaderContext,
): IngestResult<T> {
  const headerRowIndex = findHeaderRow(rows, required, ctx);
  const header = rows[headerRowIndex] || [];
  const { map, unmapped } = mapHeaders(header, ctx);

  const missing = required.filter((f) => !new Set(map.values()).has(f));
  if (missing.length > 0) {
    // Not a file of this shape. Returning empty rather than throwing lets the
    // caller try the other parsers without special-casing.
    return {
      rows: [],
      skipped: [{ row: headerRowIndex + 1, reason: `missing required column(s): ${missing.join(', ')}` }],
      unmappedHeaders: unmapped,
      headerRowIndex,
      sourceFile,
    };
  }

  const out: T[] = [];
  const skipped: IngestResult<T>['skipped'] = [];

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const raw = rows[i];
    if (!raw || raw.length === 0) continue;
    if (raw.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
    if (looksLikeTotals(raw)) continue;

    try {
      const built = build(raw, map, i + 1);
      if (built) {
        // Stable, deterministic id. Reconciliation matches book rows to portal
        // rows by tracking which portal ids were claimed; an id that changes
        // between runs silently turns every match into "unbooked".
        (built as any).id = `${sourceFile}#${i + 1}`;
        out.push(built);
      } else {
        skipped.push({ row: i + 1, reason: 'required field missing (invoice number or GSTIN)' });
      }
    } catch (e: any) {
      skipped.push({ row: i + 1, reason: e.message || 'parse error' });
    }
  }

  return { rows: out, skipped, unmappedHeaders: unmapped, headerRowIndex, sourceFile };
}

// ---------------------------------------------------------------------------
// 1. Purchase register (SAP) — the ITC books side
// ---------------------------------------------------------------------------

/**
 * The SAP purchase register repeats the tax block three times (raw / cleaned /
 * others). `mapHeaders` keeps the FIRST occurrence of each field, which is the
 * raw block. That is deliberate: the reconciliation needs what was actually
 * booked, not what a cleaning macro produced afterwards.
 */
export function parsePurchaseRegister(
  rows: unknown[][],
  sourceFile = 'purchase-register',
): IngestResult<PurchaseBill> {
  // Warnings are collected here rather than thrown: a sign conflict is a row
  // that still imports correctly (the source sign is preserved), but the
  // operator has to see it. Parse errors still throw, which makeParser records
  // in `skipped` with the row number.
  const warnings: string[] = [];
  const parsed = makeParser<PurchaseBill>(
    rows,
    sourceFile,
    ['invoice_no', 'supplier_gstin', 'taxable_value'],
    (raw, map, rowNo) => {
      const invoiceNo = String(pick(raw, map, 'invoice_no') ?? '').trim();
      const gstin = normGstin(pick(raw, map, 'supplier_gstin'));
      const date = normDate(pick(raw, map, 'invoice_date'));
      if (!invoiceNo || !gstin) return null;

      // A supplier GSTIN that is not a real 15-character GSTIN cannot be stored
      // (the column is VARCHAR(15)) and cannot match anything in GSTR-2B either.
      // Letting it through used to abort the WHOLE upload with a raw
      // "value too long for type character varying(15)" 500, so one bad row in
      // a 900-row register lost 899 good ones. The row is reported and skipped
      // instead; truncating it would file the purchase under a registration
      // that does not exist.
      if (!isValidGstin(gstin)) {
        throw new Error('supplier GSTIN is not a valid 15-character GSTIN');
      }

      const taxableRaw = toNum(pick(raw, map, 'taxable_value'));
      const igstRaw = toNum(pick(raw, map, 'igst'));
      const cgstRaw = toNum(pick(raw, map, 'cgst'));
      const sgstRaw = toNum(pick(raw, map, 'sgst'));
      const cessRaw = toNum(pick(raw, map, 'cess'));

      // The register holds invoices, credit notes and debit notes in one file,
      // and the document type decides which way the money moves. The template
      // asks for every figure as printed (positive) and the sign is applied
      // here — one place, so a credit note can never be booked as a purchase
      // because somebody forgot the minus, and a file that already carried
      // minus signs is not made double negative (see docAmount).
      const docTypeRaw = String(pick(raw, map, 'invoice_type') ?? '').trim();
      const documentType = inferDocType(docTypeRaw, [
        taxableRaw, igstRaw, cgstRaw, sgstRaw, cessRaw,
      ]);
      if (docTypeRaw && !docTypeOrNull(docTypeRaw)) {
        // Silence here is how a "Sales Return" line becomes a purchase that
        // ADDS ITC. The row is refused with the offending text and the three
        // values the dropdown offers.
        throw new Error(
          `document type "${docTypeRaw}" is not recognised — use Tax Invoice, Debit Note or Credit Note`,
        );
      }
      if (!docTypeRaw) {
        const nonZero = [taxableRaw, igstRaw, cgstRaw, sgstRaw, cessRaw].filter((n) => n !== 0);
        if (nonZero.length && nonZero.every((n) => n < 0)) {
          warnings.push(
            `row ${rowNo}: no Document Type but every amount is negative — treated as a Credit Note`,
          );
        }
      }
      const signCheck = signCheckOf(documentType, [
        taxableRaw, igstRaw, cgstRaw, sgstRaw, cessRaw,
      ]);
      if (signCheck === 'conflict') {
        warnings.push(
          `row ${rowNo}: ${documentType} "${invoiceNo}" has mixed or negative amounts — ` +
            'kept exactly as printed, sign NOT applied. Check the Document Type.',
        );
      }
      const sign = docSign(documentType);
      const taxable = docAmount(documentType, taxableRaw);
      const igst = docAmount(documentType, igstRaw);
      const cgst = docAmount(documentType, cgstRaw);
      const sgst = docAmount(documentType, sgstRaw);
      const cess = docAmount(documentType, cessRaw);

      // When the invoice was booked in our books. Many registers carry one
      // date for both this and the PO/GRN reference, which is why it has its
      // own column instead of the reference number growing a date.
      const bookEntryDate = normDate(pick(raw, map, 'book_entry_date'));

      // The register's own period column wins (it is what the books filed the
      // invoice under); fall back to the invoice date when it is blank, and
      // only then to the book entry date. Book entry date is last so adding
      // it cannot change the period of any file that already worked.
      const period =
        periodFromAny(pick(raw, map, 'period')) ||
        periodOf(date) ||
        periodOf(bookEntryDate);
      if (!period) return null;

      const ourGstin = normGstin(pick(raw, map, 'our_gstin'));

      return {
        our_gstin: ourGstin,
        unit_name: String(pick(raw, map, 'unit_name') ?? '').trim() || undefined,
        party_name: String(pick(raw, map, 'party_name') ?? '').trim(),
        supplier_gstin: gstin,
        invoice_no: invoiceNo,
        document_type: documentType,
        document_type_raw: docTypeRaw || undefined,
        sign_effect: sign,
        source_taxable_value: taxableRaw,
        source_igst: igstRaw,
        source_cgst: cgstRaw,
        source_sgst: sgstRaw,
        source_cess: cessRaw,
        reference_no: String(pick(raw, map, 'reference_no') ?? '').trim() || undefined,
        // "Yes"/"No" -> true/false/undefined. GSTR-2B carries neither figure,
        // so an absent column must stay absent rather than becoming "No".
        has_e_invoice: ynTri(pick(raw, map, 'has_e_invoice')),
        e_invoice_no: String(pick(raw, map, 'e_invoice_no') ?? '').trim() || undefined,
        has_e_way_bill: ynTri(pick(raw, map, 'has_e_way_bill')),
        e_way_bill_no: String(pick(raw, map, 'e_way_bill_no') ?? '').trim() || undefined,
        invoice_date: date,
        book_entry_date: bookEntryDate || undefined,
        period,
        taxable_value: taxable,
        igst,
        cgst,
        sgst,
        cess,
        invoice_total: r2(taxable + taxOf({ igst, cgst, sgst, cess })),
        reverse_charge: ynTri(pick(raw, map, 'reverse_charge')),
        hsn: String(pick(raw, map, 'hsn') ?? '').trim() || undefined,
        remark: String(pick(raw, map, 'remark') ?? '').trim() || undefined,
        source_file: sourceFile,
        source_row: rowNo,
      };
    },
    { profile: 'purchase' },
  );
  // Capped: a 900-row register with a systematic sign problem would otherwise
  // answer with 900 warnings, which is the same as saying nothing.
  if (warnings.length) parsed.warnings = warnings.slice(0, 50);
  return parsed;
}

// ---------------------------------------------------------------------------
// 2. GSTR-2B download (portal)
// ---------------------------------------------------------------------------

export function parseGstr2b(rows: unknown[][], sourceFile = 'gstr2b'): IngestResult<Gstr2bRecord> {
  return makeParser<Gstr2bRecord>(
    rows,
    sourceFile,
    ['invoice_no', 'supplier_gstin', 'taxable_value', 'itc_availability'],
    (raw, map, rowNo) => {
      const invoiceNo = String(pick(raw, map, 'invoice_no') ?? '').trim();
      const gstin = normGstin(pick(raw, map, 'supplier_gstin'));
      if (!invoiceNo || !gstin) return null;

      const date = normDate(pick(raw, map, 'invoice_date'));
      const period = periodFromAny(pick(raw, map, 'period')) || periodOf(date);

      // GSTR-2B puts credit notes in their own CDNR table, and their figures
      // are shown as printed there (sometimes negative, sometimes positive).
      // The ledger effect is always a reduction, so the type decides the sign.
      const docType = inferDocType(pick(raw, map, 'invoice_type'), [
        toNum(pick(raw, map, 'taxable_value')),
        toNum(pick(raw, map, 'igst')),
        toNum(pick(raw, map, 'cgst')),
        toNum(pick(raw, map, 'sgst')),
        toNum(pick(raw, map, 'cess')),
      ]);
      const signed = (f: 'taxable_value' | 'igst' | 'cgst' | 'sgst' | 'cess') =>
        docAmount(docType, toNum(pick(raw, map, f)));

      return {
        our_gstin: normGstin(pick(raw, map, 'our_gstin')),
        supplier_gstin: gstin,
        supplier_name: String(pick(raw, map, 'supplier_name') ?? pick(raw, map, 'party_name') ?? '').trim(),
        invoice_no: invoiceNo,
        invoice_type: String(pick(raw, map, 'invoice_type') ?? 'Regular').trim() || 'Regular',
        invoice_date: date,
        invoice_value:
          docAmount(docType, toNum(pick(raw, map, 'invoice_value'))) ||
          r2(
            signed('taxable_value') +
              taxOf({
                igst: signed('igst'),
                cgst: signed('cgst'),
                sgst: signed('sgst'),
                cess: signed('cess'),
              }),
          ),
        place_of_supply: String(pick(raw, map, 'place_of_supply') ?? '').trim(),
        reverse_charge: toBool(pick(raw, map, 'reverse_charge')),
        taxable_value: signed('taxable_value'),
        igst: signed('igst'),
        cgst: signed('cgst'),
        sgst: signed('sgst'),
        cess: signed('cess'),
        period,
        filing_date: normDate(pick(raw, map, 'filing_date')) || undefined,
        itc_availability: String(pick(raw, map, 'itc_availability') ?? 'Yes').trim() || 'Yes',
        reason: String(pick(raw, map, 'reason') ?? '').trim() || undefined,
        applicable_pct: String(pick(raw, map, 'applicable_pct') ?? '').trim() || undefined,
        source_file: sourceFile,
        source_row: rowNo,
      };
    },
    { profile: 'twob' },
  );
}

// ---------------------------------------------------------------------------
// 2b. GSTR-2B as downloaded from the GST portal (JSON)
// ---------------------------------------------------------------------------

/**
 * The portal's GSTR-2B JSON is not a table. It is a tree:
 *
 *   { gstin, fp, hash,
 *     b2b:   [ { ctin, inv: [ { inum, idt, val, pos, rchrg, inv_typ,
 *                             itms: [ { num, itm_det: { rt, txval, iamt, camt, samt, csamt } } ],
 *                             itc_elg, reason } ] } ],
 *     b2cl:  [ { pos, inv: [ ... ] } ],
 *     cdnr:  [ { ctin, nt_num, nt_dt, ntty, val, itms: [ ... ] } ],
 *     b2cs:  [ { sply_ty, pos, typ, itms: [ ... ] } ],
 *     isd:   [ { ctin, inum, idt, val, pos, rchrg, itms: [ ... ] } ],
 *     section: [ { sec, itc_avlbl, reason, avlb_itm: [ ... ] } ] }
 *
 * The portal renames keys between releases (and a tax agent's middleware may
 * rename them again), so every read goes through `pick` with a list of accepted
 * spellings rather than a single field name. `itms` are flattened: one invoice
 * can carry several tax lines, and the reconciliation works invoice-wise.
 *
 * B2CS and the section-level detail tables are summary rows with no invoice
 * number. They cannot be matched against the books, so they are counted and
 * reported rather than silently ingested as bogus rows.
 */

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function jpick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function pickStr(o: Record<string, unknown>, keys: string[]): string {
  return String(jpick(o, keys) ?? '').trim();
}

/** Portal `fp` is `MMYYYY` in the download and `YYYYMM` in some tools. */
function fpToPeriod(fp: string): string {
  const s = String(fp || '').replace(/\D/g, '');
  if (s.length === 6) {
    const a = Number(s.slice(0, 2));
    const b = Number(s.slice(2));
    if (a >= 1 && a <= 12 && b >= 2017) return `${b}-${String(a).padStart(2, '0')}`;
    if (b >= 1 && b <= 12 && a >= 2017) return `${a}-${String(b).padStart(2, '0')}`;
  }
  return periodFromAny(fp) || '';
}

const ITC_KEYS = ['itc_elg', 'itc_avlbl', 'itc_availability', 'itcAvailability', 'itc_availble', 'eligible'];
const REASON_KEYS = ['reason', 'rsn', 'reason_code', 'reasonCode', 'itm_rsn', 'reason_desc'];
const NO_INV_KEYS = ['inum', 'inv_num', 'invNum', 'invoice_no', 'invoiceNo', 'invno', 'inv_no', 'nt_num', 'ntnum'];

interface ItemTotals {
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  rates: string[];
}

/** Sum a 2B `itms` array into one invoice-level tax block. */
function sumItems(items: unknown): ItemTotals {
  const t: ItemTotals = { taxable_value: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, rates: [] };
  for (const raw of asArr(items)) {
    const item = asObj(raw);
    // The tax line lives under itm_det; some exports inline it.
    const d = asObj(item.itm_det ?? item.item_details ?? item.itmDet ?? item);
    t.taxable_value = r2(t.taxable_value + toNum(jpick(d, ['txval', 'taxable_value', 'taxableValue', 'taxval'])));
    t.igst = r2(t.igst + toNum(jpick(d, ['iamt', 'igst', 'intg_tax'])));
    t.cgst = r2(t.cgst + toNum(jpick(d, ['camt', 'cgst', 'c_gst'])));
    t.sgst = r2(t.sgst + toNum(jpick(d, ['samt', 'sgst', 's_gst'])));
    t.cess = r2(t.cess + toNum(jpick(d, ['csamt', 'cess'])));
    const rt = jpick(d, ['rt', 'rate']);
    if (rt !== undefined && Number.isFinite(Number(rt)) && !t.rates.includes(String(rt))) t.rates.push(String(rt));
  }
  return t;
}

/**
 * Does this object look like a portal GSTR-2B download?
 *
 * Deliberately conservative: it must have one of the invoice tables AND at
 * least one thing a 2B has that no other export does — the root `gstin` of the
 * recipient plus ITC availability somewhere.
 */
export function isGstr2bJson(json: unknown): boolean {
  const o = asObj(json);
  if (Object.keys(o).length === 0) return false;
  const tables = ['b2b', 'b2cl', 'cdnr', 'isd', 'b2cs', 'section'].filter((k) => k in o);
  if (tables.length === 0) return false;
  if (!('gstin' in o) && !('fp' in o)) return false;

  // Walk a few levels looking for an ITC-availability flag.
  let sawItc = false;
  const walk = (v: unknown, depth: number): void => {
    if (sawItc || depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o2 = asObj(v);
    for (const k of Object.keys(o2)) {
      if (ITC_KEYS.includes(k)) {
        sawItc = true;
        return;
      }
      walk(o2[k], depth + 1);
    }
  };
  walk(o, 0);
  return sawItc;
}

export function parseGstr2bJson(
  json: unknown,
  sourceFile = 'gstr2b.json',
): IngestResult<Gstr2bRecord> {
  const root = asObj(json);
  const warnings: string[] = [];
  const skipped: IngestResult<Gstr2bRecord>['skipped'] = [];
  const rows: Gstr2bRecord[] = [];
  let unmatchedNoGstin = 0;

  const ourGstin = normGstin(jpick(root, ['gstin', 'gstin_of_recipient', 'recipient_gstin', 'our_gstin']));
  const fp = fpToPeriod(pickStr(root, ['fp', 'ret_period', 'period']));

  // ---- section-level ITC flags -------------------------------------------
  // The portal repeats ITC availability in a per-section summary. Where an
  // invoice itself carries no flag, that summary is the fallback — it is the
  // same data the portal shows in the "ITC not available" tables.
  const secByGstin = new Map<string, { avail: string; reason: string; sec: string }>();
  for (const raw of asArr(root.section ?? root.sec)) {
    const s = asObj(raw);
    const sec = pickStr(s, ['sec', 'section', 'sec_cd']);
    const avail = pickStr(s, [...ITC_KEYS]);
    const reason = pickStr(s, REASON_KEYS);
    if (!sec && !avail) continue;
    // Key on the supplier GSTIN when the section row lists one; otherwise the
    // flag applies to every line in that section, so store it as a default.
    const ctin = normGstin(jpick(s, ['ctin', 'ctn', 'gstin', 'supplier_gstin']));
    secByGstin.set(ctin || '*', { avail, reason, sec });
  }
  const secDefault = secByGstin.get('*');

  let seq = 0;
  const emit = (
    o: Record<string, unknown>,
    ctx: { ctin: string; pos?: string; sec?: string; group?: string; noteType?: string },
  ): void => {
    const supplier = normGstin(
      jpick(o, ['ctin', 'ctn', 'ctinstr', 'gstin', 'supplier_gstin', 'gstin_of_supplier']) || ctx.ctin,
    );
    const invNo = pickStr(o, NO_INV_KEYS);
    if (!invNo) {
      skipped.push({ row: 0, reason: `no invoice number (${ctx.group})`, raw: JSON.stringify(o).slice(0, 200) });
      return;
    }
    if (!isValidGstin(supplier)) {
      // A B2CL line from an unregistered supplier has no GSTIN at all. It is
      // real ITC, but reconciliation matches on GSTIN + invoice number, so it
      // cannot be matched here — count it rather than inventing a key.
      unmatchedNoGstin++;
      return;
    }

    const date = normDate(jpick(o, ['idt', 'inv_dt', 'invDt', 'invoice_date', 'nt_dt', 'ntdt', 'idt_nt']));
    const items = jpick(o, ['itms', 'items', 'itms_det']);
    const t = sumItems(items);

    const secFallback = secByGstin.get(supplier) ?? secDefault;
    const sec = ctx.sec || secFallback?.sec || '';
    let itc = pickStr(o, ITC_KEYS);
    if (!itc && secFallback?.avail) itc = secFallback.avail;
    if (!itc) {
      itc = 'Yes';
      if (!warnings.length) {
        warnings.push(
          'no ITC-availability field found in the JSON — assumed "Yes". Verify blocked lines against the portal before claiming.',
        );
      }
    }

    const reasonParts: string[] = [];
    if (sec) reasonParts.push(`Section ${sec}`);
    const rRaw = pickStr(o, REASON_KEYS);
    const reasonText = rRaw || secFallback?.reason || '';
    if (reasonText) reasonParts.push(reasonText);

    const rateFromJson = pickStr(o, ['eligible_percent', 'eligiblePercent', 'itc_percent', 'avlb_percent']);
    const pct = rateFromJson || t.rates.join(',');

    // "R" regular, "C" credit note, "D" debit note.
    const rawType = pickStr(o, ['inv_typ', 'invTyp', 'inv_type', 'typ']).toUpperCase();
    let invType: string;
    if (ctx.group === 'CDNR') invType = rawType.startsWith('D') ? 'DN' : 'CDNR';
    else invType = normInvoiceType(rawType || 'R');
    // Credit notes are a reduction whatever sign the portal printed: some
    // releases export `txval` negative, others positive. The type is the fact.
    const amt = (n: number) => docAmount(invType, n);

    rows.push({
      id: `${sourceFile}#${seq++}`,
      our_gstin: ourGstin,
      supplier_gstin: supplier,
      supplier_name: pickStr(o, ['sup_name', 'supplier_name', 'party_name', 'tradenm', 'supplierNm']),
      invoice_no: invNo,
      invoice_type: invType,
      invoice_date: date,
      invoice_value:
        amt(toNum(jpick(o, ['val', 'inv_val', 'invVal', 'invoice_value', 'inv_amt']))) ||
        r2(amt(t.taxable_value) + taxOf({ igst: amt(t.igst), cgst: amt(t.cgst), sgst: amt(t.sgst), cess: amt(t.cess) })),
      place_of_supply: normPos(ctx.pos || jpick(o, ['pos', 'place_of_supply', 'poscd'])),
      reverse_charge: toBool(jpick(o, ['rchrg', 'rev_chrg', 'revChrg', 'reverse_charge'])),
      taxable_value: amt(t.taxable_value),
      igst: amt(t.igst),
      cgst: amt(t.cgst),
      sgst: amt(t.sgst),
      cess: amt(t.cess),
      period: periodOf(date) || fp,
      portal_fp: fp || undefined,
      filing_date: normDate(jpick(root, ['gstn_dt', 'gen_dt'])) || undefined,
      itc_availability: itc,
      reason: reasonParts.join(': ') || undefined,
      applicable_pct: pct || undefined,
      source_file: sourceFile,
      source_row: seq,
    });
  };

  // ---- B2B / B2CL / ISD: groups of invoices ------------------------------
  let b2csCount = 0;
  const invoiceTables: Array<{ key: string; group: string }> = [
    { key: 'b2b', group: 'B2B' },
    { key: 'b2cl', group: 'B2CL' },
    { key: 'isd', group: 'ISD' },
  ];
  for (const { key, group } of invoiceTables) {
    for (const gRaw of asArr(root[key])) {
      const g = asObj(gRaw);
      const pos = pickStr(g, ['pos', 'place_of_supply']);
      const sec = pickStr(g, ['sec', 'section']);
      // In B2B the supplier GSTIN sits on the GROUP, not on the invoice.
      const ctin = pickStr(g, ['ctin', 'ctn', 'ctinstr', 'gstin', 'supplier_gstin']);
      const list = asArr(jpick(g, ['inv', 'invs', 'inv_list']));
      if (list.length === 0) {
        // ISD and some releases list the invoice flat, with no `inv` wrapper.
        emit(g, { ctin, pos, sec, group });
        continue;
      }
      for (const iRaw of list) emit(asObj(iRaw), { ctin, pos, sec, group });
    }
  }

  // ---- CDNR: credit / debit notes ----------------------------------------
  for (const gRaw of asArr(root.cdnr ?? root.cdnra)) {
    const g = asObj(gRaw);
    emit(g, {
      ctin: pickStr(g, ['ctin', 'ctn', 'ctinstr', 'gstin', 'supplier_gstin']),
      pos: pickStr(g, ['pos', 'place_of_supply']),
      sec: pickStr(g, ['sec', 'section']),
      group: 'CDNR',
    });
  }

  // ---- B2CS: summary only, cannot be matched invoice-wise ---------------
  for (const gRaw of asArr(root.b2cs)) {
    const g = asObj(gRaw);
    const t = sumItems(jpick(g, ['itms', 'items']));
    if (t.taxable_value || taxOf(t)) b2csCount++;
  }
  if (b2csCount > 0) {
    skipped.push({ row: 0, reason: `${b2csCount} B2CS summary row(s) skipped — no invoice number, cannot be reconciled line-wise` });
  }
  if (unmatchedNoGstin > 0) {
    skipped.push({
      row: 0,
      reason: `${unmatchedNoGstin} invoice(s) without a supplier GSTIN skipped — typically B2CL from unregistered suppliers, which cannot be matched line-wise`,
    });
  }
  if (root.section) {
    skipped.push({ row: 0, reason: 'section-level ITC summary tables skipped — used only as fallback flags' });
  }

  if (!ourGstin) warnings.push('no "gstin" key at the root of the JSON — records will be unattributed. Pass the file in with a root gstin.');
  if (!fp) warnings.push('no "fp" (return period) in the JSON — periods come from the invoice dates.');

  return {
    rows,
    skipped,
    unmappedHeaders: [],
    headerRowIndex: 0,
    sourceFile,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 3. Sales register (SAP) — the outward books side, drives GSTR-1
// ---------------------------------------------------------------------------

/** A problem found while reading the sales file, tied to the invoice it is about. */
export interface SalesIssue {
  severity: 'ERROR' | 'WARNING';
  invoiceNo: string;
  message: string;
}

export interface SalesIngestResult extends IngestResult<SalesInvoice> {
  /**
   * True when the file carried item/rate lines (Line No, HSN, UQC, Quantity or
   * GST Rate). False means one row per invoice, which is still read — the two
   * shapes go through the same grouping below.
   */
  itemLevel: boolean;
  /** Invoice arithmetic, rate and place-of-supply problems. Never silent. */
  issues: SalesIssue[];
  /** Item rows read from the file, before grouping into invoices. */
  itemRows: number;
}

/** One CSV row, before it is grouped with its sibling lines. */
interface RawSalesLine {
  line: SalesInvoice & { items: SalesItem[] };
  invoice_value: number;
  /** Identity of this line inside its invoice, for duplicate detection. */
  lineKey: string;
}

/** Nothing but the two-digit state code decides an inter-state split. */
function splitIsInterState(ourGstin: string, posCode: string): boolean | undefined {
  const ours = stateOf(ourGstin);
  if (!ours || !posCode) return undefined;
  return ours !== posCode;
}

/**
 * Read a sales register into INVOICE-LEVEL rows with their item lines.
 *
 * The register is item-wise by nature: one invoice carrying two goods at two
 * rates is two rows, and the portal's HSN summary (HSNSAC, UQC, quantity, rate)
 * cannot be produced from an invoice total. So every row is parsed on its own
 * and grouped afterwards on `Our GSTIN + Invoice No + Invoice Date`:
 *
 *   - money is SUMMED across the invoice's lines;
 *   - `Invoice Value` is taken ONCE, and every line of the invoice must print
 *     the same value — a second, different value is reported, not added;
 *   - each line stays a separate item, so a second item can never overwrite the
 *     first one's amounts.
 *
 * A file with one row per invoice (no item columns at all) goes through the
 * same grouping and produces exactly the row it always did: the group has a
 * single line.
 */
export function parseSalesRegister(rows: unknown[][], sourceFile = 'sales-register'): SalesIngestResult {
  const parsed = makeParser<RawSalesLine>(
    rows,
    sourceFile,
    ['invoice_no', 'taxable_value', 'invoice_value'],
    (raw, map, rowNo) => {
      const invoiceNo = String(pick(raw, map, 'invoice_no') ?? '').trim();
      if (!invoiceNo) return null;

      const date = normDate(pick(raw, map, 'invoice_date'));
      const rawTaxable = toNum(pick(raw, map, 'taxable_value'));
      const rawIgst = toNum(pick(raw, map, 'igst'));
      const rawCgst = toNum(pick(raw, map, 'cgst'));
      const rawSgst = toNum(pick(raw, map, 'sgst'));
      const rawCess = toNum(pick(raw, map, 'cess'));
      if (rawTaxable === 0 && taxOf({ igst: rawIgst, cgst: rawCgst, sgst: rawSgst, cess: rawCess }) === 0) return null;

      const type = normInvoiceType(pick(raw, map, 'invoice_type'));
      const isCn = type === 'CDNR';
      const signFn = (v: number) => (v === 0 ? 0 : isCn ? -Math.abs(v) : v);
      const taxable = signFn(rawTaxable);
      const igst = signFn(rawIgst);
      const cgst = signFn(rawCgst);
      const sgst = signFn(rawSgst);
      const cess = signFn(rawCess);
      const period = periodOf(date);
      const lineNoRaw = pick(raw, map, 'line_no');
      const lineNo = isBlankish(lineNoRaw) ? undefined : Math.trunc(toNum(lineNoRaw));
      const quantityRaw = pick(raw, map, 'quantity');
      const rateRaw = pick(raw, map, 'gst_rate');
      const hsn = String(pick(raw, map, 'hsn') ?? '').trim();
      const uqc = String(pick(raw, map, 'uqc') ?? '').trim().toUpperCase();
      const description = String(pick(raw, map, 'item_description') ?? '').trim();

      const item: SalesItem = {
        line_no: lineNo,
        item_code: String(pick(raw, map, 'item_code') ?? '').trim() || undefined,
        description: description || undefined,
        hsn: hsn || undefined,
        uqc: uqc || undefined,
        // A blank quantity is 0, never invented — the HSN summary reports the
        // quantity the file actually gives us.
        quantity: isBlankish(quantityRaw) ? 0 : toNum(quantityRaw),
        gst_rate: isBlankish(rateRaw) ? undefined : toNum(rateRaw),
        taxable_value: taxable,
        igst,
        cgst,
        sgst,
        cess,
        freight: toNum(pick(raw, map, 'freight')) || undefined,
        other_charges: toNum(pick(raw, map, 'other_charges')) || undefined,
        source_row: rowNo,
      };

      const rawInvVal = toNum(pick(raw, map, 'invoice_value'));
      const invoiceValue =
        (rawInvVal ? signFn(rawInvVal) : 0) || r2(taxable + taxOf({ igst, cgst, sgst, cess }));

      const line: SalesInvoice & { items: SalesItem[] } = {
        our_gstin: normGstin(pick(raw, map, 'our_gstin')),
        unit_name: String(pick(raw, map, 'unit_name') ?? '').trim() || undefined,
        card_code: String(pick(raw, map, 'card_code') ?? '').trim() || undefined,
        customer_name: String(pick(raw, map, 'customer_name') ?? '').trim(),
        customer_gstin: normGstin(pick(raw, map, 'customer_gstin')),
        recipient_type: String(pick(raw, map, 'recipient_type') ?? '').trim() || undefined,
        invoice_no: invoiceNo,
        invoice_date: date,
        period,
        invoice_type: type,
        place_of_supply: String(pick(raw, map, 'place_of_supply') ?? '').trim(),
        reverse_charge: toBool(pick(raw, map, 'reverse_charge')),
        taxable_value: taxable,
        igst,
        cgst,
        sgst,
        cess,
        invoice_value: invoiceValue,
        hsn: hsn || undefined,
        items: [item],
        note_ref_no: String(pick(raw, map, 'note_ref_no') ?? '').trim() || undefined,
        note_ref_date: normDate(pick(raw, map, 'note_ref_date')) || undefined,
        amendment_invoice_no: String(pick(raw, map, 'amendment_invoice_no') ?? '').trim() || undefined,
        amendment_invoice_date: normDate(pick(raw, map, 'amendment_invoice_date')) || undefined,
        e_commerce_gstin: normGstin(pick(raw, map, 'e_commerce_gstin')) || undefined,
        doc_nature: String(pick(raw, map, 'doc_nature') ?? '').trim() || undefined,
        doc_series_from: isBlankish(pick(raw, map, 'doc_series_from')) ? undefined : toNum(pick(raw, map, 'doc_series_from')),
        doc_series_to: isBlankish(pick(raw, map, 'doc_series_to')) ? undefined : toNum(pick(raw, map, 'doc_series_to')),
        doc_series_cancelled: isBlankish(pick(raw, map, 'doc_series_cancelled'))
          ? undefined
          : toNum(pick(raw, map, 'doc_series_cancelled')),
        source_file: sourceFile,
        source_row: rowNo,
      };

      // Two rows that both declare line 3 of the same invoice are the same line
      // twice. With no line number the whole line has to match before it counts
      // as a repeat, so two genuinely different lines are never merged.
      const fingerprint =
        lineNo !== undefined
          ? `L${lineNo}`
          : [taxable, igst, cgst, sgst, cess, invoiceValue, hsn, uqc, item.quantity, item.gst_rate].join('|');

      return { line, invoice_value: invoiceValue, lineKey: fingerprint };
    },
    { profile: 'sales' },
  );

  // Which columns the file actually carried, so the caller can say whether this
  // was an item-wise register without guessing from the numbers.
  const header = rows[parsed.headerRowIndex] || [];
  const fields = new Set(mapHeaders(header, { profile: 'sales' }).map.values());
  const itemLevel = ['line_no', 'quantity', 'uqc', 'gst_rate', 'item_description'].some((f) => fields.has(f));

  const issues: SalesIssue[] = [];
  const skipped = [...parsed.skipped];

  // ---- group item rows into invoices ----
  interface Group {
    key: string;
    head: SalesInvoice & { items: SalesItem[] };
    lines: RawSalesLine[];
    invoiceValues: number[];
  }
  const groups = new Map<string, Group>();
  const order: string[] = [];

  for (const row of parsed.rows) {
    const l = row.line;
    if (!l.invoice_date) {
      skipped.push({ row: l.source_row ?? 0, reason: `invoice ${l.invoice_no}: invoice date is not a date` });
      continue;
    }
    if (l.our_gstin && !isValidGstin(l.our_gstin)) {
      skipped.push({
        row: l.source_row ?? 0,
        reason: `invoice ${l.invoice_no}: "Our GSTIN" ${l.our_gstin} is not a valid GSTIN`,
      });
      continue;
    }
    // The GSTIN must be part of the key: two registrations can each issue their
    // own "INV-1002" and they are two different invoices.
    const key = `${l.our_gstin}|${normInvoice(l.invoice_no)}|${l.invoice_date}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, head: l, lines: [], invoiceValues: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.lines.push(row);
    g.invoiceValues.push(row.invoice_value);
  }

  const out: SalesInvoice[] = [];
  for (const key of order) {
    const g = groups.get(key)!;
    const head = g.head;
    const invoiceNo = head.invoice_no;

    // ---- duplicate lines: report, and keep the FIRST ----
    const seenLines = new Map<string, number>();
    const kept: RawSalesLine[] = [];
    for (const row of g.lines) {
      const n = seenLines.get(row.lineKey);
      if (n === undefined) {
        seenLines.set(row.lineKey, 1);
        kept.push(row);
      } else {
        seenLines.set(row.lineKey, n + 1);
        issues.push({
          severity: 'ERROR',
          invoiceNo,
          message: `Invoice ${invoiceNo} (${head.invoice_date}) ki wahi line ${n + 1} baar aayi hai — dobara wali line chhod di, warna taxable aur tax dubla ho jaata.`,
        });
        skipped.push({ row: row.line.source_row ?? 0, reason: `invoice ${invoiceNo}: duplicate item line` });
      }
    }

    // ---- item lines, in the order the file declared them ----
    kept.sort((a, b) => {
      const la = a.line.items[0].line_no;
      const lb = b.line.items[0].line_no;
      if (la === undefined && lb === undefined) return 0;
      if (la === undefined) return 1;
      if (lb === undefined) return -1;
      return la - lb;
    });
    const items = kept.map((r) => r.line.items[0]);
    if (items.some((i) => i.line_no === undefined)) {
      items.forEach((i, idx) => {
        if (i.line_no === undefined) i.line_no = idx + 1;
      });
    }

    const sum = (f: (i: SalesItem) => number) => r2(items.reduce((a, i) => a + f(i), 0));
    const taxable = sum((i) => i.taxable_value);
    const igst = sum((i) => i.igst);
    const cgst = sum((i) => i.cgst);
    const sgst = sum((i) => i.sgst);
    const cess = sum((i) => i.cess);

    // ---- `Invoice Value` is counted ONCE ----
    // Every line of one invoice prints the same invoice value; summing it was
    // what inflated a multi-item invoice by a whole repeat of itself.
    const distinctValues = [...new Set(g.invoiceValues.map((v) => r2(v)))];
    const invoiceValue = distinctValues[0];
    if (distinctValues.length > 1) {
      const spread = distinctValues.map((v) => v.toFixed(2)).join(' / ');
      issues.push({
        severity: 'ERROR',
        invoiceNo,
        message: `Invoice ${invoiceNo} ki lines par alag-alag Invoice Value hai (${spread}). Ek invoice ki saari lines par wahi value honi chahiye — pehli value (${invoiceValue.toFixed(2)}) li gayi hai.`,
      });
    }

    // ---- arithmetic: the invoice value must be taxable + tax ----
    const money = r2(taxable + taxOf({ igst, cgst, sgst, cess }));
    if (Math.abs(r2(invoiceValue) - money) > 1) {
      issues.push({
        severity: 'ERROR',
        invoiceNo,
        message: `Invoice ${invoiceNo}: Invoice Value ${invoiceValue.toFixed(2)} = taxable ${taxable.toFixed(2)} + tax ${r2(taxOf({ igst, cgst, sgst, cess })).toFixed(2)} (${money.toFixed(2)}) se match nahi karta — ₹ ${r2(invoiceValue - money).toFixed(2)} ka farq.`,
      });
    }

    // ---- per line: printed rate vs charged tax, and the freight break-up ----
    for (const it of items) {
      if (it.gst_rate !== undefined) {
        const expected = r2((it.taxable_value * it.gst_rate) / 100);
        const actual = r2(it.igst + it.cgst + it.sgst);
        if (Math.abs(expected - actual) > 1) {
          issues.push({
            severity: 'ERROR',
            invoiceNo,
            message: `Invoice ${invoiceNo} line ${it.line_no}: ${it.gst_rate}% par tax ₹ ${expected.toFixed(2)} hona chahiye, file me ₹ ${actual.toFixed(2)} hai.`,
          });
        }
      }
      const extras = r2((it.freight ?? 0) + (it.other_charges ?? 0));
      if (extras > 0 && (it.taxable_value <= 0 || extras > r2(it.taxable_value) + 0.01)) {
        issues.push({
          severity: 'ERROR',
          invoiceNo,
          message: `Invoice ${invoiceNo} line ${it.line_no}: Freight + other charges ₹ ${extras.toFixed(2)} line ki Taxable Value ₹ ${it.taxable_value.toFixed(2)} se zyada hai. Ye break-up hai, alag amount nahi — GST taxable value me hi aata hai.`,
        });
      }
    }

    // ---- place of supply vs the tax split ----
    const cust = head.customer_gstin;
    const posCode = normPos(head.place_of_supply);
    const isNote = isCreditNote(head.invoice_type);
    if (cust && cust.length === 15 && posCode && stateOf(cust) !== posCode) {
      issues.push({
        severity: 'WARNING',
        invoiceNo,
        message: `Invoice ${invoiceNo}: recipient GSTIN ka state (${stateOf(cust)}) Place of Supply (${posCode}) se alag hai. Bill-to/ship-to ho to theek hai — warna POS check kar lein.`,
      });
    }
    if (!cust && !isNote) {
      if (!posCode) {
        issues.push({
          severity: 'WARNING',
          invoiceNo,
          message: `Invoice ${invoiceNo}: customer ka GSTIN nahi hai aur Place of Supply bhi nahi — B2CS me pos ke bina jayega. State ka naam (jaise "Maharashtra") bharein.`,
        });
      } else {
        const inter = splitIsInterState(head.our_gstin, posCode);
        if (inter === true && r2(cgst + sgst) > 0) {
          issues.push({
            severity: 'ERROR',
            invoiceNo,
            message: `Invoice ${invoiceNo}: inter-state supply (POS ${posCode}) par CGST/SGST lagaya hai, IGST nahi.`,
          });
        }
        if (inter === false && r2(igst) > 0) {
          issues.push({
            severity: 'ERROR',
            invoiceNo,
            message: `Invoice ${invoiceNo}: intra-state supply (POS ${posCode}) par IGST lagaya hai, CGST/SGST nahi.`,
          });
        }
      }
    }
    if (head.recipient_type && /^unreg/i.test(head.recipient_type) && cust) {
      issues.push({
        severity: 'WARNING',
        invoiceNo,
        message: `Invoice ${invoiceNo}: Recipient Type "Unregistered" likha hai lekin Customer GSTIN ${cust} bhara hai.`,
      });
    }

    // An invoice-level HSN is only meaningful when every line shares it. With
    // several HSNs the detail lives in `items`, which is what the HSN summary
    // reads.
    const hsns = [...new Set(items.map((i) => i.hsn).filter(Boolean) as string[])];

    out.push({
      ...head,
      taxable_value: taxable,
      igst,
      cgst,
      sgst,
      cess,
      invoice_value: invoiceValue,
      hsn: hsns.length === 1 ? hsns[0] : undefined,
      items,
    });
  }

  return {
    rows: out,
    skipped,
    unmappedHeaders: parsed.unmappedHeaders,
    headerRowIndex: parsed.headerRowIndex,
    sourceFile,
    itemLevel,
    issues,
    itemRows: parsed.rows.length,
  };
}

/**
 * Guess which parser a sheet belongs to.
 *
 * Used by the CLI's "just drop the file in the folder" mode: rather than asking
 * the user to declare the file type, look at the headers and decide.
 *
 * `ITC Availability` is treated as decisive. It exists ONLY in the portal's
 * GSTR-2B download — no SAP purchase or sales register has it — whereas the
 * other columns overlap heavily between the three files. Without that weight a
 * 2B download scores a tie with the purchase register and gets parsed as
 * purchase data, which silently files the whole portal feed as books.
 */
export function sniffKind(rows: unknown[][]): 'purchase' | 'twob' | 'sales' | 'unknown' {
  const REQUIRED: Record<'purchase' | 'twob' | 'sales', string[]> = {
    purchase: ['invoice_no', 'supplier_gstin', 'taxable_value'],
    twob: ['invoice_no', 'supplier_gstin', 'taxable_value', 'itc_availability'],
    sales: ['invoice_no', 'taxable_value', 'invoice_value'],
  };

  const scored = (['twob', 'purchase', 'sales'] as const).map((profile) => {
    const headerRowIndex = findHeaderRow(rows, REQUIRED[profile], { profile });
    const { map } = mapHeaders(rows[headerRowIndex] || [], { profile });
    const fields = new Set(map.values());

    const have = REQUIRED[profile].filter((f) => fields.has(f)).length;
    if (have < REQUIRED[profile].length) return { profile: profile as string, score: 0 };

    // All required fields present: this profile is viable.
    let score = 100 + fields.size;
    if (profile === 'twob' && fields.has('itc_availability')) score += 1000;
    if (profile === 'twob' && fields.has('filing_date')) score += 10;
    if (profile === 'sales' && (fields.has('customer_gstin') || fields.has('customer_name'))) score += 20;
    return { profile: profile as string, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].score === 0 ? 'unknown' : (scored[0].profile as 'purchase' | 'twob' | 'sales');
}
