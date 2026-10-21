/**
 * GST ERP — the report layer.
 *
 * Every report in the application is defined here once, as a name, a set of
 * columns and one SQL statement. The server exposes each of them as CSV and as
 * a formatted Excel file, and builds the combined "Complete Reconciliation"
 * workbook out of the same definitions — so a number can never differ between
 * the screen, the CSV, the single-report Excel and the full workbook.
 *
 * Three rules
 *   1. FILTERS FLOW INTO THE EXPORT. The filter object is the single source of
 *      truth for both the rows on screen and the rows in the file. "Download
 *      All" is the same call with the filters cleared.
 *   2. BOOK COLUMNS ARE ALWAYS SHOWN ALONGSIDE THE RECONCILIATION ONES. A
 *      report that shows only the corrected value destroys the evidence.
 *   3. A REPORT THAT CANNOT EXIST YET SAYS SO. Several categories the spec asks
 *      for ("Possible Match", "Amendments") depend on matching features that are
 *      not built. They still run and return zero rows rather than disappearing,
 *      so nobody wonders whether a report is broken or simply empty.
 *
 * Everything is read from PostgreSQL; nothing here writes.
 */

import XLSX from 'xlsx';

import type { Client } from 'pg';
import { withClient } from './store';
import { polishWorkbook } from './xlsx-format';

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

export interface ReportFilters {
  /** Our own GSTIN — the registration the report is for. */
  gstin?: string;
  /** Exact book period (YYYY-MM), or... */
  period?: string;
  from?: string;
  to?: string;
  /** Supplier GSTIN. */
  supplier?: string;
  /** Vendor name contains. */
  vendor?: string;
  /** Free text across vendor / invoice no / GSTIN. */
  q?: string;
  /** Reconciliation match status. */
  status?: string;
  /** ITC decision. */
  decision?: string;
  classification?: string;
  /** The 2B month a line matched in. */
  twoBMonth?: string;
  /** The month the Accounts team decided to claim in. */
  decisionMonth?: string;
  /** pending | responded | none */
  followUp?: string;
  locked?: boolean;
}

export type ColType = 'text' | 'gstin' | 'money' | 'int' | 'date' | 'period' | 'datetime';

export interface Column {
  /** Header text, and the key read from the row object. */
  h: string;
  k: string;
  t?: ColType;
  /** Excel column width; money columns get more room by default. */
  w?: number;
  /** Header note shown in the column comment row of the Dashboard sheet. */
  note?: string;
}

// ---------------------------------------------------------------------------
// shared SQL fragments
// ---------------------------------------------------------------------------

const ITC = `(p.book_igst + p.book_cgst + p.book_sgst + p.book_cess)`;

/**
 * The derived "ITC Status" the spec asks for separately from the decision.
 *
 * It is a *reading* of the two fields the user controls, never a decision of
 * its own: a line with no decision is pending no matter how well it matched, and
 * a line the user decided against is decided even though it matched.
 */
const ITC_STATUS_SQL = `CASE
  WHEN p.itc_decision = 'Pending Review'
       AND p.matched_2b_key IS NULL THEN 'Pending — No 2B'
  WHEN p.itc_decision = 'Pending Review' THEN 'Matched — Pending Decision'
  WHEN p.itc_decision = 'Claim'
       AND p.itc_decision_month IS NOT NULL THEN 'Claimed in 3B'
  WHEN p.itc_decision = 'Claim' THEN 'Claim — Month not set'
  WHEN p.itc_decision = 'Reclaim Later' THEN 'To Reclaim'
  WHEN p.itc_decision = 'Query Vendor' THEN 'With Vendor'
  WHEN p.itc_decision = 'Do Not Claim' THEN 'Decided — Not Claimed'
  WHEN p.itc_decision = 'Reversed' THEN 'Reversed'
  WHEN p.itc_decision = 'Ineligible' THEN 'Ineligible'
  ELSE p.itc_decision END`;

/** Everything a line-level report can show, in one place. */
const LINE_SELECT = `
  p.id::int AS id,
  p.our_gstin,
  p.period,
  p.party_name,
  p.unit_name,
  p.source_file,
  p.source_row,
  p.book_supplier_gstin,
  p.book_invoice_no,
  p.book_invoice_date,
  p.book_document_type,
  p.book_document_type_raw,
  p.book_sign,
  p.source_taxable_value,
  p.source_igst,
  p.source_cgst,
  p.source_sgst,
  p.source_cess,
  p.book_taxable_value,
  p.book_igst,
  p.book_cgst,
  p.book_sgst,
  p.book_cess,
  ${ITC} AS book_itc,
  p.recon_supplier_gstin,
  p.recon_invoice_no,
  p.recon_invoice_date,
  p.recon_edited,
  p.match_status,
  p.matched_2b_key,
  p.matched_2b_month,
  p.twob_supplier_gstin,
  p.twob_invoice_no,
  p.twob_invoice_date,
  p.twob_taxable_value,
  p.twob_igst,
  p.twob_cgst,
  p.twob_sgst,
  p.twob_cess,
  p.twob_itc,
  p.itc_availability,
  p.taxable_difference,
  p.itc_difference,
  p.duplicate_count,
  p.mismatch_reason,
  p.suggested_action,
  p.itc_decision,
  p.itc_decision_month,
  ${ITC_STATUS_SQL} AS itc_status,
  p.return_classification,
  p.decision_by,
  p.decision_at,
  p.decision_reason,
  p.remarks,
  p.vendor_response,
  p.follow_up_date,
  p.expected_correction,
  p.action_taken,
  EXISTS (SELECT 1 FROM month_locks m
           WHERE m.our_gstin = p.our_gstin AND m.period = p.period AND m.is_locked) AS is_locked`;

const FROM_LINES = `FROM purchase_lines p`;

/**
 * The reports read from five different tables, and the five tables do NOT share
 * their columns: `purchase_lines` knows `book_supplier_gstin`, the 2B table
 * knows `supplier_gstin`, `month_locks` knows no supplier at all. The screen,
 * however, has a single filter bar, and it fills every filter it can.
 *
 * A profile maps each filter to the column that really exists on the report's
 * table. A filter the table cannot answer is written down in `ignored` — never
 * turned into SQL against a column that is not there. That is the difference
 * between a working report and a 500 the moment a month is selected.
 */
export type ReportProfile = 'purchase' | 'twob' | 'audit' | 'locks' | 'files';

/** `null` means "this table cannot answer that filter". */
interface ProfileSpec {
  /** Table alias in the report's FROM clause, or '' for unqualified columns. */
  alias: string;
  ourGstin: string;
  period: string | null;
  supplier: string | null;
  vendor: string | null;
  itcDecision: string | null;
  classification: string | null;
  twoBMonth: string | null;
  decisionMonth: string | null;
  /** Columns the free-text `q` searches, in order. */
  q: string[];
  /** match_status semantics; 'inBooks' is the 2B table's one honest status. */
  status: 'match' | 'inBooks' | null;
  /** How `locked` is answered: a month_locks lookup, or the column itself. */
  locked: 'exists' | 'column' | null;
  /** purchase_lines only: vendor_response / match_status follow-up. */
  followUp: boolean;
}

const PROFILES: Record<ReportProfile, ProfileSpec> = {
  purchase: {
    alias: 'p', ourGstin: 'our_gstin', period: 'period',
    supplier: 'book_supplier_gstin', vendor: 'party_name',
    itcDecision: 'itc_decision', classification: 'return_classification',
    twoBMonth: 'matched_2b_month', decisionMonth: 'itc_decision_month',
    q: ['party_name', 'book_invoice_no', 'recon_invoice_no', 'book_supplier_gstin', 'twob_invoice_no'],
    status: 'match', locked: 'exists', followUp: true,
  },
  // gstr2b_lines: `twob_month` is its month, `supplier_name` its vendor, and it
  // has no match_status at all — the only status it knows is the fact the 2B
  // reports are built on, a portal line no book row claimed.
  twob: {
    alias: 't', ourGstin: 'our_gstin', period: 'twob_month',
    supplier: 'supplier_gstin', vendor: 'supplier_name',
    itcDecision: null, classification: null,
    twoBMonth: 'twob_month', decisionMonth: null,
    q: ['supplier_name', 'invoice_no', 'supplier_gstin'],
    status: 'inBooks', locked: 'exists', followUp: false,
  },
  audit: {
    alias: '', ourGstin: 'our_gstin', period: 'period',
    supplier: 'supplier_gstin', vendor: null,
    itcDecision: null, classification: null,
    twoBMonth: null, decisionMonth: null,
    q: ['invoice_no', 'supplier_gstin', 'changed_by', 'field_name', 'action', 'reason'],
    status: null, locked: null, followUp: false,
  },
  locks: {
    alias: '', ourGstin: 'our_gstin', period: 'period',
    supplier: null, vendor: null,
    itcDecision: null, classification: null,
    twoBMonth: null, decisionMonth: null,
    q: ['period', 'financial_year', 'locked_by', 'unlocked_by', 'unlock_reason', 'reason'],
    status: null, locked: 'column', followUp: false,
  },
  files: {
    alias: '', ourGstin: 'our_gstin', period: 'twob_month',
    supplier: null, vendor: null,
    itcDecision: null, classification: null,
    twoBMonth: 'twob_month', decisionMonth: null,
    q: ['file_name', 'our_gstin', 'portal_fp', 'uploaded_by'],
    status: null, locked: null, followUp: false,
  },
};

/**
 * Build the shared WHERE clause for one report profile.
 *
 * Status is special: several of the categories the spec asks for are not
 * `match_status` values but *derived facts* about a match (the GSTIN that was
 * corrected, the date that was corrected, the amount that differs). They are
 * expressed here so every report and every export agree on what they mean.
 */
export function buildWhere(
  f: ReportFilters,
  profile: ReportProfile = 'purchase',
): { sql: string; params: unknown[]; ignored: string[] } {
  const P = PROFILES[profile];
  const params: unknown[] = [];
  const w: string[] = [];
  const ignored: string[] = [];
  const a = (col: string) => (P.alias ? `${P.alias}.${col}` : col);

  // `??` becomes the next positional placeholder. The count is taken AFTER the
  // push, so `$n` is correct for the value that was just added.
  const add = (frag: string, ...vals: unknown[]) => {
    params.push(...vals);
    w.push(frag.replace(/\?\?/g, `$${params.length}`));
  };

  // A filter this report's table cannot answer is written down, never turned
  // into SQL against a column that does not exist.
  const skip = (label: string) => ignored.push(label);

  if (f.gstin) add(`${a(P.ourGstin)} = ??`, f.gstin.trim().toUpperCase());

  const per = P.period;
  if (f.period) { if (per) add(`${a(per)} = ??`, f.period); else skip(`Month: ${f.period}`); }
  if (f.from) { if (per) add(`${a(per)} >= ??`, f.from); else skip(`From: ${f.from}`); }
  if (f.to) { if (per) add(`${a(per)} <= ??`, f.to); else skip(`To: ${f.to}`); }

  if (f.supplier) {
    if (P.supplier) add(`${a(P.supplier)} = ??`, f.supplier.trim().toUpperCase());
    else skip(`Supplier GSTIN: ${f.supplier}`);
  }
  if (f.vendor) {
    if (P.vendor) add(`UPPER(COALESCE(${a(P.vendor)},'')) LIKE ??`, `%${f.vendor.toUpperCase()}%`);
    else skip(`Vendor contains: ${f.vendor}`);
  }
  if (f.decision) {
    if (P.itcDecision) add(`${a(P.itcDecision)} = ??`, f.decision);
    else skip(`ITC decision: ${f.decision}`);
  }
  if (f.classification) {
    if (P.classification) add(`${a(P.classification)} = ??`, f.classification);
    else skip(`Return classification: ${f.classification}`);
  }
  if (f.twoBMonth) {
    if (P.twoBMonth) add(`${a(P.twoBMonth)} = ??`, f.twoBMonth);
    else skip(`2B month: ${f.twoBMonth}`);
  }
  if (f.decisionMonth) {
    if (P.decisionMonth) add(`${a(P.decisionMonth)} = ??`, f.decisionMonth);
    else skip(`ITC decision month: ${f.decisionMonth}`);
  }

  if (f.locked !== undefined) {
    if (P.locked === 'column') {
      add(`${a('is_locked')} = ??`, f.locked);
    } else if (P.locked === 'exists' && per) {
      const exists =
        `EXISTS (SELECT 1 FROM month_locks m WHERE m.our_gstin = ${a(P.ourGstin)}` +
        ` AND m.period = ${a(per)} AND m.is_locked)`;
      add(f.locked ? exists : `NOT ${exists}`);
    } else {
      skip(`Locked: ${f.locked}`);
    }
  }

  if (f.followUp) {
    if (!P.followUp) skip(`Follow-up: ${f.followUp}`);
    else if (f.followUp === 'pending') add(`${a('match_status')} <> 'Matched' AND (${a('vendor_response')} IS NULL OR ${a('vendor_response')} = '')`);
    else if (f.followUp === 'responded') add(`(${a('vendor_response')} IS NOT NULL AND ${a('vendor_response')} <> '')`);
    else skip(`Follow-up: ${f.followUp}`);
  }

  if (f.q) {
    if (!P.q.length) {
      skip(`Search: ${f.q}`);
    } else {
      const like = `%${f.q.trim().toLowerCase()}%`;
      const first = params.length + 1;
      const parts = P.q.map((col, i) => `LOWER(COALESCE(${a(col)},'')) LIKE $${first + i}`);
      w.push(`(${parts.join(' OR ')})`);
      for (let i = 0; i < P.q.length; i++) params.push(like);
    }
  }

  const status = (f.status || '').trim();
  // Only purchase_lines has a match_status; the 2B table answers one status and
  // every other table answers none. Both are resolved first, so the long switch
  // below is reserved for the table that actually has those columns.
  const plainStatus = status && P.status === 'match' ? status : '';
  if (status && !plainStatus) {
    if (P.status === 'inBooks' && (status === 'Missing in Books' || status === 'Not Booked')) add('true');
    else skip(`Status: ${status}`);
  }
  if (plainStatus) {
    switch (plainStatus) {
      // --- plain match_status values -------------------------------------
      case 'Matched':
      case 'Missing in 2B':
      case 'Amount Mismatch':
      case 'ITC Blocked':
      case 'Duplicate':
      case 'Pending Review':
        add(`${a('match_status')} = ??`, plainStatus);
        break;

      // --- derived categories the spec asks for --------------------------
      case 'GST Mismatch':
        // Matched only after the user corrected the GSTIN: the books and the
        // portal disagree about who the supplier is.
        add(`${a('matched_2b_key')} IS NOT NULL AND ${a('recon_supplier_gstin')} <> ${a('twob_supplier_gstin')}`);
        break;

      case 'Taxable Value Mismatch':
        add(`(${a('match_status')} = 'Amount Mismatch'
              OR (${a('matched_2b_key')} IS NOT NULL
                  AND ABS(COALESCE(${a('twob_taxable_value')},0) - ${a('book_taxable_value')}) > 0.01))`);
        break;

      case 'GST Amount Mismatch':
        add(`${a('matched_2b_key')} IS NOT NULL
             AND ABS(COALESCE(${a('twob_itc')},0) - ${ITC}) > 1`);
        break;

      case 'Date Mismatch':
        add(`${a('matched_2b_key')} IS NOT NULL
             AND COALESCE(${a('recon_invoice_date')}::text,'') <> COALESCE(${a('twob_invoice_date')}::text,'')`);
        break;

      case 'Invoice Number Mismatch':
        add(`${a('matched_2b_key')} IS NOT NULL
             AND LOWER(${a('recon_invoice_no')}) <> LOWER(${a('twob_invoice_no')})`);
        break;

      case 'Possible Match':
        // A book invoice the portal does not have under that number, where the
        // SAME supplier does appear in a 2B month either side of the book month.
        // That is the honest definition of "possible": the vendor is active in
        // that window, so the invoice may simply be filed under another number.
        // It is a review list, never an auto-match.
        add(`${a('match_status')} = 'Missing in 2B' AND EXISTS (
              SELECT 1 FROM gstr2b_lines t
               WHERE t.our_gstin = ${a('our_gstin')}
                 AND t.supplier_gstin = ${a('book_supplier_gstin')}
                 AND t.twob_month BETWEEN to_char(to_date(${a('period')}, 'YYYY-MM') - INTERVAL '2 months', 'YYYY-MM')
                                     AND to_char(to_date(${a('period')}, 'YYYY-MM') + INTERVAL '2 months', 'YYYY-MM'))`);
        break;

      case 'Missing in Books':
      case 'Not Booked':
        // "Missing in Books" is a GSTR-2B status, never a purchase-line one: it
        // marks a 2B line that no book row claimed, and those live in
        // `gstr2b_lines` (reported by `twob-not-in-books`). A purchase line
        // cannot be missing from the books it sits in.
        //
        // The old clause was `NOT EXISTS (SELECT 1 FROM purchase_lines q WHERE
        // q.matched_2b_key = <key>)`. For a matched row the row itself is in the
        // subquery so it never matched; for an unmatched row the key is NULL and
        // `= NULL` is never true, so NOT EXISTS held. It therefore returned every
        // book row with no 2B match — the exact opposite of what its name said.
        add('false');
        break;

      default:
        // An unknown status must not silently return everything.
        add('false');
    }
  }

  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', params, ignored };
}

// ---------------------------------------------------------------------------
// column sets
// ---------------------------------------------------------------------------

const C = (h: string, k: string, t: ColType = 'text', w?: number): Column => ({ h, k, t, w });

/**
 * The proof columns the spec wants next to every purchase row.
 *
 * Exported because the working-sheet template (`twob-recon-template.ts`) reuses
 * these exact column lists: the sheet the Accounts team fills in and the report
 * they read on screen must be one column definition, not two that drift.
 */
export const BOOK_COLS: Column[] = [
  C('Line ID', 'id', 'int', 10),
  C('GSTIN', 'our_gstin', 'gstin', 19),
  C('Period', 'period', 'period', 9),
  C('Supplier Name', 'party_name', 'text', 30),
  C('Book Supplier GSTIN', 'book_supplier_gstin', 'gstin', 19),
  C('Book Invoice No', 'book_invoice_no', 'text', 18),
  C('Book Invoice Date', 'book_invoice_date', 'date', 13),
  C('Document Type', 'book_document_type', 'text', 14),
  C('Document Type (Source)', 'book_document_type_raw', 'text', 14),
  C('Sign', 'book_sign', 'int', 6),
  // The file's own figures next to the signed ones — a credit note entered as
  // 5,000 shows Source 5,000 and Signed -5,000, so the sign can be audited
  // without re-reading the upload.
  C('Source Taxable', 'source_taxable_value', 'money', 14),
  C('Source IGST', 'source_igst', 'money', 11),
  C('Source CGST', 'source_cgst', 'money', 11),
  C('Source SGST', 'source_sgst', 'money', 11),
  C('Source Cess', 'source_cess', 'money', 10),
  C('Signed Taxable', 'book_taxable_value', 'money', 14),
  C('Signed IGST', 'book_igst', 'money', 12),
  C('Signed CGST', 'book_cgst', 'money', 12),
  C('Signed SGST', 'book_sgst', 'money', 12),
  C('UTGST', 'utgst', 'money', 12),
  C('Signed Cess', 'book_cess', 'money', 10),
  C('Signed ITC', 'book_itc', 'money', 14),
];

export const RECON_COLS: Column[] = [
  C('Recon Supplier GSTIN', 'recon_supplier_gstin', 'gstin', 19),
  C('Recon Invoice No', 'recon_invoice_no', 'text', 18),
  C('Recon Invoice Date', 'recon_invoice_date', 'date', 13),
  C('Edited', 'edited_yesno', 'text', 8),
];

export const TWOB_COLS: Column[] = [
  C('2B Matched', 'matched_yesno', 'text', 10),
  C('2B Matched Month', 'matched_2b_month', 'period', 12),
  C('2B Supplier GSTIN', 'twob_supplier_gstin', 'gstin', 19),
  C('2B Invoice No', 'twob_invoice_no', 'text', 18),
  C('2B Invoice Date', 'twob_invoice_date', 'date', 13),
  C('2B Taxable Value', 'twob_taxable_value', 'money', 14),
  C('2B IGST', 'twob_igst', 'money', 12),
  C('2B CGST', 'twob_cgst', 'money', 12),
  C('2B SGST', 'twob_sgst', 'money', 12),
  C('2B ITC', 'twob_itc', 'money', 13),
  C('ITC Availability', 'itc_availability', 'text', 12),
  C('Taxable Difference', 'taxable_difference', 'money', 14),
  C('ITC Difference', 'itc_difference', 'money', 13),
];

export const DECISION_COLS: Column[] = [
  C('2B Match Status', 'match_status', 'text', 16),
  C('ITC Decision', 'itc_decision', 'text', 15),
  C('ITC Decision Month', 'itc_decision_month', 'period', 13),
  C('ITC Status', 'itc_status', 'text', 24),
  C('Return Classification', 'return_classification', 'text', 20),
  C('Decision By', 'decision_by', 'text', 14),
  C('Decision Date', 'decision_at', 'date', 12),
  C('Reason', 'decision_reason', 'text', 40),
];

export const FOLLOWUP_COLS: Column[] = [
  C('Remarks', 'remarks', 'text', 34),
  C('Vendor Response', 'vendor_response', 'text', 34),
  C('Follow-up Date', 'follow_up_date', 'date', 13),
  C('Expected Correction', 'expected_correction', 'text', 30),
  C('Action Taken', 'action_taken', 'text', 30),
];

const ITC_HEAD: Column[] = [
  C('Supplier GSTIN', 'supplier_gstin', 'gstin', 19),
  C('Supplier Name', 'supplier_name', 'text', 30),
  C('Book Invoice No', 'book_invoice_no', 'text', 18),
  C('Recon Invoice No', 'recon_invoice_no', 'text', 18),
  C('Book Invoice Date', 'book_invoice_date', 'date', 13),
  C('Recon Invoice Date', 'recon_invoice_date', 'date', 13),
  C('Taxable Value', 'book_taxable_value', 'money', 14),
  C('IGST', 'book_igst', 'money', 12),
  C('CGST', 'book_cgst', 'money', 12),
  C('SGST', 'book_sgst', 'money', 12),
  C('UTGST', 'utgst', 'money', 12),
  C('CESS', 'book_cess', 'money', 10),
  C('ITC Total', 'book_itc', 'money', 14),
];

// ---------------------------------------------------------------------------
// report definitions
// ---------------------------------------------------------------------------

export interface ReportDef {
  name: string;
  title: string;
  category: 'purchase' | 'itc' | 'control';
  /** Which table this report reads from — this is what drives the filter map. */
  profile?: ReportProfile;
  /** Present when the category depends on a matching feature not yet built. */
  note?: string;
  /** SQL selecting the rows, given a filter set. */
  sql: (w: string) => string;
  columns: Column[];
  /** Grouped reports summarise instead of listing. */
  aggregate?: boolean;
  /** Sort order applied after filtering. */
  orderBy?: string;
}

const line = (extra: string, cols: Column[], order = `p.our_gstin, p.period, p.party_name, p.book_invoice_no`): ReportDef['sql'] =>
  () => extra;

/**
 * Combine the caller's filter with the report's own definition of itself.
 *
 * A category report like "Missing in 2B" must BE that category even when no
 * filter is set, and must stay that category when one is. So the two clauses are
 * ANDed — never ORed, never one-or-the-other.
 */
function andWhere(filter: string, fixed?: string): string {
  // `filter` arrives from buildWhere() and may already start with WHERE.
  const clauses = [filter.replace(/^\s*WHERE\s+/i, ''), fixed ? `(${fixed})` : ''].filter(Boolean);
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

/** Filtered by `status`, exactly as the screen shows it. */
const lineReport = (
  name: string,
  title: string,
  category: ReportDef['category'],
  columns: Column[],
  opts: { fixed?: string; note?: string; aggregate?: boolean; orderBy?: string } = {},
): ReportDef => ({
  name,
  title,
  category,
  note: opts.note,
  aggregate: opts.aggregate,
  orderBy: opts.orderBy,
  columns,
  sql: (w) =>
    `SELECT ${LINE_SELECT} ${FROM_LINES} ${andWhere(w, opts.fixed)}` +
    ` ORDER BY ${opts.orderBy ?? 'p.our_gstin, p.period, p.party_name, p.book_invoice_no'}`,
});

const STATUS_FIXED = {
  Matched: `p.match_status = 'Matched'`,
  Missing: `p.match_status = 'Missing in 2B'`,
  Mismatch: `p.match_status = 'Amount Mismatch'`,
  Duplicate: `p.match_status = 'Duplicate'`,
  Blocked: `p.match_status = 'ITC Blocked'`,
} as const;

export const REPORTS: ReportDef[] = [
  // ---- purchase ---------------------------------------------------------
  lineReport('purchase-register', 'Purchase Register (as booked)', 'purchase', [
    ...BOOK_COLS, C('Remarks', 'remark', 'text', 30), C('Source File', 'source_file', 'text', 28),
  ]),
  lineReport('purchase-reconciliation', 'Purchase Reconciliation — book vs reconciliation vs 2B', 'purchase', [
    ...BOOK_COLS, ...RECON_COLS, ...TWOB_COLS, ...DECISION_COLS,
  ]),
  lineReport('invoice-wise', 'Invoice-wise Reconciliation', 'purchase', [
    ...BOOK_COLS, ...RECON_COLS, ...TWOB_COLS, C('2B Match Status', 'match_status', 'text', 16),
    C('Kya Karna Hai', 'suggested_action', 'text', 60),
  ]),
  lineReport('matched', 'Matched Invoices', 'purchase', [...BOOK_COLS, ...TWOB_COLS, ...DECISION_COLS],
    { fixed: STATUS_FIXED.Matched }),
  lineReport('missing-in-2b', 'Missing in 2B — vendor follow-up', 'purchase', [
    ...BOOK_COLS, ...RECON_COLS, ...TWOB_COLS, ...DECISION_COLS, ...FOLLOWUP_COLS,
    C('Kya Karna Hai', 'suggested_action', 'text', 60),
  ], { fixed: STATUS_FIXED.Missing, orderBy: 'p.our_gstin, p.book_supplier_gstin, p.book_invoice_no' }),
  lineReport('mismatch', 'Amount Mismatch', 'purchase', [
    ...BOOK_COLS, ...RECON_COLS, ...TWOB_COLS, C('Reason', 'mismatch_reason', 'text', 30),
  ], { fixed: STATUS_FIXED.Mismatch }),
  lineReport('gst-mismatch', 'GST Mismatch', 'purchase', [
    ...BOOK_COLS, ...RECON_COLS, C('2B Supplier GSTIN', 'twob_supplier_gstin', 'gstin', 19),
    C('Difference', 'gstin_diff', 'text', 40),
  ], { fixed: `p.matched_2b_key IS NOT NULL AND p.recon_supplier_gstin <> p.twob_supplier_gstin` }),
  lineReport('taxable-mismatch', 'Taxable Value Mismatch', 'purchase', [
    ...BOOK_COLS, ...RECON_COLS, C('2B Taxable Value', 'twob_taxable_value', 'money', 14),
    C('Taxable Difference', 'taxable_difference', 'money', 14), C('2B ITC', 'twob_itc', 'money', 13),
  ], { fixed: `(p.match_status = 'Amount Mismatch' OR (p.matched_2b_key IS NOT NULL AND ABS(COALESCE(p.twob_taxable_value,0) - p.book_taxable_value) > 0.01))` }),
  lineReport('gst-amount-mismatch', 'GST Amount Mismatch', 'purchase', [
    ...BOOK_COLS, C('Book ITC', 'book_itc', 'money', 14), C('2B ITC', 'twob_itc', 'money', 13),
    C('ITC Difference', 'itc_difference', 'money', 13),
  ], { fixed: `p.matched_2b_key IS NOT NULL AND ABS(COALESCE(p.twob_itc,0) - (p.book_igst + p.book_cgst + p.book_sgst + p.book_cess)) > 1` }),
  lineReport('date-mismatch', 'Date Mismatch', 'purchase', [
    ...BOOK_COLS, ...RECON_COLS, C('2B Invoice Date', 'twob_invoice_date', 'date', 13),
  ], { fixed: `p.matched_2b_key IS NOT NULL AND COALESCE(p.recon_invoice_date::text,'') <> COALESCE(p.twob_invoice_date::text,'')` }),
  lineReport('possible-match', 'Possible Match — review list, never auto-matched', 'purchase', [
    ...BOOK_COLS, ...RECON_COLS, C('Why Possible', 'possible_why', 'text', 70),
  ], {
    fixed: `p.match_status = 'Missing in 2B' AND EXISTS (
              SELECT 1 FROM gstr2b_lines t
               WHERE t.our_gstin = p.our_gstin AND t.supplier_gstin = p.book_supplier_gstin
                 AND t.twob_month BETWEEN to_char(to_date(p.period,'YYYY-MM') - INTERVAL '2 months','YYYY-MM')
                                     AND to_char(to_date(p.period,'YYYY-MM') + INTERVAL '2 months','YYYY-MM'))`,
    note: 'Definition: booked but absent from 2B, while the same supplier appears in a 2B month within two months either side. Review it — nothing here is matched automatically.',
  }),
  lineReport('duplicate', 'Duplicate Invoices', 'purchase', [
    ...BOOK_COLS, C('Occurrences', 'duplicate_count', 'int', 12),
  ], { fixed: STATUS_FIXED.Duplicate }),
  lineReport('itc-blocked', 'ITC Blocked (4B candidates)', 'purchase', [
    ...BOOK_COLS, C('ITC Availability', 'itc_availability', 'text', 12), C('Reason', 'mismatch_reason', 'text', 40),
  ], { fixed: STATUS_FIXED.Blocked }),
  {
    name: 'twob-not-in-books',
    title: '2B Not in Books',
    category: 'purchase',
    profile: 'twob',
    orderBy: 't.our_gstin, t.twob_month, t.supplier_gstin, t.invoice_no',
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('2B Month', 'twob_month', 'period', 11),
      C('Supplier GSTIN', 'supplier_gstin', 'gstin', 19), C('Supplier Name', 'supplier_name', 'text', 30),
      C('Invoice No', 'invoice_no', 'text', 18), C('Invoice Date', 'invoice_date', 'date', 13),
      C('Document Type', 'document_type', 'text', 14),
      C('Taxable Value', 'taxable_value', 'money', 14), C('IGST', 'igst', 'money', 12),
      C('CGST', 'cgst', 'money', 12), C('SGST', 'sgst', 'money', 12), C('CESS', 'cess', 'money', 10),
      C('Total ITC', 'itc', 'money', 13), C('ITC Availability', 'itc_availability', 'text', 12),
      C('Reason', 'reason', 'text', 30),
    ],
    sql: (w) => `SELECT t.our_gstin, t.twob_month, t.supplier_gstin, t.supplier_name, t.invoice_no,
                        t.invoice_date, t.document_type, t.taxable_value, t.igst, t.cgst, t.sgst, t.cess,
                        (t.igst + t.cgst + t.sgst + t.cess) AS itc, t.itc_availability, t.reason
                   FROM gstr2b_lines t
                  ${andWhere(w, 'NOT EXISTS (SELECT 1 FROM purchase_lines q WHERE q.matched_2b_key = t.line_key)')}
                  ORDER BY t.our_gstin, t.twob_month, t.supplier_gstin, t.invoice_no`,
  },
  {
    name: 'credit-notes',
    title: 'Credit Notes',
    category: 'purchase',
    profile: 'twob',
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('2B Month', 'twob_month', 'period', 11),
      C('Supplier GSTIN', 'supplier_gstin', 'gstin', 19), C('Supplier Name', 'supplier_name', 'text', 28),
      C('Invoice No', 'invoice_no', 'text', 18), C('Invoice Date', 'invoice_date', 'date', 13),
      C('Taxable Value', 'taxable_value', 'money', 14), C('Total ITC', 'itc', 'money', 13),
      C('In Books', 'in_books', 'text', 10),
    ],
    sql: (w) => `SELECT t.our_gstin, t.twob_month, t.supplier_gstin, t.supplier_name, t.invoice_no,
                        t.invoice_date, t.taxable_value, (t.igst + t.cgst + t.sgst + t.cess) AS itc,
                        CASE WHEN EXISTS (SELECT 1 FROM purchase_lines q WHERE q.matched_2b_key = t.line_key)
                             THEN 'Yes' ELSE 'No' END AS in_books
                   FROM gstr2b_lines t
                  ${andWhere(w, "(t.document_type ILIKE '%credit%' OR t.document_type ILIKE '%CDN%' OR t.document_type ILIKE '%CN%')")}
                  ORDER BY t.our_gstin, t.twob_month, t.invoice_no`,
  },
  {
    name: 'debit-notes',
    title: 'Debit Notes',
    category: 'purchase',
    profile: 'twob',
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('2B Month', 'twob_month', 'period', 11),
      C('Supplier GSTIN', 'supplier_gstin', 'gstin', 19), C('Supplier Name', 'supplier_name', 'text', 28),
      C('Invoice No', 'invoice_no', 'text', 18), C('Invoice Date', 'invoice_date', 'date', 13),
      C('Taxable Value', 'taxable_value', 'money', 14), C('Total ITC', 'itc', 'money', 13),
      C('In Books', 'in_books', 'text', 10),
    ],
    sql: (w) => `SELECT t.our_gstin, t.twob_month, t.supplier_gstin, t.supplier_name, t.invoice_no,
                        t.invoice_date, t.taxable_value, (t.igst + t.cgst + t.sgst + t.cess) AS itc,
                        CASE WHEN EXISTS (SELECT 1 FROM purchase_lines q WHERE q.matched_2b_key = t.line_key)
                             THEN 'Yes' ELSE 'No' END AS in_books
                   FROM gstr2b_lines t
                  ${andWhere(w, "(t.document_type ILIKE '%debit%' OR t.document_type ILIKE '%DN%')")}
                  ORDER BY t.our_gstin, t.twob_month, t.invoice_no`,
  },
  {
    name: 'amendments',
    title: 'Amendments (2B lines amended after filing)',
    category: 'purchase',
    profile: 'twob',
    note: 'Keyed on the portal reason text. A 2B that reports no amendment reason returns zero rows — that is a real answer, not a broken report.',
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('2B Month', 'twob_month', 'period', 11),
      C('Supplier GSTIN', 'supplier_gstin', 'gstin', 19), C('Supplier Name', 'supplier_name', 'text', 28),
      C('Invoice No', 'invoice_no', 'text', 18), C('Invoice Date', 'invoice_date', 'date', 13),
      C('Taxable Value', 'taxable_value', 'money', 14), C('Total ITC', 'itc', 'money', 13),
      C('Reason', 'reason', 'text', 50), C('In Books', 'in_books', 'text', 10),
    ],
    sql: (w) => `SELECT t.our_gstin, t.twob_month, t.supplier_gstin, t.supplier_name, t.invoice_no,
                        t.invoice_date, t.taxable_value, (t.igst + t.cgst + t.sgst + t.cess) AS itc, t.reason,
                        CASE WHEN EXISTS (SELECT 1 FROM purchase_lines q WHERE q.matched_2b_key = t.line_key)
                             THEN 'Yes' ELSE 'No' END AS in_books
                   FROM gstr2b_lines t
                  ${andWhere(w, "(t.reason ILIKE '%amend%' OR t.reason ILIKE '%modif%' OR t.reason ILIKE '%change%')")}
                  ORDER BY t.our_gstin, t.twob_month, t.invoice_no`,
  },
  {
    name: 'supplier-wise',
    title: 'Supplier-wise Reconciliation',
    category: 'purchase',
    aggregate: true,
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('Supplier GSTIN', 'book_supplier_gstin', 'gstin', 19),
      C('Supplier Name', 'supplier_name', 'text', 32), C('Book Invoices', 'book_invoices', 'int', 12),
      C('2B Invoices', 'twob_invoices', 'int', 12), C('Matched', 'matched', 'int', 10),
      C('Mismatch', 'mismatch', 'int', 10), C('Missing in 2B', 'missing', 'int', 12),
      C('Duplicates', 'duplicates', 'int', 11),
      C('Gross Taxable', 'gross_taxable', 'money', 15),
      C('Credit Notes', 'credit_note_taxable', 'money', 14),
      C('Net Taxable', 'book_taxable', 'money', 15), C('Book ITC', 'book_itc', 'money', 15),
      C('2B ITC', 'twob_itc', 'money', 15),
      C('ITC Pending Decision', 'itc_pending', 'int', 14), C('ITC Claimed', 'itc_claimed', 'int', 11),
      C('ITC Not Claimed', 'itc_not_claimed', 'int', 14),
      C('Last Follow-up', 'follow_up_date', 'date', 13),
    ],
    sql: (w) => `SELECT p.our_gstin, p.book_supplier_gstin, MAX(p.party_name) AS supplier_name,
                       count(*)::int AS book_invoices,
                       count(*) FILTER (WHERE p.matched_2b_key IS NOT NULL)::int AS twob_invoices,
                       count(*) FILTER (WHERE p.match_status = 'Matched')::int AS matched,
                       count(*) FILTER (WHERE p.match_status = 'Amount Mismatch')::int AS mismatch,
                       count(*) FILTER (WHERE p.match_status = 'Missing in 2B')::int AS missing,
                       count(*) FILTER (WHERE p.match_status = 'Duplicate')::int AS duplicates,
                       COALESCE(sum(CASE WHEN p.book_document_type = 'Credit Note' THEN 0
                                         ELSE p.book_taxable_value END),0) AS gross_taxable,
                       COALESCE(sum(CASE WHEN p.book_document_type = 'Credit Note'
                                         THEN ABS(p.book_taxable_value) ELSE 0 END),0) AS credit_note_taxable,
                       COALESCE(sum(p.book_taxable_value),0) AS book_taxable,
                       COALESCE(sum(${ITC}),0) AS book_itc,
                       COALESCE(sum(COALESCE(p.twob_itc,0)),0) AS twob_itc,
                       count(*) FILTER (WHERE p.itc_decision = 'Pending Review')::int AS itc_pending,
                       count(*) FILTER (WHERE p.itc_decision = 'Claim')::int AS itc_claimed,
                       count(*) FILTER (WHERE p.itc_decision IN ('Do Not Claim','Ineligible','Reversed'))::int AS itc_not_claimed,
                       MAX(p.follow_up_date) AS follow_up_date
                  FROM purchase_lines p ${w}
                 GROUP BY p.our_gstin, p.book_supplier_gstin
                 ORDER BY missing DESC, book_itc DESC`,
  },
  {
    name: 'gstin-wise',
    title: 'GSTIN-wise Reconciliation',
    category: 'purchase',
    aggregate: true,
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('Period', 'period', 'period', 10),
      C('Book Invoices', 'book_invoices', 'int', 12), C('2B Lines', 'twob_lines', 'int', 11),
      C('Matched', 'matched', 'int', 10), C('Mismatch', 'mismatch', 'int', 10),
      C('Missing in 2B', 'missing', 'int', 12), C('Duplicates', 'duplicates', 'int', 11),
      C('Gross Taxable', 'gross_taxable', 'money', 15),
      C('Credit Notes', 'credit_note_taxable', 'money', 14),
      C('Net Taxable', 'book_taxable', 'money', 15), C('Book ITC', 'book_itc', 'money', 15),
      C('2B ITC Matched', 'twob_itc', 'money', 15),
      C('ITC Pending Decision', 'itc_pending', 'int', 14),
      C('ITC Claimed', 'itc_claimed', 'int', 11),
      C('Match %', 'match_pct', 'text', 9),
    ],
    sql: (w) => `SELECT p.our_gstin, p.period,
                       count(*)::int AS book_invoices,
                       (SELECT count(*)::int FROM gstr2b_lines t
                         WHERE t.our_gstin = p.our_gstin AND t.twob_month = p.period) AS twob_lines,
                       count(*) FILTER (WHERE p.match_status = 'Matched')::int AS matched,
                       count(*) FILTER (WHERE p.match_status = 'Amount Mismatch')::int AS mismatch,
                       count(*) FILTER (WHERE p.match_status = 'Missing in 2B')::int AS missing,
                       count(*) FILTER (WHERE p.match_status = 'Duplicate')::int AS duplicates,
                       COALESCE(sum(CASE WHEN p.book_document_type = 'Credit Note' THEN 0
                                         ELSE p.book_taxable_value END),0) AS gross_taxable,
                       COALESCE(sum(CASE WHEN p.book_document_type = 'Credit Note'
                                         THEN ABS(p.book_taxable_value) ELSE 0 END),0) AS credit_note_taxable,
                       COALESCE(sum(p.book_taxable_value),0) AS book_taxable,
                       COALESCE(sum(${ITC}),0) AS book_itc,
                       COALESCE(sum(COALESCE(p.twob_itc,0)),0) AS twob_itc,
                       count(*) FILTER (WHERE p.itc_decision = 'Pending Review')::int AS itc_pending,
                       count(*) FILTER (WHERE p.itc_decision = 'Claim')::int AS itc_claimed,
                       CASE WHEN count(*) FILTER (WHERE p.match_status <> 'Duplicate') = 0 THEN '0.0'
                            ELSE round(100.0 * count(*) FILTER (WHERE p.match_status = 'Matched')
                                  / count(*) FILTER (WHERE p.match_status <> 'Duplicate'), 1)::text END AS match_pct
                  FROM purchase_lines p ${w}
                 GROUP BY p.our_gstin, p.period
                 ORDER BY p.our_gstin, p.period`,
  },

  // ---- ITC --------------------------------------------------------------
  {
    name: 'itc-working',
    title: 'ITC Working — the human decision, per invoice',
    category: 'itc',
    columns: [...BOOK_COLS.slice(0, 4), ...ITC_HEAD.slice(0, 13), ...TWOB_COLS, ...DECISION_COLS, ...FOLLOWUP_COLS],
    sql: (w) => `SELECT ${LINE_SELECT} ${FROM_LINES} ${w}
                 ORDER BY p.our_gstin, p.matched_2b_month, p.party_name, p.book_invoice_no`,
  },
  {
    name: 'itc-decision-report',
    title: 'ITC Decision Report — every decision and its reason',
    category: 'itc',
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('Period', 'period', 'period', 9),
      ...ITC_HEAD, C('2B Match Status', 'match_status', 'text', 16), C('2B Matched Month', 'matched_2b_month', 'period', 12),
      ...DECISION_COLS, ...FOLLOWUP_COLS,
    ],
    sql: (w) => `SELECT ${LINE_SELECT} ${FROM_LINES} ${w}
                 ORDER BY p.itc_decision, p.our_gstin, p.period, p.party_name`,
  },
  ...(['Pending Review', 'Claim', 'Do Not Claim', 'Reclaim Later', 'Query Vendor', 'Ineligible', 'Reversed'] as const).map(
    (d): ReportDef => ({
      name: `itc-${d.toLowerCase().replace(/[^a-z]+/g, '-')}`,
      title: `ITC — ${d}`,
      category: 'itc',
      columns: [
        C('GSTIN', 'our_gstin', 'gstin', 19), C('Period', 'period', 'period', 9),
        ...ITC_HEAD, C('2B Match Status', 'match_status', 'text', 16), C('2B Matched Month', 'matched_2b_month', 'period', 12),
        C('ITC Status', 'itc_status', 'text', 24), C('Decision Month', 'itc_decision_month', 'period', 13),
        C('Decision By', 'decision_by', 'text', 14), C('Decision Date', 'decision_at', 'date', 12),
        C('Reason', 'decision_reason', 'text', 40),
      ],
      sql: (w) => `SELECT ${LINE_SELECT} ${FROM_LINES}
                   ${andWhere(w, `p.itc_decision = '${d.replace(/'/g, "''")}'`)}
                   ORDER BY p.our_gstin, p.period, p.party_name`,
    }),
  ),
  {
    name: 'itc-pending',
    title: 'ITC Pending — matched but no decision taken',
    category: 'itc',
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('Period', 'period', 'period', 9),
      ...ITC_HEAD, C('2B Match Status', 'match_status', 'text', 16), C('2B Matched Month', 'matched_2b_month', 'period', 12),
      C('ITC Status', 'itc_status', 'text', 24), ...FOLLOWUP_COLS,
    ],
    sql: (w) => `SELECT ${LINE_SELECT} ${FROM_LINES}
                 ${andWhere(w, `p.itc_decision = 'Pending Review'`)}
                 ORDER BY p.our_gstin, p.period, p.party_name`,
  },
  {
    name: 'itc-2b-month-wise',
    title: 'ITC by 2B Month — what the portal made available, and when',
    category: 'itc',
    aggregate: true,
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('2B Month', 'matched_2b_month', 'period', 11),
      C('Invoices', 'invoices', 'int', 11), C('Taxable', 'taxable', 'money', 16),
      C('IGST', 'igst', 'money', 14), C('CGST', 'cgst', 'money', 14), C('SGST', 'sgst', 'money', 14),
      C('Total ITC', 'itc', 'money', 16),
      C('Claimed', 'claimed', 'int', 11), C('Do Not Claim', 'do_not_claim', 'int', 12),
      C('Query Vendor', 'query_vendor', 'int', 12), C('Pending', 'pending', 'int', 11),
      C('Claimed ITC (decision)', 'claimed_itc', 'money', 17),
    ],
    sql: (w) => `SELECT p.our_gstin, p.matched_2b_month,
                       count(*)::int AS invoices,
                       COALESCE(sum(p.book_taxable_value),0) AS taxable,
                       COALESCE(sum(p.book_igst),0) AS igst,
                       COALESCE(sum(p.book_cgst),0) AS cgst,
                       COALESCE(sum(p.book_sgst),0) AS sgst,
                       COALESCE(sum(${ITC}),0) AS itc,
                       count(*) FILTER (WHERE p.itc_decision = 'Claim')::int AS claimed,
                       count(*) FILTER (WHERE p.itc_decision = 'Do Not Claim')::int AS do_not_claim,
                       count(*) FILTER (WHERE p.itc_decision = 'Query Vendor')::int AS query_vendor,
                       count(*) FILTER (WHERE p.itc_decision = 'Pending Review')::int AS pending,
                       COALESCE(sum(${ITC}) FILTER (WHERE p.itc_decision = 'Claim'),0) AS claimed_itc
                  FROM purchase_lines p
                  ${andWhere(w, 'p.matched_2b_month IS NOT NULL')}
                 GROUP BY p.our_gstin, p.matched_2b_month
                 ORDER BY p.our_gstin, p.matched_2b_month`,
  },
  {
    name: 'itc-claim-month-wise',
    title: 'ITC by Claim Month — what will flow into which GSTR-3B',
    category: 'itc',
    note: 'Shows the month the Accounts team assigned each invoice to. The GSTR-3B working itself is NOT driven by this yet — that is Phase 2.',
    aggregate: true,
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('Decision Month', 'itc_decision_month', 'period', 13),
      C('Invoices', 'invoices', 'int', 11), C('Taxable', 'taxable', 'money', 16),
      C('IGST', 'igst', 'money', 14), C('CGST', 'cgst', 'money', 14), C('SGST', 'sgst', 'money', 14),
      C('CESS', 'cess', 'money', 11), C('Total ITC', 'itc', 'money', 16),
      C('Claimed', 'claimed', 'int', 11), C('Other Decisions', 'other', 'int', 14),
      C('2B Months Covered', 'twob_months', 'text', 24),
    ],
    sql: (w) => `SELECT p.our_gstin, p.itc_decision_month,
                       count(*)::int AS invoices,
                       COALESCE(sum(p.book_taxable_value),0) AS taxable,
                       COALESCE(sum(p.book_igst),0) AS igst,
                       COALESCE(sum(p.book_cgst),0) AS cgst,
                       COALESCE(sum(p.book_sgst),0) AS sgst,
                       COALESCE(sum(p.book_cess),0) AS cess,
                       COALESCE(sum(${ITC}),0) AS itc,
                       count(*) FILTER (WHERE p.itc_decision = 'Claim')::int AS claimed,
                       count(*) FILTER (WHERE p.itc_decision <> 'Claim')::int AS other,
                       string_agg(DISTINCT p.matched_2b_month, ', ') AS twob_months
                  FROM purchase_lines p
                  ${andWhere(w, 'p.itc_decision_month IS NOT NULL')}
                 GROUP BY p.our_gstin, p.itc_decision_month
                 ORDER BY p.our_gstin, p.itc_decision_month`,
  },

  // ---- control ----------------------------------------------------------
  {
    name: 'audit-trail',
    title: 'Audit Trail — every change, who and why',
    category: 'control',
    profile: 'audit',
    columns: [
      C('Date Time', 'ts', 'datetime', 19), C('User', 'changed_by', 'text', 14),
      C('Action', 'action', 'text', 14), C('GSTIN', 'our_gstin', 'gstin', 19),
      C('FY', 'financial_year', 'text', 9), C('Month', 'period', 'period', 9),
      C('Line ID', 'line_id', 'int', 10), C('Invoice No', 'invoice_no', 'text', 18),
      C('Supplier GSTIN', 'supplier_gstin', 'gstin', 19), C('Field', 'field_name', 'text', 24),
      C('Old Value', 'old_value', 'text', 24), C('New Value', 'new_value', 'text', 24),
      C('Reason', 'reason', 'text', 45),
    ],
    sql: (w) => `SELECT ts, changed_by, action, our_gstin, financial_year, period, line_id, invoice_no,
                        supplier_gstin, field_name, old_value, new_value, reason
                   FROM audit_trail ${w}
                   ORDER BY ts DESC, id DESC LIMIT 50000`,
  },
  {
    name: 'month-locks',
    title: 'Month Locks',
    category: 'control',
    profile: 'locks',
    columns: [
      C('GSTIN', 'our_gstin', 'gstin', 19), C('FY', 'financial_year', 'text', 9),
      C('Month', 'period', 'period', 9), C('Locked', 'is_locked', 'text', 9),
      C('Locked By', 'locked_by', 'text', 14), C('Locked At', 'locked_at', 'datetime', 19),
      C('Unlock Reason', 'unlock_reason', 'text', 45), C('Unlocked By', 'unlocked_by', 'text', 14),
      C('Unlocked At', 'unlocked_at', 'datetime', 19), C('Lock Reason', 'reason', 'text', 45),
    ],
    sql: (w) => `SELECT our_gstin, financial_year, period,
                        CASE WHEN is_locked THEN 'LOCKED' ELSE 'OPEN' END AS is_locked,
                        locked_by, locked_at, unlock_reason, unlocked_by, unlocked_at, reason
                   FROM month_locks ${w}
                   ORDER BY period DESC, our_gstin`,
  },
  {
    name: 'twob-files',
    title: 'GSTR-2B File Registry',
    category: 'control',
    profile: 'files',
    columns: [
      C('File Name', 'file_name', 'text', 40), C('GSTIN', 'our_gstin', 'gstin', 19),
      C('FY', 'financial_year', 'text', 9), C('2B Month', 'twob_month', 'period', 11),
      C('Portal FP', 'portal_fp', 'text', 10), C('Records', 'record_count', 'int', 10),
      C('Blocked', 'blocked_count', 'int', 10), C('Format', 'source_format', 'text', 8),
      C('Uploaded At', 'uploaded_at', 'datetime', 19), C('Uploaded By', 'uploaded_by', 'text', 14),
      C('Fingerprint', 'sha256', 'text', 22),
    ],
    sql: (w) => `SELECT file_name, our_gstin, financial_year, twob_month, portal_fp, record_count,
                        blocked_count, source_format, uploaded_at, uploaded_by, left(sha256, 16) AS sha256
                   FROM gstr2b_files ${w}
                   ORDER BY our_gstin, twob_month`,
  },
];

export function findReport(name: string): ReportDef | undefined {
  return REPORTS.find((r) => r.name === name);
}

// ---------------------------------------------------------------------------
// the supplier follow-up screen
// ---------------------------------------------------------------------------

/**
 * Per-supplier exposure, ranked by the ITC we cannot claim yet.
 *
 * "Who keeps costing us ITC" is a monthly conversation with a vendor, not an
 * annual audit finding — so the answer has to be a ranked list with the last
 * contact date next to it.
 */
export async function supplierFollowUp(f: ReportFilters) {
  const { sql, params } = buildWhere(f);
  return withClient((c: Client) =>
    c.query(
      `SELECT p.our_gstin,
              p.book_supplier_gstin AS supplier_gstin,
              MAX(p.party_name)     AS supplier_name,
              count(*)::int                                        AS invoices,
              count(*) FILTER (WHERE p.match_status = 'Missing in 2B')::int   AS missing_in_2b,
              count(*) FILTER (WHERE p.match_status = 'Amount Mismatch')::int AS mismatch,
              count(*) FILTER (WHERE p.match_status = 'ITC Blocked')::int     AS blocked,
              count(*) FILTER (WHERE p.match_status = 'Duplicate')::int       AS duplicates,
              COALESCE(sum(${ITC}) FILTER (WHERE p.match_status = 'Missing in 2B'), 0) AS itc_at_risk,
              COALESCE(sum(${ITC}), 0)                             AS book_itc,
              count(*) FILTER (WHERE p.itc_decision = 'Pending Review')::int     AS itc_pending,
              count(*) FILTER (WHERE p.itc_decision = 'Query Vendor')::int      AS with_vendor,
              MAX(p.follow_up_date) AS last_follow_up,
              count(*) FILTER (WHERE p.follow_up_date IS NOT NULL)::int AS chased,
              MAX(p.vendor_response)  AS vendor_response,
              MAX(p.expected_correction) AS expected_correction,
              MAX(p.action_taken)    AS action_taken
         FROM purchase_lines p ${sql}
        GROUP BY p.our_gstin, p.book_supplier_gstin
        HAVING count(*) FILTER (WHERE p.match_status <> 'Matched') > 0
           OR count(*) FILTER (WHERE p.itc_decision <> 'Pending Review') > 0
        ORDER BY itc_at_risk DESC, missing_in_2b DESC`,
      params,
    ),
  ).then((r) => r.rows);
}

export const FOLLOWUP_COLUMNS: Column[] = [
  C('GSTIN', 'our_gstin', 'gstin', 19),
  C('Supplier GSTIN', 'supplier_gstin', 'gstin', 19),
  C('Supplier Name', 'supplier_name', 'text', 32),
  C('Invoices', 'invoices', 'int', 11),
  C('Missing in 2B', 'missing_in_2b', 'int', 12),
  C('Mismatch', 'mismatch', 'int', 10),
  C('Blocked', 'blocked', 'int', 10),
  C('Duplicates', 'duplicates', 'int', 11),
  C('ITC At Risk (4A i)', 'itc_at_risk', 'money', 15),
  C('Book ITC', 'book_itc', 'money', 15),
  C('ITC Pending Decision', 'itc_pending', 'int', 15),
  C('With Vendor', 'with_vendor', 'int', 12),
  C('Times Chased', 'chased', 'int', 12),
  C('Last Follow-up', 'last_follow_up', 'date', 13),
  C('Vendor Response', 'vendor_response', 'text', 40),
  C('Expected Correction', 'expected_correction', 'text', 34),
  C('Action Taken', 'action_taken', 'text', 34),
];

// ---------------------------------------------------------------------------
// row shaping
// ---------------------------------------------------------------------------

/**
 * Turn a database row into the exact values the columns ask for.
 *
 * `utgst` is always zero and is reported as such rather than hidden: the SAP
 * register carries a single "State/UT Tax" column, so there is no way to split
 * it, and pretending otherwise would be a fabricated number.
 */
export function shapeRow(row: Record<string, any>): Record<string, any> {
  const out = { ...row };
  out.utgst = 0;
  out.edited_yesno = row.recon_edited ? 'YES' : '';
  out.matched_yesno = row.matched_2b_key ? 'YES' : 'No';
  out.remark = row.remarks ?? row.mismatch_reason ?? row.suggested_action ?? '';
  if (row.match_status) {
    out.gstin_diff =
      row.twob_supplier_gstin && row.recon_supplier_gstin !== row.twob_supplier_gstin
        ? `book ${row.book_supplier_gstin} → recon ${row.recon_supplier_gstin} → 2B ${row.twob_supplier_gstin}`
        : '';
  }
  if (row.match_status === 'Missing in 2B') {
    out.possible_why = 'Same supplier appears in a 2B month within 2 months — check whether this invoice is filed under another number.';
  }
  return out;
}

function cellValue(v: unknown, col: Column): unknown {
  if (v === null || v === undefined) return '';
  if (col.t === 'date') return String(v).slice(0, 10);
  if (col.t === 'datetime') return String(v).slice(0, 19).replace('T', ' ');
  // PostgreSQL returns bigint as a string; a numeric column must reach Excel
  // and the CSV as a number or every sum in the workbook is text.
  if (col.t === 'money' || col.t === 'int') {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : '';
  }
  return v;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export interface ReportResult {
  def: ReportDef;
  rows: Array<Record<string, any>>;
  count: number;
  /** Filters this report's table could not apply; the export says so. */
  ignored: string[];
}

export async function runReport(def: ReportDef, f: ReportFilters): Promise<ReportResult> {
  // The report knows which table it reads; that is what decides how a filter is
  // expressed. Defaulting to the purchase profile keeps every report that has
  // always read `purchase_lines` working unchanged.
  const { sql, params, ignored } = buildWhere(f, def.profile ?? 'purchase');
  const rows = await withClient((c) => c.query(def.sql(sql), params)).then((r) => r.rows.map(shapeRow));
  return { def, rows, count: rows.length, ignored };
}

/** Read a report and hand back the column list plus the shaped rows. */
export async function runReportNamed(name: string, f: ReportFilters): Promise<ReportResult | null> {
  const def = findReport(name);
  if (!def) return null;
  return runReport(def, f);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Raw, comma-separated, one header row, no formatting — for further processing. */
export function toCsv(
  columns: Column[],
  rows: Array<Record<string, any>>,
  meta?: string[],
): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // CSV cannot carry an image, so the company identity travels as text lines.
  const lines: string[] = [];
  for (const m of meta ?? []) lines.push(esc(m));
  if (meta && meta.length) lines.push('');
  lines.push(columns.map((c) => esc(c.h)).join(','));
  for (const r of rows) lines.push(columns.map((c) => esc(cellValue(r[c.k], c))).join(','));
  // Excel needs CRLF to open a UTF-8 CSV without mangling it.
  return '﻿' + lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

const MONEY_FMT = '#,##0.00';
const INT_FMT = '#,##0';
const DATE_FMT = 'dd-mmm-yyyy';

/**
 * Build a worksheet from a column list and rows.
 *
 * Header row, frozen header, autofilter, sensible widths and per-type number
 * formats. The money columns are plain numbers, not text, so the Accounts team
 * can sum and pivot them without a single formula.
 */
export function toWorksheet(columns: Column[], rows: Array<Record<string, any>>): XLSX.WorkSheet {
  const aoa: unknown[][] = [columns.map((c) => c.h)];
  for (const r of rows) aoa.push(columns.map((c) => cellValue(r[c.k], c)));

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = columns.map((c) => ({ wch: c.w ?? (c.t === 'money' ? 14 : c.t === 'date' || c.t === 'datetime' ? 14 : 16) }));
  if (rows.length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: columns.length - 1 } }) };

  for (let r = 1; r <= rows.length; r++) {
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      if (!col.t || col.t === 'text' || col.t === 'gstin') continue;
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = (ws as any)[addr];
      if (!cell) continue;
      cell.z = col.t === 'money' ? MONEY_FMT : col.t === 'int' ? INT_FMT : col.t === 'date' ? DATE_FMT : undefined;
    }
  }
  return ws;
}

/** One report as a standalone, formatted xlsx file. */
export function toWorkbookBuffer(title: string, columns: Column[], rows: Array<Record<string, any>>, meta?: string[]): Buffer {
  const wb = XLSX.utils.book_new();

  // A cover sheet, because a file that starts with 20 columns of amounts tells
  // the reader nothing about which GSTIN or month they are looking at.
  const cover: unknown[][] = [[title], [`Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]];
  for (const m of meta ?? []) cover.push([m]);
  cover.push([], ['Records', rows.length]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cover), 'Report');

  const ws = toWorksheet(columns, rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  (ws as any)['!freeze'] = 1;

  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return polishWorkbook(raw, { freezeRows: 1, styleHeader: true });
}

/** The combined "Download Complete Reconciliation" workbook. */
export function toCompleteWorkbook(
  sheets: Array<{ name: string; title: string; columns: Column[]; rows: Array<Record<string, any>> }>,
  meta: string[],
): Buffer {
  const wb = XLSX.utils.book_new();

  const cover: unknown[][] = [['GST RECONCILIATION — COMPLETE WORKING'], [], ...meta.map((m) => [m])];
  cover.push([], ['Sheets in this workbook:']);
  for (const s of sheets) cover.push([`  ${s.name} — ${s.title} (${s.rows.length} rows)`]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cover), 'Dashboard');

  for (const s of sheets) {
    const ws = toWorksheet(s.columns, s.rows);
    (ws as any)['!freeze'] = 1;
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }

  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return polishWorkbook(raw, { freezeRows: 1, styleHeader: true });
}

/** `Missing_in_2B_2026-04.csv` — a name that says what is inside it. */
export function fileNameFor(reportName: string, title: string, f: ReportFilters, ext: string): string {
  const parts = [reportName.replace(/-/g, '_')];
  if (f.period) parts.push(f.period);
  else if (f.from || f.to) parts.push(`${f.from || 'start'}_to_${f.to || 'end'}`);
  if (f.gstin) parts.push(f.gstin);
  if (f.status) parts.push(f.status.replace(/[^A-Za-z0-9]+/g, '_'));
  if (f.supplier) parts.push(f.supplier);
  void title;
  return parts.join('_') + '.' + ext;
}

/** A short human summary of which filters produced this file. */
export function describeFilters(f: ReportFilters, ignored: string[] = []): string[] {
  const out: string[] = [];
  if (f.gstin) out.push(`GSTIN: ${f.gstin}`);
  if (f.period) out.push(`Month: ${f.period}`);
  if (f.from || f.to) out.push(`Months: ${f.from || 'start'} to ${f.to || 'end'}`);
  if (f.supplier) out.push(`Supplier GSTIN: ${f.supplier}`);
  if (f.vendor) out.push(`Vendor contains: ${f.vendor}`);
  if (f.status) out.push(`Status: ${f.status}`);
  if (f.decision) out.push(`ITC decision: ${f.decision}`);
  if (f.classification) out.push(`Return classification: ${f.classification}`);
  if (f.twoBMonth) out.push(`2B month: ${f.twoBMonth}`);
  if (f.decisionMonth) out.push(`ITC decision month: ${f.decisionMonth}`);
  if (f.followUp) out.push(`Follow-up: ${f.followUp}`);
  if (f.q) out.push(`Search: ${f.q}`);
  // A filter this report's table cannot answer is stated out loud, never
  // silently dropped — otherwise the file looks filtered when it is not.
  for (const g of ignored) out.push(`Not applicable to this report (ignored): ${g}`);
  return out.length ? out : ['none — this is the complete report, no filter applied'];
}