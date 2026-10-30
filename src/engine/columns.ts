/**
 * GST ERP — column detection.
 *
 * Source files arrive in three different shapes (SAP purchase export, the GST
 * portal's GSTR-2B download, SAP sales export) and SAP reorders columns
 * between periods. So columns are matched by *name alias*, never by position.
 *
 * The registry below is deliberately generous with aliases because the cost of
 * a missing alias is silent data loss: the parser cannot fill a column it does
 * not recognise, and the resulting GST return is quietly wrong.
 */

/** Canonical field -> accepted header spellings (already lower-cased). */
export const FIELD_ALIASES: Record<string, string[]> = {
  // ---- identity ----
  // A bare "GSTIN" column is deliberately NOT listed here. In a sales file it
  // means the CUSTOMER's GSTIN; in a purchase file it means the SUPPLIER's.
  // Attributing it to our own registration would silently file every sale
  // under the wrong GSTIN and every purchase under the wrong supplier.
  our_gstin: [
    'our gstin', 'our gstn', 'our gst no', 'our gstin number', 'gstin of company',
    'gstin of recipient entity', 'company gstin', 'our registration', 'gstn',
  ],
  supplier_gstin: [
    'gstin of supplier', 'gstin of the supplier', 'supplier gstin', 'gstin/uin',
    'gst number', 'gstin number', 'vendor gstin', 'party gstin', 'gstin', 'gst no',
  ],
  customer_gstin: [
    'gstin of recipient', 'customer gstin', 'gstin of the recipient', 'recipient gstin',
    'customer gstin/uin', 'gstin', 'gstin/uin', 'party gstin',
  ],
  party_name: [
    'trade/legal name', 'trade/legal name (supplier)', 'trade legal name', 'trade name',
    'vendor', 'vendor name', 'supplier', 'supplier name', 'party name', 'particulars',
    'account name', 'name of supplier',
  ],
  customer_name: [
    'customer name', 'customer', 'party name', 'name of recipient', 'account name',
    'trade/legal name', 'particulars',
  ],
  supplier_name: [
    'trade/legal name', 'trade/legal name (supplier)', 'trade name', 'vendor',
    'vendor name', 'supplier name', 'name of supplier',
  ],
  invoice_no: [
    'invoice number', 'invoice no', 'invoice no.', 'inv no', 'document number',
    'doc no', 'bill no', 'supplier invoice', 'supplier invoice no', 'voucher no',
  ],
  invoice_date: [
    'invoice date', 'inv date', 'doc date', 'document date', 'bill date',
    'supplier invoice date', 'customer invoice date', 'invoice dt',
    'posting date', 'voucher date',
  ],
  invoice_type: [
    'invoice type', 'note/value', 'document type', 'doc type', 'note type',
    'supply type', 'type',
  ],
  invoice_value: [
    'invoice value(₹)', 'invoice value', 'invoice amount', 'total invoice value',
    'invoice total', 'gross amount', 'total amount', 'bill value',
    'doc total', 'doctotal', 'net amount', 'bill amount', 'total value',
  ],
  place_of_supply: ['place of supply', 'place of supply (name)', 'pos', 'supply state', 'to location', 'tolocation'],
  reverse_charge: [
    'supply attract reverse charge', 'reverse charge', 'rcm', 'attract reverse charge',
    'supply attracts reverse charge',
  ],

  // ---- amounts ----
  taxable_value: [
    'taxable value (₹)', 'taxable value', 'taxable amount', 'taxable val',
    'assessable value', 'basic amount', 'taxable amt',
    'net taxable', 'taxable', 'net value',
  ],
  igst: ['integrated tax(₹)', 'integrated tax', 'igst', 'igst amount', 'igst amt', 'igst input'],
  cgst: ['central tax(₹)', 'central tax', 'cgst', 'cgst amount', 'cgst amt', 'cgst input'],
  sgst: [
    'state/ut tax(₹)', 'state/ut tax', 'sgst/utgst', 'sgst', 'sgst amount', 'sgst amt',
    'utgst input', 'utgst', 'utgst amt', 'state tax',
  ],
  cess: ['cess(₹)', 'cess', 'cess amount', 'cess amt'],

  // ---- period / filing ----
  period: ['2b-month', '2b month', 'return period', 'tax period', 'period', 'month'],
  filing_date: [
    'gstr-1/iff/gstr-5 filing date', 'gstr-1/iff/gstr-5 period', 'filing date',
    'gstr-1/i-ff filing date', 'gstr-1/iff filing date', 'gstr-1 filing date',
  ],
  itc_availability: ['itc availability', 'itc available', 'eligibility', 'itc eligibility', 'availment'],
  reason: ['reason', 'itc reason', 'reason for ineligibility', 'ineligible reason'],
  applicable_pct: ['applicable % of tax rate', 'applicable pct of tax rate', 'tax rate', 'rate'],
  hsn: ['hsn', 'hsn code', 'hsn/sac', 'sac', 'sac code'],
  unit_name: [
    'unit', 'unit name', 'plant', 'location', 'location name', 'branch', 'company location',
    // The register's Location column, spelled out as a code. Same field: SAP
    // exports it as a plant code ("1000") and exports from other systems spell
    // it as a name, and the accounts team wants one column either way.
    'our location no', 'our location', 'location no', 'location code', 'plant code',
  ],
  remark: ['remark', 'remarks', 'note', 'notes'],

  // ---- e-invoice / e-way bill ----
  // Neither figure appears in GSTR-2B, so a purchase register may or may not
  // carry them. Kept as their own fields so the reconciliation screen can show
  // and re-record them without touching any book amount.
  has_e_invoice: ['e-invoice', 'einvoice', 'e invoice generated', 'e-invoice generated', 'irn generated'],
  e_invoice_no: ['e-invoice irn', 'irn', 'irn no', 'irn number', 'irn hash', 'e-invoice number'],
  has_e_way_bill: ['e-way bill', 'eway bill', 'e way bill', 'e-way bill generated', 'ewaybill generated'],
  e_way_bill_no: ['e-way bill no', 'eway bill no', 'e-way bill number', 'ewaybill no', 'ewaybill number', 'ewb no'],

  // ---- purchase-only ----
  // A purchase register usually carries the PO / GRN reference alongside the
  // invoice. It is NOT the invoice number, so it gets its own field instead of
  // being listed under `invoice_no` — otherwise a file carrying both columns
  // would match whichever came first and silently file the wrong number.
  reference_no: [
    'reference no', 'reference no.', 'reference number', 'reference',
    'ref no', 'ref. no', 'ref number', 'po no', 'po number', 'purchase order no',
    'grn no', 'grn number', 'voucher reference', 'your reference',
  ],

  // The date the invoice was booked in OUR books. Distinct from the supplier's
  // invoice date: a bill dated 28-Apr can be booked in May, and that gap is
  // precisely what puts a purchase in one month's books and a different
  // month's GSTR-2B.
  //
  // Deliberately NOT aliasing "posting date" / "voucher date" — those already
  // belong to `invoice_date`, and HEADER_LOOKUP is first-wins, so claiming
  // them here would silently move an existing file's invoice date.
  book_entry_date: [
    'book entry date', 'book date', 'entry date', 'booking date',
    'voucher entry date', 'document entry date', 'booked on', 'entry dt',
  ],

  // ---- sales-only ----
  note_ref_no: ['note no', 'note number', 'ref against invoice', 'linked invoice no', 'original invoice no'],
  note_ref_date: ['note date', 'note date (original)', 'linked invoice date', 'original invoice date'],
  card_code: ['cardcode', 'cardcode name', 'card code', 'customer code', 'party code', 'account code'],

  // ---- sales ITEM level (one CSV row = one invoice item / rate line) ----
  //
  // These are what make the HSN summary real. Without them the return can only
  // report one blended rate per invoice and an HSN row with no quantity — which
  // is why the sales parser groups rows into invoices first and then reads
  // these per line.
  //
  // `uqc` deliberately does NOT accept a bare "Unit"/"Unit Name": that header
  // already belongs to `unit_name` (our own plant/branch) and stealing it here
  // would silently move every unit name into the GST unit-of-measure column.
  line_no: ['line no', 'line number', 'line item', 'line item no', 'invoice line'],
  item_code: ['item code', 'material code', 'material no', 'material number', 'article code', 'product code', 'item no', 'item number', 'sku'],
  item_description: ['item description', 'item name', 'material description', 'product description', 'description of goods', 'description'],
  uqc: ['uqc', 'uom', 'unit of measure', 'unit of measurement', 'unit quantity code'],
  quantity: ['quantity', 'qty', 'billed quantity', 'invoice quantity', 'quantity billed'],
  // The rate PRINTED on the invoice line. `applicable_pct` (a GSTR-2B field)
  // already claims the generic "Tax Rate"/"Rate" spellings, so in a sales file
  // that header is remapped to this field — see PROFILE_FIELD_REMAP.
  gst_rate: ['gst rate', 'gst rate %', 'gst percentage', 'gst %', 'rate of gst', 'gst slab', 'igst rate'],
  // A break-up of the line's taxable value, NOT an extra amount on top of it.
  // Freight on which GST is charged is taxable, so it is part of `taxable_value`
  // already; these columns only let the CA see how much of it was freight.
  freight: ['freight', 'freight charges', 'freight amount', 'freight & other charges', 'freight and other charges'],
  other_charges: ['other charges', 'other charge', 'other expenses', 'other amount'],
  recipient_type: ['recipient type', 'customer type', 'party type', 'registration type'],

  // ---- amendments (B2BA / CDNRA) — captured now, used when a filed invoice
  // is corrected in a later period ----
  amendment_invoice_no: ['amendment of invoice no', 'amendment of invoice number', 'amendment invoice no', 'amended invoice no'],
  amendment_invoice_date: ['amendment of invoice date', 'amendment invoice date', 'amended invoice date'],

  // ---- e-commerce, and the document-series declaration (DOC_ISSUED) ----
  e_commerce_gstin: ['e-commerce gstin', 'ecommerce gstin', 'e commerce gstin', 'e-com operator gstin', 'e commerce operator gstin', 'etin'],
  doc_nature: ['doc nature', 'document nature', 'nature of document'],
  doc_series_from: ['doc series from', 'document series from', 'series from', 'invoice series from', 'from serial no'],
  doc_series_to: ['doc series to', 'document series to', 'series to', 'invoice series to', 'to serial no'],
  doc_series_cancelled: ['doc series cancelled', 'document series cancelled', 'series cancelled', 'cancelled invoices', 'cancelled count'],
};

/**
 * Preferred spellings when a field is claimed by more than one column.
 *
 * The SAP purchase register has FOUR columns that all look like a period —
 * `Month` (the entry month, an Excel serial) and `2B Month` (the GSTR-2B return
 * month, sometimes text like "Apr-25").
 *
 * `Period` / `Return Period` / `Tax Period` name the month the row is being
 * reported in, so they outrank `2B Month`: an explicit period column is the
 * whole reason one file can carry several months (see the purchase template).
 * `2B Month` stays next because it is what the SAP export actually has, and a
 * SAP file carries no `Period` column — so its behaviour is unchanged.
 */
export const FIELD_PRIORITY: Record<string, string[]> = {
  period: [
    'period', 'return period', 'tax period', '2b month', '2b-month',
    'gstr1/iff/gstr-5 period',
  ],
  invoice_no: ['invoice number', 'invoice no', 'supplier invoice no', 'document number'],
  taxable_value: ['taxable value', 'taxable amount'],
  // "Reference No" and "Invoice No" are different columns; when a file carries
  // both, the one that actually names the invoice must win.
  reference_no: ['reference no', 'reference no.', 'reference number', 'reference', 'ref no'],
};

/** Rank of a normalised header within its field. Lower is better, 999 = no rank. */
function rankOf(field: string, normalisedHeader: string): number {
  const prefs = FIELD_PRIORITY[field];
  if (!prefs) return 999;
  const idx = prefs.indexOf(normalisedHeader);
  return idx === -1 ? 999 : idx;
}

/** Lower-case, strip punctuation and collapse whitespace for alias comparison. */
export function normaliseHeader(h: unknown): string {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[₹]/g, '')
    .replace(/[_.()]/g, ' ')
    .replace(/[^a-z0-9/%& ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reverse index: normalised header -> canonical field. First alias wins. */
const HEADER_LOOKUP: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const a of aliases) {
      const k = normaliseHeader(a);
      if (!m.has(k)) m.set(k, field);
    }
  }
  return m;
})();

/**
 * Headers whose meaning depends on which register they came from.
 *
 * A column literally headed "GSTIN" means the CUSTOMER's GSTIN in a sales
 * register and the SUPPLIER's in a purchase register. Without this context a
 * sales file would attribute every customer's GSTIN to the supplier field, and
 * every sale would drop out of B2B into B2CS — a silent, expensive error.
 */
const CONTEXTUAL_FIELDS = new Set(['supplier_gstin', 'customer_gstin', 'supplier_name', 'customer_name', 'party_name']);
void CONTEXTUAL_FIELDS;

export interface HeaderContext {
  /** Which register the file is. Decides what bare "GSTIN" / "Name" mean. */
  profile: 'purchase' | 'twob' | 'sales';
}

/** Fields a bare, unqualified header should resolve to for each profile. */
const PROFILE_REMAP: Record<HeaderContext['profile'], Record<string, string>> = {
  purchase: { supplier_gstin: 'supplier_gstin', customer_gstin: 'supplier_gstin' },
  twob: { supplier_gstin: 'supplier_gstin', customer_gstin: 'supplier_gstin' },
  sales: { supplier_gstin: 'customer_gstin', customer_gstin: 'customer_gstin' },
};

/** Party-name fields follow the same buyer/seller split. */
const PROFILE_NAME_REMAP: Record<HeaderContext['profile'], Record<string, string>> = {
  purchase: { supplier_name: 'supplier_name', customer_name: 'supplier_name', party_name: 'party_name' },
  twob: { supplier_name: 'supplier_name', customer_name: 'supplier_name', party_name: 'party_name' },
  sales: { supplier_name: 'customer_name', customer_name: 'customer_name', party_name: 'customer_name' },
};

/**
 * Fields whose meaning in one register is another field's meaning elsewhere.
 *
 * Purely a renaming per profile, so the alias table itself stays one table.
 * A sales register's "Tax Rate" is the rate printed on the invoice line — the
 * GST-2B `applicable_pct` header of the same name means the percentage of
 * credit eligible, which is a different fact about a different kind of row.
 */
const PROFILE_FIELD_REMAP: Record<HeaderContext['profile'], Record<string, string>> = {
  purchase: {},
  twob: {},
  sales: { applicable_pct: 'gst_rate' },
};

/** Map a single header cell to a canonical field, or null if unknown. */
export function detectField(header: unknown, ctx?: HeaderContext): string | null {
  const k = normaliseHeader(header);
  if (!k) return null;
  const field = HEADER_LOOKUP.get(k);
  if (!field) return null;
  if (!ctx) return field;

  // A bare "GSTIN" / "Name" header means whichever counterparty this register
  // is about. Without the remap, a sales file would put every customer's GSTIN
  // in the supplier field and every sale would fall out of B2B into B2CS.
  if (field === 'supplier_gstin' || field === 'customer_gstin') {
    return PROFILE_REMAP[ctx.profile][field];
  }
  if (field === 'supplier_name' || field === 'customer_name' || field === 'party_name') {
    return PROFILE_NAME_REMAP[ctx.profile][field];
  }
  return PROFILE_FIELD_REMAP[ctx.profile][field] ?? field;
}

/**
 * Build a header -> field map for a whole row.
 *
 * `used` guards against two columns both claiming the same canonical field
 * (SAP registers often repeat a tax block three times for raw/clean/other).
 * The first occurrence wins, which matches how the team's existing workbook
 * reads the file.
 */
export function mapHeaders(headerRow: unknown[], ctx?: HeaderContext): {
  map: Map<number, string>;
  unmapped: string[];
} {
  const map = new Map<number, string>();
  const bestRank = new Map<string, number>();
  const bestIdx = new Map<string, number>();
  const unmapped: string[] = [];

  headerRow.forEach((cell, idx) => {
    const field = detectField(cell, ctx);
    if (!field) {
      const txt = String(cell ?? '').trim();
      if (txt) unmapped.push(txt);
      return;
    }
    const rank = rankOf(field, normaliseHeader(cell));
    if (!bestRank.has(field) || rank < bestRank.get(field)!) {
      bestRank.set(field, rank);
      bestIdx.set(field, idx);
    }
  });

  // Commit only the winning column per field, lowest rank first.
  const winners = [...bestRank.keys()].sort((a, b) => bestRank.get(a)! - bestRank.get(b)!);
  for (const field of winners) map.set(bestIdx.get(field)!, field);

  headerRow.forEach((cell, idx) => {
    const field = detectField(cell, ctx);
    if (!field) return;
    if (bestIdx.get(field) !== idx) {
      unmapped.push(`${String(cell).trim()} (superseded for ${field})`);
    }
  });

  return { map, unmapped };
}

/** Maps one header cell to a canonical field, or null when unrecognised. */
export type HeaderDetector = (cell: unknown) => string | null;

/**
 * Locate the header row inside a sheet.
 *
 * Source exports often carry a title banner and a totals line before the real
 * header. We score the first 15 rows and take the best.
 *
 * `detect` lets a caller with its own column vocabulary reuse this scan. The
 * GSTR-1 portal export shares no headers with the purchase register, so it
 * needs its own aliases — but the "where is the header row" question is
 * identical, and answering it two different ways is how two parsers end up
 * disagreeing about the same file.
 */
export function findHeaderRow(
  rows: unknown[][],
  required: string[],
  ctx?: HeaderContext,
  detect: HeaderDetector = (cell) => detectField(cell, ctx),
): number {
  let bestRow = 0;
  let bestScore = -1;
  const limit = Math.min(rows.length, 15);

  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    const fields = new Set<string>();
    for (const cell of row) {
      const f = detect(cell);
      if (f) fields.add(f);
    }
    let score = 0;
    for (const req of required) if (fields.has(req)) score++;
    // Prefer the row that recognises the most *required* fields; break ties by
    // total recognised fields so a data row never outscores a header row.
    score = score * 100 + fields.size;
    if (score > bestScore) {
      bestScore = score;
      bestRow = i;
    }
  }
  return bestScore > 0 ? bestRow : 0;
}

/** Read a field out of a row using a header map. */
export function pick(row: unknown[], map: Map<number, string>, field: string): unknown {
  for (const [idx, f] of map) {
    if (f === field) return row[idx];
  }
  return undefined;
}
