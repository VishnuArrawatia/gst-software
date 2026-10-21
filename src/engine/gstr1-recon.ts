/**
 * Outward reconciliation: books -> draft -> filed -> match.
 *
 * This file does NOT build the draft. It does not need to: `buildGstr1` in
 * ./gstr1 already turns book-side sales invoices into the exact return this
 * application would file, complete with B2B / B2CL / B2CS / CDNR breakdown, HSN
 * summary and the validations the portal enforces. Writing a second draft
 * builder here would be actively harmful — the two would drift, and the
 * reconciliation screen would then disagree with the return the software itself
 * produces, which is the one comparison nobody can explain away.
 *
 * So the draft enters here already built, and this file converts it into
 * comparable documents, ingests what the portal says was filed, and compares
 * the two invoice by invoice.
 *
 * Everything is pure: plain objects in, plain objects out, no database and no
 * file system. That is what makes the outward side testable with literal
 * inputs, which matters more here than on the inward side because a filed
 * GSTR-1 is the one artefact whose correctness is judged by the portal and not
 * by us.
 */

import {
  effectiveRate,
  fyOf,
  isCreditNote,
  normGstin,
  normInvoice,
  normInvoiceType,
  normPos,
  r2,
  stateOf,
  taxOf,
  withinTolerance,
  type InvoiceType,
} from './core';
import type { Gstr1Model, ReturnInvoice } from './gstr1';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Rupee tolerance. GST allows a rupee of rounding on a return. */
export const DEFAULT_TOLERANCE = 1;

export type Gstr1TableType = 'B2B' | 'B2CL' | 'B2CS' | 'CDNR' | 'CDNUR';

export const GSTR1_TABLES: Gstr1TableType[] = ['B2B', 'B2CL', 'B2CS', 'CDNR', 'CDNUR'];

export const TABLE_LABEL: Record<Gstr1TableType, string> = {
  B2B: 'B2B — registered recipient',
  B2CL: 'B2CL — unregistered, inter-state',
  B2CS: 'B2CS — consolidated summary',
  CDNR: 'Credit / debit notes (registered, 9A)',
  CDNUR: 'Credit / debit notes (unregistered, 9B)',
};

/**
 * One document as it will sit in `gstr1_documents`.
 *
 * Deliberately NOT the same shape as `Gstr1Model`'s `ReturnInvoice`: the model
 * is shaped for producing a return (rate buckets, portal field names) and this
 * is shaped for storing a row and diffing two of them. Converting between the
 * two once, here, is what keeps the comparison honest.
 */
export interface Gstr1Document {
  our_gstin: string;
  financial_year: string;
  period: string;
  source: 'draft' | 'filed';
  table_type: Gstr1TableType;
  invoice_number_raw: string;
  invoice_number_norm: string;
  invoice_date: string | null;
  invoice_type: InvoiceType;
  recipient_gstin_raw?: string | null;
  recipient_gstin_norm?: string | null;
  recipient_name?: string | null;
  place_of_supply?: string | null;
  pos_code?: string | null;
  reverse_charge: boolean;
  hsn?: string | null;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  invoice_value: number;
  /** B2CS rows only: the slab the amount rolls up into. */
  rate?: number | null;
  note_ref_number?: string | null;
  note_ref_date?: string | null;
  source_row?: number;
}

// ---------------------------------------------------------------------------
// stage 1 adapter — Gstr1Model -> documents
// ---------------------------------------------------------------------------

/**
 * The synthetic identity of a B2CS aggregate.
 *
 * B2CS is not a document list. The portal groups every unregistered supply into
 * a summary, so two unrelated invoices to two walk-in customers at the same
 * rate are one B2CS line and have no invoice number between them.
 *
 * Known limitation, stated rather than hidden: the portal's own B2CS grouping
 * is by place of supply AND rate, but `buildGstr1` buckets B2CS by rate alone.
 * So both sides of this comparison are keyed by rate. The money still foots
 * exactly, because a draft and a filed B2CS covering different states still
 * total the same; what is lost is POS-level diagnosis inside B2CS. Widening
 * `buildGstr1` to carry a place of supply per bucket would fix it, but it would
 * also change the portal JSON this application files, so it is not done
 * silently here.
 */
export function b2csKey(rate: number): string {
  return `B2CS|${r2(rate).toFixed(3)}`;
}

/** Collapse an invoice's rate buckets into the one figure a document carries. */
function moneyOf(inv: ReturnInvoice): { taxable: number; igst: number; cgst: number; sgst: number; cess: number } {
  return {
    taxable: r2(inv.items.reduce((s, i) => s + i.taxable, 0)),
    igst: r2(inv.items.reduce((s, i) => s + i.igst, 0)),
    cgst: r2(inv.items.reduce((s, i) => s + i.cgst, 0)),
    sgst: r2(inv.items.reduce((s, i) => s + i.sgst, 0)),
    cess: r2(inv.items.reduce((s, i) => s + i.cess, 0)),
  };
}

/**
 * Turn a drafted return into storable, comparable documents.
 *
 * `salesInvoiceIdByNumber` links each drafted document back to the book row it
 * came from. Without it the reconciliation could report that an invoice matches
 * but not hang the outcome off the book invoice, and every later question —
 * "who is this customer's CA", "amend which invoice" — would need a second
 * lookup keyed on a number that may since have been re-typed.
 */
export function draftDocuments(
  model: Gstr1Model,
  salesInvoiceIdByNumber: Map<string, number> = new Map(),
): Gstr1Document[] {
  const gstin = normGstin(model.gstin);
  const period = model.period;
  const fy = model.financialYear || fyOf(period);
  const out: Gstr1Document[] = [];

  const fromInvoice = (inv: ReturnInvoice, table: Gstr1TableType): Gstr1Document => {
    const m = moneyOf(inv);
    return {
      our_gstin: gstin,
      financial_year: fy,
      period,
      source: 'draft',
      table_type: table,
      invoice_number_raw: inv.invoiceNo,
      invoice_number_norm: normInvoice(inv.invoiceNo),
      invoice_date: inv.invoiceDate || null,
      invoice_type: inv.invoiceType,
      recipient_gstin_raw: inv.counterpartyGstin || null,
      recipient_gstin_norm: normGstin(inv.counterpartyGstin) || null,
      recipient_name: inv.counterpartyName || null,
      place_of_supply: inv.placeOfSupply || null,
      pos_code: normPos(inv.placeOfSupply) || null,
      reverse_charge: Boolean(inv.reverseCharge),
      taxable_value: m.taxable,
      igst: m.igst,
      cgst: m.cgst,
      sgst: m.sgst,
      cess: m.cess,
      invoice_value: r2(inv.invoiceValue),
      note_ref_number: inv.noteRefNo || null,
      note_ref_date: inv.noteRefDate || null,
    };
  };

  for (const inv of model.b2b) out.push(fromInvoice(inv, 'B2B'));
  for (const inv of model.b2cl) out.push(fromInvoice(inv, 'B2CL'));
  for (const inv of model.cdnr) out.push(fromInvoice(inv, 'CDNR'));
  for (const inv of model.cdnur) out.push(fromInvoice(inv, 'CDNUR'));

  // B2CS buckets carry money but no document identity of their own.
  for (const bucket of model.b2cs) {
    out.push({
      our_gstin: gstin,
      financial_year: fy,
      period,
      source: 'draft',
      table_type: 'B2CS',
      invoice_number_raw: '',
      invoice_number_norm: b2csKey(bucket.rate),
      invoice_date: null,
      invoice_type: 'R',
      recipient_gstin_raw: null,
      recipient_gstin_norm: null,
      recipient_name: null,
      place_of_supply: null,
      pos_code: null,
      reverse_charge: false,
      taxable_value: r2(bucket.taxable),
      igst: r2(bucket.igst),
      cgst: r2(bucket.cgst),
      sgst: r2(bucket.sgst),
      cess: r2(bucket.cess),
      invoice_value: 0,
      rate: r2(bucket.rate),
    });
  }

  // Attach the book row where we can find it. A miss is not an error: the model
  // may have been built from a file that has since been edited, and the
  // reconciliation still works on the numbers.
  for (const doc of out) {
    const id = salesInvoiceIdByNumber.get(doc.invoice_number_norm);
    if (id) (doc as Gstr1Document & { sales_invoice_id?: number }).sales_invoice_id = id;
  }

  return out;
}

// ---------------------------------------------------------------------------
// stage 2 — the filed return
// ---------------------------------------------------------------------------

/** A row as it comes out of a portal export, before we know its table. */
export interface FiledRow {
  our_gstin: string;
  period: string;
  table_type?: string;
  invoice_number?: string;
  invoice_date?: string;
  invoice_type?: string;
  recipient_gstin?: string;
  recipient_name?: string;
  place_of_supply?: string;
  pos_code?: string;
  reverse_charge?: boolean;
  hsn?: string;
  taxable_value?: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
  cess?: number;
  invoice_value?: number;
  rate?: number;
  note_ref_number?: string;
  note_ref_date?: string;
  source_row?: number;
}

/**
 * Table names as they appear in portal exports and in our own UI.
 *
 * Accepts the full label ("B2B invoices", "b2cl", "Credit/Debit Notes") as well
 * as the bare code, because a GST portal download names the section in words
 * far more often than in codes.
 */
export function parseTableType(v: unknown): Gstr1TableType | null {
  const s = String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  if (s.startsWith('B2B')) return 'B2B';
  if (s.startsWith('B2CL')) return 'B2CL';
  if (s.startsWith('B2CS')) return 'B2CS';
  // CDNUR before CDNR. The two prefixes do not actually collide ("CDNUR" does
  // not start with "CDNR"), but writing the longer one first keeps the intent
  // obvious to the next reader.
  if (s.startsWith('CDNUR')) return 'CDNUR';
  if (s.startsWith('CDNR') || s.startsWith('CDN')) return 'CDNR';
  if (s.startsWith('CREDIT') || s.startsWith('DEBIT') || s.startsWith('NOTE')) return 'CDNR';
  if (s === 'B2BA' || s === 'SEZWP' || s === 'SEWOP') return 'B2B';
  return null;
}

/**
 * Turn one portal export row into a filed document.
 *
 * Two things here are not obvious.
 *
 * First, a credit note's "GSTIN of recipient" is still filled in on the portal,
 * so the table cannot be inferred from the counterparty — the row is already a
 * note. Hence the declared table, then the invoice type, are consulted before
 * the GSTIN ever is.
 *
 * Second, B2CS rows have no invoice number in the export, so one is synthesised
 * from the declared rate. If the export omits the rate too it is derived from
 * the amounts — the same derivation the draft uses, so the two land on the same
 * key rather than on two keys that look alike.
 */
export function classifyFiled(row: FiledRow): Gstr1Document | null {
  const gstin = normGstin(row.our_gstin);
  if (!gstin) return null;
  const period = row.period;
  if (!period) return null;

  const invoiceType = normInvoiceType(row.invoice_type);
  const declaredTable = parseTableType(row.table_type);
  // Trust the declared table over inference. The export is telling us what the
  // taxpayer actually filed, which may well be wrong — and detecting that is
  // the entire job.
  // A note with no declared table: table 9A when the export still shows a
  // recipient GSTIN, table 9B when it does not. 9A is grouped by that GSTIN, so
  // a note without one cannot be a CDNR row.
  const tableType: Gstr1TableType =
    declaredTable ?? (isCreditNote(invoiceType) ? (normGstin(row.recipient_gstin) ? 'CDNR' : 'CDNUR') : 'B2B');

  const pos = normPos(row.pos_code) || normPos(row.place_of_supply) || stateOf(row.recipient_gstin) || null;

  const doc: Gstr1Document = {
    our_gstin: gstin,
    financial_year: fyOf(period),
    period,
    source: 'filed',
    table_type: tableType,
    invoice_number_raw: row.invoice_number ?? '',
    invoice_number_norm: normInvoice(row.invoice_number),
    invoice_date: row.invoice_date || null,
    invoice_type: invoiceType,
    recipient_gstin_raw: row.recipient_gstin || null,
    recipient_gstin_norm: normGstin(row.recipient_gstin) || null,
    recipient_name: row.recipient_name || null,
    place_of_supply: row.place_of_supply || null,
    pos_code: pos,
    reverse_charge: Boolean(row.reverse_charge),
    hsn: row.hsn || null,
    taxable_value: r2(row.taxable_value),
    igst: r2(row.igst),
    cgst: r2(row.cgst),
    sgst: r2(row.sgst),
    cess: r2(row.cess),
    invoice_value: r2(row.invoice_value),
    note_ref_number: row.note_ref_number || null,
    note_ref_date: row.note_ref_date || null,
    source_row: row.source_row,
  };

  if (tableType === 'B2CS') {
    const rate =
      row.rate === undefined || row.rate === null || Number.isNaN(row.rate)
        ? effectiveRate(doc.taxable_value, taxOf(doc))
        : r2(row.rate);
    doc.rate = rate;
    doc.invoice_number_norm = b2csKey(rate);
    doc.invoice_number_raw = '';
    doc.invoice_date = null;
  }

  return doc;
}

/** Classify a batch, dropping rows that cannot be placed at all. */
export function classifyFiledRows(rows: FiledRow[]): Gstr1Document[] {
  const out: Gstr1Document[] = [];
  for (const row of rows) {
    const doc = classifyFiled(row);
    if (doc) out.push(doc);
  }
  return out;
}

/**
 * Collapse duplicate filed B2CS rows into one aggregate per rate.
 *
 * A portal export gives B2CS as one row per place of supply and rate. Two
 * states at one rate are two rows on the portal and one aggregate in our
 * comparison, and folding them is what lets a single draft bucket match both.
 */
export function foldFiledB2cs(rows: Gstr1Document[]): Gstr1Document[] {
  const out: Gstr1Document[] = [];
  const byKey = new Map<string, Gstr1Document>();
  for (const row of rows) {
    if (row.table_type !== 'B2CS') {
      out.push(row);
      continue;
    }
    const key = row.invoice_number_norm;
    const existing = byKey.get(key);
    if (!existing) {
      // A COPY, never the row itself. Folding in place would mutate the
      // caller's data, and this runs three times over the same array in one
      // reconciliation (reconcile, then summarise, then countOutcomes) — so an
      // in-place fold adds the same amounts repeatedly and the reported totals
      // grow every time they are read.
      const copy: Gstr1Document = { ...row };
      byKey.set(key, copy);
      out.push(copy);
      continue;
    }
    existing.taxable_value = r2(existing.taxable_value + row.taxable_value);
    existing.igst = r2(existing.igst + row.igst);
    existing.cgst = r2(existing.cgst + row.cgst);
    existing.sgst = r2(existing.sgst + row.sgst);
    existing.cess = r2(existing.cess + row.cess);
    existing.invoice_value = r2(existing.invoice_value + row.invoice_value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// stage 3 — reconciliation
// ---------------------------------------------------------------------------

export type Gstr1ReconStatus =
  | 'Matched'
  | 'Not Declared'
  | 'Declared Not In Books'
  | 'Amount Mismatch'
  | 'Table Mismatch'
  | 'Recipient Mismatch'
  | 'Duplicate'
  | 'Credit Note Missing Ref';

export interface Gstr1ReconOutcome {
  status: Gstr1ReconStatus;
  our_gstin: string;
  period: string;
  table_type: Gstr1TableType | null;
  invoice_number_norm: string;
  invoice_date: string | null;
  sales_invoice_id?: number;
  draft?: Gstr1Document;
  filed?: Gstr1Document;
  difference_amount: number;
  difference_details: Record<string, unknown>;
  action: string;
}

/** Identity of a document within a return: number plus date, or the B2CS key. */
export function docKey(doc: Pick<Gstr1Document, 'invoice_number_norm' | 'invoice_date'>): string {
  return `${doc.invoice_number_norm}|${doc.invoice_date ?? ''}`;
}

type Bucket = Map<string, Gstr1Document[]>;

function indexByKey(docs: Gstr1Document[]): Bucket {
  const out: Bucket = new Map();
  for (const d of docs) {
    const k = docKey(d);
    const list = out.get(k);
    if (list) list.push(d);
    else out.set(k, [d]);
  }
  return out;
}

/** Group documents by GSTIN and period — the unit a return is filed for. */
export function groupByReturn(
  docs: Gstr1Document[],
): Map<string, { our_gstin: string; financial_year: string; period: string; docs: Gstr1Document[] }> {
  const out = new Map<string, { our_gstin: string; financial_year: string; period: string; docs: Gstr1Document[] }>();
  for (const d of docs) {
    const key = `${d.our_gstin}|${d.period}`;
    let bucket = out.get(key);
    if (!bucket) {
      bucket = { our_gstin: d.our_gstin, financial_year: d.financial_year, period: d.period, docs: [] };
      out.set(key, bucket);
    }
    bucket.docs.push(d);
  }
  return out;
}

/**
 * Compare a drafted return against the filed one, invoice by invoice.
 *
 * The filed side drives the loop. Every row in the filed return gets an
 * outcome, including rows with no draft counterpart — a return can contain a
 * document we have never heard of, and that is a finding, not an absence. The
 * draft side is swept afterwards for documents that never made it into the
 * return.
 *
 * Duplicates are detected before matching rather than after. Two filed rows
 * sharing a key cannot both be the counterpart of one draft row, so picking
 * either would be arbitrary; saying "duplicate" is the only honest answer, and
 * the portal is in fact capable of accepting it.
 */
export function reconcile(
  drafts: Gstr1Document[],
  filedInput: Gstr1Document[],
  tolerance = DEFAULT_TOLERANCE,
): Gstr1ReconOutcome[] {
  const filed = foldFiledB2cs(filedInput);
  const outcomes: Gstr1ReconOutcome[] = [];
  const draftByKey = indexByKey(drafts);
  const filedByKey = indexByKey(filed);
  const usedDrafts = new Set<Gstr1Document>();

  for (const f of filed) {
    const siblings = filedByKey.get(docKey(f)) ?? [f];
    const candidates = draftByKey.get(docKey(f)) ?? [];
    const free = candidates.filter((d) => !usedDrafts.has(d));
    const sid = (f as Gstr1Document & { sales_invoice_id?: number }).sales_invoice_id;

    const isDuplicate =
      siblings.length > 1 ||
      candidates.length > 1 ||
      (siblings.length === 1 && free.length === 0 && candidates.length > 0);

    if (isDuplicate) {
      outcomes.push({
        status: 'Duplicate',
        our_gstin: f.our_gstin,
        period: f.period,
        table_type: f.table_type,
        invoice_number_norm: f.invoice_number_norm,
        invoice_date: f.invoice_date,
        sales_invoice_id: sid,
        filed: f,
        difference_amount: r2(siblings.length * taxOf(f) - (free[0] ? taxOf(free[0]) : 0)),
        difference_details: {
          filedRows: siblings.length,
          draftRows: candidates.length,
          reason:
            candidates.length === 0
              ? 'Declared more than once with no book counterpart'
              : 'Same invoice number and date appears more than once on one or both sides',
        },
        action: 'Confirm which declaration is genuine and amend or cancel the other',
      });
      continue;
    }

    if (candidates.length === 0) {
      outcomes.push({
        status: 'Declared Not In Books',
        our_gstin: f.our_gstin,
        period: f.period,
        table_type: f.table_type,
        invoice_number_norm: f.invoice_number_norm,
        invoice_date: f.invoice_date,
        filed: f,
        difference_amount: r2(taxOf(f)),
        difference_details: { reason: 'In the filed return but no book invoice with this number and date' },
        action: 'Check whether the invoice is missing from the sales register or its number was mistyped',
      });
      continue;
    }

    const d = free[0];
    usedDrafts.add(d);
    outcomes.push(comparePair(d, f, tolerance));
  }

  // Drafted but not filed: either not declared, or a filed row already covered
  // it and was reported as a duplicate above.
  for (const d of drafts) {
    if (usedDrafts.has(d)) continue;
    if ((filedByKey.get(docKey(d)) ?? []).length > 0) continue;
    outcomes.push({
      status: 'Not Declared',
      our_gstin: d.our_gstin,
      period: d.period,
      table_type: d.table_type,
      invoice_number_norm: d.invoice_number_norm,
      invoice_date: d.invoice_date,
      sales_invoice_id: (d as Gstr1Document & { sales_invoice_id?: number }).sales_invoice_id,        draft: d,
        // filed minus books: nothing was filed, so the whole of the book tax is a
        // deficit and reads negative — the same sign a filed amount that came in
        // below the books gets from an Amount Mismatch.
        difference_amount: r2(0 - taxOf(d)),
        difference_details: { reason: 'In the books, absent from the filed return' },
        action: 'Declare in an amended return, or correct the books if the invoice should not exist',
      });
  }

  return outcomes;
}

/**
 * Compare one matched pair.
 *
 * The order of the checks is deliberate and not cosmetic. A document that
 * changed table did not merely change amount — it changed what it was declared
 * as — and reporting that as an amount difference would send the reviewer to
 * the wrong place with the wrong fix. The same holds for a recipient change.
 * Amounts come last, once identity and classification already agree.
 */
function comparePair(d: Gstr1Document, f: Gstr1Document, tolerance: number): Gstr1ReconOutcome {
  const base = {
    our_gstin: d.our_gstin,
    period: d.period,
    invoice_number_norm: d.invoice_number_norm,
    invoice_date: d.invoice_date ?? f.invoice_date,
    sales_invoice_id: (d as Gstr1Document & { sales_invoice_id?: number }).sales_invoice_id,
    draft: d,
    filed: f,
  };

  if (d.table_type === 'CDNR' && !d.note_ref_number) {
    return {
      ...base,
      status: 'Credit Note Missing Ref',
      table_type: d.table_type,
      difference_amount: r2(taxOf(f) - taxOf(d)),
      difference_details: {
        reason: 'Credit note drafted without the original invoice number; the portal will reject it',
      },
      action: 'Add the original invoice number and date to the credit note',
    };
  }

  if (d.table_type !== f.table_type) {
    return {
      ...base,
      status: 'Table Mismatch',
      table_type: f.table_type,
      difference_amount: r2(taxOf(f) - taxOf(d)),
      difference_details: {
        reason: 'Drafted into one outward table, filed into another',
        draftedAs: d.table_type,
        filedAs: f.table_type,
      },
      action:
        'Usually the recipient GSTIN was missing or wrong in the books — fix the books so the table is right next time',
    };
  }

  // Only compare recipients stated on both sides. An empty cell is not a
  // disagreement about a customer, it is an absence of data, and that surfaces
  // as a table mismatch above rather than as an accusation.
  if (d.recipient_gstin_norm && f.recipient_gstin_norm && d.recipient_gstin_norm !== f.recipient_gstin_norm) {
    return {
      ...base,
      status: 'Recipient Mismatch',
      table_type: f.table_type,
      difference_amount: r2(taxOf(f) - taxOf(d)),
      difference_details: {
        reason: 'Filed against a different recipient GSTIN than the books record',
        booksGstin: d.recipient_gstin_norm,
        filedGstin: f.recipient_gstin_norm,
      },
      action: 'Confirm which customer the invoice was actually raised to and correct the books',
    };
  }

  const taxableDiff = r2(f.taxable_value - d.taxable_value);
  const taxDiff = r2(taxOf(f) - taxOf(d));
  if (
    !withinTolerance(f.taxable_value, d.taxable_value, tolerance) ||
    !withinTolerance(taxOf(f), taxOf(d), tolerance)
  ) {
    return {
      ...base,
      status: 'Amount Mismatch',
      table_type: f.table_type,
      difference_amount: taxDiff,
      difference_details: {
        reason: 'Declared amounts differ from the books',
        taxableDifference: taxableDiff,
        taxDifference: taxDiff,
        booksTaxable: d.taxable_value,
        filedTaxable: f.taxable_value,
        booksTax: r2(taxOf(d)),
        filedTax: r2(taxOf(f)),
      },
      action: 'Amend the return for the difference, or correct the books',
    };
  }

  return {
    ...base,
    status: 'Matched',
    table_type: f.table_type,
    difference_amount: 0,
    difference_details: {},
    action: 'No action',
  };
}

// ---------------------------------------------------------------------------
// table-level totals
// ---------------------------------------------------------------------------

export interface Gstr1TableTotal {
  table_type: Gstr1TableType;
  count: number;
  taxable: number;
  tax: number;
}

/** Totals per outward table — the shape the GSTR-1 summary itself has. */
export function totalsByTable(docs: Gstr1Document[]): Map<Gstr1TableType, Gstr1TableTotal> {
  const out = new Map<Gstr1TableType, Gstr1TableTotal>();
  for (const d of docs) {
    let t = out.get(d.table_type);
    if (!t) {
      t = { table_type: d.table_type, count: 0, taxable: 0, tax: 0 };
      out.set(d.table_type, t);
    }
    t.count += 1;
    t.taxable = r2(t.taxable + d.taxable_value);
    t.tax = r2(t.tax + taxOf(d));
  }
  return out;
}

export type SummaryStatus = 'OK' | 'Taxable Diff' | 'Tax Diff' | 'Both Diff' | 'Count Diff' | 'Missing Side';

export interface Gstr1SummaryRow {
  table_type: Gstr1TableType;
  draft_count: number;
  filed_count: number;
  draft_taxable: number;
  filed_taxable: number;
  draft_tax: number;
  filed_tax: number;
  taxable_difference: number;
  tax_difference: number;
  status: SummaryStatus;
}

/**
 * Table-level comparison for one GSTIN and period.
 *
 * A table missing on one side is `Missing Side` rather than a plain difference:
 * an empty B2CL and an absent B2CL mean different things to a reviewer, and
 * only the first is a clean nil return. A table absent from both sides is not
 * reported at all — there is nothing to say about it.
 */
export function summarise(
  drafts: Gstr1Document[],
  filedInput: Gstr1Document[],
  tolerance = DEFAULT_TOLERANCE,
): Gstr1SummaryRow[] {
  const filed = foldFiledB2cs(filedInput);
  const dTotals = totalsByTable(drafts);
  const fTotals = totalsByTable(filed);
  const rows: Gstr1SummaryRow[] = [];

  for (const table of GSTR1_TABLES) {
    const d = dTotals.get(table);
    const f = fTotals.get(table);
    if (!d && !f) continue;

    const draftCount = d?.count ?? 0;
    const filedCount = f?.count ?? 0;
    const draftTaxable = r2(d?.taxable ?? 0);
    const filedTaxable = r2(f?.taxable ?? 0);
    const draftTax = r2(d?.tax ?? 0);
    const filedTax = r2(f?.tax ?? 0);
    const taxableDifference = r2(filedTaxable - draftTaxable);
    const taxDifference = r2(filedTax - draftTax);

    let status: SummaryStatus;
    if (!d || !f) status = 'Missing Side';
    else if (!withinTolerance(filedTaxable, draftTaxable, tolerance) && !withinTolerance(filedTax, draftTax, tolerance)) status = 'Both Diff';
    else if (!withinTolerance(filedTaxable, draftTaxable, tolerance)) status = 'Taxable Diff';
    else if (!withinTolerance(filedTax, draftTax, tolerance)) status = 'Tax Diff';
    else if (draftCount !== filedCount) status = 'Count Diff';
    else status = 'OK';

    rows.push({
      table_type: table,
      draft_count: draftCount,
      filed_count: filedCount,
      draft_taxable: draftTaxable,
      filed_taxable: filedTaxable,
      draft_tax: draftTax,
      filed_tax: filedTax,
      taxable_difference: taxableDifference,
      tax_difference: taxDifference,
      status,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// run totals
// ---------------------------------------------------------------------------

export interface Gstr1RunTotals {
  draft_documents: number;
  filed_documents: number;
  matched: number;
  not_declared: number;
  declared_not_in_books: number;
  amount_mismatch: number;
  table_mismatch: number;
  recipient_mismatch: number;
  credit_note_missing_ref: number;
  duplicates: number;
  taxable_difference: number;
  tax_difference: number;
  has_filed_data: boolean;
}

/**
 * Headline counters for one GSTIN and period.
 *
 * The money headline deliberately excludes Table Mismatch and Recipient
 * Mismatch. Those are real findings and they are counted, but neither moves
 * rupee one of tax — a document declared in the wrong table still carries the
 * same liability. Folding them into the difference would make a data-entry
 * error look like a shortfall.
 */
export function countOutcomes(
  outcomes: Gstr1ReconOutcome[],
  drafted: Gstr1Document[],
  filedInput: Gstr1Document[],
): Gstr1RunTotals {
  const filed = foldFiledB2cs(filedInput);
  const totals: Gstr1RunTotals = {
    draft_documents: drafted.length,
    filed_documents: filed.length,
    matched: 0,
    not_declared: 0,
    declared_not_in_books: 0,
    amount_mismatch: 0,
    table_mismatch: 0,
    recipient_mismatch: 0,
    credit_note_missing_ref: 0,
    duplicates: 0,
    taxable_difference: 0,
    tax_difference: 0,
    has_filed_data: filedInput.length > 0,
  };

  for (const o of outcomes) {
    switch (o.status) {
      case 'Matched': totals.matched += 1; break;
      case 'Not Declared': totals.not_declared += 1; break;
      case 'Declared Not In Books': totals.declared_not_in_books += 1; break;
      case 'Amount Mismatch': totals.amount_mismatch += 1; break;
      case 'Table Mismatch': totals.table_mismatch += 1; break;
      case 'Recipient Mismatch': totals.recipient_mismatch += 1; break;
      case 'Credit Note Missing Ref': totals.credit_note_missing_ref += 1; break;
      case 'Duplicate': totals.duplicates += 1; break;
    }

    // Only outcomes that represent real money move the headline, and BOTH money
    // columns must cover the same population. Tax difference and taxable
    // difference are read side by side, so a tax difference summed over three
    // statuses against a taxable difference summed over five would put two
    // figures next to each other that do not describe the same findings.
    //
    // A one-sided outcome counts its absent side as zero, and the sign is always
    // filed MINUS books — the convention `summarise` already uses — so an
    // under-declared invoice reads negative everywhere rather than positive in
    // one table and negative in another.
    const movesMoney =
      o.status === 'Amount Mismatch' ||
      o.status === 'Not Declared' ||
      o.status === 'Declared Not In Books';
    if (movesMoney) {
      const filedTaxable = o.filed?.taxable_value ?? 0;
      const draftTaxable = o.draft?.taxable_value ?? 0;
      const filedTax = o.filed ? taxOf(o.filed) : 0;
      const draftTax = o.draft ? taxOf(o.draft) : 0;
      totals.tax_difference = r2(totals.tax_difference + (filedTax - draftTax));
      totals.taxable_difference = r2(totals.taxable_difference + (filedTaxable - draftTaxable));
    }
  }
  return totals;
}