/**
 * GST ERP — Phase 0 store.
 *
 * The engine is pure and the monthly pipeline is file-based, which is exactly
 * why the original Purchase Register values, the reconciliation overrides, the
 * human ITC decision and the audit trail had nowhere to live. This module is
 * where they live: PostgreSQL, in the additive Phase-0 tables from migration 04.
 *
 * Three rules this file is built around.
 *
 *   1. BOOK VALUES ARE WRITTEN ONCE. `persistRun` upserts on a deterministic
 *      `line_key`, and the upsert never updates a book_* column. A database
 *      trigger (`trg_pl_book_immutable`) is the backstop.
 *   2. A RE-IMPORT NEVER CLOBBERS HUMAN WORK. On conflict, the reconciliation
 *      columns are only refreshed while they still equal the previous book
 *      values; once a user has edited them (`recon_edited`), they are left
 *      alone. The ITC decision is never reset by a re-import.
 *   3. LOCKED MONTHS ARE CLOSED. Every write path checks `month_locks` and
 *      refuses, and the database trigger refuses as well.
 *
 * Nothing in here is used by the pure engine, so unit tests stay pure.
 */

import crypto from 'node:crypto';
import { Client } from 'pg';

import {
  fyOf, isValidGstin, isoDate, labelOf, normDate, normDocType, normGstin, normInvoice, r2, taxOf,
} from '../engine/core';
import { reconcilePurchases, type ReconResult } from '../engine/match';
import type { Gstr2bRecord, PurchaseBill, ReconRow, SalesInvoice } from '../engine/core';
import { pgConfig } from '../config/env';
import { assertConnectedDatabase, isTestProfile } from '../config/test-db';
import { loadEnv } from '../config/env';

// The CLI does not otherwise need the environment, so load it here rather than
// making every entry point remember to. loadEnv never overrides a real env var.
loadEnv();

// ---------------------------------------------------------------------------
// ITC decision vocabulary (spec §10, §13). Software never picks one.
// ---------------------------------------------------------------------------

export const ITC_DECISIONS = [
  'Pending Review',
  'Claim',
  'Do Not Claim',
  'Reclaim Later',
  'Query Vendor',
  'Ineligible',
  'Reversed',
] as const;
export type ItcDecision = (typeof ITC_DECISIONS)[number];

export const RETURN_CLASSIFICATIONS = [
  'Pending Review',
  '4(A) — Claimed',
  '4(A)(i) — Books only',
  '4(B) — Blocked',
  'Not in 3B — Carried',
  'Ineligible',
] as const;

export const RECON_FIELDS = ['recon_supplier_gstin', 'recon_invoice_no', 'recon_invoice_date'] as const;
export type ReconField = (typeof RECON_FIELDS)[number];

/**
 * E-invoice / e-way bill, recorded per invoice while reconciling bill-to-bill.
 *
 * Neither figure arrives in GSTR-2B, so the person doing the reconciliation
 * answers a plain yes/no from the invoice in front of them. Three states, not
 * two: NULL means "not looked at yet", which is what keeps the exception
 * report honest instead of counting every untouched invoice as missing.
 */
export const E_DOC_FIELDS = [
  'has_e_invoice', 'e_invoice_no', 'has_e_way_bill', 'e_way_bill_no',
  'e_invoice_required', 'e_way_bill_required',
] as const;
export type EDocField = (typeof E_DOC_FIELDS)[number];

/** What the Yes/No control in the UI sends. */
export type EYesNo = 'yes' | 'no';

const YES_NO: Record<string, boolean | null> = { yes: true, no: false, '': null };

/**
 * Read one e-doc field off a request body.
 *
 * `undefined` means "leave it alone" — the invoice working screen sends the
 * whole row every time, and an untouched control must not blank a value
 * somebody else recorded.
 */
export function parseEDocField(
  field: EDocField,
  raw: unknown,
): { ok: true; value: boolean | string | null } | { ok: false; reason: string } {
  const s = String(raw ?? '').trim();

  if (field === 'has_e_invoice' || field === 'has_e_way_bill') {
    const v = YES_NO[s.toLowerCase()];
    if (v === undefined) {
      return { ok: false, reason: `"${s}" is not a yes/no answer.` };
    }
    return { ok: true, value: v };
  }
  if (field === 'e_invoice_required' || field === 'e_way_bill_required') {
    if (s === '') return { ok: true, value: null };
    const v = YES_NO[s.toLowerCase()];
    if (v === undefined) {
      return { ok: false, reason: `"${s}" is not a yes/no answer.` };
    }
    return { ok: true, value: v };
  }

  // The reference numbers. A number with no Yes/No answer yet is accepted —
  // having the IRN on record is the point — but it is trimmed and length-capped
  // so a pasted paragraph cannot silently truncate in the database.
  const clean = s === '' ? null : s.slice(0, 100);
  return { ok: true, value: clean };
}

export const FIELD_LABEL: Record<string, string> = {
  recon_supplier_gstin: 'Reconciliation GSTIN',
  recon_invoice_no: 'Reconciliation Invoice No',
  recon_invoice_date: 'Reconciliation Invoice Date',
  has_e_invoice: 'E-Invoice Generated',
  e_invoice_no: 'E-Invoice IRN',
  has_e_way_bill: 'E-Way Bill Generated',
  e_way_bill_no: 'E-Way Bill No',
  e_invoice_required: 'E-Invoice Required',
  e_way_bill_required: 'E-Way Bill Required',
  itc_decision: 'ITC Decision',
  itc_decision_month: 'ITC Decision Month',
  decision_reason: 'ITC Reason',
  return_classification: 'Return Classification',
  remarks: 'Remarks',
  vendor_response: 'Vendor Response',
  follow_up_date: 'Follow-up Date',
  expected_correction: 'Expected Correction',
  action_taken: 'Action Taken',
};

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

/** A short-lived pooled-ish client. One per operation, closed after. */
export async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const cfg = pgConfig();
  const client = new Client(cfg);
  await client.connect();
  try {
    // Fail-closed for test runs: when the test profile is armed, this connection
    // must really be the test database, and only the server can confirm that.
    // Inert in production — a normal run has no profile set. See
    // src/config/test-db.ts for why this is a hard exit and not a warning.
    if (isTestProfile()) {
      const landed = await client.query('SELECT current_database() AS d');
      assertConnectedDatabase(String(landed.rows[0]?.d ?? ''), 'a database write (src/app/store.ts withClient)');
    }
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function dbReady(): Promise<{ ok: boolean; reason?: string }> {
  if (!pgConfig().password) return { ok: false, reason: 'PGPASSWORD is not set in .env' };
  try {
    await withClient(async (c) => {
      await c.query('SELECT 1 FROM purchase_lines LIMIT 1');
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e.message };
  }
}

/** GSTIN number -> { gstin_id, company_id }. Resolved once per run. */
export type GstinMap = Map<string, { gstin_id: number | null; company_id: number | null }>;

export async function loadGstinMap(): Promise<GstinMap> {
  const out: GstinMap = new Map();
  try {
    await withClient(async (c) => {
      const r = await c.query('SELECT id, company_id, gstin_number FROM gstins');
      for (const row of r.rows) out.set(String(row.gstin_number).toUpperCase(), { gstin_id: row.id, company_id: row.company_id });
    });
  } catch {
    /* masters not seeded — lines still import, just without an id */
  }
  return out;
}

// ---------------------------------------------------------------------------
// line identity
// ---------------------------------------------------------------------------

/**
 * Stable identity of a book line.
 *
 * Same input file -> same rows in the same order, so
 * `our_gstin|period|source_file|source_row` is reproducible and lets a re-run
 * refresh the match result without losing an edit. `source_row` is what keeps
 * two identical-looking invoices in one file apart.
 */
export function lineKeyOf(b: { our_gstin: string; period: string; source_file?: string; source_row?: number }): string {
  return [normGstin(b.our_gstin), b.period, b.source_file || 'manual', b.source_row ?? 0].join('|');
}

/**
 * Identity of a GSTR-2B line in the database.
 *
 * This MUST be the record's own `id`, because that is what reconciliation
 * stores in `purchase_lines.matched_2b_key`. Inventing a second key format here
 * silently breaks every "which 2B lines are still unbooked" question — the
 * anti-join simply never matches. Ingest sets `id` to `<sourceFile>#<row>`,
 * which is stable across runs for the same file.
 */
function twobKeyOf(r: Gstr2bRecord): string {
  return r.id || [normGstin(r.our_gstin), r.period, r.source_file || 'manual', r.source_row ?? 0].join('|');
}

export function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// persist a completed run
// ---------------------------------------------------------------------------

export interface TwoBFileInput {
  file_name: string;
  sha256: string;
  file_size?: number;
  our_gstin: string;
  twob_month: string;
  portal_fp?: string;
  record_count: number;
  blocked_count: number;
  source_format: 'xlsx' | 'json' | 'paste';
}

export interface PersistInput {
  books: PurchaseBill[];
  twob: Gstr2bRecord[];
  /** Sales read from the SAP sales register. Stored so GSTR-1 has a base. */
  sales?: SalesInvoice[];
  /** Reconciliation outcome per our_gstin + period. */
  reconByBundle: Map<string, ReconResult>;
  twoBFiles?: TwoBFileInput[];
  uploadedBy?: string;
}

const bundleKey = (gstin: string, period: string) => `${normGstin(gstin)}|${period}`;

export interface PersistResult {
  ok: boolean;
  reason?: string;
  linesInserted: number;
  linesUpdated: number;
  twobInserted: number;
  twobUpdated: number;
  salesInserted: number;
  salesUpdated: number;
  /** Item lines written to `sales_invoice_items`. */
  salesItemsStored: number;
  /** Rows we could not store because their GSTIN is not in the master. */
  salesUnknownGstin: string[];
  filesRegistered: number;
  duplicateFiles: string[];
  lockedSkipped: string[];
  registered: string[];
}

const EMPTY: PersistResult = {
  ok: false, linesInserted: 0, linesUpdated: 0, twobInserted: 0, twobUpdated: 0,
  salesInserted: 0, salesUpdated: 0, salesItemsStored: 0, salesUnknownGstin: [],
  filesRegistered: 0, duplicateFiles: [], lockedSkipped: [], registered: [],
};

/**
 * Write a run's book lines, portal lines and file registry into the database.
 *
 * Never throws: a database outage must not turn a successful reconciliation
 * into a failed run. The caller gets `ok: false` with the reason and shows it.
 */
export async function persistRun(input: PersistInput): Promise<PersistResult> {
  const res: PersistResult = { ...EMPTY, registered: [] };
  try {
    await withClient(async (c) => {
      const gmap = await loadGstinMap();

      // ---- 2B file registry -------------------------------------------
      for (const f of input.twoBFiles ?? []) {
        const g = gmap.get(normGstin(f.our_gstin));
        const r = await c.query(
          `INSERT INTO gstr2b_files
             (file_name, sha256, file_size, our_gstin, company_id, financial_year,
              twob_month, portal_fp, record_count, blocked_count, source_format, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (our_gstin, twob_month, sha256) DO NOTHING
           RETURNING id`,
          [f.file_name, f.sha256, f.file_size ?? null, normGstin(f.our_gstin), g?.company_id ?? null,
           fyOf(f.twob_month), f.twob_month, f.portal_fp ?? null, f.record_count, f.blocked_count,
           f.source_format, input.uploadedBy ?? 'system'],
        );
        if (r.rowCount) res.filesRegistered++;
        else res.duplicateFiles.push(`${f.our_gstin} ${labelOf(f.twob_month)} ${f.file_name}`);
      }

      // ---- locked months are read-only --------------------------------
      const locked = new Set<string>();
      const lk = await c.query('SELECT our_gstin, period FROM month_locks WHERE is_locked');
      for (const row of lk.rows) locked.add(`${normGstin(row.our_gstin)}|${row.period}`);

      // ---- GSTR-2B lines -----------------------------------------------
      const twobValues: unknown[][] = [];
      // Must match the INSERT column list below: gstin_id, company_id,
// customer_gstin_norm, customer_gstin_raw, customer_name, invoice_number_raw,
// invoice_number_norm, invoice_date, financial_year, period, invoice_type,
// place_of_supply, reverse_charge, hsn, taxable_value, igst, cgst, sgst, cess,
// invoice_value, note_ref_number, note_ref_date, source_row_number,
// recipient_type, item_count, e_commerce_gstin, doc_nature, doc_series_from,
// doc_series_to, doc_series_cancelled, amendment_invoice_number,
// amendment_invoice_date.
const SALES_COL_COUNT = 32;

// Must match the INSERT column list in the item block below: sales_invoice_id,
// line_no, item_code, item_description, hsn, uqc, quantity, gst_rate,
// taxable_value, igst, cgst, sgst, cess, freight, other_charges,
// source_row_number.
const SALES_ITEM_COL_COUNT = 16;
      const twobMeta = new Map<string, Gstr2bRecord>();
      for (const t of input.twob) {
        const key = twobKeyOf(t);
        const month = (t.portal_fp || t.period || '').slice(0, 7);
        if (!month) continue;
        const g = gmap.get(normGstin(t.our_gstin));
        twobMeta.set(key, t);
        twobValues.push([
          key, normGstin(t.our_gstin), normGstin(t.supplier_gstin), t.supplier_name || '',
          String(t.invoice_no ?? '').trim(), t.invoice_date || null, t.invoice_type || null,
          r2(t.taxable_value), r2(t.igst), r2(t.cgst), r2(t.sgst), r2(t.cess), r2(t.invoice_value),
          month, (t.portal_fp || '').slice(0, 7) || null, t.filing_date || null,
          t.place_of_supply || null, !!t.reverse_charge, t.itc_availability || 'Yes',
          t.reason || null, t.applicable_pct || null, t.source_file || null, t.source_row ?? null,
          /\.json$/i.test(t.source_file || '') ? 'json' : 'xlsx',
        ]);
      }
      // ---- Sales invoices ----------------------------------------------
      // The SAP sales register was always READ by a run but never STORED, so
      // `sales_invoices` stayed empty and GSTR-1 had nothing to reconcile
      // against. Persisting it here makes sales-vs-GSTR-1 possible.
      //
      // The unique index on (gstin_id, invoice_number_norm, invoice_date) is
      // what makes a re-run safe: the same invoice is updated, never doubled.
      // A locked month is skipped rather than written, exactly like purchases.
      const salesValues: unknown[][] = [];
      // Item lines, kept beside the invoice rows so the parent always has
      // exactly as many children as the register declared — never one item
      // overwriting another.
      const salesItemValues: unknown[][] = [];
      const salesItemKeys: Array<[number, string, string]> = [];
      for (const s of input.sales ?? []) {
        const gstin = normGstin(s.our_gstin);
        if (!gstin) continue;
        if (locked.has(`${gstin}|${s.period}`)) {
          if (!res.lockedSkipped.includes(`${gstin} ${labelOf(s.period)}`)) {
            res.lockedSkipped.push(`${gstin} ${labelOf(s.period)}`);
          }
          continue;
        }
        const g = gmap.get(gstin);
        if (!g?.gstin_id) {
          const key = `${gstin} (sales)`;
          if (!res.salesUnknownGstin.includes(key)) res.salesUnknownGstin.push(key);
          continue;
        }
        const invNo = String(s.invoice_no ?? '').trim();
        if (!invNo) continue;
        const invNorm = normInvoice(invNo);
        salesValues.push([
          g.gstin_id, g.company_id ?? null,
          normGstin(s.customer_gstin) || null, String(s.customer_gstin ?? '').trim() || null,
          (s.customer_name ?? '').trim() || null,
          invNo, invNorm, s.invoice_date, fyOf(s.period), s.period,
          s.invoice_type || 'R', (s.place_of_supply ?? '').trim() || null,
          !!s.reverse_charge, (s.hsn ?? '').trim() || null,
          r2(s.taxable_value), r2(s.igst), r2(s.cgst), r2(s.sgst), r2(s.cess), r2(s.invoice_value),
          (s.note_ref_no ?? '').trim() || null, s.note_ref_date || null,
          s.source_row ?? null,
          (s.recipient_type ?? '').trim() || null, s.items?.length ?? 0,
          normGstin(s.e_commerce_gstin) || null, (s.doc_nature ?? '').trim() || null,
          s.doc_series_from ?? null, s.doc_series_to ?? null, s.doc_series_cancelled ?? null,
          (s.amendment_invoice_no ?? '').trim() || null, s.amendment_invoice_date || null,
        ]);

        const items = s.items ?? [];
        items.forEach((it, idx) => {
          salesItemKeys.push([g.gstin_id!, invNorm, s.invoice_date]);
          salesItemValues.push([
            // The parent id is filled in after the upsert, by key.
            g.gstin_id, invNorm, s.invoice_date,
            it.line_no ?? idx + 1,
            (it.item_code ?? '').trim() || null,
            (it.description ?? '').trim() || null,
            (it.hsn ?? '').trim() || null,
            (it.uqc ?? '').trim() || null,
            it.quantity ?? null,
            it.gst_rate ?? null,
            r2(it.taxable_value), r2(it.igst), r2(it.cgst), r2(it.sgst), r2(it.cess),
            it.freight ?? null, it.other_charges ?? null,
            it.source_row ?? null,
          ]);
        });
      }
      if (salesValues.length) {
        for (const chunk of chunkRows(salesValues, SALES_COL_COUNT)) {
          const r = await c.query(
            `INSERT INTO sales_invoices
               (gstin_id, company_id, customer_gstin_norm, customer_gstin_raw, customer_name,
                invoice_number_raw, invoice_number_norm, invoice_date, financial_year, period,
                invoice_type, place_of_supply, reverse_charge, hsn,
                taxable_value, igst, cgst, sgst, cess, invoice_value,
                note_ref_number, note_ref_date, source_row_number,
                recipient_type, item_count, e_commerce_gstin, doc_nature,
                doc_series_from, doc_series_to, doc_series_cancelled,
                amendment_invoice_number, amendment_invoice_date)
             VALUES ${Array.from({ length: chunk.length }, (_, i) =>
               `(${Array.from({ length: SALES_COL_COUNT }, (_, k) => '$' + (i * SALES_COL_COUNT + k + 1)).join(',')})`).join(',')}
             ON CONFLICT (gstin_id, invoice_number_norm, invoice_date) DO UPDATE SET
               customer_name = EXCLUDED.customer_name,
               period = EXCLUDED.period,
               invoice_type = EXCLUDED.invoice_type,
               place_of_supply = EXCLUDED.place_of_supply,
               reverse_charge = EXCLUDED.reverse_charge,
               hsn = EXCLUDED.hsn,
               taxable_value = EXCLUDED.taxable_value,
               igst = EXCLUDED.igst,
               cgst = EXCLUDED.cgst,
               sgst = EXCLUDED.sgst,
               cess = EXCLUDED.cess,
               invoice_value = EXCLUDED.invoice_value,
               note_ref_number = EXCLUDED.note_ref_number,
               note_ref_date = EXCLUDED.note_ref_date,
               recipient_type = EXCLUDED.recipient_type,
               item_count = EXCLUDED.item_count,
               e_commerce_gstin = EXCLUDED.e_commerce_gstin,
               doc_nature = EXCLUDED.doc_nature,
               doc_series_from = EXCLUDED.doc_series_from,
               doc_series_to = EXCLUDED.doc_series_to,
               doc_series_cancelled = EXCLUDED.doc_series_cancelled,
               amendment_invoice_number = EXCLUDED.amendment_invoice_number,
               amendment_invoice_date = EXCLUDED.amendment_invoice_date,
               updated_at = now()
             /* xmax = 0 on a fresh INSERT, non-zero on an UPDATE. This is the
                only reliable way to tell them apart: rowCount counts both, so
                a re-run would otherwise be reported as 2 more insertions. */
             RETURNING (xmax = 0) AS was_insert`,
            chunk.flat(),
          );
          let inserted = 0;
          for (const row of r.rows) if (row.was_insert) inserted++;
          res.salesInserted += inserted;
          res.salesUpdated += r.rowCount - inserted;
        }
      }

      // ---- Sales ITEM lines --------------------------------------------
      // Written after their invoice rows exist, and REPLACED rather than
      // merged: an item deleted from the register must not survive a re-upload,
      // and a second item must never land on top of the first one. The parent
      // id is resolved by key (`gstin_id` + normalised number + date) instead of
      // trusting the ORDER rows come back from a multi-row upsert — that order
      // is not something a foreign key should ever depend on.
      if (salesItemValues.length) {
        const gstinIds = [...new Set(salesItemKeys.map((k) => k[0]))];
        const dates = [...new Set(salesItemKeys.map((k) => k[2]))];
        const idRows = await c.query(
          `SELECT id, gstin_id, invoice_number_norm, to_char(invoice_date, 'YYYY-MM-DD') AS d
             FROM sales_invoices
            WHERE gstin_id = ANY($1::int[]) AND invoice_date = ANY($2::date[])`,
          [gstinIds, dates],
        );
        const idByKey = new Map<string, string>();
        for (const row of idRows.rows) {
          idByKey.set(`${row.gstin_id}|${row.invoice_number_norm}|${row.d}`, String(row.id));
        }

        const affected = new Set<string>();
        const itemValues: unknown[][] = [];
        for (const v of salesItemValues) {
          const id = idByKey.get(`${v[0]}|${v[1]}|${v[2]}`);
          if (!id) continue;
          affected.add(id);
          itemValues.push([id, ...v.slice(3)]);
        }
        if (affected.size) {
          await c.query('DELETE FROM sales_invoice_items WHERE sales_invoice_id = ANY($1::bigint[])', [
            [...affected],
          ]);
        }
        for (const chunk of chunkRows(itemValues, SALES_ITEM_COL_COUNT)) {
          await c.query(
            `INSERT INTO sales_invoice_items
               (sales_invoice_id, line_no, item_code, item_description, hsn, uqc,
                quantity, gst_rate, taxable_value, igst, cgst, sgst, cess,
                freight, other_charges, source_row_number)
             VALUES ${chunk.map((_, i) =>
               `(${Array.from({ length: SALES_ITEM_COL_COUNT }, (_, k) => '$' + (i * SALES_ITEM_COL_COUNT + k + 1)).join(',')})`).join(',')}
             ON CONFLICT (sales_invoice_id, line_no) DO UPDATE SET
               item_code = EXCLUDED.item_code,
               item_description = EXCLUDED.item_description,
               hsn = EXCLUDED.hsn,
               uqc = EXCLUDED.uqc,
               quantity = EXCLUDED.quantity,
               gst_rate = EXCLUDED.gst_rate,
               taxable_value = EXCLUDED.taxable_value,
               igst = EXCLUDED.igst,
               cgst = EXCLUDED.cgst,
               sgst = EXCLUDED.sgst,
               cess = EXCLUDED.cess,
               freight = EXCLUDED.freight,
               other_charges = EXCLUDED.other_charges,
               source_row_number = EXCLUDED.source_row_number,
               updated_at = now()`,
            chunk.flat(),
          );
          res.salesItemsStored += chunk.length;
        }
      }

      if (twobValues.length) {
        for (const chunk of chunkRows(twobValues, TWOB_COL_COUNT)) {
          const r = await c.query(
            `INSERT INTO gstr2b_lines
               (line_key, our_gstin, supplier_gstin, supplier_name, invoice_no, invoice_date,
                document_type, taxable_value, igst, cgst, sgst, cess, invoice_value,
                twob_month, portal_fp, filing_date, place_of_supply, reverse_charge,
                itc_availability, reason, applicable_pct, source_file, source_row, source_format)
             VALUES ${chunk.map((_, i) =>
               `(${Array.from({ length: TWOB_COL_COUNT }, (_, k) => '$' + (i * TWOB_COL_COUNT + k + 1)).join(',')})`).join(',')}
             ON CONFLICT (line_key) DO UPDATE SET
               supplier_gstin = EXCLUDED.supplier_gstin,
               supplier_name = COALESCE(NULLIF(EXCLUDED.supplier_name,''), gstr2b_lines.supplier_name),
               taxable_value = EXCLUDED.taxable_value,
               igst = EXCLUDED.igst, cgst = EXCLUDED.cgst, sgst = EXCLUDED.sgst,
               cess = EXCLUDED.cess, invoice_value = EXCLUDED.invoice_value,
               twob_month = EXCLUDED.twob_month, portal_fp = EXCLUDED.portal_fp,
               itc_availability = EXCLUDED.itc_availability, reason = EXCLUDED.reason,
               imported_at = now()`,
            chunk.flat(),
          );
          res.twobUpdated += r.rowCount;
        }
        res.twobInserted = twobValues.length;
      }

      // ---- purchase lines ----------------------------------------------
      const values: unknown[][] = [];
      for (const b of input.books) {
        const bk = bundleKey(b.our_gstin, b.period);
        if (locked.has(bk)) {
          res.lockedSkipped.push(`${b.our_gstin} ${labelOf(b.period)}`);
          continue;
        }
        const key = lineKeyOf(b);
        const g = gmap.get(normGstin(b.our_gstin));
        const recon = input.reconByBundle.get(bk);
        const row = recon?.rows.find((r) => r.source_row === b.source_row);
        const matchedTwob = row?.matched_2b_id ? input.twob.find((t) => t.id === row.matched_2b_id) : undefined;
        values.push(lineParams(key, b, g, row, matchedTwob, 'file'));
      }
      if (values.length) {
        for (const chunk of chunkRows(values, PURCHASE_COL_COUNT)) {
          const r = await c.query(insertPurchaseSql(chunk.length), chunk.flat());
          res.linesUpdated += r.rowCount;
        }
        res.linesInserted = values.length;
      }
    });
    res.ok = true;
  } catch (e: any) {
    res.ok = false;
    res.reason = e.message;
  }
  return res;
}

const PURCHASE_COL_COUNT = 58;
const TWOB_COL_COUNT = 24;
/** PostgreSQL allows 65535 bind parameters per statement, so bulk writes chunk. */
const MAX_PARAMS = 60_000;

function chunkRows<T>(rows: T[], colsPerRow: number): T[][] {
  const per = Math.max(1, Math.floor(MAX_PARAMS / colsPerRow));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += per) out.push(rows.slice(i, i + per));
  return out;
}

function insertPurchaseSql(n: number): string {
  return (
    `INSERT INTO purchase_lines
       (line_key, our_gstin, period, financial_year, gstin_id, company_id, unit_name,
        party_name, source_file, source_row, import_source,
        book_supplier_gstin, book_invoice_no, book_invoice_date, book_reference_no,
        book_entry_date, book_document_type, book_document_type_raw, book_sign,
        source_taxable_value, source_igst, source_cgst, source_sgst, source_cess,
        book_taxable_value, book_igst, book_cgst, book_sgst, book_cess,
        recon_supplier_gstin, recon_invoice_no, recon_invoice_date,
        match_status, match_method, matched_2b_key, matched_2b_month,
        twob_supplier_gstin, twob_invoice_no, twob_invoice_date, twob_taxable_value,
        twob_igst, twob_cgst, twob_sgst, twob_cess, twob_itc, itc_availability,
        mismatch_reason, itc_amount, taxable_difference, itc_difference,
        duplicate_count, suggested_action, reconciled_at, imported_at,
        has_e_invoice, e_invoice_no, has_e_way_bill, e_way_bill_no)
     VALUES ${Array.from({ length: n }, (_, i) =>
       `(${Array.from({ length: PURCHASE_COL_COUNT }, (_, k) => '$' + (i * PURCHASE_COL_COUNT + k + 1)).join(',')})`).join(',')}
     ON CONFLICT (line_key) DO UPDATE SET
       party_name = EXCLUDED.party_name,
       -- E-invoice / e-way bill answers follow the file when it carries the
       -- columns. A file that does not carry them must not blank an answer
       -- somebody recorded by hand during reconciliation, hence the IS NOT
       -- DISTINCT FROM guard rather than a plain overwrite.
       has_e_invoice = CASE WHEN EXCLUDED.has_e_invoice IS NULL
                            THEN purchase_lines.has_e_invoice
                            ELSE EXCLUDED.has_e_invoice END,
       e_invoice_no = CASE WHEN EXCLUDED.has_e_invoice IS NULL
                           THEN purchase_lines.e_invoice_no
                           ELSE EXCLUDED.e_invoice_no END,
       has_e_way_bill = CASE WHEN EXCLUDED.has_e_way_bill IS NULL
                             THEN purchase_lines.has_e_way_bill
                             ELSE EXCLUDED.has_e_way_bill END,
       e_way_bill_no = CASE WHEN EXCLUDED.has_e_way_bill IS NULL
                            THEN purchase_lines.e_way_bill_no
                            ELSE EXCLUDED.e_way_bill_no END,
       -- The PO/GRN reference is book data like the invoice number, so it
       -- follows the file on every re-import and is never a user edit.
       book_reference_no = EXCLUDED.book_reference_no,
       -- Book data like the reference, so it follows the file. COALESCE rather
       -- than a plain overwrite so a file that carries no Book Entry Date
       -- column cannot silently blank a date an earlier file supplied.
       book_entry_date = COALESCE(EXCLUDED.book_entry_date, purchase_lines.book_entry_date),
       -- The document type decides the sign of every amount on the line, so a
       -- corrected file must be able to fix it on re-import.
       book_document_type = EXCLUDED.book_document_type,
       book_document_type_raw = EXCLUDED.book_document_type_raw,
       book_sign = EXCLUDED.book_sign,
       source_taxable_value = EXCLUDED.source_taxable_value,
       source_igst = EXCLUDED.source_igst,
       source_cgst = EXCLUDED.source_cgst,
       source_sgst = EXCLUDED.source_sgst,
       source_cess = EXCLUDED.source_cess,
       unit_name = COALESCE(EXCLUDED.unit_name, purchase_lines.unit_name),
       match_status = EXCLUDED.match_status,
       match_method = EXCLUDED.match_method,
       matched_2b_key = EXCLUDED.matched_2b_key,
       matched_2b_month = EXCLUDED.matched_2b_month,
       twob_supplier_gstin = EXCLUDED.twob_supplier_gstin,
       twob_invoice_no = EXCLUDED.twob_invoice_no,
       twob_invoice_date = EXCLUDED.twob_invoice_date,
       twob_taxable_value = EXCLUDED.twob_taxable_value,
       twob_igst = EXCLUDED.twob_igst, twob_cgst = EXCLUDED.twob_cgst,
       twob_sgst = EXCLUDED.twob_sgst, twob_cess = EXCLUDED.twob_cess,
       twob_itc = EXCLUDED.twob_itc,
       itc_availability = EXCLUDED.itc_availability,
       mismatch_reason = EXCLUDED.mismatch_reason,
       itc_amount = EXCLUDED.itc_amount,
       taxable_difference = EXCLUDED.taxable_difference,
       itc_difference = EXCLUDED.itc_difference,
       duplicate_count = EXCLUDED.duplicate_count,
       suggested_action = EXCLUDED.suggested_action,
       reconciled_at = EXCLUDED.reconciled_at,
       imported_at = now(),
       -- The three editable fields follow the book only while nobody has
       -- touched them. recon_edited is the flag, so a user's edit survives
       -- every future re-import of the same file.
       recon_supplier_gstin = CASE WHEN purchase_lines.recon_edited
                                   THEN purchase_lines.recon_supplier_gstin
                                   ELSE EXCLUDED.recon_supplier_gstin END,
       recon_invoice_no = CASE WHEN purchase_lines.recon_edited
                               THEN purchase_lines.recon_invoice_no
                               ELSE EXCLUDED.recon_invoice_no END,
       recon_invoice_date = CASE WHEN purchase_lines.recon_edited
                                 THEN purchase_lines.recon_invoice_date
                                 ELSE EXCLUDED.recon_invoice_date END,
       recon_edited = CASE WHEN purchase_lines.recon_edited THEN true
                           ELSE (purchase_lines.recon_supplier_gstin  IS DISTINCT FROM EXCLUDED.recon_supplier_gstin
                              OR purchase_lines.recon_invoice_no      IS DISTINCT FROM EXCLUDED.recon_invoice_no
                              OR purchase_lines.recon_invoice_date    IS DISTINCT FROM EXCLUDED.recon_invoice_date) END,
       updated_at = now()`
  );
}

/**
 * One row of the `purchase_lines` upsert, in the column order of
 * `insertPurchaseSql`. The recon_* columns are seeded from the book values —
 * a line starts life as "matched on what the books say".
 */
function lineParams(
  key: string,
  b: PurchaseBill,
  g: { gstin_id: number | null; company_id: number | null } | undefined,
  row: ReconRow | undefined,
  twob: Gstr2bRecord | undefined,
  importSource: string,
): unknown[] {
  const itc = taxOf(b);
  const matched = !!(row && row.matched_2b_id);
  return [
    key, normGstin(b.our_gstin), b.period, fyOf(b.period), g?.gstin_id ?? null, g?.company_id ?? null,
    b.unit_name ?? null, b.party_name ?? null, b.source_file ?? null, b.source_row ?? null, importSource,
    // book_* — written once
    normGstin(b.supplier_gstin), String(b.invoice_no ?? '').trim(), b.invoice_date || null,
    String(b.reference_no ?? '').trim() || null, b.book_entry_date || null,
    b.document_type ?? 'Tax Invoice',
    b.document_type_raw ?? null,
    b.sign_effect ?? 1,
    r2(b.source_taxable_value ?? b.taxable_value),
    r2(b.source_igst ?? b.igst),
    r2(b.source_cgst ?? b.cgst),
    r2(b.source_sgst ?? b.sgst),
    r2(b.source_cess ?? b.cess),
    r2(b.taxable_value), r2(b.igst), r2(b.cgst), r2(b.sgst), r2(b.cess),
    // recon_* — the editable copy
    normGstin(b.supplier_gstin), String(b.invoice_no ?? '').trim(), b.invoice_date || null,
    // match outcome
    row?.status ?? null, row ? 'primary' : 'none', row?.matched_2b_id ?? null,
    row?.matched_2b_month ?? null,
    matched ? normGstin(twob?.supplier_gstin ?? b.supplier_gstin) : null,
    matched ? String(twob?.invoice_no ?? row?.invoice_no ?? '') : null,
    matched ? twob?.invoice_date || row?.invoice_date || null : null,
    row?.two_b_taxable ?? null,
    matched ? r2(twob?.igst) : null, matched ? r2(twob?.cgst) : null,
    matched ? r2(twob?.sgst) : null, matched ? r2(twob?.cess) : null,
    row?.two_b_itc ?? null, row?.itc_availability ?? null,
    row?.reason ?? null, itc, row?.taxable_difference ?? null, row?.itc_difference ?? null,
    row?.duplicate_count ?? null, row?.action ?? null, row ? new Date() : null, new Date(),
    b.has_e_invoice ?? null, b.e_invoice_no ?? null, b.has_e_way_bill ?? null, b.e_way_bill_no ?? null,
  ];
}

// ---------------------------------------------------------------------------
// re-reconcile one GSTIN + month from stored data
// ---------------------------------------------------------------------------

export interface LineFilters {
  gstin?: string;
  period?: string;
  search?: string;
  status?: string;
  decision?: string;
  limit?: number;
  offset?: number;
}

function lineWhere(f: LineFilters, params: unknown[]): string {
  const w: string[] = [];
  if (f.gstin) { params.push(normGstin(f.gstin)); w.push(`our_gstin = $${params.length}`); }
  if (f.period) { params.push(f.period); w.push(`period = $${params.length}`); }
  if (f.status) { params.push(f.status); w.push(`match_status = $${params.length}`); }
  if (f.decision) { params.push(f.decision); w.push(`itc_decision = $${params.length}`); }
  if (f.search) {
    params.push(`%${f.search.toLowerCase()}%`);
    w.push(`(LOWER(COALESCE(party_name,'')) LIKE $${params.length}
          OR LOWER(book_invoice_no) LIKE $${params.length}
          OR LOWER(recon_invoice_no) LIKE $${params.length}
          OR LOWER(book_supplier_gstin) LIKE $${params.length}
          OR LOWER(recon_supplier_gstin) LIKE $${params.length})`);
  }
  return w.length ? `WHERE ${w.join(' AND ')}` : '';
}

const LINE_COLS = `id, line_key, our_gstin, period, financial_year, company_id, unit_name, party_name,
  source_file, source_row, import_source, imported_at,
  book_supplier_gstin, book_invoice_no, book_invoice_date, book_taxable_value,
  book_igst, book_cgst, book_sgst, book_cess, book_reference_no, book_entry_date,
  book_document_type, book_document_type_raw, book_sign,
  source_taxable_value, source_igst, source_cgst, source_sgst, source_cess,
  has_e_invoice, e_invoice_no, has_e_way_bill, e_way_bill_no,
  e_invoice_required, e_way_bill_required,
  recon_supplier_gstin, recon_invoice_no, recon_invoice_date, recon_edited, recon_edited_by, recon_edited_at,
  match_status, match_method, matched_2b_key, matched_2b_month,
  twob_supplier_gstin, twob_invoice_no, twob_invoice_date, twob_taxable_value,
  twob_igst, twob_cgst, twob_sgst, twob_cess, twob_itc, itc_availability,
  mismatch_reason, itc_amount, taxable_difference, itc_difference, duplicate_count,
  suggested_action, reconciled_at,
  itc_decision, itc_decision_month, decision_by, decision_at, decision_reason, return_classification,
  remarks, vendor_response, follow_up_date, expected_correction, action_taken`;

/** A line shaped for the UI, with `itc` and `itc_total` filled in. */
export function shapeLine(r: Record<string, any>): Record<string, any> {
  const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  // The date arrives as a YYYY-MM-DD string (the DATE type parser in
  // config/env keeps it a string) but can be a Date when the row came from
  // somewhere else, so both are accepted. The month is derived, never stored
  // twice — one source of truth means the two can never disagree.
  const raw = r.book_entry_date;
  const iso = raw instanceof Date ? isoDate(raw) : typeof raw === 'string' ? raw.slice(0, 10) : '';
  const bookEntryMonth = /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : '';
  return {
    ...r,
    // Invoice | Credit Note | Debit Note — the UI shows it next to the number so
    // a negative line reads as a credit note rather than a data error.
    document_type: normDocType(r.book_document_type),
    document_type_raw: r.book_document_type_raw ?? null,
    sign_effect: Number(r.book_sign ?? 1),
    book_itc: r2(n(r.book_igst) + n(r.book_cgst) + n(r.book_sgst) + n(r.book_cess)),
    periodLabel: labelOf(r.period),
    twoBMonthLabel: r.matched_2b_month ? labelOf(r.matched_2b_month) : '',
    twoBMatched: !!r.matched_2b_key,
    // Shown next to the period so a purchase invoiced in April but booked in
    // May reads as two different months — the reason the column exists.
    book_entry_month: bookEntryMonth || null,
    bookEntryMonthLabel: bookEntryMonth ? labelOf(bookEntryMonth) : '',
  };
}

export async function listLines(f: LineFilters): Promise<{ total: number; rows: Record<string, any>[] }> {
  const params: unknown[] = [];
  const where = lineWhere(f, params);
  const limit = Math.min(f.limit ?? 200, 5000);
  const offset = f.offset ?? 0;
  const t = await withClient((c) => c.query(`SELECT count(*)::int n FROM purchase_lines ${where}`, params));
  const r = await withClient((c) =>
    c.query(
      `SELECT ${LINE_COLS} FROM purchase_lines ${where}
       ORDER BY our_gstin, period, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
  );
  return { total: t.rows[0].n, rows: r.rows.map(shapeLine) };
}

export async function getLine(id: number): Promise<Record<string, any> | null> {
  const r = await withClient((c) => c.query(`SELECT ${LINE_COLS} FROM purchase_lines WHERE id = $1`, [id]));
  return r.rowCount ? shapeLine(r.rows[0]) : null;
}

/** History for one line: recon corrections and ITC decisions, oldest first. */
export async function lineHistory(id: number): Promise<Record<string, any>[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT id, field_name, old_value, new_value, reason, changed_by, changed_at, rerefreshed
         FROM recon_corrections WHERE line_id = $1 ORDER BY changed_at, id`,
      [id],
    );
    return r.rows;
  });
}

/** Load the stored lines + 2B lines for one GSTIN/period back into the engine. */
export async function loadBundleForReconcile(gstin: string, period: string) {
  const books: PurchaseBill[] = [];
  const twob: Gstr2bRecord[] = [];

  const b = await withClient((c) =>
    c.query(
      `SELECT * FROM purchase_lines WHERE our_gstin = $1 AND period = $2 ORDER BY id`,
      [normGstin(gstin), period],
    ),
  );
  for (const r of b.rows) {
    books.push({
      id: String(r.id),
      our_gstin: r.our_gstin,
      unit_name: r.unit_name ?? undefined,
      party_name: r.party_name ?? '',
      supplier_gstin: r.book_supplier_gstin,
      invoice_no: r.book_invoice_no,
      document_type: normDocType(r.book_document_type),
      reference_no: r.book_reference_no ?? undefined,
      book_entry_date: typeof r.book_entry_date === 'string'
        ? r.book_entry_date
        : (r.book_entry_date ? iso(r.book_entry_date as Date) : undefined),
      invoice_date: r.book_invoice_date instanceof Date ? iso(r.book_invoice_date) : r.book_invoice_date,
      period: r.period,
      taxable_value: Number(r.book_taxable_value),
      igst: Number(r.book_igst),
      cgst: Number(r.book_cgst),
      sgst: Number(r.book_sgst),
      cess: Number(r.book_cess),
      invoice_total: r2(Number(r.book_taxable_value)),
      source_file: r.source_file ?? undefined,
      source_row: r.source_row ?? undefined,
      recon_supplier_gstin: r.recon_supplier_gstin,
      recon_invoice_no: r.recon_invoice_no,
      recon_invoice_date:
        r.recon_invoice_date instanceof Date ? iso(r.recon_invoice_date) : r.recon_invoice_date,
    });
  }

  // The 2B lines come from every month the portal has published, because an
  // invoice booked in March can match in the April 2B. Restricting to the book
  // period is how "Missing in 2B" would become a permanent lie.
  const t = await withClient((c) =>
    c.query(`SELECT * FROM gstr2b_lines WHERE our_gstin = $1 ORDER BY twob_month, id`, [normGstin(gstin)]),
  );
  for (const r of t.rows) {
    twob.push({
      id: r.line_key,
      our_gstin: r.our_gstin,
      supplier_gstin: r.supplier_gstin,
      supplier_name: r.supplier_name ?? '',
      invoice_no: r.invoice_no,
      invoice_type: r.document_type ?? 'Regular',
      invoice_date: r.invoice_date instanceof Date ? iso(r.invoice_date) : r.invoice_date ?? '',
      invoice_value: Number(r.invoice_value),
      place_of_supply: r.place_of_supply ?? '',
      reverse_charge: !!r.reverse_charge,
      taxable_value: Number(r.taxable_value),
      igst: Number(r.igst),
      cgst: Number(r.cgst),
      sgst: Number(r.sgst),
      cess: Number(r.cess),
      period: r.twob_month,
      portal_fp: r.portal_fp ?? r.twob_month,
      filing_date: r.filing_date ? iso(r.filing_date) : undefined,
      itc_availability: r.itc_availability ?? 'Yes',
      reason: r.reason ?? undefined,
      source_file: r.source_file ?? undefined,
      source_row: r.source_row ?? undefined,
    });
  }
  return { books, twob };
}

function iso(d: Date): string {
  // Local parts, not toISOString: pg hands back a DATE as local midnight, and
  // converting to UTC first shifts every invoice date back by one day in IST.
  // See core.isoDate for the full explanation.
  return isoDate(d);
}

export interface ReReconcileResult {
  ok: boolean;
  reason?: string;
  gstin: string;
  period: string;
  lines: number;
  twobLines: number;
  before: Record<string, number>;
  after: Record<string, number>;
  /**
   * How many lines this run actually MOVED. Not the matched total: a second
   * run over unchanged data must report 0, otherwise the number cannot answer
   * the only question the operator has after pressing Save & Re-reconcile —
   * did my correction fix anything?
   */
  changed: number;
  /** Lines matching after this run, so the total is still one read away. */
  matched: number;
  changedBy: string;
}

/**
 * SAVE & RE-RECONCILE.
 *
 * Re-runs the pure engine over the stored lines — using whatever the
 * reconciliation fields now say — and writes the new outcome back. The book
 * columns are not read for matching and not written at all.
 */
export async function reReconcile(
  gstin: string,
  period: string,
  opts: { changedBy: string; reason?: string } = { changedBy: 'unknown' },
): Promise<ReReconcileResult> {
  const out: ReReconcileResult = {
    ok: false, gstin: normGstin(gstin), period, lines: 0, twobLines: 0,
    before: {}, after: {}, changed: 0, matched: 0, changedBy: opts.changedBy,
  };
  try {
    const locked = await isLocked(gstin, period);
    if (locked.locked) {
      out.reason = `GST month ${labelOf(period)} for ${gstin} is LOCKED — unlock it as admin first.`;
      return out;
    }

    const { books, twob } = await loadBundleForReconcile(gstin, period);
    out.lines = books.length;
    out.twobLines = twob.length;
    if (!books.length) {
      out.reason = 'No purchase lines are stored for that GSTIN and month. Import the register first.';
      return out;
    }

    // The engine must not re-file a book row under the 2B month; it groups by
    // our own period, which is what the DB stores.
    const result = reconcilePurchases(books, twob);
    out.before = countStatuses(await statusesFor(gstin, period));
    out.after = countStatuses(result.rows);

    await withClient(async (c) => {
      await c.query('BEGIN');
      // A book line is identified by the file and row it came from, which is
      // the same identity the DB stores — not the invoice number, because two
      // vendors can both invoice "123".
      const byKey = new Map<string, string>();
      for (const b of books as any[]) byKey.set(`${b.source_file}|${b.source_row}`, b.id);
      // The stored outcome is read BEFORE the writes, so the run can report how
      // many lines it actually moved. Comparing after the UPDATE would always
      // compare the new values with themselves and report the matched total.
      const prior = await c.query(
        `SELECT id::text AS id, coalesce(match_status,'') AS st, coalesce(matched_2b_key,'') AS k
           FROM purchase_lines WHERE our_gstin = $1 AND period = $2`,
        [normGstin(gstin), period],
      );
      const priorById = new Map(prior.rows.map((r) => [String(r.id), r]));
      let moved = 0;
      for (const r of result.rows) {
        const id = byKey.get(`${r.source_file ?? ''}|${r.source_row}`);
        if (!id) continue;
        const was = priorById.get(String(id));
        if (was && (was.st !== r.status || was.k !== (r.matched_2b_id ?? ''))) moved++;
        await c.query(
          `UPDATE purchase_lines SET
             match_status = $2, match_method = 're-reconcile',
             matched_2b_key = $3, matched_2b_month = $4,
             twob_supplier_gstin = $5, twob_invoice_no = $6, twob_invoice_date = $7,
             twob_taxable_value = $8, twob_itc = $9, itc_availability = $10,
             mismatch_reason = $11, itc_amount = $12,
             taxable_difference = $13, itc_difference = $14,
             suggested_action = $15, reconciled_at = now(), updated_at = now()
           WHERE id = $1`,
          [id, r.status, r.matched_2b_id ?? null, r.matched_2b_month ?? null,
           r.matched_2b_id ? normGstin(r.supplier_gstin) : null,
           r.matched_2b_id ? r.invoice_no : null,
           r.matched_2b_id ? r.invoice_date || null : null,
           r.two_b_taxable ?? null, r.two_b_itc ?? null, r.itc_availability ?? null,
           r.reason ?? null, r.itc,
           r.taxable_difference ?? null, r.itc_difference ?? null, r.action ?? null],
        );
      }
      await c.query(
        `INSERT INTO audit_trail
           (changed_by, action, our_gstin, financial_year, period, reason, details)
         VALUES ($1,'RE-RECONCILE',$2,$3,$4,$5,$6)`,
        [opts.changedBy, normGstin(gstin), fyOf(period), period, opts.reason ?? 'Save & Re-reconcile',
         JSON.stringify({ lines: books.length, twobLines: twob.length, summary: out.after, changed: moved })],
      );
      // Tie the pending corrections to the re-run, so the trail proves the match
      // was actually re-attempted and not merely retyped.
      await c.query(
        'UPDATE recon_corrections SET rerefreshed = true WHERE our_gstin = $1 AND period = $2 AND rerefreshed = false',
        [normGstin(gstin), period],
      );
      await c.query('COMMIT');
      out.changed = moved;
    });

    out.matched = result.summary.matched;
    out.ok = true;
    return out;
  } catch (e: any) {
    out.reason = e.message;
    return out;
  }
}

async function statusesFor(gstin: string, period: string): Promise<Array<{ match_status: string | null }>> {
  return withClient((c) =>
    c.query('SELECT match_status FROM purchase_lines WHERE our_gstin = $1 AND period = $2', [normGstin(gstin), period]),
  ).then((r) => r.rows);
}

function countStatuses(rows: Array<{ match_status: string | null } | ReconRow>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const s = (r as any).match_status ?? (r as any).status ?? 'Unknown';
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// edits
// ---------------------------------------------------------------------------

export const FOLLOW_UP_FIELDS = [
  'remarks',
  'vendor_response',
  'follow_up_date',
  'expected_correction',
  'action_taken',
] as const;
export type FollowUpField = (typeof FOLLOW_UP_FIELDS)[number];

/** A field label is only legal in the correction-history CHECK if it is one of these. */
const CORRECTION_FIELDS = new Set([
  'recon_supplier_gstin',
  'recon_invoice_no',
  'recon_invoice_date',
  'itc_decision',
  'itc_decision_month',
  'decision_reason',
  'return_classification',
  // The e-invoice / e-way bill answers are recorded on the same invoice while
  // it is open, and they are corrections in exactly the same sense: a value a
  // person asserts about a source row, kept with who said it and when. They
  // belong in the correction history beside the other per-invoice answers,
  // otherwise "what did we record, and who changed it" has a hole in it.
  'has_e_invoice',
  'e_invoice_no',
  'has_e_way_bill',
  'e_way_bill_no',
  'e_invoice_required',
  'e_way_bill_required',
  // The company's own registration on the row. Not a recon_* column — it is
  // changed ON the line — but it is a correction in the same sense and gets the
  // same history row, so "what did we change, who changed it" has no hole.
  'our_gstin',
]);

export interface EditResult {
  ok: boolean;
  reason?: string;
  changed: string[];
  locked?: boolean;
  historyId?: number;
}

/** One line's worth of changes, whichever route they arrived by. */
export interface LineEdit {
  lineId: number;
  recon?: Partial<Record<ReconField, string>>;
  itc?: { decision?: string; decisionMonth?: string; reason?: string };
  /** E-invoice / e-way bill answers. Absent = leave whatever is recorded. */
  edocs?: Partial<Record<EDocField, boolean | string | null>>;
  classification?: string;
  followUp?: Partial<Record<FollowUpField, string>>;
}

export interface EditRowResult {
  lineId: number;
  ok: boolean;
  changed: string[];
  reason?: string;
  locked?: boolean;
  /** What each field changed from and to — shown before the change is applied. */
  diff?: Array<{ field: string; from: string; to: string }>;
}

export interface BulkResult {
  ok: boolean;
  reason?: string;
  changedLines: number;
  changedFields: string[];
  rows: EditRowResult[];
}

/**
 * Apply any number of edits to any number of lines, in ONE transaction.
 *
 * Single-line edits from the UI and a 500-row re-upload of an exported report
 * both come through here, so there is exactly one implementation of:
 *
 *   * a locked month refuses the write
 *   * only genuinely changed fields are written, so a re-upload that changed
 *     nothing produces no history and no noise
 *   * every changed field gets an audit row, with who and why, and the
 *     reconciliation and decision fields also get a correction row
 *   * the `book_*` columns are not parameters of any statement below
 *
 * One bad row does not roll back the good ones unless `atomic` is set: the
 * Accounts team uploading 400 rows needs the 380 that are fine to land.
 */
export async function applyEdits(
  edits: LineEdit[],
  opts: { by: string; reason?: string; atomic?: boolean },
): Promise<BulkResult> {
  const out: BulkResult = { ok: true, changedLines: 0, changedFields: [], rows: [] };
  if (!edits.length) return out;

  try {
    await withClient(async (c) => {
      await c.query('BEGIN');

      for (const e of edits) {
        const r: EditRowResult = { lineId: e.lineId, ok: true, changed: [], diff: [] };
        out.rows.push(r);

        const fail = (reason: string, locked = false): void => {
          r.ok = false;
          r.reason = reason;
          if (locked) r.locked = true;
          if (opts.atomic) throw new Error(reason);
        };

        const cur = await c.query('SELECT * FROM purchase_lines WHERE id = $1 FOR UPDATE', [e.lineId]);
        if (!cur.rowCount) {
          fail(`Purchase line ${e.lineId} does not exist.`);
          continue;
        }
        const row = cur.rows[0];

        const lock = await c.query(
          'SELECT locked_by FROM month_locks WHERE is_locked AND our_gstin = $1 AND period = $2',
          [row.our_gstin, row.period],
        );
        if (lock.rowCount) {
          fail(
            `GST month ${labelOf(row.period)} for ${row.our_gstin} is LOCKED (by ${lock.rows[0].locked_by}). ` +
              'Unlock it as admin first.',
            true,
          );
          continue;
        }

        const sets: string[] = [];
        const params: unknown[] = [e.lineId];
        const stampRecon = !!(e.recon && Object.keys(e.recon).length);
        const stampDecision = !!(e.itc && e.itc.decision !== undefined);
        let wroteAnything = false;

        // ---- the three reconciliation fields ---------------------------
        for (const f of RECON_FIELDS) {
          const given = e.recon?.[f];
          if (given === undefined) continue;
          const next = normaliseField(f, given);
          const prev = fieldText(row[f]);
          if (next === prev) continue;
          params.push(next);
          sets.push(`${f} = $${params.length}`);
          wroteAnything = true;
          r.changed.push(f);
          r.diff!.push({ field: f, from: prev, to: next });
        }

        // ---- e-invoice / e-way bill ------------------------------------
        // Recorded by the person reconciling bill-to-bill, because GSTR-2B
        // carries neither figure. A key that is absent is left untouched; a key
        // present with null clears the answer back to "not checked".
        if (e.edocs) {
          for (const f of E_DOC_FIELDS) {
            if (!(f in e.edocs)) continue;
            const next = e.edocs[f];
            if (next === undefined || next === row[f]) continue;
            params.push(next);
            sets.push(`${f} = $${params.length}`);
            wroteAnything = true;
            r.changed.push(f);
            r.diff!.push({
              field: f,
              from: row[f] === null || row[f] === undefined ? '' : String(row[f]),
              to: next === null ? '' : String(next),
            });
          }
        }

        // ---- the ITC decision ------------------------------------------
        if (e.itc) {
          if (e.itc.decision !== undefined) {
            if (!ITC_DECISIONS.includes(e.itc.decision as ItcDecision)) {
              fail(`Unknown ITC decision "${e.itc.decision}". Allowed: ${ITC_DECISIONS.join(', ')}`);
              continue;
            }
            if (e.itc.decision !== row.itc_decision) {
              params.push(e.itc.decision);
              sets.push(`itc_decision = $${params.length}`);
              wroteAnything = true;
              r.changed.push('itc_decision');
              r.diff!.push({ field: 'itc_decision', from: fieldText(row.itc_decision), to: e.itc.decision });
            }
          }
          if (e.itc.decisionMonth !== undefined) {
            const next = e.itc.decisionMonth || null;
            if (next && !/^\d{4}-\d{2}$/.test(next)) {
              fail('ITC decision month must be YYYY-MM (for example 2026-04).');
              continue;
            }
            if (next !== (row.itc_decision_month ?? null)) {
              params.push(next);
              sets.push(`itc_decision_month = $${params.length}`);
              wroteAnything = true;
              r.changed.push('itc_decision_month');
              r.diff!.push({ field: 'itc_decision_month', from: fieldText(row.itc_decision_month), to: next ?? '' });
            }
          }
          if (e.itc.reason !== undefined && e.itc.reason !== (row.decision_reason ?? null)) {
            params.push(e.itc.reason);
            sets.push(`decision_reason = $${params.length}`);
            wroteAnything = true;
            r.changed.push('decision_reason');
            r.diff!.push({ field: 'decision_reason', from: fieldText(row.decision_reason), to: e.itc.reason });
          }
        }

        // ---- the return classification (a separate, human-owned field) --
        if (e.classification) {
          if (!RETURN_CLASSIFICATIONS.includes(e.classification as any)) {
            fail(`Unknown classification "${e.classification}". Allowed: ${RETURN_CLASSIFICATIONS.join(', ')}`);
            continue;
          }
          if (e.classification !== row.return_classification) {
            params.push(e.classification);
            sets.push(`return_classification = $${params.length}`);
            wroteAnything = true;
            r.changed.push('return_classification');
            r.diff!.push({
              field: 'return_classification',
              from: fieldText(row.return_classification),
              to: e.classification,
            });
          }
        }

        // ---- the follow-up notes, which are NOT reconciliation inputs ---
        for (const f of FOLLOW_UP_FIELDS) {
          const given = e.followUp?.[f];
          if (given === undefined) continue;
          const next = f === 'follow_up_date' ? normDate(given) || null : String(given).trim() || null;
          if (next === (row[f] ?? null)) continue;
          params.push(next);
          sets.push(`${f} = $${params.length}`);
          wroteAnything = true;
          r.changed.push(f);
          r.diff!.push({ field: f, from: fieldText(row[f]), to: next ?? '' });
        }

        if (!wroteAnything) continue; // nothing actually changed — write no history

        if (stampRecon) {
          sets.push('recon_edited = true');
          params.push(opts.by);
          sets.push(`recon_edited_by = $${params.length}`);
          params.push(new Date());
          sets.push(`recon_edited_at = $${params.length}`);
        }
        if (stampDecision) {
          params.push(opts.by);
          sets.push(`decision_by = $${params.length}`);
          params.push(new Date());
          sets.push(`decision_at = $${params.length}`);
        }
        sets.push('updated_at = now()');

        await c.query(`UPDATE purchase_lines SET ${sets.join(', ')} WHERE id = $1`, params);

        const why = opts.reason ?? e.itc?.reason ?? null;
        for (const d of r.diff!) {
          if (CORRECTION_FIELDS.has(d.field)) {
            // rerefreshed starts FALSE: an edit is not "re-reconciled" until a
            // re-reconcile has actually run against it. reReconcile() flips it,
            // so the trail never claims a re-run that did not happen.
            await c.query(
              `INSERT INTO recon_corrections
                 (line_id, our_gstin, period, invoice_no, supplier_gstin, field_name,
                  old_value, new_value, reason, changed_by, rerefreshed)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)`,
              [e.lineId, row.our_gstin, row.period, row.recon_invoice_no, row.recon_supplier_gstin,
               d.field, d.from, d.to, why, opts.by],
            );
          }
          await writeAudit(c, {
            changedBy: opts.by,
            action: (RECON_FIELDS as readonly string[]).includes(d.field)
              ? 'EDIT'
              : (E_DOC_FIELDS as readonly string[]).includes(d.field)
                ? 'E DOC'
                : (FOLLOW_UP_FIELDS as readonly string[]).includes(d.field)
                  ? 'FOLLOW-UP'
                  : 'ITC DECISION',
            our_gstin: row.our_gstin,
            period: row.period,
            financialYear: row.financial_year,
            lineId: e.lineId,
            invoiceNo: row.recon_invoice_no,
            supplierGstin: row.recon_supplier_gstin,
            field: d.field,
            oldValue: d.from,
            newValue: d.to,
            reason: why,
            company: null,
          });
        }

        out.changedLines++;
        for (const f of r.changed) if (!out.changedFields.includes(f)) out.changedFields.push(f);
      }

      await c.query('COMMIT');
    });
    return out;
  } catch (e: any) {
    out.ok = false;
    out.reason = e.message;
    return out;
  }
}

/**
 * Save the three editable reconciliation fields and record every change.
 *
 * The correction rows are the audit trail. They are INSERT-only — a later edit
 * adds a row, it never rewrites the previous one (spec §6: history must never be
 * deleted).
 */
export async function updateRecon(
  lineId: number,
  patch: Partial<Record<ReconField, string>>,
  opts: { changedBy: string; reason?: string },
): Promise<EditResult> {
  const out: EditResult = { ok: false, changed: [] };

  if (patch.recon_invoice_date !== undefined && String(patch.recon_invoice_date).trim()) {
    if (!normDate(patch.recon_invoice_date)) {
      out.reason = `Could not read the reconciliation invoice date "${patch.recon_invoice_date}". Use YYYY-MM-DD.`;
      return out;
    }
  }
  if (patch.recon_supplier_gstin !== undefined && String(patch.recon_supplier_gstin).trim()) {
    if (!isValidGstin(patch.recon_supplier_gstin)) {
      out.reason = `"${patch.recon_supplier_gstin}" is not a valid 15-character GSTIN.`;
      return out;
    }
  }

  const bulk = await applyEdits([{ lineId, recon: patch }], { by: opts.changedBy, reason: opts.reason, atomic: true });
  const row = bulk.rows[0];
  out.ok = bulk.ok && !!row?.ok;
  out.changed = row?.changed ?? [];
  out.locked = row?.locked;
  out.reason = bulk.reason ?? row?.reason;
  return out;
}

/**
 * Correct the company's own GSTIN on one purchase line.
 *
 * The register is imported under whichever registration the upload carried. A
 * row that landed under the wrong one is not a data-entry problem the software
 * can ignore: it puts the purchase in the wrong company and unit, and it makes
 * the matcher compare it against the wrong GSTR-2B — either a wrong match or no
 * match at all.
 *
 * So this is a correction ON the line, not an override beside it, and it obeys
 * the same rules as every other correction:
 *
 *   * both the month being left and the month being joined must be OPEN. The
 *     database trigger only checks the NEW value, so leaving a locked month
 *     would otherwise slip through;
 *   * the new GSTIN must already exist in the GSTIN master, because that is
 *     where the company and unit come from — a GSTIN nobody registered would
 *     leave the line attached to nothing;
 *   * the deterministic `line_key` is recomputed, so a later re-run of the same
 *     file still lands on this row instead of creating a twin;
 *   * nothing is written when the value is unchanged.
 *
 * The caller re-reconciles BOTH months afterwards — leaving one and joining
 * another are two different match results.
 */
export async function setOurGstin(
  lineId: number,
  value: string,
  opts: { changedBy: string; reason?: string },
): Promise<EditResult & { movedFrom?: string; movedTo?: string }> {
  const out: EditResult & { movedFrom?: string; movedTo?: string } = { ok: false, changed: [] };
  const next = normGstin(value);

  if (!isValidGstin(next)) {
    out.reason = `"${value}" is not a valid 15-character GSTIN.`;
    return out;
  }

  try {
    await withClient(async (c) => {
      await c.query('BEGIN');

      const cur = await c.query('SELECT * FROM purchase_lines WHERE id = $1 FOR UPDATE', [lineId]);
      if (!cur.rowCount) {
        out.reason = `Purchase line ${lineId} does not exist.`;
        await c.query('ROLLBACK');
        return;
      }
      const row = cur.rows[0];
      const from = normGstin(row.our_gstin);

      if (from === next) {
        out.ok = true;
        await c.query('ROLLBACK');
        return;
      }

      // Both months. The trigger looks only at NEW.our_gstin, so the month the
      // line is LEAVING has to be checked here or a locked month could be
      // quietly emptied.
      const locks = await c.query(
        `SELECT our_gstin, locked_by FROM month_locks
          WHERE is_locked AND period = $1 AND our_gstin IN ($2, $3)`,
        [row.period, from, next],
      );
      if (locks.rowCount) {
        const which = locks.rows.map((l: any) => `${l.our_gstin}:${row.period}`).join(', ');
        out.locked = true;
        out.reason =
          `GST month ${row.period} is LOCKED for ${which}. Unlock it (as admin) before moving the line.`;
        await c.query('ROLLBACK');
        return;
      }

      const g = await c.query(
        'SELECT id, company_id FROM gstins WHERE UPPER(gstin_number) = $1 LIMIT 1',
        [next],
      );
      if (!g.rowCount) {
        out.reason =
          `${next} is not in the GSTIN master, so the line cannot be attached to a company or unit. ` +
          'Add the registration in Masters first.';
        await c.query('ROLLBACK');
        return;
      }

      const key = lineKeyOf({
        our_gstin: next,
        period: row.period,
        source_file: row.source_file ?? undefined,
        source_row: row.source_row ?? undefined,
      });

      await c.query(
        `UPDATE purchase_lines
            SET our_gstin = $2, line_key = $3, gstin_id = $4, company_id = $5, updated_at = now()
          WHERE id = $1`,
        [lineId, next, key, g.rows[0].id, g.rows[0].company_id],
      );

      await c.query(
        `INSERT INTO recon_corrections
           (line_id, our_gstin, period, invoice_no, supplier_gstin, field_name,
            old_value, new_value, reason, changed_by, rerefreshed)
         VALUES ($1,$2,$3,$4,$5,'our_gstin',$6,$7,$8,$9,false)`,
        [lineId, from, row.period, row.recon_invoice_no, row.recon_supplier_gstin,
         from, next, opts.reason ?? null, opts.changedBy],
      );

      await writeAudit(c, {
        changedBy: opts.changedBy,
        action: 'GSTIN CORRECTION',
        our_gstin: from,
        period: row.period,
        financialYear: row.financial_year,
        lineId,
        invoiceNo: row.recon_invoice_no,
        supplierGstin: row.recon_supplier_gstin,
        field: 'our_gstin',
        oldValue: from,
        newValue: next,
        reason: opts.reason ?? null,
        company: null,
      });

      await c.query('COMMIT');

      out.ok = true;
      out.changed = ['our_gstin'];
      out.movedFrom = from;
      out.movedTo = next;
    });
    return out;
  } catch (e: any) {
    out.ok = false;
    out.reason =
      /duplicate key/i.test(e.message)
        ? 'Another purchase line already occupies this GSTIN, month and source row. Adjust the register instead.'
        : e.message;
    return out;
  }
}

export async function setItcDecision(
  lineId: number,
  patch: { decision?: string; decisionMonth?: string; reason?: string },
  opts: { changedBy: string },
): Promise<EditResult> {
  const out: EditResult = { ok: false, changed: [] };
  if (patch.decision !== undefined && !ITC_DECISIONS.includes(patch.decision as ItcDecision)) {
    out.reason = `Unknown ITC decision "${patch.decision}". Allowed: ${ITC_DECISIONS.join(', ')}`;
    return out;
  }
  if (patch.decisionMonth !== undefined && patch.decisionMonth && !/^\d{4}-\d{2}$/.test(patch.decisionMonth)) {
    out.reason = 'ITC decision month must be YYYY-MM (for example 2026-04).';
    return out;
  }
  const bulk = await applyEdits([{ lineId, itc: patch }], { by: opts.changedBy, reason: patch.reason, atomic: true });
  const row = bulk.rows[0];
  out.ok = bulk.ok && !!row?.ok;
  out.changed = row?.changed ?? [];
  out.locked = row?.locked;
  out.reason = bulk.reason ?? row?.reason;
  return out;
}

export async function setReturnClassification(
  lineId: number,
  value: string,
  opts: { changedBy: string; reason?: string },
): Promise<EditResult> {
  const out: EditResult = { ok: false, changed: [] };
  if (!RETURN_CLASSIFICATIONS.includes(value as any)) {
    out.reason = `Unknown classification "${value}". Allowed: ${RETURN_CLASSIFICATIONS.join(', ')}`;
    return out;
  }
  const bulk = await applyEdits([{ lineId, classification: value }], {
    by: opts.changedBy,
    reason: opts.reason,
    atomic: true,
  });
  const row = bulk.rows[0];
  out.ok = bulk.ok && !!row?.ok;
  out.changed = row?.changed ?? [];
  out.locked = row?.locked;
  out.reason = bulk.reason ?? row?.reason;
  return out;
}

/** Attach the vendor follow-up notes to one line (the Export → work → Upload loop). */
export async function setFollowUp(
  lineId: number,
  patch: Partial<Record<FollowUpField, string>>,
  opts: { changedBy: string },
): Promise<EditResult> {
  const out: EditResult = { ok: false, changed: [] };
  const bulk = await applyEdits([{ lineId, followUp: patch }], { by: opts.changedBy, atomic: true });
  const row = bulk.rows[0];
  out.ok = bulk.ok && !!row?.ok;
  out.changed = row?.changed ?? [];
  out.locked = row?.locked;
  out.reason = bulk.reason ?? row?.reason;
  return out;
}

function normaliseField(f: ReconField, v: string): string {
  const s = String(v ?? '').trim();
  if (f === 'recon_supplier_gstin') return normGstin(s);
  if (f === 'recon_invoice_date') return normDate(s);
  return s;
}

function fieldText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return iso(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// month lock
// ---------------------------------------------------------------------------

export async function isLocked(gstin: string, period: string): Promise<{ locked: boolean; by?: string; at?: string }> {
  const r = await withClient((c) =>
    c.query('SELECT locked_by, locked_at FROM month_locks WHERE our_gstin = $1 AND period = $2 AND is_locked', [
      normGstin(gstin), period,
    ]),
  );
  return r.rowCount ? { locked: true, by: r.rows[0].locked_by, at: r.rows[0].locked_at } : { locked: false };
}

export async function lockMonth(
  gstin: string,
  period: string,
  opts: { by: string; reason?: string },
): Promise<EditResult> {
  const out: EditResult = { ok: false, changed: [] };
  if (!/^\d{4}-\d{2}$/.test(period)) {
    out.reason = 'Month must be YYYY-MM.';
    return out;
  }
  try {
    await withClient(async (c) => {
      await c.query(
        `INSERT INTO month_locks (our_gstin, financial_year, period, is_locked, locked_by, reason)
         VALUES ($1,$2,$3,true,$4,$5)
         ON CONFLICT (our_gstin, financial_year, period) DO UPDATE
           SET is_locked = true, locked_by = EXCLUDED.locked_by, locked_at = now(),
               unlocked_by = NULL, unlocked_at = NULL, updated_at = now()`,
        [normGstin(gstin), fyOf(period), period, opts.by, opts.reason ?? null],
      );
      await writeAudit(c, {
        changedBy: opts.by, action: 'LOCK', our_gstin: normGstin(gstin), period,
        financialYear: fyOf(period), field: 'is_locked', oldValue: 'false', newValue: 'true',
        reason: opts.reason, company: null,
      });
    });
    out.ok = true;
    out.changed = ['is_locked'];
    return out;
  } catch (e: any) {
    out.reason = e.message;
    return out;
  }
}

/**
 * Unlock. Always requires an explicit admin confirmation from the caller, and
 * is always written to the audit trail with who and why.
 */
export async function unlockMonth(
  gstin: string,
  period: string,
  opts: { by: string; reason?: string; adminConfirmed: boolean },
): Promise<EditResult> {
  const out: EditResult = { ok: false, changed: [] };
  if (!opts.adminConfirmed) {
    out.reason = 'Unlock needs an explicit admin confirmation.';
    return out;
  }
  if (!opts.reason || opts.reason.trim().length < 3) {
    out.reason = 'Unlock needs a reason — it goes into the audit trail permanently.';
    return out;
  }
  try {
    await withClient(async (c) => {
      const r = await c.query(
        `UPDATE month_locks SET is_locked = false, unlocked_by = $3, unlocked_at = now(),
            unlock_reason = $4, updated_at = now()
         WHERE our_gstin = $1 AND period = $2 AND is_locked`,
        [normGstin(gstin), period, opts.by, opts.reason],
      );
      if (!r.rowCount) throw new Error('That month is not locked.');
      await writeAudit(c, {
        changedBy: opts.by, action: 'UNLOCK', our_gstin: normGstin(gstin), period,
        financialYear: fyOf(period), field: 'is_locked', oldValue: 'true', newValue: 'false',
        reason: opts.reason, company: null,
      });
    });
    out.ok = true;
    out.changed = ['is_locked'];
    return out;
  } catch (e: any) {
    out.reason = e.message;
    return out;
  }
}

export async function listLocks() {
  return withClient((c) =>
    c.query(
      `SELECT our_gstin, financial_year, period, is_locked, locked_by, locked_at,
              unlocked_by, unlocked_at, unlock_reason
         FROM month_locks ORDER BY period DESC, our_gstin`,
    ),
  ).then((r) => r.rows);
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

/** The ITC working (spec §14) — one row per purchase line, all decisions shown. */
export async function itcWorking(f: LineFilters) {
  const params: unknown[] = [];
  const where = lineWhere(f, params);
  const r = await withClient((c) =>
    c.query(
      `SELECT id, our_gstin, period, party_name, unit_name AS unitName,
              book_reference_no AS bookReferenceNo,
              has_e_invoice, e_invoice_no, has_e_way_bill, e_way_bill_no,
              book_supplier_gstin AS bookGstin, book_invoice_no AS bookInvoiceNo,
              book_invoice_date AS bookInvoiceDate,
              recon_supplier_gstin AS reconGstin, recon_invoice_no AS reconInvoiceNo,
              recon_invoice_date AS reconInvoiceDate, recon_edited AS edited,
              book_taxable_value AS taxable, book_igst AS igst, book_cgst AS cgst,
              book_sgst AS sgst, book_cess AS cess,
              match_status, matched_2b_key, matched_2b_month,
              twob_taxable_value AS twoBTaxable, twob_itc AS twoBItc, itc_availability,
              itc_decision, itc_decision_month, decision_by, decision_at, decision_reason,
              return_classification, itc_amount, mismatch_reason
         FROM purchase_lines ${where}
         ORDER BY our_gstin, period, party_name, book_invoice_no
         LIMIT ${Math.min(f.limit ?? 20000, 50000)}`,
      params,
    ),
  );
  return r.rows.map((x: any) => ({
    ...x,
    itc: r2(Number(x.igst) + Number(x.cgst) + Number(x.sgst) + Number(x.cess)),
    periodLabel: labelOf(x.period),
    twoBMonthLabel: x.matched_2b_month ? labelOf(x.matched_2b_month) : '',
    twoBMatched: !!x.matched_2b_key,
  }));
}

export interface Dashboard {
  lines: number;
  twobLines: number;
  itcMatched: number;
  itcPending: number;
  byStatus: Record<string, number>;
  byDecision: Record<string, number>;
  byClassification: Record<string, number>;
  by2bMonth: Array<{ month: string; label: string; lines: number; itc: number }>;
  gstins: string[];
  periods: string[];
  locked: Array<{ our_gstin: string; period: string }>;
  /** Gross (invoice + debit note) and credit-note reduction, kept apart from net. */
  taxableGross?: number;
  taxableCredit?: number;
  taxableNet?: number;
  invoiceDocs?: number;
  debitDocs?: number;
  creditDocs?: number;
}

export async function dashboard(f: { gstin?: string; period?: string } = {}): Promise<Dashboard> {
  const params: unknown[] = [];
  const w: string[] = [];
  if (f.gstin) { params.push(normGstin(f.gstin)); w.push(`our_gstin = $${params.length}`); }
  if (f.period) { params.push(f.period); w.push(`period = $${params.length}`); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';

  return withClient(async (c) => {
    const group = async (col: string) => {
      const r = await c.query(`SELECT ${col} k, count(*)::int n FROM purchase_lines ${where} GROUP BY ${col}`, params);
      const out: Record<string, number> = {};
      for (const row of r.rows) out[row.k ?? 'Unknown'] = row.n;
      return out;
    };
    const totals = await c.query(
      `SELECT count(*)::int lines,
              count(*) FILTER (WHERE matched_2b_key IS NOT NULL)::int matched,
              count(*) FILTER (WHERE itc_decision = 'Pending Review')::int pending,
              coalesce(sum(book_igst + book_cgst + book_sgst + book_cess) FILTER (WHERE matched_2b_key IS NOT NULL),0)::numeric itc_matched,
              coalesce(sum(book_igst + book_cgst + book_sgst + book_cess) FILTER (WHERE itc_decision = 'Claim'),0)::numeric itc_claim,
              count(*) FILTER (WHERE book_document_type = 'Credit Note')::int credit_docs,
              count(*) FILTER (WHERE book_document_type = 'Debit Note')::int debit_docs,
              count(*) FILTER (WHERE book_document_type = 'Tax Invoice')::int invoice_docs,
              coalesce(sum(CASE WHEN book_document_type = 'Credit Note' THEN 0
                                ELSE book_taxable_value END),0)::numeric taxable_gross,
              coalesce(sum(CASE WHEN book_document_type = 'Credit Note'
                                THEN ABS(book_taxable_value) ELSE 0 END),0)::numeric taxable_credit,
              coalesce(sum(book_taxable_value),0)::numeric taxable_net
         FROM purchase_lines ${where}`,
      params,
    );
    const twobCount = f.gstin
      ? await c.query('SELECT count(*)::int n FROM gstr2b_lines WHERE our_gstin = $1', [normGstin(f.gstin)])
      : await c.query('SELECT count(*)::int n FROM gstr2b_lines');
    const m = await c.query(
      `SELECT matched_2b_month k, count(*)::int n,
              coalesce(sum(book_igst + book_cgst + book_sgst + book_cess),0)::numeric itc
         FROM purchase_lines ${where} ${where ? 'AND' : 'WHERE'} matched_2b_month IS NOT NULL
        GROUP BY matched_2b_month ORDER BY matched_2b_month`,
      params,
    );
    const gs = await c.query(
      `SELECT DISTINCT our_gstin FROM purchase_lines ${where} ORDER BY 1`,
      params,
    );
    const ps = await c.query(
      `SELECT DISTINCT period FROM purchase_lines ${where} ORDER BY 1`,
      params,
    );
    const lk = await c.query('SELECT our_gstin, period FROM month_locks WHERE is_locked');

    const t = totals.rows[0];
    return {
      lines: t.lines,
      twobLines: twobCount.rows[0].n,
      itcMatched: Number(t.itc_matched),
      itcPending: t.pending,
      itcClaim: Number(t.itc_claim),
      byStatus: await group('match_status'),
      byDecision: await group('itc_decision'),
      byClassification: await group('return_classification'),
      by2bMonth: m.rows.map((r: any) => ({ month: r.k, label: labelOf(r.k), lines: r.n, itc: Number(r.itc) })),
      gstins: gs.rows.map((r: any) => r.our_gstin),
      periods: ps.rows.map((r: any) => r.period),
      locked: lk.rows.map((r: any) => ({ our_gstin: r.our_gstin, period: r.period })),
      taxableGross: Number(t.taxable_gross),
      taxableCredit: Number(t.taxable_credit),
      taxableNet: Number(t.taxable_net),
      invoiceDocs: t.invoice_docs,
      debitDocs: t.debit_docs,
      creditDocs: t.credit_docs,
    } as Dashboard & { itcClaim: number };
  });
}

/** 2B file registry (spec §9) plus which months are still missing. */
export async function twoBRegistry() {
  const rows = await withClient((c) =>
    c.query(
      `SELECT f.*, c.name AS company FROM gstr2b_files f
         LEFT JOIN companies c ON c.id = f.company_id
        ORDER BY f.our_gstin, f.twob_month`,
    ),
  ).then((r) => r.rows);

  const uploads = await withClient((c) =>
    c.query(
      `SELECT our_gstin, twob_month, count(*)::int files, max(uploaded_at) last_upload
         FROM gstr2b_files GROUP BY 1,2 ORDER BY 1,2`,
    ),
  ).then((r) => r.rows);

  const uploadsByKey = new Map(uploads.map((u: any) => [`${u.our_gstin}|${u.twob_month}`, u]));
  return rows.map((f: any) => ({
    ...f,
    twob_month_label: labelOf(f.twob_month),
    last_upload: uploadsByKey.get(`${f.our_gstin}|${f.twob_month}`)?.last_upload ?? f.uploaded_at,
  }));
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export interface AuditFilters {
  gstin?: string;
  period?: string;
  invoice?: string;
  field?: string;
  by?: string;
  from?: string;
  to?: string;
  lineId?: number;
  limit?: number;
}

export async function auditTrail(f: AuditFilters) {
  const params: unknown[] = [];
  const w: string[] = [];
  if (f.gstin) { params.push(normGstin(f.gstin)); w.push(`our_gstin = $${params.length}`); }
  if (f.period) { params.push(f.period); w.push(`period = $${params.length}`); }
  if (f.invoice) { params.push(`%${f.invoice}%`); w.push(`LOWER(COALESCE(invoice_no,'')) LIKE $${params.length}`); }
  if (f.field) { params.push(f.field); w.push(`field_name = $${params.length}`); }
  if (f.by) { params.push(f.by); w.push(`LOWER(changed_by) LIKE $${params.length.toString()}`); }
  if (f.lineId) { params.push(f.lineId); w.push(`line_id = $${params.length}`); }
  if (f.from) { params.push(f.from); w.push(`ts >= $${params.length}::timestamptz`); }
  if (f.to) { params.push(f.to); w.push(`ts <= $${params.length}::timestamptz`); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  return withClient(async (c) => {
    const total = await c.query(`SELECT count(*)::int n FROM audit_trail ${where}`, params);
    const r = await c.query(
      `SELECT * FROM audit_trail ${where} ORDER BY ts DESC, id DESC LIMIT ${Math.min(f.limit ?? 300, 5000)}`,
      params,
    );
    return { total: total.rows[0].n, rows: r.rows };
  });
}

async function writeAudit(
  c: Client,
  a: {
    changedBy: string; action: string; our_gstin?: string | null; period?: string | null;
    financialYear?: string | null; lineId?: number | null; invoiceNo?: string | null;
    supplierGstin?: string | null; field?: string | null; oldValue?: string | null;
    newValue?: string | null; reason?: string | null; company?: string | null;
  },
) {
  await c.query(
    `INSERT INTO audit_trail
       (changed_by, action, our_gstin, company, financial_year, period, line_id,
        invoice_no, supplier_gstin, field_name, old_value, new_value, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [a.changedBy, a.action, a.our_gstin ?? null, a.company ?? null, a.financialYear ?? null,
     a.period ?? null, a.lineId ?? null, a.invoiceNo ?? null, a.supplierGstin ?? null,
     a.field ?? null, a.oldValue ?? null, a.newValue ?? null, a.reason ?? null],
  );
}

// ---------------------------------------------------------------------------
// pasted purchase register
// ---------------------------------------------------------------------------

export interface PasteImportResult {
  ok: boolean;
  reason?: string;
  lines: number;
  skipped: Array<{ row: number; reason: string }>;
  unmappedHeaders: string[];
  headerRowIndex: number;
  /** First (GSTIN, period) of the batch — kept for backward compatibility. */
  key: { gstin: string; period: string };
  /**
   * EVERY (GSTIN, period) the batch touched, in file order.
   *
   * One register file routinely carries several months, and a batch can carry
   * several GSTINs. Reporting only `key` made the other months look imported
   * but unreconciled — the rows were saved, yet nothing reconciled them and no
   * lock was checked.
   */
  keys: Array<{ gstin: string; period: string; lines: number }>;
  reReconcile: ReReconcileResult | null;
  /** One entry per month in `keys`, so the caller can report each month. */
  reReconcileAll: ReReconcileResult[];
  /** Months that were saved but could not be reconciled (e.g. locked). */
  blocked: Array<{ gstin: string; period: string; reason: string }>;
  warnings: string[];
}

/**
 * Save a paste into `purchase_lines` and reconcile it immediately.
 *
 * A pasted block becomes its own source file (`paste:<timestamp>`), so its
 * `line_key`s are stable for that paste and a re-paste of the same data lands on
 * the same rows rather than duplicating them.
 */
export async function importPastedPurchase(
  bills: PurchaseBill[],
  pasteId: string,
  opts: { by: string },
): Promise<PasteImportResult> {
  const out: PasteImportResult = {
    ok: false, lines: 0, skipped: [], unmappedHeaders: [], headerRowIndex: 0,
    key: { gstin: '', period: '' }, keys: [], reReconcile: null, reReconcileAll: [],
    blocked: [], warnings: [],
  };
  const g = bills[0];
  if (!g) {
    out.reason = 'No usable rows were found in the pasted data.';
    return out;
  }

  // ---- every month/GSTIN in the batch, not just the first row ----------------
  // A purchase register is often one file per quarter. Keying the whole import
  // off `bills[0]` meant the second and third month were written to
  // `purchase_lines` but never lock-checked and never reconciled, so those
  // months silently stayed "Data Imported" with no matches. Group first, then
  // treat each (GSTIN, period) as its own unit of work.
  const groups = new Map<string, { gstin: string; period: string; lines: number }>();
  for (const b of bills) {
    const gstin = normGstin(b.our_gstin);
    const period = b.period;
    if (!gstin || !period) continue;
    const k = `${gstin}|${period}`;
    const cur = groups.get(k);
    if (cur) cur.lines += 1;
    else groups.set(k, { gstin, period, lines: 1 });
  }
  out.keys = [...groups.values()];
  out.key = { gstin: normGstin(g.our_gstin), period: g.period };

  // A locked month anywhere in the batch stops the whole import: half a
  // register in the database is worse than none, because the operator cannot
  // tell which rows are missing.
  const lockedRows = out.keys.length
    ? await withClient((c) =>
        c.query(
          `SELECT our_gstin, period FROM month_locks
            WHERE is_locked AND (our_gstin, period) IN (
              SELECT * FROM unnest($1::text[], $2::text[])
            )`,
          [out.keys.map((k) => k.gstin), out.keys.map((k) => k.period)],
        ).then((r) => r.rows as Array<{ our_gstin: string; period: string }>),
      )
    : [];
  if (lockedRows.length) {
    const first = lockedRows[0];
    out.reason =
      lockedRows.length === 1
        ? `GST month ${labelOf(first.period)} for ${first.our_gstin} is LOCKED. Unlock it as admin first.`
        : `${lockedRows.length} months in this batch are LOCKED ` +
          `(${lockedRows.slice(0, 4).map((r) => `${labelOf(r.period)} ${r.our_gstin}`).join(', ')}` +
          `${lockedRows.length > 4 ? ', …' : ''}). Unlock them as admin first.`;
    return out;
  }

  const gmap = await loadGstinMap();
  await withClient(async (c) => {
    const values: unknown[][] = [];
    for (const b of bills) {
      const source = `${pasteId}`;
      const key = lineKeyOf({ ...b, source_file: source });
      values.push(
        lineParams(key, { ...b, source_file: source }, gmap.get(normGstin(b.our_gstin)), undefined, undefined, 'paste'),
      );
    }
    for (const chunk of chunkRows(values, PURCHASE_COL_COUNT)) {
      await c.query(insertPurchaseSql(chunk.length), chunk.flat());
    }
    // One audit row per (GSTIN, period): the audit trail is read month-wise, so
    // a single row tagged with only the first month hid the rest.
    for (const k of out.keys.length ? out.keys : [out.key]) {
      await writeAudit(c, {
        changedBy: opts.by, action: 'PASTE IMPORT', our_gstin: k.gstin, period: k.period,
        financialYear: fyOf(k.period), field: 'purchase_lines',
        newValue: String('lines' in k ? k.lines : bills.length),
        reason: `purchase register import ${pasteId}`, company: null,
      });
    }
    out.lines = bills.length;
  });

  out.ok = true;
  // Reconcile every month the batch touched. A failure in one month must not
  // hide the others, so each result is recorded and reported separately.
  const targets = out.keys.length ? out.keys : [out.key];
  for (const k of targets) {
    const res = await reReconcile(k.gstin, k.period, {
      changedBy: opts.by,
      reason: 'Purchase register imported — reconciled immediately',
    });
    out.reReconcileAll.push(res);
    if (!res.ok) {
      out.blocked.push({ gstin: k.gstin, period: k.period, reason: res.reason || 'reconciliation failed' });
    }
  }
  out.reReconcile = out.reReconcileAll[0] ?? null;
  return out;
}

/** Build a recon result map keyed `GSTIN|period` for persistence. */
export function reconMapOf(
  entries: Array<{ gstin: string; period: string; result: ReconResult }>,
): Map<string, ReconResult> {
  const m = new Map<string, ReconResult>();
  for (const e of entries) m.set(bundleKey(e.gstin, e.period), e.result);
  return m;
}

// ---------------------------------------------------------------------------
// GST CONTROL CENTRE — month control strip (read-only, additive)
// ---------------------------------------------------------------------------

/**
 * The lifecycle a GST month walks through, in order. The Control Centre shows
 * exactly one of these per month; the order matters, so it is a fixed tuple.
 */
export const MONTH_STATUS = [
  'Not Started',
  'Data Imported',
  'Reconciliation Pending',
  'Under Review',
  'Ready for Filing',
  'Filed',
  'Locked',
] as const;
export type MonthStatus = (typeof MONTH_STATUS)[number];

export interface MonthControlRow {
  period: string;
  label: string;
  fy: string;
  /** purchase book lines in this GST month */
  lines: number;
  taxable: number;
  purchaseGst: number;
  matched: number;
  /** GST on the lines that did match 2B — the ITC the portal allows */
  matchedItc: number;
  missing: number;
  mismatch: number;
  duplicate: number;
  blocked: number;
  /** lines where a human ITC decision is still outstanding */
  pendingDecision: number;
  claimed: number;
  claimedAmt: number;
  /** lines still sitting in 2B that no supplier query has been raised for */
  followUp: number;
  twobFiles: number;
  twobRecords: number;
  locked: boolean;
  filed1: boolean;
  filed3b: boolean;
  status: MonthStatus;
}

/** '2026-04' -> '2026-27'. April starts the FY; May..Mar belong to the next one. */
export function fyLabelOf(period: string): string {
  // This used to bail out on `month < 4` before the January branch below it
  // could ever run, so every Jan/Feb/Mar month carried an EMPTY financial
  // year: fyOptionsOf() then dropped that year from the month picker, and a
  // report for a March month printed a blank FY column. fyOf() is the one
  // rule — delegate to it instead of keeping a second copy that can drift.
  return fyOf(period);
}

/** Filing tables store the period without the dash ('202604'); normalise both sides. */
function barePeriod(p: unknown): string {
  return String(p ?? '').replace(/\D/g, '');
}

/**
 * One row per GST month for the Control Centre strip. Read-only: this derives
 * the picture the dashboard shows and never writes.
 */
export async function monthControl(f: { gstin?: string } = {}): Promise<MonthControlRow[]> {
  const params: unknown[] = [];
  const w: string[] = [];
  if (f.gstin) { params.push(normGstin(f.gstin)); w.push(`our_gstin = $${params.length}`); }
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';

  return withClient(async (c) => {
    const lines = await c.query(
      `SELECT period,
              count(*)::int lines,
              coalesce(sum(book_taxable_value),0)::numeric taxable,
              coalesce(sum(book_igst + book_cgst + book_sgst + book_cess),0)::numeric purchase_gst,
              count(*) FILTER (WHERE matched_2b_key IS NOT NULL)::int matched,
              coalesce(sum(book_igst + book_cgst + book_sgst + book_cess)
                       FILTER (WHERE matched_2b_key IS NOT NULL),0)::numeric matched_itc,
              count(*) FILTER (WHERE match_status = 'Missing in 2B')::int missing,
              count(*) FILTER (WHERE match_status = 'Amount Mismatch')::int mismatch,
              count(*) FILTER (WHERE match_status = 'Duplicate')::int duplicate,
              count(*) FILTER (WHERE match_status = 'ITC Blocked')::int blocked,
              count(*) FILTER (WHERE itc_decision = 'Pending Review')::int pending_decision,
              count(*) FILTER (WHERE itc_decision = 'Claim')::int claimed,
              coalesce(sum(book_igst + book_cgst + book_sgst + book_cess)
                       FILTER (WHERE itc_decision = 'Claim'),0)::numeric claimed_amt,
              count(*) FILTER (WHERE match_status <> 'Matched'
                               AND (follow_up_date IS NULL OR action_taken IS NULL))::int follow_up
         FROM purchase_lines ${where}
        GROUP BY period ORDER BY period`,
      params,
    );

    const fparams: unknown[] = [];
    const fw: string[] = [];
    if (f.gstin) { fparams.push(normGstin(f.gstin)); fw.push(`our_gstin = $${fparams.length}`); }
    const fWhere = fw.length ? `WHERE ${fw.join(' AND ')}` : '';

    const files = await c.query(
      `SELECT twob_month period, count(*)::int files, coalesce(sum(record_count),0)::int records
         FROM gstr2b_files ${fWhere} GROUP BY twob_month`,
      fparams,
    );
    const locks = await c.query(`SELECT period, bool_or(is_locked) locked FROM month_locks ${fWhere} GROUP BY period`, fparams);

    // gstr1/gstr3b filings key on gstin_id, not our_gstin — resolve through gstins.
    const flParams: unknown[] = [];
    const flWhere = f.gstin
      ? 'WHERE gstin_id = (SELECT id FROM gstins WHERE gstin_number = $1)'
      : '';
    if (f.gstin) flParams.push(normGstin(f.gstin));
    const f1 = await c.query(`SELECT period, count(*)::int n FROM gstr1_filings ${flWhere} GROUP BY period`, flParams);
    const f3 = await c.query(`SELECT period, count(*)::int n FROM gstr3b_filings ${flWhere} GROUP BY period`, flParams);

    // Filing tables may carry '202604' where purchase_lines carries '2026-04'.
    const filingSet = (rows: any[]): Set<string> => new Set(rows.map((r) => barePeriod(r.period)));
    const filed1 = filingSet(f1.rows);
    const filed3b = filingSet(f3.rows);

    const twob = new Map<string, { files: number; records: number }>();
    for (const r of files.rows as any[]) twob.set(r.period, { files: r.files, records: r.records });
    const lockMap = new Map<string, boolean>();
    for (const r of locks.rows as any[]) lockMap.set(r.period, !!r.locked);

    const out: MonthControlRow[] = lines.rows.map((r: any) => {
      const t = twob.get(r.period) || { files: 0, records: 0 };
      const locked = lockMap.get(r.period) === true;
      const open = r.missing + r.mismatch + r.duplicate;
      let status: MonthStatus;
      if (locked) status = 'Locked';
      else if (!r.lines && !t.files) status = 'Not Started';
      else if (barePeriod(r.period) && (filed1.has(barePeriod(r.period)) || filed3b.has(barePeriod(r.period)))) status = 'Filed';
      else if (!r.lines) status = 'Data Imported';
      else if (r.pending_decision > 0) status = 'Under Review';
      else if (open > 0 || !t.files) status = 'Reconciliation Pending';
      else if (r.blocked > 0) status = 'Reconciliation Pending';
      else status = 'Ready for Filing';

      return {
        period: r.period,
        label: labelOf(r.period),
        fy: fyLabelOf(r.period),
        lines: r.lines,
        taxable: Number(r.taxable),
        purchaseGst: Number(r.purchase_gst),
        matched: r.matched,
        matchedItc: Number(r.matched_itc),
        missing: r.missing,
        mismatch: r.mismatch,
        duplicate: r.duplicate,
        blocked: r.blocked,
        pendingDecision: r.pending_decision,
        claimed: r.claimed,
        claimedAmt: Number(r.claimed_amt),
        followUp: r.follow_up,
        twobFiles: t.files,
        twobRecords: t.records,
        locked,
        filed1: filed1.has(barePeriod(r.period)),
        filed3b: filed3b.has(barePeriod(r.period)),
        status,
      };
    });

    // Months that only exist as a 2B upload (books never imported) must still
    // appear, or "Not Started" would be invisible exactly when it matters.
    for (const [period, t] of twob) {
      if (out.some((x) => x.period === period)) continue;
      const locked = lockMap.get(period) === true;
      out.push({
        period, label: labelOf(period), fy: fyLabelOf(period),
        lines: 0, taxable: 0, purchaseGst: 0, matched: 0, matchedItc: 0, missing: 0, mismatch: 0,
        duplicate: 0, blocked: 0, pendingDecision: 0, claimed: 0, claimedAmt: 0,
        followUp: 0, twobFiles: t.files, twobRecords: t.records, locked,
        filed1: filed1.has(barePeriod(period)), filed3b: filed3b.has(barePeriod(period)),
        status: locked ? 'Locked' : 'Data Imported',
      });
    }

    out.sort((a, b) => a.period.localeCompare(b.period));
    return out;
  });
}

/** The distinct financial years present, newest last. */
export function fyOptionsOf(rows: MonthControlRow[]): string[] {
  return [...new Set(rows.map((r) => r.fy).filter(Boolean))].sort();
}

// ---------------------------------------------------------------------------
// USERS — the accounts team (read-only here; login arrives in a later phase)
// ---------------------------------------------------------------------------

export interface AppUser {
  id: number;
  username: string;
  displayName: string;
  email: string;
  status: string;
  roles: string[];
  /** The owner of the system — the only account that may unlock a month. */
  isMaster: boolean;
}

export const MASTER_ROLE = 'Master Administrator';

/**
 * Everyone who can be attributed in the audit trail. Read-only: user
 * management is a later phase, so this only lists what migration 07 seeded.
 */
export async function listUsers(): Promise<AppUser[]> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT u.id, u.username, u.display_name, u.email, u.status,
              coalesce(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
        WHERE u.status <> 'inactive'
        GROUP BY u.id, u.username, u.display_name, u.email, u.status
        ORDER BY (u.username = 'master') DESC, u.id`,
    );
    return r.rows.map((x: any) => ({
      id: x.id,
      username: x.username,
      displayName: x.display_name || x.username,
      email: x.email,
      status: x.status,
      roles: x.roles as string[],
      isMaster: (x.roles as string[]).includes(MASTER_ROLE),
    }));
  });
}
