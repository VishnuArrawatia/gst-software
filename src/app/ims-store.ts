/**
 * GST ERP — Independent IMS Database Store, Workflow, Dashboard, 17 Reports & Combined View
 * (Master Prompt Parts 6, 7, 8, 9, 10, 12).
 *
 * Strictly independent from GSTR-2B! Never modifies `purchase_lines` or `gstr2b_lines`.
 * Original `ims_documents` rows are enforced immutable by DB trigger `trg_ims_doc_immutable`.
 */

import crypto from 'node:crypto';
import XLSX from 'xlsx';
import {
  fyOf,
  isoDate,
  normDocType,
  normGstin,
  normInvoice,
  r2,
  taxOf,
  type DocType,
} from '../engine/core';
import { expandSelectedPeriods } from '../engine/gstr2b-excel';
import {
  imsFingerprintOf,
  parseImsFilesBatch,
  type ImsBatchPreview,
} from '../engine/ims-import';
import {
  IMS_ACTIONS,
  IMS_WORKFLOW_STATES,
  internalKeyOf,
  reconcileImsVsBooks,
  recommendImsAction,
  supportedActionsForIms,
  type BookLineForImsRecon,
  type ImsReconStatus,
  type ImsSourceDocForRecon,
  type ImsUserAction,
  type ImsWorkflowState,
} from '../engine/ims-recon';
import type { ImsWorkingRow, StoredImsDocForValidation } from './ims-excel';
import { toWorkbookBuffer, type Column } from './reports';
import { withClient } from './store';

export interface ImsFilterScope {
  gstin?: string;
  gstins?: string[];
  allowedGstins?: string[] | null;
  portalMatchingKey?: string;
  reconStatus?: string;
  docType?: string;
  supplierGstin?: string;
  actionView?: 'all' | 'actioned' | 'non_actioned';
  uploadStatus?: string;
  q?: string;
  periodMode?: 'single' | 'range' | 'multi' | 'all';
  period?: string;
  from?: string;
  to?: string;
  periods?: string[];
  limit?: number;
  offset?: number;
}

function resolveGstinScope(f: ImsFilterScope): string[] | null {
  let req: string[] = [];
  if (f.gstins && f.gstins.length) req = f.gstins.map(normGstin).filter(Boolean);
  else if (f.gstin && f.gstin.toUpperCase() !== 'ALL') req = [normGstin(f.gstin)];

  if (f.allowedGstins !== undefined && f.allowedGstins !== null) {
    const allow = new Set(f.allowedGstins.map(normGstin));
    return req.length ? req.filter((g) => allow.has(g)) : [...allow];
  }
  return req.length ? req : null;
}

// ---------------------------------------------------------------------------
// 1. IMS Import & Immutable Storage
// ---------------------------------------------------------------------------

export async function loadExistingImsFingerprints(gstins?: string[] | null): Promise<Set<string>> {
  return withClient(async (c) => {
    const params: unknown[] = [];
    let where = '';
    if (gstins && gstins.length) {
      params.push(gstins.map(normGstin));
      where = 'WHERE our_gstin = ANY($1::text[])';
    }
    const r = await c.query(
      `SELECT our_gstin, supplier_gstin, document_type, document_no_norm,
              document_date, doc_category, taxable_value, igst, cgst, sgst, cess,
              portal_matching_key
         FROM ims_documents ${where}`,
      params,
    );
    const out = new Set<string>();
    for (const row of r.rows) {
      out.add(
        imsFingerprintOf({
          our_gstin: row.our_gstin,
          supplier_gstin: row.supplier_gstin,
          document_type: normDocType(row.document_type),
          document_no_norm: row.document_no_norm,
          document_date: row.document_date ? isoDate(row.document_date) : '',
          doc_category: row.doc_category || 'B2B',
          taxable_value: Number(row.taxable_value || 0),
          igst: Number(row.igst || 0),
          cgst: Number(row.cgst || 0),
          sgst: Number(row.sgst || 0),
          cess: Number(row.cess || 0),
          portal_matching_key: String(row.portal_matching_key || ''),
        }),
      );
    }
    return out;
  });
}

export async function previewImsImport(
  files: Array<{ name: string; buffer: Buffer }>,
  opts: { selectedGstin?: string; allowedGstins?: string[] | null },
): Promise<ImsBatchPreview> {
  const existing = await loadExistingImsFingerprints(opts.allowedGstins);
  return parseImsFilesBatch(files, {
    selectedGstin: opts.selectedGstin,
    allowedGstins: opts.allowedGstins,
    existingDbFingerprints: existing,
  });
}

export async function commitImsImport(
  files: Array<{ name: string; buffer: Buffer }>,
  opts: { selectedGstin?: string; allowedGstins?: string[] | null; importedBy: string },
): Promise<{
  ok: boolean;
  batchIds: number[];
  preview: ImsBatchPreview;
  insertedCount: number;
  duplicateCount: number;
  reason?: string;
}> {
  const preview = await previewImsImport(files, opts);
  const batchIds: number[] = [];
  let insertedCount = 0;

  try {
    await withClient(async (c) => {
      await c.query('BEGIN');
      try {
        const batchIdByFile = new Map<string, number>();
        for (const f of preview.files) {
          const bUid = `IMS-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          const ins = await c.query(
            `INSERT INTO ims_import_batches
               (batch_uid, our_gstin, file_name, file_sha256, file_format, categories,
                total_records, accepted_records, duplicate_records, rejected_records,
                validation_errors, imported_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             RETURNING id`,
            [
              bUid,
              f.gstins.length === 1 ? f.gstins[0] : (opts.selectedGstin || null),
              f.fileName,
              f.fileSha256,
              f.fileFormat,
              f.categories,
              f.totalRecords,
              f.acceptedRecords,
              f.duplicateRecords,
              f.rejectedRecords,
              JSON.stringify(f.validationErrors.slice(0, 200)),
              opts.importedBy || 'system',
            ],
          );
          const id = Number(ins.rows[0].id);
          batchIds.push(id);
          batchIdByFile.set(f.fileName, id);
        }

        for (const d of preview.acceptedDocs) {
          const bId = batchIdByFile.get(d.source_file) ?? batchIds[0] ?? null;
          const r = await c.query(
            `INSERT INTO ims_documents
               (doc_key, import_batch_id, our_gstin, supplier_gstin, supplier_name,
                doc_category, document_type, document_type_raw, document_no, document_no_norm,
                document_date, place_of_supply, reverse_charge, taxable_value, igst, cgst, sgst, cess,
                invoice_value, source_taxable_value, source_igst, source_cgst, source_sgst, source_cess,
                portal_matching_key, ims_source_action, ims_source_status, gstr1_filing_status,
                gstr1_period, itc_reduction_required, source_file, source_row, raw_payload, imported_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
             ON CONFLICT (doc_key) DO NOTHING`,
            [
              d.doc_key, bId, d.our_gstin, d.supplier_gstin, d.supplier_name || null,
              d.doc_category, d.document_type, d.document_type_raw, d.document_no, d.document_no_norm,
              d.document_date || null, d.place_of_supply || null, !!d.reverse_charge,
              r2(d.taxable_value), r2(d.igst), r2(d.cgst), r2(d.sgst), r2(d.cess), r2(d.invoice_value),
              r2(d.source_taxable_value), r2(d.source_igst), r2(d.source_cgst), r2(d.source_sgst), r2(d.source_cess),
              d.portal_matching_key || null, d.ims_source_action || null, d.ims_source_status || null,
              d.gstr1_filing_status || null, d.gstr1_period || null, !!d.itc_reduction_required,
              d.source_file, d.source_row, JSON.stringify(d.raw_payload), opts.importedBy || 'system',
            ],
          );
          insertedCount += r.rowCount ?? 0;
        }

        await c.query(
          `INSERT INTO ims_audit_trail (actor, event_type, our_gstin, batch_id, new_value, reason, details)
           VALUES ($1,'IMS_IMPORT',$2,$3,$4,$5,$6)`,
          [
            opts.importedBy || 'system',
            preview.gstins[0] || opts.selectedGstin || null,
            batchIds[0] ?? null,
            `${insertedCount} inserted`,
            'Imported original IMS file(s)',
            JSON.stringify({
              files: preview.files.map((f) => f.fileName),
              accepted: insertedCount,
              duplicates: preview.duplicateRecords,
              rejected: preview.rejectedRecords,
            }),
          ],
        );

        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    });
    return {
      ok: true,
      batchIds,
      preview,
      insertedCount,
      duplicateCount: preview.duplicateRecords + (preview.acceptedRecords - insertedCount),
    };
  } catch (e: any) {
    return {
      ok: false,
      batchIds,
      preview,
      insertedCount,
      duplicateCount: preview.duplicateRecords,
      reason: e?.message || 'IMS import failed',
    };
  }
}

export async function listImsBatches(allowed?: string[] | null) {
  return withClient(async (c) => {
    const params: unknown[] = [];
    let where = '';
    if (allowed && allowed.length) {
      params.push(allowed.map(normGstin));
      where = 'WHERE our_gstin IS NULL OR our_gstin = ANY($1::text[])';
    } else if (allowed && allowed.length === 0) {
      return [];
    }
    const r = await c.query(
      `SELECT id::int, batch_uid, our_gstin, file_name, file_format, categories,
              total_records, accepted_records, duplicate_records, rejected_records,
              validation_errors, imported_by, imported_at
         FROM ims_import_batches ${where}
        ORDER BY imported_at DESC LIMIT 100`,
      params,
    );
    return r.rows;
  });
}

// ---------------------------------------------------------------------------
// 2. Independent IMS vs Purchase Register Reconciliation
// ---------------------------------------------------------------------------

export async function runImsReconciliation(opts: {
  gstin: string;
  periodMode?: 'single' | 'range' | 'multi' | 'all';
  period?: string;
  from?: string;
  to?: string;
  periods?: string[];
  tolerance?: number;
  actor: string;
}): Promise<{
  ok: boolean;
  runId: number;
  summary: ReturnType<typeof reconcileImsVsBooks>['summary'];
  reason?: string;
}> {
  const gstin = normGstin(opts.gstin);
  const pMode = opts.periodMode ?? 'single';
  const targetPeriods =
    pMode === 'all'
      ? []
      : expandSelectedPeriods({
          periodMode: pMode,
          period: opts.period,
          from: opts.from,
          to: opts.to,
          periods: opts.periods,
        });

  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      // Load ALL immutable IMS docs for this GSTIN (never filter IMS by return month)
      const iRes = await c.query(
        `SELECT id, our_gstin, supplier_gstin, supplier_name, doc_category,
                document_type, document_no, document_date, taxable_value, igst, cgst, sgst, cess,
                portal_matching_key, ims_source_action, ims_source_status, gstr1_period, itc_reduction_required
           FROM ims_documents
          WHERE our_gstin = $1
          ORDER BY id`,
        [gstin],
      );

      // Load Books lines scoped by requested Purchase Register period(s)
      const bParams: unknown[] = [gstin];
      let bPeriodClause = '';
      if (targetPeriods.length) {
        bParams.push(targetPeriods);
        bPeriodClause = `AND period = ANY($${bParams.length}::text[])`;
      }
      const bRes = await c.query(
        `SELECT id, our_gstin, period, book_supplier_gstin, recon_supplier_gstin, party_name,
                book_document_type, book_invoice_no, recon_invoice_no,
                book_invoice_date, recon_invoice_date,
                book_taxable_value, book_igst, book_cgst, book_sgst, book_cess
           FROM purchase_lines
          WHERE our_gstin = $1 ${bPeriodClause}
          ORDER BY id`,
        bParams,
      );

      // Preserve any existing manually linked pairs for this GSTIN
      const manRes = await c.query(
        `SELECT DISTINCT ON (r.ims_doc_id)
                r.ims_doc_id, r.purchase_line_id, r.manual_linked_by, r.manual_linked_at, r.remarks
           FROM ims_recon_results r
           JOIN ims_recon_runs run ON run.id = r.run_id
          WHERE r.our_gstin = $1 AND r.is_manual_link = true AND r.ims_doc_id IS NOT NULL AND r.purchase_line_id IS NOT NULL
          ORDER BY r.ims_doc_id, r.id DESC`,
        [gstin],
      );
      const manualLinks = new Map<number, { bookId: number; by: string; at: any; remarks: string }>();
      for (const m of manRes.rows) {
        manualLinks.set(Number(m.ims_doc_id), {
          bookId: Number(m.purchase_line_id),
          by: String(m.manual_linked_by || ''),
          at: m.manual_linked_at,
          remarks: String(m.remarks || ''),
        });
      }

      const imsDocs: ImsSourceDocForRecon[] = iRes.rows.map((r: any) => ({
        id: Number(r.id),
        our_gstin: normGstin(r.our_gstin),
        supplier_gstin: normGstin(r.supplier_gstin),
        supplier_name: String(r.supplier_name || ''),
        doc_category: String(r.doc_category || 'B2B'),
        document_type: normDocType(r.document_type),
        document_no: String(r.document_no || ''),
        document_date: r.document_date ? isoDate(r.document_date) : '',
        taxable_value: Number(r.taxable_value || 0),
        igst: Number(r.igst || 0),
        cgst: Number(r.cgst || 0),
        sgst: Number(r.sgst || 0),
        cess: Number(r.cess || 0),
        portal_matching_key: String(r.portal_matching_key || ''),
        ims_source_action: String(r.ims_source_action || ''),
        ims_source_status: String(r.ims_source_status || ''),
        gstr1_period: r.gstr1_period ? String(r.gstr1_period) : undefined,
        itc_reduction_required: Boolean(r.itc_reduction_required),
      }));

      const bookLines: BookLineForImsRecon[] = bRes.rows.map((r: any) => ({
        id: Number(r.id),
        our_gstin: normGstin(r.our_gstin),
        period: String(r.period || ''),
        supplier_gstin: normGstin(r.book_supplier_gstin),
        recon_supplier_gstin: normGstin(r.recon_supplier_gstin || r.book_supplier_gstin),
        party_name: String(r.party_name || ''),
        document_type: normDocType(r.book_document_type || 'Tax Invoice'),
        invoice_no: String(r.book_invoice_no || ''),
        recon_invoice_no: String(r.recon_invoice_no || r.book_invoice_no || ''),
        invoice_date: r.book_invoice_date ? isoDate(r.book_invoice_date) : '',
        recon_invoice_date: r.recon_invoice_date ? isoDate(r.recon_invoice_date) : (r.book_invoice_date ? isoDate(r.book_invoice_date) : ''),
        taxable_value: Number(r.book_taxable_value || 0),
        igst: Number(r.book_igst || 0),
        cgst: Number(r.book_cgst || 0),
        sgst: Number(r.book_sgst || 0),
        cess: Number(r.book_cess || 0),
      }));

      // Exclude manually linked pairs from automatic matcher, then emit them with preserved manual link status
      const manualImsIds = new Set(manualLinks.keys());
      const manualBookIds = new Set([...manualLinks.values()].map((m) => m.bookId));
      const autoRecon = reconcileImsVsBooks(
        imsDocs.filter((d) => !manualImsIds.has(d.id)),
        bookLines.filter((b) => !manualBookIds.has(b.id)),
        { tolerance: opts.tolerance ?? 1 },
      );

      const imsById = new Map(imsDocs.map((d) => [d.id, d]));
      const bookById = new Map(bookLines.map((b) => [b.id, b]));
      for (const [imsId, ml] of manualLinks) {
        const ims = imsById.get(imsId);
        const book = bookById.get(ml.bookId);
        if (!ims || !book) continue;
        const rec = recommendImsAction({
          docCategory: ims.doc_category,
          documentType: ims.document_type,
          itcReductionRequired: ims.itc_reduction_required,
          reconStatus: 'MANUALLY LINKED AFTER CONFIRMATION',
          hasImsDoc: true,
        });
        autoRecon.results.push({
          our_gstin: gstin,
          books_period: book.period,
          ims_doc_id: ims.id,
          purchase_line_id: book.id,
          recon_status: 'MANUALLY LINKED AFTER CONFIRMATION',
          portal_matching_key: ims.portal_matching_key,
          internal_match_key: internalKeyOf(gstin, ims.supplier_gstin, ims.document_type, ims.document_no),
          taxable_diff: r2(ims.taxable_value - book.taxable_value),
          igst_diff: r2(ims.igst - book.igst),
          cgst_diff: r2(ims.cgst - book.cgst),
          sgst_diff: r2(ims.sgst - book.sgst),
          cess_diff: r2(ims.cess - book.cess),
          total_tax_diff: r2(taxOf(ims) - taxOf(book)),
          date_diff_days: null,
          recommended_action: rec.recommendedAction,
          supported_actions: rec.supportedActions,
          recommendation_reason: rec.reason,
          remarks: ml.remarks || `Manually linked by ${ml.by}`,
        });
        autoRecon.summary.matched++;
      }

      const runIns = await c.query(
        `INSERT INTO ims_recon_runs
           (our_gstin, books_period_mode, books_periods, tolerance,
            total_ims, total_books, matched_count, ims_only_count,
            books_only_count, mismatch_count, duplicate_count, run_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          gstin, pMode, targetPeriods, opts.tolerance ?? 1,
          imsDocs.length, bookLines.length,
          autoRecon.summary.matched,
          autoRecon.summary.ims_only,
          autoRecon.summary.books_only,
          autoRecon.summary.tax_or_taxable_mismatch + autoRecon.summary.date_or_doc_mismatch,
          autoRecon.summary.duplicates,
          opts.actor || 'system',
        ],
      );
      const runId = Number(runIns.rows[0].id);

      for (const r of autoRecon.results) {
        const ml = r.ims_doc_id ? manualLinks.get(r.ims_doc_id) : undefined;
        await c.query(
          `INSERT INTO ims_recon_results
             (run_id, our_gstin, books_period, ims_doc_id, purchase_line_id, recon_status,
              portal_matching_key, internal_match_key, taxable_diff, igst_diff, cgst_diff,
              sgst_diff, cess_diff, total_tax_diff, date_diff_days, recommended_action,
              recommendation_reason, is_manual_link, manual_linked_by, manual_linked_at, remarks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [
            runId, r.our_gstin, r.books_period, r.ims_doc_id, r.purchase_line_id, r.recon_status,
            r.portal_matching_key || null, r.internal_match_key,
            r.taxable_diff, r.igst_diff, r.cgst_diff, r.sgst_diff, r.cess_diff, r.total_tax_diff,
            r.date_diff_days, r.recommended_action, r.recommendation_reason,
            Boolean(ml), ml?.by || null, ml?.at || null, r.remarks,
          ],
        );
      }

      await c.query(
        `INSERT INTO ims_audit_trail (actor, event_type, our_gstin, batch_id, new_value, reason, details)
         VALUES ($1,'IMS_RECON_RUN',$2,$3,$4,$5,$6)`,
        [
          opts.actor || 'system', gstin, runId,
          `Matched ${autoRecon.summary.matched} / IMS ${imsDocs.length}`,
          'Executed independent IMS vs Purchase Register reconciliation',
          JSON.stringify(autoRecon.summary),
        ],
      );

      await c.query('COMMIT');
      return { ok: true, runId, summary: autoRecon.summary };
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}

// ---------------------------------------------------------------------------
// 3. Query latest IMS Recon Documents + Manual Link + User Actions
// ---------------------------------------------------------------------------

export async function listImsReconDocuments(f: ImsFilterScope): Promise<{
  total: number;
  rows: any[];
}> {
  const gstins = resolveGstinScope(f);
  if (gstins && gstins.length === 0) return { total: 0, rows: [] };

  return withClient(async (c) => {
    const params: unknown[] = [];
    const where: string[] = [];

    if (gstins) {
      params.push(gstins);
      where.push(`res.our_gstin = ANY($${params.length}::text[])`);
    }
    if (f.portalMatchingKey) {
      params.push(f.portalMatchingKey.trim());
      where.push(`COALESCE(doc.portal_matching_key, res.portal_matching_key, '') = $${params.length}`);
    }
    if (f.reconStatus) {
      params.push(f.reconStatus);
      where.push(`res.recon_status = $${params.length}`);
    }
    if (f.docType) {
      params.push(f.docType);
      where.push(`COALESCE(doc.document_type, pl.book_document_type, '') = $${params.length}`);
    }
    if (f.supplierGstin) {
      params.push(normGstin(f.supplierGstin));
      where.push(`(doc.supplier_gstin = $${params.length} OR pl.book_supplier_gstin = $${params.length})`);
    }
    if (f.actionView === 'actioned') {
      where.push(`dec.id IS NOT NULL AND dec.user_action <> 'DO NOT TAKE ANY ACTION'`);
    } else if (f.actionView === 'non_actioned') {
      where.push(`res.ims_doc_id IS NOT NULL AND (dec.id IS NULL OR dec.user_action = 'DO NOT TAKE ANY ACTION')`);
    }
    if (f.uploadStatus) {
      params.push(f.uploadStatus);
      where.push(`COALESCE(dec.workflow_status, 'NOT READY') = $${params.length}`);
    }
    if (f.q) {
      params.push(`%${f.q.toLowerCase()}%`);
      where.push(
        `(LOWER(COALESCE(doc.document_no,'')) LIKE $${params.length}
          OR LOWER(COALESCE(pl.book_invoice_no,'')) LIKE $${params.length}
          OR LOWER(COALESCE(doc.supplier_gstin, pl.book_supplier_gstin,'')) LIKE $${params.length}
          OR LOWER(COALESCE(doc.supplier_name, pl.party_name,'')) LIKE $${params.length}
          OR LOWER(COALESCE(doc.portal_matching_key,'')) LIKE $${params.length})`,
      );
    }

    const limit = Math.min(f.limit ?? 500, 5000);
    const offset = f.offset ?? 0;

    // Pick results from ONLY the latest ims_recon_runs per GSTIN
    const baseCte = `
      WITH latest_runs AS (
        SELECT DISTINCT ON (our_gstin) id AS run_id, our_gstin
          FROM ims_recon_runs
         ORDER BY our_gstin, id DESC
      )
      SELECT res.id::int AS recon_id,
             res.run_id::int,
             res.our_gstin,
             res.books_period,
             res.ims_doc_id::int,
             res.purchase_line_id::int,
             res.recon_status,
             COALESCE(doc.portal_matching_key, res.portal_matching_key, '') AS portal_matching_key,
             res.internal_match_key,
             res.taxable_diff, res.igst_diff, res.cgst_diff, res.sgst_diff, res.cess_diff, res.total_tax_diff,
             res.date_diff_days, res.recommended_action, res.recommendation_reason,
             res.is_manual_link, res.remarks AS recon_remarks,
             doc.doc_category, doc.document_type AS ims_doc_type, doc.document_no AS ims_doc_no,
             doc.document_date AS ims_doc_date, doc.supplier_gstin AS ims_supplier_gstin,
             doc.supplier_name AS ims_supplier_name,
             doc.taxable_value AS ims_taxable, doc.igst AS ims_igst, doc.cgst AS ims_cgst,
             doc.sgst AS ims_sgst, doc.cess AS ims_cess,
             doc.ims_source_action, doc.ims_source_status, doc.gstr1_filing_status, doc.gstr1_period,
             doc.itc_reduction_required,
             pl.book_document_type AS books_doc_type, pl.book_invoice_no AS books_doc_no,
             pl.book_invoice_date AS books_doc_date, pl.book_supplier_gstin AS books_supplier_gstin,
             pl.party_name AS books_party_name, pl.period AS purchase_period,
             pl.book_taxable_value AS books_taxable, pl.book_igst AS books_igst,
             pl.book_cgst AS books_cgst, pl.book_sgst AS books_sgst, pl.book_cess AS books_cess,
             pl.itc_decision, pl.itc_decision_month, pl.detailed_match_status AS twob_detailed_status,
             dec.user_action, dec.remarks AS user_remarks, dec.workflow_status,
             dec.decided_by, dec.decided_at, dec.approved_by, dec.approved_at
        FROM ims_recon_results res
        JOIN latest_runs lr ON lr.run_id = res.run_id
        LEFT JOIN ims_documents doc ON doc.id = res.ims_doc_id
        LEFT JOIN purchase_lines pl ON pl.id = res.purchase_line_id
        LEFT JOIN ims_action_decisions dec ON dec.ims_doc_id = res.ims_doc_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY res.our_gstin, COALESCE(doc.document_no, pl.book_invoice_no), res.id`;

    const allRes = await c.query(baseCte, params);
    const shaped = allRes.rows.map((r: any) => {
      const imsTotalTax = r.ims_doc_id
        ? r2(Number(r.ims_igst || 0) + Number(r.ims_cgst || 0) + Number(r.ims_sgst || 0) + Number(r.ims_cess || 0))
        : null;
      const booksTotalTax = r.purchase_line_id
        ? r2(Number(r.books_igst || 0) + Number(r.books_cgst || 0) + Number(r.books_sgst || 0) + Number(r.books_cess || 0))
        : null;
      const supported = supportedActionsForIms({
        docCategory: r.doc_category || 'B2B',
        documentType: r.ims_doc_type || r.books_doc_type || 'Tax Invoice',
        itcReductionRequired: Boolean(r.itc_reduction_required),
        reconStatus: r.recon_status as ImsReconStatus,
        hasImsDoc: Boolean(r.ims_doc_id),
      });
      return {
        ...r,
        ims_doc_date: r.ims_doc_date ? isoDate(r.ims_doc_date) : '',
        books_doc_date: r.books_doc_date ? isoDate(r.books_doc_date) : '',
        ims_total_tax: imsTotalTax,
        books_total_tax: booksTotalTax,
        supported_actions: supported,
      };
    });

    return {
      total: shaped.length,
      rows: shaped.slice(offset, offset + limit),
    };
  });
}

export async function manualLinkImsDocument(opts: {
  imsDocId: number;
  purchaseLineId: number;
  actor: string;
  reason?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return withClient(async (c) => {
    const imsR = await c.query('SELECT * FROM ims_documents WHERE id = $1', [opts.imsDocId]);
    const bkR = await c.query('SELECT * FROM purchase_lines WHERE id = $1', [opts.purchaseLineId]);
    const ims = imsR.rows[0];
    const bk = bkR.rows[0];
    if (!ims || !bk) return { ok: false, reason: 'IMS document or Purchase line not found.' };
    if (normGstin(ims.our_gstin) !== normGstin(bk.our_gstin)) {
      return { ok: false, reason: 'Cannot manually link documents across different Our GSTIN registrations.' };
    }
    if (normDocType(ims.document_type) !== normDocType(bk.book_document_type)) {
      return { ok: false, reason: `Cannot link ${ims.document_type} with Books ${bk.book_document_type} (Document Types must match).` };
    }

    const imsTax = r2(Number(ims.igst) + Number(ims.cgst) + Number(ims.sgst) + Number(ims.cess));
    const bkTax = r2(Number(bk.book_igst) + Number(bk.book_cgst) + Number(bk.book_sgst) + Number(bk.book_cess));
    const txDiff = r2(Number(ims.taxable_value) - Number(bk.book_taxable_value));
    const totDiff = r2(imsTax - bkTax);

    await c.query('BEGIN');
    try {
      await c.query(
        `UPDATE ims_recon_results
            SET purchase_line_id = $2,
                books_period = $3,
                recon_status = 'MANUALLY LINKED AFTER CONFIRMATION',
                taxable_diff = $4,
                igst_diff = $5,
                cgst_diff = $6,
                sgst_diff = $7,
                cess_diff = $8,
                total_tax_diff = $9,
                recommended_action = 'ACCEPT',
                recommendation_reason = $10,
                is_manual_link = true,
                manual_linked_by = $11,
                manual_linked_at = now(),
                remarks = $12,
                updated_at = now()
          WHERE ims_doc_id = $1
            AND run_id = (SELECT id FROM ims_recon_runs WHERE our_gstin = $13 ORDER BY id DESC LIMIT 1)`,
        [
          opts.imsDocId, opts.purchaseLineId, bk.period,
          txDiff,
          r2(Number(ims.igst) - Number(bk.book_igst)),
          r2(Number(ims.cgst) - Number(bk.book_cgst)),
          r2(Number(ims.sgst) - Number(bk.book_sgst)),
          r2(Number(ims.cess) - Number(bk.book_cess)),
          totDiff,
          opts.reason || 'Manually linked by authorised user after review',
          opts.actor,
          opts.reason || `Linked with Books ID ${opts.purchaseLineId}`,
          normGstin(ims.our_gstin),
        ],
      );

      await c.query(
        `INSERT INTO ims_audit_trail
           (actor, event_type, our_gstin, ims_doc_id, purchase_line_id, new_value, reason)
         VALUES ($1,'IMS_MANUAL_LINK',$2,$3,$4,'MANUALLY LINKED AFTER CONFIRMATION',$5)`,
        [opts.actor, ims.our_gstin, opts.imsDocId, opts.purchaseLineId, opts.reason || 'Manual link confirmed'],
      );
      await c.query('COMMIT');
      return { ok: true };
    } catch (err: any) {
      await c.query('ROLLBACK');
      return { ok: false, reason: err?.message || 'Manual link failed' };
    }
  });
}

export async function saveImsUserActions(
  decisions: Array<{ ims_doc_id: number; user_action: string; remarks?: string }>,
  actor: string,
  channel: 'ui' | 'excel_upload' = 'ui',
  allowedGstins?: string[] | null,
): Promise<{
  ok: boolean;
  savedCount: number;
  rejected: Array<{ ims_doc_id: number; reason: string }>;
}> {
  const allowSet = allowedGstins ? new Set(allowedGstins.map(normGstin)) : null;
  const rejected: Array<{ ims_doc_id: number; reason: string }> = [];
  let savedCount = 0;

  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      for (const dec of decisions) {
        const docR = await c.query(
          `SELECT d.*, r.recon_status, r.recommended_action,
                  ad.user_action AS prev_action, ad.workflow_status AS prev_wf
             FROM ims_documents d
             LEFT JOIN LATERAL (
               SELECT recon_status, recommended_action
                 FROM ims_recon_results
                WHERE ims_doc_id = d.id
                ORDER BY id DESC LIMIT 1
             ) r ON true
             LEFT JOIN ims_action_decisions ad ON ad.ims_doc_id = d.id
            WHERE d.id = $1`,
          [dec.ims_doc_id],
        );
        const doc = docR.rows[0];
        if (!doc) {
          rejected.push({ ims_doc_id: dec.ims_doc_id, reason: 'IMS document not found.' });
          continue;
        }
        const og = normGstin(doc.our_gstin);
        if (allowSet && !allowSet.has(og)) {
          rejected.push({ ims_doc_id: dec.ims_doc_id, reason: `User not permitted for GSTIN ${og}.` });
          continue;
        }
        const act = String(dec.user_action || '').trim().toUpperCase() as ImsUserAction;
        if (!IMS_ACTIONS.includes(act)) {
          rejected.push({ ims_doc_id: dec.ims_doc_id, reason: `Invalid IMS action "${dec.user_action}".` });
          continue;
        }
        const supported = supportedActionsForIms({
          docCategory: doc.doc_category,
          documentType: doc.document_type,
          itcReductionRequired: Boolean(doc.itc_reduction_required),
          reconStatus: (doc.recon_status || 'IMS ONLY') as ImsReconStatus,
          hasImsDoc: true,
        });
        if (!supported.includes(act)) {
          rejected.push({
            ims_doc_id: dec.ims_doc_id,
            reason: `Action "${act}" not supported for category ${doc.doc_category} (${doc.document_type}).`,
          });
          continue;
        }
        if (doc.prev_wf === 'SUCCESS' || doc.prev_wf === 'UPLOAD PENDING' || doc.prev_wf === 'PROCESSING') {
          rejected.push({
            ims_doc_id: dec.ims_doc_id,
            reason: `Document is locked in portal state "${doc.prev_wf}" — blind overwrite refused.`,
          });
          continue;
        }

        const wfStatus: ImsWorkflowState =
          act === 'DO NOT TAKE ANY ACTION' ? 'NOT UPLOADED' : 'READY FOR REVIEW';

        await c.query(
          `INSERT INTO ims_action_decisions
             (ims_doc_id, our_gstin, portal_matching_key, current_portal_action,
              recommended_action, user_action, remarks, workflow_status, source_channel, decided_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (ims_doc_id) DO UPDATE SET
             current_portal_action = COALESCE(ims_action_decisions.current_portal_action, EXCLUDED.current_portal_action),
             recommended_action = COALESCE(EXCLUDED.recommended_action, ims_action_decisions.recommended_action),
             user_action = EXCLUDED.user_action,
             remarks = COALESCE(NULLIF(EXCLUDED.remarks,''), ims_action_decisions.remarks),
             workflow_status = EXCLUDED.workflow_status,
             source_channel = EXCLUDED.source_channel,
             decided_by = EXCLUDED.decided_by,
             decided_at = now(),
             updated_at = now()`,
          [
            dec.ims_doc_id, og, doc.portal_matching_key || null, doc.ims_source_action || null,
            doc.recommended_action || null, act, dec.remarks ?? null, wfStatus, channel, actor,
          ],
        );

        await c.query(
          `INSERT INTO ims_audit_trail
             (actor, event_type, our_gstin, ims_doc_id, old_value, new_value, reason, details)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            actor,
            channel === 'excel_upload' ? 'IMS_ACTION_EXCEL_SAVE' : 'IMS_ACTION_SAVED',
            og,
            dec.ims_doc_id,
            doc.prev_action || doc.ims_source_action || '',
            act,
            dec.remarks || `Action saved via ${channel}`,
            JSON.stringify({ workflow_status: wfStatus, portal_matching_key: doc.portal_matching_key || '' }),
          ],
        );
        savedCount++;
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });

  return { ok: true, savedCount, rejected };
}

export async function getImsWorkingRows(f: ImsFilterScope): Promise<{
  rows: ImsWorkingRow[];
  docsById: Map<number, StoredImsDocForValidation>;
}> {
  const { rows } = await listImsReconDocuments({ ...f, limit: 5000, offset: 0 });
  const imsOnlyRows = rows.filter((r) => Boolean(r.ims_doc_id));

  const working: ImsWorkingRow[] = imsOnlyRows.map((r) => ({
    ims_doc_id: Number(r.ims_doc_id),
    our_gstin: r.our_gstin,
    portal_matching_key: r.portal_matching_key || '',
    internal_match_key: r.internal_match_key || '',
    doc_category: r.doc_category || 'B2B',
    document_type: r.ims_doc_type || 'Tax Invoice',
    supplier_gstin: r.ims_supplier_gstin || '',
    supplier_name: r.ims_supplier_name || '',
    ims_doc_no: r.ims_doc_no || '',
    ims_doc_date: r.ims_doc_date || '',
    ims_taxable: r2(r.ims_taxable),
    ims_igst: r2(r.ims_igst),
    ims_cgst: r2(r.ims_cgst),
    ims_sgst: r2(r.ims_sgst),
    ims_cess: r2(r.ims_cess),
    ims_total_tax: r2(r.ims_total_tax),
    books_doc_no: r.books_doc_no || '',
    books_doc_date: r.books_doc_date || '',
    books_taxable: r.purchase_line_id ? r2(r.books_taxable) : null,
    books_total_tax: r.purchase_line_id ? r2(r.books_total_tax) : null,
    taxable_diff: r.taxable_diff !== null && r.taxable_diff !== undefined ? r2(r.taxable_diff) : null,
    total_tax_diff: r.total_tax_diff !== null && r.total_tax_diff !== undefined ? r2(r.total_tax_diff) : null,
    recon_status: r.recon_status || 'IMS ONLY',
    current_portal_action: r.ims_source_action || 'NO ACTION',
    recommended_action: r.recommended_action || 'PENDING',
    proposed_action: r.user_action || '',
    user_remarks: r.user_remarks || '',
    workflow_status: r.workflow_status || 'READY FOR REVIEW',
  }));

  const docsById = await withClient(async (c) => {
    const r = await c.query(
      `SELECT d.id, d.our_gstin, d.supplier_gstin, d.doc_category, d.document_type, d.document_no,
              d.portal_matching_key, d.ims_source_action, d.itc_reduction_required,
              (SELECT recon_status FROM ims_recon_results WHERE ims_doc_id = d.id ORDER BY id DESC LIMIT 1) AS recon_status,
              ad.user_action AS existing_user_action, ad.remarks AS existing_remarks,
              ad.workflow_status AS existing_workflow_status
         FROM ims_documents d
         LEFT JOIN ims_action_decisions ad ON ad.ims_doc_id = d.id`,
    );
    const m = new Map<number, StoredImsDocForValidation>();
    for (const row of r.rows) {
      m.set(Number(row.id), {
        id: Number(row.id),
        our_gstin: row.our_gstin,
        supplier_gstin: row.supplier_gstin,
        doc_category: row.doc_category,
        document_type: row.document_type,
        document_no: row.document_no,
        portal_matching_key: row.portal_matching_key,
        ims_source_action: row.ims_source_action,
        recon_status: row.recon_status,
        itc_reduction_required: Boolean(row.itc_reduction_required),
        existing_user_action: row.existing_user_action,
        existing_remarks: row.existing_remarks,
        existing_workflow_status: row.existing_workflow_status,
      });
    }
    return m;
  });

  return { rows: working, docsById };
}

// ---------------------------------------------------------------------------
// 4. Phase 7 — Manual Portal Action Approval, Tracking & Error Reports
// ---------------------------------------------------------------------------

export async function reviewAndApproveImsActions(opts: {
  gstin: string;
  imsDocIds: number[];
  actor: string;
  remarks?: string;
}): Promise<{
  ok: boolean;
  uploadBatchId?: number;
  batchRef?: string;
  mode: 'MANUAL_PORTAL_EXPORT';
  note: string;
  approvedDocs: number;
  portalPayload?: Record<string, unknown>;
  reason?: string;
}> {
  const gstin = normGstin(opts.gstin);
  if (!opts.imsDocIds.length) {
    return { ok: false, mode: 'MANUAL_PORTAL_EXPORT', note: '', approvedDocs: 0, reason: 'No documents selected for approval.' };
  }

  return withClient(async (c) => {
    const r = await c.query(
      `SELECT d.id, d.our_gstin, d.supplier_gstin, d.document_type, d.document_no, d.document_date,
              d.doc_category, d.portal_matching_key, d.ims_source_action, d.taxable_value,
              d.igst, d.cgst, d.sgst, d.cess,
              ad.user_action, ad.workflow_status, ad.remarks
         FROM ims_documents d
         JOIN ims_action_decisions ad ON ad.ims_doc_id = d.id
        WHERE d.id = ANY($1::bigint[])`,
      [opts.imsDocIds],
    );
    if (!r.rows.length) {
      return { ok: false, mode: 'MANUAL_PORTAL_EXPORT', note: '', approvedDocs: 0, reason: 'Selected documents have no saved user actions yet.' };
    }

    for (const row of r.rows) {
      if (normGstin(row.our_gstin) !== gstin) {
        return { ok: false, mode: 'MANUAL_PORTAL_EXPORT', note: '', approvedDocs: 0, reason: `Document ${row.document_no} belongs to different GSTIN ${row.our_gstin}.` };
      }
      if (row.workflow_status === 'SUCCESS' || row.workflow_status === 'UPLOAD PENDING' || row.workflow_status === 'PROCESSING') {
        return {
          ok: false, mode: 'MANUAL_PORTAL_EXPORT', note: '', approvedDocs: 0,
          reason: `Blind retry blocked: ${row.document_no} is already in "${row.workflow_status}" state.`,
        };
      }
    }

    const batchRef = `IMS-UP-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    await c.query('BEGIN');
    try {
      const bIns = await c.query(
        `INSERT INTO ims_portal_upload_batches
           (batch_ref, our_gstin, mode, batch_status, total_docs, pending_count, approved_by, notes)
         VALUES ($1,$2,'MANUAL_PORTAL_EXPORT','APPROVED BY USER',$3,$3,$4,$5)
         RETURNING id`,
        [batchRef, gstin, r.rows.length, opts.actor, opts.remarks || 'Explicit user approval for manual GST Portal upload'],
      );
      const batchId = Number(bIns.rows[0].id);

      const payloadItems: Array<Record<string, unknown>> = [];
      for (const row of r.rows) {
        await c.query(
          `INSERT INTO ims_portal_upload_results
             (upload_batch_id, ims_doc_id, our_gstin, portal_matching_key,
              previous_action, proposed_action, upload_status)
           VALUES ($1,$2,$3,$4,$5,$6,'APPROVED BY USER')`,
          [
            batchId, row.id, gstin, row.portal_matching_key || null,
            row.ims_source_action || 'NO ACTION', row.user_action,
          ],
        );

        await c.query(
          `UPDATE ims_action_decisions
              SET workflow_status = 'APPROVED BY USER',
                  approved_by = $2,
                  approved_at = now(),
                  approval_remarks = $3,
                  updated_at = now()
            WHERE ims_doc_id = $1`,
          [row.id, opts.actor, opts.remarks || `Approved in batch ${batchRef}`],
        );

        await c.query(
          `INSERT INTO ims_audit_trail
             (actor, event_type, our_gstin, ims_doc_id, batch_id, old_value, new_value, reason)
           VALUES ($1,'IMS_ACTION_APPROVED',$2,$3,$4,$5,$6,$7)`,
          [
            opts.actor, gstin, row.id, batchId,
            row.workflow_status || 'READY FOR REVIEW',
            `APPROVED BY USER (${row.user_action})`,
            opts.remarks || `Batch ${batchRef} approved for manual GST Portal upload`,
          ],
        );

        payloadItems.push({
          supplier_gstin: row.supplier_gstin,
          doc_category: row.doc_category,
          document_type: row.document_type,
          document_no: row.document_no,
          document_date: row.document_date ? isoDate(row.document_date) : '',
          portal_matching_key: row.portal_matching_key || '',
          action: row.user_action,
          taxable_value: Number(row.taxable_value),
          igst: Number(row.igst),
          cgst: Number(row.cgst),
          sgst: Number(row.sgst),
          cess: Number(row.cess),
        });
      }

      await c.query('COMMIT');
      return {
        ok: true,
        uploadBatchId: batchId,
        batchRef,
        mode: 'MANUAL_PORTAL_EXPORT',
        note: 'Manual GST Portal workflow: Direct GSTN API is NOT integrated. Upload the exported action file/JSON on the GST Portal and record confirmation or error report here.',
        approvedDocs: r.rows.length,
        portalPayload: {
          batch_ref: batchRef,
          our_gstin: gstin,
          generated_at: new Date().toISOString(),
          mode: 'MANUAL_GST_PORTAL_UPLOAD',
          items: payloadItems,
        },
      };
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}

export async function updateImsUploadBatchStatus(opts: {
  batchId: number;
  status: ImsWorkflowState;
  portalAckRef?: string;
  notes?: string;
  actor: string;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!IMS_WORKFLOW_STATES.includes(opts.status)) {
    return { ok: false, reason: `Invalid upload status "${opts.status}".` };
  }
  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      const bR = await c.query('SELECT * FROM ims_portal_upload_batches WHERE id = $1', [opts.batchId]);
      const batch = bR.rows[0];
      if (!batch) {
        await c.query('ROLLBACK');
        return { ok: false, reason: 'Upload batch not found.' };
      }

      const resDocs = await c.query('SELECT ims_doc_id FROM ims_portal_upload_results WHERE upload_batch_id = $1', [opts.batchId]);
      const cnt = resDocs.rows.length;
      const succ = opts.status === 'SUCCESS' ? cnt : 0;
      const fail = opts.status === 'FAILED' || opts.status === 'ERROR REVIEW REQUIRED' ? cnt : 0;
      const pend = cnt - succ - fail;

      await c.query(
        `UPDATE ims_portal_upload_batches
            SET batch_status = $2::varchar,
                portal_ack_ref = COALESCE($3, portal_ack_ref),
                notes = COALESCE($4, notes),
                success_count = $5,
                failed_count = $6,
                pending_count = $7,
                submitted_at = CASE WHEN $2::text IN ('UPLOAD PENDING','PROCESSING','SUCCESS','FAILED') THEN COALESCE(submitted_at, now()) ELSE submitted_at END
          WHERE id = $1`,
        [opts.batchId, opts.status, opts.portalAckRef || null, opts.notes || null, succ, fail, pend],
      );

      await c.query(
        `UPDATE ims_portal_upload_results
            SET upload_status = $2::varchar,
                portal_reference = COALESCE($3, portal_reference),
                confirmed_by = CASE WHEN $2::text = 'SUCCESS' THEN $4 ELSE confirmed_by END,
                confirmed_at = CASE WHEN $2::text = 'SUCCESS' THEN now() ELSE confirmed_at END,
                updated_at = now()
          WHERE upload_batch_id = $1`,
        [opts.batchId, opts.status, opts.portalAckRef || null, opts.actor],
      );

      const docIds = resDocs.rows.map((x: any) => Number(x.ims_doc_id));
      if (docIds.length) {
        await c.query(
          `UPDATE ims_action_decisions SET workflow_status = $2::varchar, updated_at = now() WHERE ims_doc_id = ANY($1::bigint[])`,
          [docIds, opts.status],
        );
      }

      await c.query(
        `INSERT INTO ims_audit_trail (actor, event_type, our_gstin, batch_id, old_value, new_value, reason)
         VALUES ($1,'IMS_PORTAL_STATUS_UPDATE',$2,$3,$4,$5,$6)`,
        [opts.actor, batch.our_gstin, opts.batchId, batch.batch_status, opts.status, opts.notes || opts.portalAckRef || 'Status updated'],
      );

      await c.query('COMMIT');
      return { ok: true };
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}

export async function listImsUploadBatches(allowed?: string[] | null) {
  return withClient(async (c) => {
    const params: unknown[] = [];
    let where = '';
    if (allowed && allowed.length) {
      params.push(allowed.map(normGstin));
      where = 'WHERE our_gstin = ANY($1::text[])';
    } else if (allowed && allowed.length === 0) return [];
    const r = await c.query(
      `SELECT id::int, batch_ref, our_gstin, mode, batch_status, total_docs,
              success_count, failed_count, pending_count, portal_ack_ref,
              approved_by, approved_at, submitted_at, notes
         FROM ims_portal_upload_batches ${where}
        ORDER BY id DESC LIMIT 100`,
      params,
    );
    return r.rows;
  });
}

export async function importImsPortalErrorReport(opts: {
  uploadBatchId?: number;
  gstin?: string;
  fileName: string;
  buffer: Buffer;
  actor: string;
}): Promise<{ ok: boolean; errorCount: number; updatedDocs: number; errors: any[] }> {
  let gstin = normGstin(opts.gstin || '');
  if (!gstin && opts.uploadBatchId) {
    await withClient(async (c) => {
      const bRes = await c.query('SELECT our_gstin FROM ims_portal_upload_batches WHERE id = $1', [opts.uploadBatchId]);
      if (bRes.rows[0]?.our_gstin) {
        gstin = normGstin(bRes.rows[0].our_gstin);
      }
    });
  }
  const parsedErrors: Array<{
    supplier_gstin?: string;
    document_no?: string;
    portal_matching_key?: string;
    error_code?: string;
    error_message: string;
  }> = [];

  if (opts.fileName.toLowerCase().endsWith('.json')) {
    const j = JSON.parse(opts.buffer.toString('utf8'));
    const arr = Array.isArray(j?.errors || j?.error_report || j) ? (j.errors || j.error_report || j) : [];
    for (const item of arr) {
      parsedErrors.push({
        supplier_gstin: item.supplier_gstin || item.ctin || item.stin,
        document_no: item.document_no || item.inum || item.nt_num,
        portal_matching_key: item.portal_matching_key || item.matching_key,
        error_code: item.error_code || item.err_cd || 'PORTAL_ERR',
        error_message: item.error_message || item.err_msg || item.message || 'GST Portal rejected action',
      });
    }
  } else {
    const wb = XLSX.read(opts.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }) as Array<Record<string, any>>;
    for (const r of rows) {
      const msg = String(r['Error Message'] || r['error_message'] || r['Reason'] || r['Message'] || '').trim();
      if (!msg) continue;
      parsedErrors.push({
        supplier_gstin: String(r['Supplier GSTIN'] || r['supplier_gstin'] || ''),
        document_no: String(r['Document Number'] || r['Invoice Number'] || r['document_no'] || ''),
        portal_matching_key: String(r['Matching Key'] || r['Portal Matching Key'] || r['portal_matching_key'] || ''),
        error_code: String(r['Error Code'] || r['error_code'] || 'PORTAL_ERR'),
        error_message: msg,
      });
    }
  }

  let updatedDocs = 0;
  await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      for (const err of parsedErrors) {
        // Match IMS doc by portal_matching_key OR (gstin, supplier_gstin, document_no_norm)
        const docR = await c.query(
          `SELECT id FROM ims_documents
            WHERE our_gstin = $1
              AND (($2 <> '' AND portal_matching_key = $2)
                OR (supplier_gstin = $3 AND document_no_norm = $4))
            ORDER BY id DESC LIMIT 1`,
          [
            gstin,
            err.portal_matching_key || '',
            normGstin(err.supplier_gstin || ''),
            normInvoice(err.document_no || ''),
          ],
        );
        const imsDocId = docR.rows[0]?.id ? Number(docR.rows[0].id) : null;

        await c.query(
          `INSERT INTO ims_error_reports
             (upload_batch_id, ims_doc_id, our_gstin, supplier_gstin, document_no,
              portal_matching_key, error_code, error_message, source_file, imported_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            opts.uploadBatchId ?? null, imsDocId, gstin,
            err.supplier_gstin ? normGstin(err.supplier_gstin) : null,
            err.document_no || null, err.portal_matching_key || null,
            err.error_code || 'PORTAL_ERR', err.error_message,
            opts.fileName, opts.actor,
          ],
        );

        if (imsDocId) {
          updatedDocs++;
          await c.query(
            `UPDATE ims_action_decisions
                SET workflow_status = 'ERROR REVIEW REQUIRED', updated_at = now()
              WHERE ims_doc_id = $1`,
            [imsDocId],
          );
          if (opts.uploadBatchId) {
            await c.query(
              `UPDATE ims_portal_upload_results
                  SET upload_status = 'ERROR REVIEW REQUIRED',
                      portal_error_code = $3,
                      portal_error_message = $4,
                      updated_at = now()
                WHERE upload_batch_id = $1 AND ims_doc_id = $2`,
              [opts.uploadBatchId, imsDocId, err.error_code || 'PORTAL_ERR', err.error_message],
            );
          }
          await c.query(
            `INSERT INTO ims_audit_trail
               (actor, event_type, our_gstin, ims_doc_id, batch_id, new_value, reason)
             VALUES ($1,'IMS_PORTAL_ERROR',$2,$3,$4,'ERROR REVIEW REQUIRED',$5)`,
            [opts.actor, gstin, imsDocId, opts.uploadBatchId ?? null, `${err.error_code}: ${err.error_message}`],
          );
        }
      }

      if (opts.uploadBatchId && parsedErrors.length > 0) {
        await c.query(
          `UPDATE ims_portal_upload_batches
              SET batch_status = 'ERROR REVIEW REQUIRED',
                  failed_count = GREATEST(failed_count, $2)
            WHERE id = $1`,
          [opts.uploadBatchId, parsedErrors.length],
        );
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });

  return { ok: true, errorCount: parsedErrors.length, updatedDocs, errors: parsedErrors };
}

// ---------------------------------------------------------------------------
// 5. Phase 8 — IMS Dashboard (14 KPIs) & 17 Reports & Combined Management View
// ---------------------------------------------------------------------------

export async function getImsDashboard(f: ImsFilterScope) {
  const gstins = resolveGstinScope(f);
  if (gstins && gstins.length === 0) {
    return {
      totalImsDocuments: 0, matchedWithPurchaseRegister: 0, imsOnly: 0, booksOnly: 0,
      taxableOrTaxMismatch: 0, docNumberOrDateMismatch: 0, possibleDuplicates: 0,
      actionRecommended: 0, actionedDocuments: 0, nonActionedDocuments: 0,
      approvedForUpload: 0, successfullyUploaded: 0, failedUpload: 0, pendingPortalConfirmation: 0,
    };
  }
  return withClient(async (c) => {
    const params: unknown[] = [];
    let whereG = '';
    if (gstins) {
      params.push(gstins);
      whereG = 'WHERE res.our_gstin = ANY($1::text[])';
    }
    const r = await c.query(
      `WITH latest_runs AS (
         SELECT DISTINCT ON (our_gstin) id AS run_id
           FROM ims_recon_runs
          ORDER BY our_gstin, id DESC
       )
       SELECT
         COUNT(*) FILTER (WHERE res.ims_doc_id IS NOT NULL)::int AS total_ims_documents,
         COUNT(*) FILTER (WHERE res.recon_status IN ('MATCHED — IMS vs BOOKS','MANUALLY LINKED AFTER CONFIRMATION'))::int AS matched_with_pr,
         COUNT(*) FILTER (WHERE res.recon_status = 'IMS ONLY')::int AS ims_only,
         COUNT(*) FILTER (WHERE res.recon_status = 'BOOKS ONLY')::int AS books_only,
         COUNT(*) FILTER (WHERE res.recon_status IN ('MATCHED WITH TAX DIFFERENCE','MATCHED WITH TAXABLE DIFFERENCE'))::int AS taxable_or_tax_mismatch,
         COUNT(*) FILTER (WHERE res.recon_status IN ('MATCHED WITH DOCUMENT DATE DIFFERENCE','DOCUMENT NUMBER MISMATCH','SUPPLIER GSTIN MISMATCH','DOCUMENT TYPE MISMATCH'))::int AS doc_or_date_mismatch,
         COUNT(*) FILTER (WHERE res.recon_status IN ('POSSIBLE DUPLICATE','DUPLICATE REJECTED'))::int AS possible_duplicates,
         COUNT(*) FILTER (WHERE res.ims_doc_id IS NOT NULL AND res.recommended_action IS NOT NULL)::int AS action_recommended,
         COUNT(*) FILTER (WHERE dec.id IS NOT NULL AND dec.user_action <> 'DO NOT TAKE ANY ACTION')::int AS actioned_documents,
         COUNT(*) FILTER (WHERE res.ims_doc_id IS NOT NULL AND (dec.id IS NULL OR dec.user_action = 'DO NOT TAKE ANY ACTION'))::int AS non_actioned_documents,
         COUNT(*) FILTER (WHERE dec.workflow_status = 'APPROVED BY USER')::int AS approved_for_upload,
         COUNT(*) FILTER (WHERE dec.workflow_status = 'SUCCESS')::int AS successfully_uploaded,
         COUNT(*) FILTER (WHERE dec.workflow_status IN ('FAILED','ERROR REVIEW REQUIRED'))::int AS failed_upload,
         COUNT(*) FILTER (WHERE dec.workflow_status IN ('APPROVED BY USER','UPLOAD PENDING','PROCESSING'))::int AS pending_portal_confirmation
        FROM ims_recon_results res
        JOIN latest_runs lr ON lr.run_id = res.run_id
        LEFT JOIN ims_action_decisions dec ON dec.ims_doc_id = res.ims_doc_id
        ${whereG}`,
      params,
    );
    const x = r.rows[0] || {};
    return {
      totalImsDocuments: Number(x.total_ims_documents || 0),
      matchedWithPurchaseRegister: Number(x.matched_with_pr || 0),
      imsOnly: Number(x.ims_only || 0),
      booksOnly: Number(x.books_only || 0),
      taxableOrTaxMismatch: Number(x.taxable_or_tax_mismatch || 0),
      docNumberOrDateMismatch: Number(x.doc_or_date_mismatch || 0),
      possibleDuplicates: Number(x.possible_duplicates || 0),
      actionRecommended: Number(x.action_recommended || 0),
      actionedDocuments: Number(x.actioned_documents || 0),
      nonActionedDocuments: Number(x.non_actioned_documents || 0),
      approvedForUpload: Number(x.approved_for_upload || 0),
      successfullyUploaded: Number(x.successfully_uploaded || 0),
      failedUpload: Number(x.failed_upload || 0),
      pendingPortalConfirmation: Number(x.pending_portal_confirmation || 0),
    };
  });
}

export const IMS_REPORTS_CATALOG = [
  { id: 'ims-complete-recon', title: '1. IMS vs Purchase Register Complete Reconciliation' },
  { id: 'ims-matched', title: '2. IMS Matched Documents' },
  { id: 'ims-only', title: '3. IMS Only' },
  { id: 'books-only', title: '4. Books Only' },
  { id: 'tax-mismatch', title: '5. Tax Mismatch' },
  { id: 'doc-mismatch', title: '6. Document Number / Date Mismatch' },
  { id: 'credit-note-recon', title: '7. Credit Note Reconciliation' },
  { id: 'debit-note-recon', title: '8. Debit Note Reconciliation' },
  { id: 'supplier-wise', title: '9. Supplier-wise Reconciliation' },
  { id: 'matching-key-wise', title: '10. Matching Key-wise Report' },
  { id: 'action-recommendation', title: '11. IMS Action Recommendation' },
  { id: 'actioned-docs', title: '12. Actioned Documents' },
  { id: 'non-actioned-docs', title: '13. Non-Actioned Documents' },
  { id: 'portal-upload-status', title: '14. Portal Upload Status' },
  { id: 'ims-error-report', title: '15. IMS Error Report' },
  { id: 'ims-import-history', title: '16. IMS Import History' },
  { id: 'ims-audit-trail', title: '17. IMS Action Audit Trail' },
] as const;

const RECON_COLS: Column[] = [
  { h: 'Our GSTIN', k: 'our_gstin', t: 'gstin', w: 18 },
  { h: 'Portal Matching Key', k: 'portal_matching_key', t: 'text', w: 26 },
  { h: 'Internal Match Key', k: 'internal_match_key', t: 'text', w: 30 },
  { h: 'IMS Category', k: 'doc_category', t: 'text', w: 14 },
  { h: 'Document Type', k: 'doc_type_display', t: 'text', w: 15 },
  { h: 'Supplier GSTIN', k: 'supplier_gstin_display', t: 'gstin', w: 18 },
  { h: 'Supplier Name', k: 'supplier_name_display', t: 'text', w: 28 },
  { h: 'IMS Doc No', k: 'ims_doc_no', t: 'text', w: 20 },
  { h: 'IMS Doc Date', k: 'ims_doc_date', t: 'date', w: 14 },
  { h: 'IMS Taxable', k: 'ims_taxable', t: 'money', w: 15 },
  { h: 'IMS Total Tax', k: 'ims_total_tax', t: 'money', w: 15 },
  { h: 'Books Month', k: 'purchase_period', t: 'period', w: 13 },
  { h: 'Books Doc No', k: 'books_doc_no', t: 'text', w: 20 },
  { h: 'Books Doc Date', k: 'books_doc_date', t: 'date', w: 14 },
  { h: 'Books Taxable', k: 'books_taxable', t: 'money', w: 15 },
  { h: 'Books Total Tax', k: 'books_total_tax', t: 'money', w: 15 },
  { h: 'Taxable Diff', k: 'taxable_diff', t: 'money', w: 14 },
  { h: 'Total Tax Diff', k: 'total_tax_diff', t: 'money', w: 14 },
  { h: 'IMS Recon Status', k: 'recon_status', t: 'text', w: 30 },
  { h: 'Current Portal Action', k: 'ims_source_action', t: 'text', w: 18 },
  { h: 'Recommended Action', k: 'recommended_action', t: 'text', w: 22 },
  { h: 'User Selected Action', k: 'user_action', t: 'text', w: 22 },
  { h: 'Upload Status', k: 'workflow_status', t: 'text', w: 22 },
  { h: 'Books ITC Decision', k: 'itc_decision', t: 'text', w: 18 },
];

export async function runImsReport(name: string, f: ImsFilterScope): Promise<{
  title: string;
  columns: Column[];
  rows: Array<Record<string, any>>;
} | null> {
  const def = IMS_REPORTS_CATALOG.find((r) => r.id === name);
  if (!def) return null;
  const gstins = resolveGstinScope(f);

  const enrichRecon = (rows: any[]) =>
    rows.map((r) => ({
      ...r,
      doc_type_display: r.ims_doc_type || r.books_doc_type || '',
      supplier_gstin_display: r.ims_supplier_gstin || r.books_supplier_gstin || '',
      supplier_name_display: r.ims_supplier_name || r.books_party_name || '',
    }));

  if (name === 'ims-error-report') {
    const rows = await withClient(async (c) => {
      const p: unknown[] = [];
      const w = gstins ? (p.push(gstins), 'WHERE our_gstin = ANY($1::text[])') : gstins === null ? '' : 'WHERE FALSE';
      return (await c.query(`SELECT * FROM ims_error_reports ${w} ORDER BY imported_at DESC`, p)).rows;
    });
    return {
      title: def.title,
      columns: [
        { h: 'ID', k: 'id', t: 'int', w: 10 },
        { h: 'Our GSTIN', k: 'our_gstin', t: 'gstin', w: 18 },
        { h: 'Supplier GSTIN', k: 'supplier_gstin', t: 'gstin', w: 18 },
        { h: 'Document No', k: 'document_no', t: 'text', w: 20 },
        { h: 'Portal Matching Key', k: 'portal_matching_key', t: 'text', w: 28 },
        { h: 'Error Code', k: 'error_code', t: 'text', w: 16 },
        { h: 'Error Message', k: 'error_message', t: 'text', w: 40 },
        { h: 'Source File', k: 'source_file', t: 'text', w: 24 },
        { h: 'Resolution Status', k: 'resolution_status', t: 'text', w: 18 },
        { h: 'Imported By', k: 'imported_by', t: 'text', w: 16 },
        { h: 'Imported At', k: 'imported_at', t: 'datetime', w: 20 },
      ],
      rows,
    };
  }

  if (name === 'ims-import-history') {
    const rows = await listImsBatches(f.allowedGstins);
    return {
      title: def.title,
      columns: [
        { h: 'Batch ID', k: 'id', t: 'int', w: 10 },
        { h: 'Batch UID', k: 'batch_uid', t: 'text', w: 24 },
        { h: 'GSTIN', k: 'our_gstin', t: 'gstin', w: 18 },
        { h: 'File Name', k: 'file_name', t: 'text', w: 30 },
        { h: 'Format', k: 'file_format', t: 'text', w: 10 },
        { h: 'Total', k: 'total_records', t: 'int', w: 10 },
        { h: 'Accepted', k: 'accepted_records', t: 'int', w: 10 },
        { h: 'Duplicate', k: 'duplicate_records', t: 'int', w: 10 },
        { h: 'Rejected', k: 'rejected_records', t: 'int', w: 10 },
        { h: 'Imported By', k: 'imported_by', t: 'text', w: 16 },
        { h: 'Imported At', k: 'imported_at', t: 'datetime', w: 20 },
      ],
      rows,
    };
  }

  if (name === 'ims-audit-trail') {
    const rows = await withClient(async (c) => {
      const p: unknown[] = [];
      const w = gstins ? (p.push(gstins), 'WHERE our_gstin = ANY($1::text[])') : gstins === null ? '' : 'WHERE FALSE';
      return (await c.query(`SELECT * FROM ims_audit_trail ${w} ORDER BY ts DESC LIMIT 1000`, p)).rows;
    });
    return {
      title: def.title,
      columns: [
        { h: 'Timestamp', k: 'ts', t: 'datetime', w: 20 },
        { h: 'Actor', k: 'actor', t: 'text', w: 16 },
        { h: 'Event', k: 'event_type', t: 'text', w: 24 },
        { h: 'GSTIN', k: 'our_gstin', t: 'gstin', w: 18 },
        { h: 'IMS Doc ID', k: 'ims_doc_id', t: 'int', w: 12 },
        { h: 'Old Value', k: 'old_value', t: 'text', w: 24 },
        { h: 'New Value', k: 'new_value', t: 'text', w: 24 },
        { h: 'Reason / Remarks', k: 'reason', t: 'text', w: 36 },
      ],
      rows,
    };
  }

  if (name === 'portal-upload-status') {
    const rows = await listImsUploadBatches(f.allowedGstins);
    return {
      title: def.title,
      columns: [
        { h: 'Batch Ref', k: 'batch_ref', t: 'text', w: 24 },
        { h: 'Our GSTIN', k: 'our_gstin', t: 'gstin', w: 18 },
        { h: 'Mode', k: 'mode', t: 'text', w: 22 },
        { h: 'Status', k: 'batch_status', t: 'text', w: 22 },
        { h: 'Total Docs', k: 'total_docs', t: 'int', w: 12 },
        { h: 'Success', k: 'success_count', t: 'int', w: 10 },
        { h: 'Failed', k: 'failed_count', t: 'int', w: 10 },
        { h: 'Pending', k: 'pending_count', t: 'int', w: 10 },
        { h: 'Portal Ack Ref', k: 'portal_ack_ref', t: 'text', w: 24 },
        { h: 'Approved By', k: 'approved_by', t: 'text', w: 16 },
        { h: 'Approved At', k: 'approved_at', t: 'datetime', w: 20 },
      ],
      rows,
    };
  }

  const { rows: rawAll } = await listImsReconDocuments({ ...f, limit: 5000, offset: 0 });
  const all = enrichRecon(rawAll);

  if (name === 'supplier-wise') {
    const grp = new Map<string, any>();
    for (const r of all) {
      const k = `${r.our_gstin}|${r.supplier_gstin_display}`;
      const cur = grp.get(k) || {
        our_gstin: r.our_gstin,
        supplier_gstin: r.supplier_gstin_display,
        supplier_name: r.supplier_name_display,
        docs: 0,
        matched: 0,
        mismatched: 0,
        ims_only: 0,
        books_only: 0,
        ims_taxable: 0,
        ims_tax: 0,
        books_taxable: 0,
        books_tax: 0,
      };
      cur.docs++;
      if (r.recon_status === 'MATCHED — IMS vs BOOKS' || r.recon_status === 'MANUALLY LINKED AFTER CONFIRMATION') cur.matched++;
      else if (r.recon_status === 'IMS ONLY') cur.ims_only++;
      else if (r.recon_status === 'BOOKS ONLY') cur.books_only++;
      else cur.mismatched++;
      if (r.ims_doc_id) {
        cur.ims_taxable = r2(cur.ims_taxable + Number(r.ims_taxable || 0));
        cur.ims_tax = r2(cur.ims_tax + Number(r.ims_total_tax || 0));
      }
      if (r.purchase_line_id) {
        cur.books_taxable = r2(cur.books_taxable + Number(r.books_taxable || 0));
        cur.books_tax = r2(cur.books_tax + Number(r.books_total_tax || 0));
      }
      grp.set(k, cur);
    }
    return {
      title: def.title,
      columns: [
        { h: 'Our GSTIN', k: 'our_gstin', t: 'gstin', w: 18 },
        { h: 'Supplier GSTIN', k: 'supplier_gstin', t: 'gstin', w: 18 },
        { h: 'Supplier Name', k: 'supplier_name', t: 'text', w: 28 },
        { h: 'Total Records', k: 'docs', t: 'int', w: 12 },
        { h: 'Matched', k: 'matched', t: 'int', w: 10 },
        { h: 'Mismatched', k: 'mismatched', t: 'int', w: 12 },
        { h: 'IMS Only', k: 'ims_only', t: 'int', w: 10 },
        { h: 'Books Only', k: 'books_only', t: 'int', w: 12 },
        { h: 'IMS Taxable', k: 'ims_taxable', t: 'money', w: 16 },
        { h: 'IMS Tax', k: 'ims_tax', t: 'money', w: 16 },
        { h: 'Books Taxable', k: 'books_taxable', t: 'money', w: 16 },
        { h: 'Books Tax', k: 'books_tax', t: 'money', w: 16 },
      ],
      rows: [...grp.values()],
    };
  }

  if (name === 'matching-key-wise') {
    const sorted = [...all].sort((a, b) =>
      String(a.portal_matching_key || a.internal_match_key).localeCompare(String(b.portal_matching_key || b.internal_match_key)),
    );
    return { title: def.title, columns: RECON_COLS, rows: sorted };
  }

  let filtered = all;
  if (name === 'ims-matched') {
    filtered = all.filter((r) => r.recon_status === 'MATCHED — IMS vs BOOKS' || r.recon_status === 'MANUALLY LINKED AFTER CONFIRMATION');
  } else if (name === 'ims-only') {
    filtered = all.filter((r) => r.recon_status === 'IMS ONLY');
  } else if (name === 'books-only') {
    filtered = all.filter((r) => r.recon_status === 'BOOKS ONLY');
  } else if (name === 'tax-mismatch') {
    filtered = all.filter((r) => r.recon_status === 'MATCHED WITH TAX DIFFERENCE' || r.recon_status === 'MATCHED WITH TAXABLE DIFFERENCE');
  } else if (name === 'doc-mismatch') {
    filtered = all.filter((r) =>
      r.recon_status === 'MATCHED WITH DOCUMENT DATE DIFFERENCE' ||
      r.recon_status === 'DOCUMENT NUMBER MISMATCH' ||
      r.recon_status === 'SUPPLIER GSTIN MISMATCH' ||
      r.recon_status === 'DOCUMENT TYPE MISMATCH',
    );
  } else if (name === 'credit-note-recon') {
    filtered = all.filter((r) => r.doc_type_display === 'Credit Note');
  } else if (name === 'debit-note-recon') {
    filtered = all.filter((r) => r.doc_type_display === 'Debit Note');
  } else if (name === 'action-recommendation') {
    filtered = all.filter((r) => Boolean(r.ims_doc_id));
  } else if (name === 'actioned-docs') {
    filtered = all.filter((r) => Boolean(r.user_action) && r.user_action !== 'DO NOT TAKE ANY ACTION');
  } else if (name === 'non-actioned-docs') {
    filtered = all.filter((r) => Boolean(r.ims_doc_id) && (!r.user_action || r.user_action === 'DO NOT TAKE ANY ACTION'));
  }

  return { title: def.title, columns: RECON_COLS, rows: filtered };
}

export async function runImsReportWorkbook(name: string, f: ImsFilterScope): Promise<{
  fileName: string;
  buffer: Buffer;
} | null> {
  const rep = await runImsReport(name, f);
  if (!rep) return null;
  const buf = toWorkbookBuffer(rep.title, rep.columns, rep.rows, [
    `GSTIN Scope: ${f.gstin || 'All Permitted'}`,
    `Records: ${rep.rows.length}`,
  ]);
  return { fileName: `${name}.xlsx`, buffer: buf };
}

// ---------------------------------------------------------------------------
// 6. Part 10 — Combined Management View (Books + 2B + IMS + IMS Action + Separate ITC)
// ---------------------------------------------------------------------------

export async function getCombinedManagementView(f: ImsFilterScope): Promise<{
  total: number;
  rows: Array<Record<string, any>>;
}> {
  const gstins = resolveGstinScope(f);
  if (gstins && gstins.length === 0) return { total: 0, rows: [] };

  const periods =
    f.periodMode === 'all'
      ? []
      : expandSelectedPeriods({
          periodMode: f.periodMode ?? 'single',
          period: f.period,
          from: f.from,
          to: f.to,
          periods: f.periods,
        });

  return withClient(async (c) => {
    const params: unknown[] = [];
    const where: string[] = [];
    if (gstins) {
      params.push(gstins);
      where.push(`p.our_gstin = ANY($${params.length}::text[])`);
    }
    if (periods.length) {
      params.push(periods);
      where.push(`p.period = ANY($${params.length}::text[])`);
    }
    if (f.q) {
      params.push(`%${f.q.toLowerCase()}%`);
      where.push(
        `(LOWER(p.book_invoice_no) LIKE $${params.length}
          OR LOWER(COALESCE(p.party_name,'')) LIKE $${params.length}
          OR LOWER(p.book_supplier_gstin) LIKE $${params.length})`,
      );
    }

    const r = await c.query(
      `SELECT p.id::int AS purchase_line_id,
              p.our_gstin,
              p.period AS books_month,
              p.financial_year AS books_fy,
              p.book_document_type,
              p.book_invoice_no,
              p.book_invoice_date,
              p.book_supplier_gstin,
              p.party_name,
              p.book_taxable_value,
              (p.book_igst + p.book_cgst + p.book_sgst + p.book_cess) AS book_total_tax,
              -- Independent GSTR-2B status
              COALESCE(p.detailed_match_status, p.match_status, 'Pending Review') AS gstr2b_status,
              p.matched_2b_month,
              p.itc_difference AS gstr2b_tax_diff,
              -- Independent IMS status & action
              COALESCE(ims.recon_status, 'Not Reconciled in IMS') AS ims_status,
              COALESCE(ims.portal_matching_key, '') AS ims_portal_matching_key,
              ims.total_tax_diff AS ims_tax_diff,
              COALESCE(ims.user_action, ims.ims_source_action, 'NO ACTION') AS ims_action,
              COALESCE(ims.workflow_status, 'NOT READY') AS ims_upload_status,
              -- Separate Human ITC Decision
              p.itc_decision,
              p.itc_decision_month,
              p.return_classification
         FROM purchase_lines p
         LEFT JOIN LATERAL (
           SELECT ir.recon_status, ir.portal_matching_key, ir.total_tax_diff,
                  doc.ims_source_action, dec.user_action, dec.workflow_status
             FROM ims_recon_results ir
             JOIN ims_recon_runs run ON run.id = ir.run_id
             LEFT JOIN ims_documents doc ON doc.id = ir.ims_doc_id
             LEFT JOIN ims_action_decisions dec ON dec.ims_doc_id = ir.ims_doc_id
            WHERE ir.purchase_line_id = p.id
              AND run.id = (SELECT MAX(id) FROM ims_recon_runs r2 WHERE r2.our_gstin = p.our_gstin)
            ORDER BY ir.id DESC LIMIT 1
         ) ims ON true
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY p.our_gstin, p.period, p.book_supplier_gstin, p.book_invoice_no`,
      params,
    );

    const rows = r.rows.map((x: any) => ({
      ...x,
      book_invoice_date: x.book_invoice_date ? isoDate(x.book_invoice_date) : '',
      book_taxable_value: r2(x.book_taxable_value),
      book_total_tax: r2(x.book_total_tax),
    }));
    const limit = Math.min(f.limit ?? 5000, 5000);
    return { total: rows.length, rows: rows.slice(0, limit) };
  });
}

export const COMBINED_VIEW_COLUMNS: Column[] = [
  { h: 'Our GSTIN', k: 'our_gstin', t: 'gstin', w: 18 },
  { h: 'Books Month', k: 'books_month', t: 'period', w: 13 },
  { h: 'Books FY', k: 'books_fy', t: 'text', w: 13 },
  { h: 'Document Type', k: 'book_document_type', t: 'text', w: 14 },
  { h: 'Books Invoice No', k: 'book_invoice_no', t: 'text', w: 20 },
  { h: 'Books Date', k: 'book_invoice_date', t: 'date', w: 14 },
  { h: 'Supplier GSTIN', k: 'book_supplier_gstin', t: 'gstin', w: 18 },
  { h: 'Supplier Name', k: 'party_name', t: 'text', w: 28 },
  { h: 'Books Taxable', k: 'book_taxable_value', t: 'money', w: 16 },
  { h: 'Books Total Tax', k: 'book_total_tax', t: 'money', w: 16 },
  { h: 'GSTR-2B Status (Independent)', k: 'gstr2b_status', t: 'text', w: 28 },
  { h: '2B Month', k: 'matched_2b_month', t: 'period', w: 12 },
  { h: 'IMS Status (Independent)', k: 'ims_status', t: 'text', w: 28 },
  { h: 'IMS Portal Matching Key', k: 'ims_portal_matching_key', t: 'text', w: 24 },
  { h: 'IMS Action (Portal Workflow)', k: 'ims_action', t: 'text', w: 22 },
  { h: 'IMS Upload State', k: 'ims_upload_status', t: 'text', w: 20 },
  { h: 'ITC Decision (Separate Approval)', k: 'itc_decision', t: 'text', w: 22 },
  { h: 'ITC Claim Month', k: 'itc_decision_month', t: 'period', w: 14 },
  { h: 'Return Classification', k: 'return_classification', t: 'text', w: 20 },
];
