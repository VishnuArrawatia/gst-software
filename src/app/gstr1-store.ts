/**
 * Persistence for the outward reconciliation.
 *
 * Three separate stores, three separate jobs, deliberately not one:
 *
 *   rebuildDrafts()  books          -> the return we would file
 *   importFiled()    portal export  -> the return that was filed
 *   runRecon()       the two        -> outcomes, table summary, run history
 *
 * Keeping the draft in the database is the whole point. A reconciliation that
 * computes the draft in memory, compares it, throws it away and reports only
 * "MATCHED" is unauditable: a CA who disagrees has nothing to look at, and the
 * only honest answer to "why do you say this is fine" would be to re-read the
 * code. Storing it means the draft we compared against can be shown, dated and
 * re-read months later.
 *
 * Regeneration replaces drafts wholesale rather than upserting them. A draft is
 * a derived artefact — if the books change, the draft must follow, and a row
 * left behind by a previous draft would be a document the software would then
 * report as "not declared" against a return it no longer believes in. Filed
 * rows are the opposite case and are only ever upserted: they are evidence of
 * what was submitted and must survive a rebuild untouched.
 */

import type { Client } from 'pg';

import { loadGstinMap, withClient } from './store';
import { buildGstr1, type Gstr1Model, type ScopedHsnRow } from '../engine/gstr1';
import {
  classifyFiledRows,
  countOutcomes,
  draftDocuments,
  reconcile,
  summarise,
  type FiledRow,
  type Gstr1Document,
  type Gstr1ReconOutcome,
  type Gstr1SummaryRow,
  type Gstr1TableType,
} from '../engine/gstr1-recon';
import {
  fyOf,
  isCreditNote,
  isoDate,
  labelOf,
  normGstin,
  r2,
  type SalesInvoice,
  type SalesItem,
} from '../engine/core';

/** Columns of gstr1_documents written on insert, in bind order. */
const DOC_COL_COUNT = 27;

export interface DraftResult {
  ok: boolean;
  reason?: string;
  gstin: string;
  period: string;
  gstin_id: number | null;
  sales_rows: number;
  /**
   * Item lines read from `sales_invoice_items` for this period. 0 means every
   * invoice came from an invoice-level register, and the return is built from
   * the invoice totals exactly as it always was.
   */
  item_lines: number;
  /** Invoices that carried item lines, i.e. were imported item-wise. */
  item_level_invoices: number;
  documents: number;
  by_table: Record<string, number>;
  /**
   * Drafted credit notes the database refused, because a note without its
   * original invoice number is one the portal will reject. Reported rather than
   * silently dropped — otherwise the CA sees a clean return and no reason for
   * it.
   */
  rejected: Array<{ invoice_number: string; reason: string }>;
  blocked?: string;
  /** Name of the violated constraint, when Postgres reported one. */
  constraint?: string | null;
  /** The exact key it collided on. */
  detail?: string | null;
}

const EMPTY_DRAFT: DraftResult = {
  ok: false, gstin: '', period: '', gstin_id: null,
  sales_rows: 0, item_lines: 0, item_level_invoices: 0,
  documents: 0, by_table: {}, rejected: [],
};

/**
 * The book side of the return: every invoice for one GSTIN + period, each with
 * the item lines that belong to it.
 *
 * The item lines are the whole point of this loader. A draft is REGENERATED from
 * the database, so a loader that read only `sales_invoices` gave an item-wise
 * register back as one blended rate per invoice: the B2B `itms` collapsed into a
 * single line and the HSN summary (table 12) reported quantity 0 for goods whose
 * quantities were sitting in `sales_invoice_items`. That is the same defect the
 * item-wise importer fixed on the file path — except this is the path the GSTR-1
 * screen uses, so the fix has to exist here too.
 *
 * An invoice with no item rows is not an error. An invoice-level register is
 * still fully supported and those invoices fall back to their own totals, exactly
 * as before — which is why the count of item lines is reported rather than
 * assumed.
 */
async function loadBooksForReturn(
  c: Client,
  gstinId: number,
  gstin: string,
  period: string,
): Promise<{
  sales: SalesInvoice[];
  idByNumber: Map<string, number>;
  itemLines: number;
  itemLevelInvoices: number;
}> {
  const sres = await c.query(
    `SELECT id, invoice_number_raw, invoice_number_norm, invoice_date, period,
            customer_gstin_raw, customer_gstin_norm, customer_name, invoice_type,
            place_of_supply, reverse_charge, hsn, taxable_value, igst, cgst, sgst,
            cess, invoice_value, note_ref_number, note_ref_date
       FROM sales_invoices
      WHERE gstin_id = $1 AND period = $2 AND NOT is_deleted
      ORDER BY id`,
    [gstinId, period],
  );

  // ---- item lines, keyed by their parent invoice -------------------------
  const itemsByInvoice = new Map<number, SalesItem[]>();
  const ids = sres.rows.map((r: any) => r.id);
  if (ids.length) {
    const ires = await c.query(
      `SELECT sales_invoice_id, line_no, item_code, item_description, hsn, uqc,
              quantity, gst_rate, taxable_value, igst, cgst, sgst, cess,
              freight, other_charges, source_row_number
         FROM sales_invoice_items
        WHERE sales_invoice_id = ANY($1::bigint[])
        ORDER BY sales_invoice_id, line_no`,
      [ids],
    );
    const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
    for (const it of ires.rows) {
      const key = Number(it.sales_invoice_id);
      const list = itemsByInvoice.get(key) ?? [];
      list.push({
        line_no: num(it.line_no),
        item_code: it.item_code ?? undefined,
        description: it.item_description ?? undefined,
        hsn: it.hsn ?? undefined,
        uqc: it.uqc ?? undefined,
        quantity: num(it.quantity),
        gst_rate: num(it.gst_rate),
        taxable_value: r2(it.taxable_value),
        igst: r2(it.igst),
        cgst: r2(it.cgst),
        sgst: r2(it.sgst),
        cess: r2(it.cess),
        freight: num(it.freight),
        other_charges: num(it.other_charges),
        source_row: num(it.source_row_number),
      });
      itemsByInvoice.set(key, list);
    }
  }

  const sales: SalesInvoice[] = [];
  const idByNumber = new Map<string, number>();
  let itemLines = 0;
  let itemLevelInvoices = 0;
  for (const row of sres.rows) {
    const items = itemsByInvoice.get(Number(row.id));
    if (items?.length) {
      itemLines += items.length;
      itemLevelInvoices += 1;
    }
    sales.push({
      our_gstin: gstin,
      customer_name: row.customer_name ?? '',
      customer_gstin: row.customer_gstin_norm ?? row.customer_gstin_raw ?? '',
      invoice_no: row.invoice_number_raw,
      invoice_date: normDbDate(row.invoice_date),
      period: row.period,
      invoice_type: row.invoice_type,
      place_of_supply: row.place_of_supply ?? '',
      reverse_charge: row.reverse_charge,
      taxable_value: r2(row.taxable_value),
      igst: r2(row.igst),
      cgst: r2(row.cgst),
      sgst: r2(row.sgst),
      cess: r2(row.cess),
      invoice_value: r2(row.invoice_value),
      hsn: row.hsn ?? undefined,
      items,
      note_ref_no: row.note_ref_number ?? undefined,
      note_ref_date: row.note_ref_date ? normDbDate(row.note_ref_date) : undefined,
    });
    if (row.invoice_number_norm) idByNumber.set(row.invoice_number_norm, row.id);
  }

  return { sales, idByNumber, itemLines, itemLevelInvoices };
}

export type HsnScopeFilter = 'b2b' | 'b2c' | 'all';

export interface HsnTotals {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  qty: number;
}

/**
 * An HSN row as the PORTAL holds it, taken from the filed invoices.
 *
 * `uqc` and `qty` are typed `null` rather than optional on purpose: a filed
 * invoice row carries no unit and no quantity, and this app will not fill them
 * with a plausible-looking zero. A number here would look like an imported value
 * and silently turn "not comparable" into "nil".
 */
export interface PortalHsnRow {
  scope: 'b2b' | 'b2c';
  hsn: string;
  /** The rate the filed document stated, or null when it stated none. */
  rate: number | null;
  uqc: null;
  qty: null;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  /** How many filed documents rolled into this row. */
  documents: number;
}

export interface HsnComparisonRow {
  key: string;
  /** Which half of the return this comparison belongs to. */
  scope: 'b2b' | 'b2c';
  hsn: string;
  desc: string;
  uqc: string;
  rate: number | null;
  books: HsnTotals | null;
  portal: HsnTotals | null;
  /** Books minus portal. Null when there is nothing to subtract from. */
  diff: { taxable: number; igst: number; cgst: number; sgst: number; cess: number } | null;
  status: 'MATCHED' | 'DIFFERS' | 'BOOKS ONLY' | 'PORTAL ONLY';
  /** Why the row reads the way it does. Never empty on a non-match. */
  remarks: string[];
}

export interface HsnSummaryResult {
  ok: boolean;
  reason?: string;
  gstin: string;
  period: string;
  periodLabel: string;
  financialYear: string;
  gstin_id: number | null;
  /** Which half was asked for. 'all' returns both, each row still labelled. */
  scope: HsnScopeFilter;
  /** Book invoices read for this GSTIN + period. */
  invoices: number;
  /** Item lines read from `sales_invoice_items`. */
  item_lines: number;
  /** How many of those invoices were imported item-wise. */
  item_level_invoices: number;
  /** BOOKS rows for the requested scope, grouped by HSN/SAC + UQC + rate. */
  rows: ScopedHsnRow[];
  totals: HsnTotals;
  /**
   * Both halves, always. The consolidated screen shows these as separate blocks
   * with their own totals, so a B2C shortfall can never disappear into a B2B
   * total.
   */
  books: {
    b2b: { rows: ScopedHsnRow[]; totals: HsnTotals };
    b2c: { rows: ScopedHsnRow[]; totals: HsnTotals };
  };
  portal: {
    available: boolean;
    reason?: string;
    source: string;
    rows: PortalHsnRow[];
    b2b: PortalHsnRow[];
    b2c: PortalHsnRow[];
    totals: HsnTotals | null;
    notes: string[];
  };
  comparison: {
    available: boolean;
    reason?: string;
    status: 'NO PORTAL DATA' | 'COMPARED';
    rows: HsnComparisonRow[];
    matched: number;
    differs: number;
    books_only: number;
    portal_only: number;
    notes: string[];
  };
  /** What the return builder would refuse or warn about for this period. */
  validation: Gstr1Model['validation'];
}

const EMPTY_TOTALS = (): HsnTotals => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, qty: 0 });

function totalsOf(rows: Array<{ qty: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number }>): HsnTotals {
  return rows.reduce(
    (a, h) => ({
      taxable: r2(a.taxable + h.taxable),
      igst: r2(a.igst + h.igst),
      cgst: r2(a.cgst + h.cgst),
      sgst: r2(a.sgst + h.sgst),
      cess: r2(a.cess + h.cess),
      qty: r2(a.qty + h.qty),
    }),
    EMPTY_TOTALS(),
  );
}

/** Rupee-level tolerance. One paisa out is a rounding artefact, not a finding. */
const HSN_TOLERANCE = 0.01;

/**
 * Compare the books' HSN buckets with what the portal holds for the period.
 *
 * Matching is on HSN/SAC and, when the filed document states one, the rate.
 * A filed document that states NO rate (the usual case outside B2CS) is matched
 * on HSN alone, and the row says so — refusing to match it would report every
 * B2B HSN as "books only" and cry wolf.
 *
 * Quantity and UQC are compared only where BOTH sides have them. A filed
 * invoice row never does, so they are reported as not comparable rather than as
 * a difference of the books figure.
 */
function compareHsn(
  booksRows: ScopedHsnRow[],
  portalRows: PortalHsnRow[],
): { rows: HsnComparisonRow[]; matched: number; differs: number; booksOnly: number; portalOnly: number } {
  const rows: HsnComparisonRow[] = [];
  const used = new Set<number>();

  for (const b of booksRows) {
    // Every portal row for this HSN, that has not already been claimed.
    const candidates = portalRows
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => !used.has(i) && normHsn(p.hsn) === normHsn(b.hsn));
    const exact = candidates.filter(({ p }) => p.rate !== null && r2(p.rate) === r2(b.rateOut));
    const wildcard = candidates.filter(({ p }) => p.rate === null);
    const matchedPortal = exact.length ? exact : wildcard;

    const books: HsnTotals = {
      taxable: b.taxable, igst: b.igst, cgst: b.cgst, sgst: b.sgst, cess: b.cess, qty: b.qty,
    };

    if (!matchedPortal.length) {
      rows.push({
        key: `${b.scope}|${b.hsn}|${b.rateOut}`,
        scope: b.scope === 'B2B' ? 'b2b' : 'b2c',
        hsn: b.hsn, desc: b.desc, uqc: b.uqc, rate: b.rateOut,
        books,
        portal: null,
        diff: null,
        status: 'BOOKS ONLY',
        remarks: [
          portalRows.length
            ? 'Portal me is HSN ki koi filed row nahi mili — ya HSN/rate bhinn hai. Portal HSN sheet import hone par hi ise confirm kiya ja sakta hai.'
            : 'Portal ka GSTR-1 data import nahi hua hai, isliye ise abhi compare nahi kiya ja sakta.',
        ],
      });
      continue;
    }

    for (const { i } of matchedPortal) used.add(i);
    const portalSum = matchedPortal.reduce<HsnTotals>(
      (a, { p }) => ({
        taxable: r2(a.taxable + p.taxable), igst: r2(a.igst + p.igst),
        cgst: r2(a.cgst + p.cgst), sgst: r2(a.sgst + p.sgst), cess: r2(a.cess + p.cess),
        qty: 0,
      }),
      EMPTY_TOTALS(),
    );

    const diff = {
      taxable: r2(b.taxable - portalSum.taxable),
      igst: r2(b.igst - portalSum.igst),
      cgst: r2(b.cgst - portalSum.cgst),
      sgst: r2(b.sgst - portalSum.sgst),
      cess: r2(b.cess - portalSum.cess),
    };
    const differs = Object.values(diff).some((v) => Math.abs(v) > HSN_TOLERANCE);
    const remarks: string[] = [];
    if (matchedPortal.some(({ p }) => p.rate === null)) {
      remarks.push('Filed document par rate stated nahi hai — HSN level par compare kiya gaya, rate-wise nahi.');
    }
    if (differs) {
      remarks.push('Taxable value ya tax books aur portal me alag hai — neeche difference dekhein.');
    }
    remarks.push(
      'Quantity aur UQC sirf books me hain: filed invoice row me ye field hota hi nahi, isliye compare nahi kiya gaya.',
    );

    rows.push({
      key: `${b.scope}|${b.hsn}|${b.rateOut}`,
      scope: b.scope === 'B2B' ? 'b2b' : 'b2c',
      hsn: b.hsn, desc: b.desc, uqc: b.uqc, rate: b.rateOut,
      books, portal: portalSum, diff,
      status: differs ? 'DIFFERS' : 'MATCHED',
      remarks,
    });
  }

  portalRows.forEach((p, i) => {
    if (used.has(i)) return;
    rows.push({
      key: `portal|${p.scope}|${p.hsn}|${p.rate ?? ''}`,
      scope: p.scope,
      hsn: p.hsn, desc: '', uqc: '', rate: p.rate,
      books: null,
      portal: { taxable: p.taxable, igst: p.igst, cgst: p.cgst, sgst: p.sgst, cess: p.cess, qty: 0 },
      diff: null,
      status: 'PORTAL ONLY',
      remarks: ['Portal me ye HSN hai lekin books me nahi — filed return me zyada declare hua hai.'],
    });
  });

  return {
    rows,
    matched: rows.filter((r) => r.status === 'MATCHED').length,
    differs: rows.filter((r) => r.status === 'DIFFERS').length,
    booksOnly: rows.filter((r) => r.status === 'BOOKS ONLY').length,
    portalOnly: rows.filter((r) => r.status === 'PORTAL ONLY').length,
  };
}

/** HSN codes are compared as printed: '8536' and '8536 ' are the same bucket. */
function normHsn(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

/**
 * GSTR-1 table 12 (HSN summary) for one GSTIN and period, from the STORED item
 * lines — split into the B2B and B2C halves, with the portal's side where the
 * portal data exists, and a comparison of the two.
 *
 * This is what makes an item-wise import worth having: the summary is grouped by
 * HSN/SAC + UQC + rate and carries a real QUANTITY, which only exists because the
 * importer wrote `sales_invoice_items`. Run it over an invoice-level register and
 * it still answers — one rate bucket per invoice, quantity 0 — rather than
 * failing, which is the same behaviour the file path has.
 *
 * The grouping is deliberately NOT re-implemented here. It is `buildGstr1`'s HSN
 * summary: the same code that writes the workbook's HSN sheet and the portal
 * JSON, so the screen, the file and the JSON can never disagree about a bucket.
 *
 * What this function adds is the evidence trail: which half a bucket belongs to,
 * what the portal holds for the same period, and — where the portal holds
 * nothing — a reason instead of a made-up match.
 */
export async function hsnSummary(
  gstinRaw: string,
  period: string,
  scope: HsnScopeFilter = 'all',
): Promise<HsnSummaryResult> {
  const want: HsnScopeFilter = scope === 'b2b' || scope === 'b2c' ? scope : 'all';
  const res: HsnSummaryResult = {
    ok: false,
    gstin: normGstin(gstinRaw),
    period,
    periodLabel: period ? labelOf(period) : '',
    financialYear: period ? fyOf(period) : '',
    gstin_id: null,
    scope: want,
    invoices: 0,
    item_lines: 0,
    item_level_invoices: 0,
    rows: [],
    totals: EMPTY_TOTALS(),
    books: { b2b: { rows: [], totals: EMPTY_TOTALS() }, b2c: { rows: [], totals: EMPTY_TOTALS() } },
    portal: {
      available: false,
      source: 'filed GSTR-1 documents',
      rows: [], b2b: [], b2c: [], totals: null, notes: [],
    },
    comparison: {
      available: false,
      status: 'NO PORTAL DATA',
      rows: [], matched: 0, differs: 0, books_only: 0, portal_only: 0, notes: [],
    },
    validation: [],
  };

  if (!res.gstin || !period) {
    res.reason = 'GSTIN and period are both required';
    return res;
  }

  try {
    const gmap = await loadGstinMap();
    const g = gmap.get(res.gstin);
    if (!g?.gstin_id) {
      res.reason = `${res.gstin} is not in the GSTIN master`;
      return res;
    }
    res.gstin_id = g.gstin_id;
    const gstinId = g.gstin_id;

    return await withClient(async (c) => {
      const books = await loadBooksForReturn(c, gstinId, res.gstin, period);
      const model = buildGstr1(res.gstin, books.sales);

      res.ok = true;
      res.invoices = books.sales.length;
      res.item_lines = books.itemLines;
      res.item_level_invoices = books.itemLevelInvoices;
      res.validation = model.validation;

      // ---- books, both halves and the requested slice -------------------
      res.books.b2b = { rows: model.hsnB2b, totals: totalsOf(model.hsnB2b) };
      res.books.b2c = { rows: model.hsnB2c, totals: totalsOf(model.hsnB2c) };
      const scopedBooks =
        want === 'b2b' ? model.hsnB2b : want === 'b2c' ? model.hsnB2c : [...model.hsnB2b, ...model.hsnB2c];
      res.rows = scopedBooks;
      res.totals = totalsOf(scopedBooks);

      // ---- the portal's side, from the FILED documents ------------------
      // Only the HSN the filed rows actually carry. A filed invoice row has no
      // quantity and no UQC, so those stay null and are reported as not
      // comparable rather than as a difference against the books.
      const pres = await c.query(
        `SELECT d.hsn, d.rate, count(*)::int AS documents,
                sum(d.taxable_value) AS taxable, sum(d.igst) AS igst,
                sum(d.cgst) AS cgst, sum(d.sgst) AS sgst, sum(d.cess) AS cess,
                CASE WHEN d.table_type IN ('B2B','CDNR') THEN 'b2b' ELSE 'b2c' END AS sc
           FROM gstr1_documents d
          WHERE d.gstin_id = $1 AND d.period = $2 AND d.source = 'filed'
            AND d.hsn IS NOT NULL AND btrim(d.hsn) <> ''
          GROUP BY d.hsn, d.rate, sc
          ORDER BY d.hsn, d.rate`,
        [gstinId, period],
      );
      const everyPortalRow: PortalHsnRow[] = pres.rows.map((r: any) => ({
        scope: r.sc === 'b2b' ? 'b2b' : 'b2c',
        hsn: normHsn(r.hsn),
        rate: r.rate === null || r.rate === undefined ? null : Number(r.rate),
        uqc: null,
        qty: null,
        taxable: r2(r.taxable),
        igst: r2(r.igst),
        cgst: r2(r.cgst),
        sgst: r2(r.sgst),
        cess: r2(r.cess),
        documents: r.documents,
      }));

      res.portal.b2b = everyPortalRow.filter((p) => p.scope === 'b2b');
      res.portal.b2c = everyPortalRow.filter((p) => p.scope === 'b2c');
      res.portal.rows =
        want === 'all' ? everyPortalRow : everyPortalRow.filter((p) => p.scope === want);
      res.portal.notes.push(
        'Portal ki HSN sheet (table 12) import nahi hoti — yahan sirf filed invoice rows ka HSN hisaab hai, isliye UQC aur quantity portal side par available nahi hain.',
      );

      if (res.portal.rows.length) {
        res.portal.available = true;
        res.portal.totals = totalsOf(res.portal.rows.map((p) => ({ ...p, qty: 0 })));
      } else {
        const anyFiled = await c.query(
          `SELECT count(*)::int AS n FROM gstr1_documents
            WHERE gstin_id = $1 AND period = $2 AND source = 'filed'`,
          [gstinId, period],
        );
        const filed = Number(anyFiled.rows[0]?.n ?? 0);
        res.portal.reason = filed
          ? `${filed} filed GSTR-1 row(s) is period ke liye import hain, lekin unme HSN blank hai (portal ki b2b/cdnr sheets me HSN column nahi hota) — isliye portal ka HSN summary abhi ban nahi sakta.`
          : 'Is GSTIN aur period ka koi filed GSTR-1 import hi nahi hua hai.';
      }

      // ---- comparison ---------------------------------------------------
      if (res.portal.rows.length) {
        const cmp = compareHsn(scopedBooks, res.portal.rows);
        res.comparison = {
          available: true,
          status: 'COMPARED',
          rows: cmp.rows,
          matched: cmp.matched,
          differs: cmp.differs,
          books_only: cmp.booksOnly,
          portal_only: cmp.portalOnly,
          notes: [
            'Books aur portal invoice rows ka HSN milaya gaya hai. Quantity/UQC comparison possible nahi (portal side par ye fields nahi hote).',
            'Portal ki HSN sheet import hone par hi ye reconciliation poori kehla sakti hai.',
          ],
        };
      } else {
        res.comparison.available = false;
        res.comparison.reason = res.portal.reason;
        res.comparison.notes.push(
          'Portal ka HSN data import nahi hua — isliye ye reconciliation adhoori hai aur complete nahi kahi ja sakti.',
        );
      }

      return res;
    });
  } catch (e: any) {
    res.reason = e?.message ?? String(e);
    return res;
  }
}

/**
 * Rebuild the drafted return for one GSTIN and period from the books.
 *
 * Refuses outright on a locked period. A lock means the books for that period
 * are settled; regenerating a draft over them would quietly restate a filed
 * month, which is exactly what a lock exists to prevent.
 */
export async function rebuildDrafts(gstinRaw: string, period: string): Promise<DraftResult> {
  const res: DraftResult = { ...EMPTY_DRAFT, gstin: normGstin(gstinRaw), period };
  if (!res.gstin || !period) {
    res.reason = 'GSTIN and period are both required';
    return res;
  }

  try {
    const gmap = await loadGstinMap();
    const g = gmap.get(res.gstin);
    if (!g?.gstin_id) {
      res.reason = `${res.gstin} is not in the GSTIN master`;
      return res;
    }
    res.gstin_id = g.gstin_id;

    const locked = await withClient(async (c) => {
      const r = await c.query(
        `SELECT 1 FROM period_locks
          WHERE is_locked AND (gstin_id = $1 OR gstin_id IS NULL)
            AND financial_year = $2 AND period = $3`,
        [g.gstin_id, fyOf(period), period],
      );
      return r.rowCount > 0;
    });
    if (locked) {
      res.blocked = `${res.gstin} ${period} is locked. Unlock it before rebuilding the draft.`;
      return res;
    }

    return await withClient(async (c) => {
      // ---- books -> SalesInvoice, WITH the item lines --------------------
      const books = await loadBooksForReturn(c, g.gstin_id, res.gstin, period);
      res.sales_rows = books.sales.length;
      res.item_lines = books.itemLines;
      res.item_level_invoices = books.itemLevelInvoices;
      const sales = books.sales;
      const idByNumber = books.idByNumber;

      // ---- build + store ------------------------------------------------
      const model = buildGstr1(res.gstin, sales);
      let docs = draftDocuments(model, idByNumber);
      res.by_table = countByTable(docs);

      // ck_g1doc_cdnr_ref refuses a drafted note with no original invoice
      // number. Filter them here so the finding is reported as a finding.
      const rejected: DraftResult['rejected'] = [];
      docs = docs.filter((d) => {
        if (d.table_type !== 'CDNR' || !isCreditNote(d.invoice_type)) return true;
        if (d.note_ref_number && d.note_ref_date) return true;
        rejected.push({
          invoice_number: d.invoice_number_raw || d.invoice_number_norm,
          reason: d.note_ref_number
            ? 'credit note has the original invoice number but no original invoice date'
            : 'credit note has no original invoice number; the portal will reject it',
        });
        return false;
      });

      // Replace, do not merge. See the file header for why.
      await c.query(`DELETE FROM gstr1_documents WHERE gstin_id = $1 AND period = $2 AND source = 'draft'`, [
        g.gstin_id,
        period,
      ]);

      for (const chunk of batches(docs, 50)) {
        const values: unknown[][] = [];
        for (const d of chunk) {
          const sid = (d as Gstr1Document & { sales_invoice_id?: number }).sales_invoice_id ?? null;
          values.push([
            g.gstin_id, d.financial_year, d.period, d.source, d.table_type,
            d.invoice_number_raw || null, d.invoice_number_norm, d.invoice_date,
            d.invoice_type, d.recipient_gstin_raw || null, d.recipient_gstin_norm || null,
            d.recipient_name || null, d.place_of_supply || null, d.pos_code || null,
            d.reverse_charge, d.hsn || null,
            r2(d.taxable_value), r2(d.igst), r2(d.cgst), r2(d.sgst), r2(d.cess),
            r2(d.invoice_value), d.rate ?? null,
            d.note_ref_number || null, d.note_ref_date || null,
            sid, d.source_row ?? null,
          ]);
        }
        await c.query(
          `INSERT INTO gstr1_documents
             (gstin_id, financial_year, period, source, table_type,
              invoice_number_raw, invoice_number_norm, invoice_date,
              invoice_type, recipient_gstin_raw, recipient_gstin_norm, recipient_name,
              place_of_supply, pos_code, reverse_charge, hsn,
              taxable_value, igst, cgst, sgst, cess, invoice_value, rate,
              note_ref_number, note_ref_date, sales_invoice_id, source_row_number)
           VALUES ${values.map((_, i) =>
             `(${Array.from({ length: DOC_COL_COUNT }, (_, k) => '$' + (i * DOC_COL_COUNT + k + 1)).join(',')})`).join(',')}`,
          values.flat(),
        );
      }

      res.documents = docs.length;
      res.rejected = rejected;
      res.ok = true;
      return res;
    });
  } catch (e: any) {
    // Postgres names the violated constraint and the key it collided on. Losing
    // that turns a one-line diagnosis into a bisect, so it is kept.
    res.reason = e.message + (e.constraint ? ` [constraint ${e.constraint}]` : '');
    res.constraint = e.constraint ?? null;
    res.detail = e.detail ?? null;
    return res;
  }
}

export interface FiledImportResult {
  ok: boolean;
  reason?: string;
  gstin: string;
  period: string;
  inserted: number;
  updated: number;
  by_table: Record<string, number>;
  /** Per-period split, so a multi-month file lands in every month it touches. */
  periods: Record<string, number>;
}

/**
 * Store a portal export as filed rows.
 *
 * Upsert on the normalised key, so re-importing the same download after the CA
 * corrects a figure updates that row instead of producing a second copy. A
 * second copy would be worse than useless: the reconciliation would report a
 * duplicate on a file the portal itself would accept.
 */
export async function importFiled(
  gstinRaw: string,
  fallbackPeriod: string,
  rows: FiledRow[],
): Promise<FiledImportResult> {
  const res: FiledImportResult = {
    ok: false, gstin: normGstin(gstinRaw), period: fallbackPeriod,
    inserted: 0, updated: 0, by_table: {}, periods: {},
  };
  if (!res.gstin) {
    res.reason = 'A GSTIN is required — the portal export does not always name it';
    return res;
  }
  if (!rows.length) {
    res.reason = 'No GSTR-1 rows could be read from the file';
    return res;
  }

  try {
    const gmap = await loadGstinMap();
    const g = gmap.get(res.gstin);
    if (!g?.gstin_id) {
      res.reason = `${res.gstin} is not in the GSTIN master`;
      return res;
    }

    const docs = classifyFiledRows(rows);
    res.by_table = countByTable(docs);
    for (const d of docs) res.periods[d.period] = (res.periods[d.period] ?? 0) + 1;

    await withClient(async (c) => {
      for (const chunk of batches(docs, 50)) {
        const values: unknown[][] = chunk.map((d) => [
          g.gstin_id, d.financial_year, d.period, d.source, d.table_type,
          d.invoice_number_raw || null, d.invoice_number_norm, d.invoice_date,
          d.invoice_type, d.recipient_gstin_raw || null, d.recipient_gstin_norm || null,
          d.recipient_name || null, d.place_of_supply || null, d.pos_code || null,
          d.reverse_charge, d.hsn || null,
          r2(d.taxable_value), r2(d.igst), r2(d.cgst), r2(d.sgst), r2(d.cess),
          r2(d.invoice_value), d.rate ?? null,
          d.note_ref_number || null, d.note_ref_date || null,
          null, d.source_row ?? null,
        ]);
        const r = await c.query(
          `INSERT INTO gstr1_documents
             (gstin_id, financial_year, period, source, table_type,
              invoice_number_raw, invoice_number_norm, invoice_date,
              invoice_type, recipient_gstin_raw, recipient_gstin_norm, recipient_name,
              place_of_supply, pos_code, reverse_charge, hsn,
              taxable_value, igst, cgst, sgst, cess, invoice_value, rate,
              note_ref_number, note_ref_date, sales_invoice_id, source_row_number)
           VALUES ${values.map((_, i) =>
             `(${Array.from({ length: DOC_COL_COUNT }, (_, k) => '$' + (i * DOC_COL_COUNT + k + 1)).join(',')})`).join(',')}
           ON CONFLICT (gstin_id, period, source, invoice_number_norm,
                        (COALESCE(invoice_date, DATE '1900-01-01'))) DO UPDATE SET
             table_type         = EXCLUDED.table_type,
             invoice_type       = EXCLUDED.invoice_type,
             recipient_gstin_raw = EXCLUDED.recipient_gstin_raw,
             recipient_gstin_norm = EXCLUDED.recipient_gstin_norm,
             recipient_name     = EXCLUDED.recipient_name,
             place_of_supply    = EXCLUDED.place_of_supply,
             pos_code           = EXCLUDED.pos_code,
             reverse_charge     = EXCLUDED.reverse_charge,
             taxable_value      = EXCLUDED.taxable_value,
             igst               = EXCLUDED.igst,
             cgst               = EXCLUDED.cgst,
             sgst               = EXCLUDED.sgst,
             cess               = EXCLUDED.cess,
             invoice_value      = EXCLUDED.invoice_value,
             rate               = EXCLUDED.rate,
             note_ref_number    = EXCLUDED.note_ref_number,
             note_ref_date      = EXCLUDED.note_ref_date,
             source_row_number  = EXCLUDED.source_row_number,
             updated_at         = now()
           /* xmax = 0 only on a fresh INSERT. rowCount counts updates too, so
              without this a re-import of the same file would report thousands
              of phantom insertions. */
           RETURNING (xmax = 0) AS was_insert`,
          values.flat(),
        );
        let inserted = 0;
        for (const row of r.rows) if (row.was_insert) inserted++;
        res.inserted += inserted;
        res.updated += r.rowCount - inserted;
      }
    });

    res.ok = true;
    return res;
  } catch (e: any) {
    res.reason = e.message;
    return res;
  }
}

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------

export interface ReconResult {
  ok: boolean;
  reason?: string;
  /** Name of the violated constraint, when Postgres reported one. */
  constraint?: string | null;
  /** The exact key it collided on. */
  detail?: string | null;
  gstin: string;
  period: string;
  has_filed_data: boolean;
  totals: ReturnType<typeof countOutcomes>;
  summary: Gstr1SummaryRow[];
  outcomes_written: number;
  run_id: number | null;
}

/**
 * Compare the stored draft against the stored filed return and write the result.
 *
 * Rewrites the outcomes for the period rather than merging into them. Outcomes
 * are a function of the two inputs; once either input changes, every previous
 * outcome is stale, and leaving stale rows beside fresh ones is how a
 * reconciliation screen ends up showing two verdicts about the same invoice.
 */
export async function runRecon(gstinRaw: string, period: string, userId?: number): Promise<ReconResult> {
  const res: ReconResult = {
    ok: false, gstin: normGstin(gstinRaw), period, has_filed_data: false,
    totals: countOutcomes([], [], []), summary: [], outcomes_written: 0, run_id: null,
  };
  if (!res.gstin || !period) {
    res.reason = 'GSTIN and period are both required';
    return res;
  }

  try {
    const gmap = await loadGstinMap();
    const g = gmap.get(res.gstin);
    if (!g?.gstin_id) {
      res.reason = `${res.gstin} is not in the GSTIN master`;
      return res;
    }

    return await withClient(async (c) => {
      const docs = await loadDocuments(c, g.gstin_id!, period);
      const drafts = docs.filter((d) => d.source === 'draft');
      const filed = docs.filter((d) => d.source === 'filed');

      const outcomes = reconcile(drafts, filed);
      const summary = summarise(drafts, filed);
      const totals = countOutcomes(outcomes, drafts, filed);
      res.has_filed_data = totals.has_filed_data;

      await writeOutcomes(c, g.gstin_id!, res.gstin, period, outcomes);
      await writeSummary(c, g.gstin_id!, fyOf(period), period, summary);
      res.outcomes_written = outcomes.length;

      const run = await c.query(
        `INSERT INTO gstr1_recon_runs
           (gstin_id, financial_year, period, draft_documents, filed_documents, matched,
            not_declared, declared_not_in_books, amount_mismatch, table_mismatch,
            recipient_mismatch, credit_note_missing_ref, duplicates,
            taxable_difference, tax_difference, has_filed_data, run_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id`,
        [
          g.gstin_id, fyOf(period), period,
          totals.draft_documents, totals.filed_documents, totals.matched,
          totals.not_declared, totals.declared_not_in_books, totals.amount_mismatch,
          totals.table_mismatch, totals.recipient_mismatch, totals.credit_note_missing_ref,
          totals.duplicates, totals.taxable_difference, totals.tax_difference,
          totals.has_filed_data, userId ?? null,
        ],
      );
      res.run_id = Number(run.rows[0].id);
      res.totals = totals;
      res.summary = summary;
      res.ok = true;
      return res;
    });
  } catch (e: any) {
    res.reason = e.message + (e.constraint ? ` [constraint ${e.constraint}]` : '');
    res.constraint = e.constraint ?? null;
    res.detail = e.detail ?? null;
    return res;
  }
}

async function writeOutcomes(
  c: import('pg').Client,
  gstinId: number,
  gstin: string,
  period: string,
  outcomes: Gstr1ReconOutcome[],
): Promise<void> {
  // Link filed rows to the book invoice their draft matched, so every question
  // after this — whose invoice is it, which amendment applies — has an answer
  // without re-running the comparison.
  await c.query(
    `UPDATE gstr1_documents f
        SET sales_invoice_id = d.sales_invoice_id
       FROM gstr1_documents d
      WHERE f.sales_invoice_id IS NULL
        AND d.source = 'draft' AND d.sales_invoice_id IS NOT NULL
        AND f.gstin_id = d.gstin_id AND f.gstin_id = $1
        AND f.period   = d.period
        AND f.invoice_number_norm = d.invoice_number_norm
        AND COALESCE(f.invoice_date, DATE '1900-01-01') = COALESCE(d.invoice_date, DATE '1900-01-01')
        AND f.source = 'filed'`,
    [gstinId],
  );

  await c.query(`DELETE FROM sales_reconciliation WHERE gstin_id = $1 AND period = $2`, [gstinId, period]);

  // Catch a colliding unique key ourselves, before the database does. Postgres
  // only says "duplicate key value violates unique constraint" without naming
  // which two outcomes collided, and that turns a one-line diagnosis into a
  // bisect. Failing loudly here is better than a partial insert.
  const seen = new Set<string>();
  for (const o of outcomes) {
    const key = `${o.sales_invoice_id ?? -1}|${docIdOf(o.filed) ?? -1}|${o.table_type ?? 'null'}`;
    if (seen.has(key)) {
      throw new Error(
        `two outcomes share one key (sales_invoice_id=${o.sales_invoice_id ?? 'NULL'}, ` +
          `filed_id=${docIdOf(o.filed) ?? 'NULL'}, table=${o.table_type ?? 'NULL'}): ` +
          `both are "${o.status}" on ${o.invoice_number_norm}`,
      );
    }
    seen.add(key);
  }

  for (const chunk of batches(outcomes, 100)) {
    const values: unknown[][] = chunk.map((o) => [
      o.sales_invoice_id ?? null, gstinId, period, o.status,
      r2(o.difference_amount), fyOf(period), o.table_type,
      docIdOf(o.draft), docIdOf(o.filed),
      money(o.draft), taxOfDoc(o.draft), money(o.filed), taxOfDoc(o.filed),
      JSON.stringify(o.difference_details ?? {}),
    ]);
    await c.query(
      `INSERT INTO sales_reconciliation
         (sales_invoice_id, gstin_id, period, status, difference_amount, financial_year,
          table_type, gstr1_draft_id, gstr1_filed_id,
          draft_taxable, draft_tax, filed_taxable, filed_tax, difference_json)
       VALUES ${values.map((_, i) =>
         `(${Array.from({ length: values[0].length }, (_, k) => '$' + (i * values[0].length + k + 1)).join(',')})`).join(',')}`,
      values.flat(),
    );
  }
}

async function writeSummary(
  c: import('pg').Client,
  gstinId: number,
  fy: string,
  period: string,
  rows: Gstr1SummaryRow[],
): Promise<void> {
  // Rows for tables that no longer appear (say the books lost their only B2CL
  // invoice) have to go, or the summary would keep reporting a table the return
  // no longer has.
  await c.query(
    `DELETE FROM gstr1_summary_comparison
      WHERE gstin_id = $1 AND period = $2
        AND NOT (table_type = ANY($3::gstr1_table_type[]))`,
    [gstinId, period, rows.map((r) => r.table_type)],
  );
  for (const r of rows) {
    await c.query(
      `INSERT INTO gstr1_summary_comparison
         (gstin_id, financial_year, period, table_type, draft_count, filed_count,
          draft_taxable, filed_taxable, draft_tax, filed_tax,
          taxable_difference, tax_difference, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (gstin_id, period, table_type) DO UPDATE SET
         draft_count = EXCLUDED.draft_count, filed_count = EXCLUDED.filed_count,
         draft_taxable = EXCLUDED.draft_taxable, filed_taxable = EXCLUDED.filed_taxable,
         draft_tax = EXCLUDED.draft_tax, filed_tax = EXCLUDED.filed_tax,
         taxable_difference = EXCLUDED.taxable_difference,
         tax_difference = EXCLUDED.tax_difference,
         status = EXCLUDED.status, computed_at = now()`,
      [
        gstinId, fy, period, r.table_type, r.draft_count, r.filed_count,
        r.draft_taxable, r.filed_taxable, r.draft_tax, r.filed_tax,
        r.taxable_difference, r.tax_difference, r.status,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// reading back
// ---------------------------------------------------------------------------

export interface OutcomeFilters {
  status?: string;
  table?: string;
  limit?: number;
}

export interface OutcomePage {
  ok: boolean;
  reason?: string;
  gstin: string;
  period: string;
  has_filed_data: boolean;
  /**
   * What is actually stored, counted now. Deliberately separate from
   * `last_run`: the run history can be absent (never compared, or cleared)
   * while the documents are plainly there, and a screen that reports "draft
   * documents 0" over 443 stored drafts sends the reader hunting for data that
   * was never lost.
   */
  stored_drafts: number;
  stored_filed: number;
  summary: Gstr1SummaryRow[];
  last_run: Record<string, any> | null;
  totals: Record<string, number>;
  outcomes: Array<Record<string, any>>;
  total: number;
}

/** Everything the reconciliation screen shows, for one GSTIN and period. */
export async function loadOutcomePage(
  gstinRaw: string,
  period: string,
  filters: OutcomeFilters = {},
): Promise<OutcomePage> {
  const gstin = normGstin(gstinRaw);
  const page: OutcomePage = {
    ok: false, gstin, period, has_filed_data: false, stored_drafts: 0, stored_filed: 0,
    summary: [], last_run: null, totals: {}, outcomes: [], total: 0,
  };
  if (!gstin || !period) {
    page.reason = 'GSTIN and period are both required';
    return page;
  }

  try {
    const gmap = await loadGstinMap();
    const g = gmap.get(gstin);
    if (!g?.gstin_id) {
      page.reason = `${gstin} is not in the GSTIN master`;
      return page;
    }
    const gid = g.gstin_id;

    return await withClient(async (c) => {
      // Sequential, not Promise.all: pg queues concurrent queries on one client
      // but warns about it, and five small reads do not need the parallelism.
      const sres = await c.query(
        `SELECT table_type::text, draft_count, filed_count, draft_taxable, filed_taxable,
                draft_tax, filed_tax, taxable_difference, tax_difference, status
           FROM gstr1_summary_comparison WHERE gstin_id = $1 AND period = $2
          ORDER BY table_type`,
        [gid, period],
      );
      const runres = await c.query(
        `SELECT * FROM gstr1_recon_runs WHERE gstin_id = $1 AND period = $2
          ORDER BY ran_at DESC LIMIT 1`,
        [gid, period],
      );
      const filedres = await c.query(
        `SELECT
            count(*) FILTER (WHERE source = 'draft')::int AS drafts,
            count(*) FILTER (WHERE source = 'filed')::int AS filed
           FROM gstr1_documents WHERE gstin_id = $1 AND period = $2`,
        [gid, period],
      );
      const outres = await c.query(
        `SELECT sr.id, sr.status::text AS status, sr.difference_amount, sr.difference_json,
                sr.table_type::text AS table_type, sr.sales_invoice_id,
                COALESCE(si.invoice_number_raw, dd.invoice_number_raw, fd.invoice_number_raw) AS invoice_number_raw,
                COALESCE(si.invoice_number_norm, dd.invoice_number_norm, fd.invoice_number_norm) AS invoice_number_norm,
                COALESCE(si.invoice_date, dd.invoice_date, fd.invoice_date) AS invoice_date,
                COALESCE(si.customer_name, dd.recipient_name, fd.recipient_name) AS customer_name,
                COALESCE(si.customer_gstin_norm, dd.recipient_gstin_norm, fd.recipient_gstin_norm) AS customer_gstin_norm,
                COALESCE(si.place_of_supply, dd.place_of_supply, fd.place_of_supply) AS place_of_supply,
                dd.table_type::text AS draft_table_type, dd.taxable_value AS draft_taxable,
                dd.igst AS draft_igst, dd.cgst AS draft_cgst, dd.sgst AS draft_sgst, dd.cess AS draft_cess,
                (dd.igst + dd.cgst + dd.sgst + dd.cess) AS draft_tax,
                dd.invoice_value AS draft_invoice_value,
                fd.table_type::text AS filed_table_type, fd.taxable_value AS filed_taxable,
                fd.igst AS filed_igst, fd.cgst AS filed_cgst, fd.sgst AS filed_sgst, fd.cess AS filed_cess,
                (fd.igst + fd.cgst + fd.sgst + fd.cess) AS filed_tax,
                fd.invoice_value AS filed_invoice_value,
                (COALESCE(dd.taxable_value, 0) - COALESCE(fd.taxable_value, 0)) AS taxable_difference,
                ((COALESCE(dd.igst, 0) + COALESCE(dd.cgst, 0) + COALESCE(dd.sgst, 0) + COALESCE(dd.cess, 0)) -
                 (COALESCE(fd.igst, 0) + COALESCE(fd.cgst, 0) + COALESCE(fd.sgst, 0) + COALESCE(fd.cess, 0))) AS tax_difference,
                sr.resolved_at, sr.resolved_by
           FROM sales_reconciliation sr
           LEFT JOIN gstr1_documents dd ON dd.id = sr.gstr1_draft_id
           LEFT JOIN gstr1_documents fd ON fd.id = sr.gstr1_filed_id
           LEFT JOIN sales_invoices si   ON si.id = sr.sales_invoice_id
          WHERE sr.gstin_id = $1 AND sr.period = $2
          ORDER BY sr.status, COALESCE(si.invoice_date, dd.invoice_date, fd.invoice_date) NULLS LAST,
                   COALESCE(si.invoice_number_norm, dd.invoice_number_norm, fd.invoice_number_norm)`,
        [gid, period],
      );
      const totres = await c.query(
        `SELECT status::text AS status, count(*)::int AS n FROM sales_reconciliation
          WHERE gstin_id = $1 AND period = $2 GROUP BY status`,
        [gid, period],
      );

      page.summary = sres.rows as Gstr1SummaryRow[];
      page.last_run = runres.rows[0] ?? null;
      page.stored_drafts = filedres.rows[0]?.drafts ?? 0;
      page.stored_filed = filedres.rows[0]?.filed ?? 0;
      page.has_filed_data = page.stored_filed > 0;
      page.total = outres.rowCount;
      for (const t of totres.rows) page.totals[t.status] = t.n;

      let rows = outres.rows as Array<Record<string, any>>;
      if (filters.status) rows = rows.filter((r) => r.status === filters.status);
      if (filters.table) rows = rows.filter((r) => r.table_type === filters.table);
      if (filters.limit && filters.limit > 0) rows = rows.slice(0, filters.limit);
      page.outcomes = rows;
      page.ok = true;
      return page;
    });
  } catch (e: any) {
    page.reason = e.message;
    return page;
  }
}

/** Which GSTINs and periods have outward data at all, for the picker. */
export async function outwardCoverage(): Promise<Array<{ gstin: string; period: string; drafts: number; filed: number }>> {
  try {
    return await withClient(async (c) => {
      const r = await c.query(
        `SELECT g.gstin_number AS gstin, d.period,
                count(*) FILTER (WHERE d.source = 'draft')::int AS drafts,
                count(*) FILTER (WHERE d.source = 'filed')::int AS filed
           FROM gstr1_documents d
           JOIN gstins g ON g.id = d.gstin_id
          GROUP BY g.gstin_number, d.period
          ORDER BY d.period DESC, g.gstin_number`,
      );
      return r.rows;
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function batches<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function countByTable(docs: Gstr1Document[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of docs) out[d.table_type] = (out[d.table_type] ?? 0) + 1;
  return out;
}

/** A pg DATE arrives as a local-midnight Date; format it in local parts. */
function normDbDate(v: unknown): string {
  return isoDate(v);
}

/**
 * A document's database id, or null when it has not been stored.
 *
 * The cast matters more than it looks: `id` is BIGINT, and node-pg returns
 * int8 as a STRING because JavaScript numbers cannot hold the whole range.
 * A `typeof id === 'number'` test therefore fails for every real row, quietly
 * nulling every foreign key the reconciliation writes.
 */
function docIdOf(doc: Gstr1Document | undefined): number | null {
  const raw = (doc as (Gstr1Document & { id?: number | string }) | undefined)?.id;
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function money(doc: Gstr1Document | undefined): number | null {
  return doc ? r2(doc.taxable_value) : null;
}

function taxOfDoc(doc: Gstr1Document | undefined): number | null {
  return doc ? r2(doc.igst + doc.cgst + doc.sgst + doc.cess) : null;
}

/** Read both sides of a period out of gstr1_documents. */
async function loadDocuments(c: import('pg').Client, gstinId: number, period: string): Promise<Gstr1Document[]> {
  const r = await c.query(
    `SELECT id, gstin_id, financial_year, period, source::text AS source, table_type::text AS table_type,
            invoice_number_raw, invoice_number_norm, invoice_date, invoice_type,
            recipient_gstin_raw, recipient_gstin_norm, recipient_name, place_of_supply, pos_code,
            reverse_charge, hsn, taxable_value, igst, cgst, sgst, cess, invoice_value, rate,
            note_ref_number, note_ref_date, sales_invoice_id, source_row_number
       FROM gstr1_documents WHERE gstin_id = $1 AND period = $2 ORDER BY id`,
    [gstinId, period],
  );
  return r.rows.map((row) => ({
    ...row,
    invoice_date: row.invoice_date ? normDbDate(row.invoice_date) : null,
    note_ref_date: row.note_ref_date ? normDbDate(row.note_ref_date) : null,
    taxable_value: r2(row.taxable_value),
    igst: r2(row.igst),
    cgst: r2(row.cgst),
    sgst: r2(row.sgst),
    cess: r2(row.cess),
    invoice_value: r2(row.invoice_value),
    rate: row.rate === null ? null : r2(row.rate),
    table_type: row.table_type as Gstr1TableType,
  } as Gstr1Document & { id: number }));
}