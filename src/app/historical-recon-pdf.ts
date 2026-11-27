/**
 * GST Control ERP — Phase 5: Consultant-Format Executive PDF Generator (`pdfkit`).
 *
 * Consumes the exact same `HistoricalReconReport` object as the 7-sheet Excel
 * builder, guaranteeing ₹0.00 mathematical parity between JSON, Excel, and PDF.
 *
 * Features:
 *   - A4 Landscape professional consultant layout with crisp header banner
 *   - Repeating column headers across automatic page breaks
 *   - Page numbers (`Page X of Y`) on every page via `bufferPages: true`
 *   - Sections: Executive Summary & KPIs, 13-Bucket Reconciliation Summary,
 *     Month-wise Movement, Supplier-wise Summary, Mismatch & Pending Details,
 *     Historical Books Bill-wise Register, and GSTR-2B Only Register.
 */

import PDFDocument from 'pdfkit';
import { r2 } from '../engine/core';
import type { HistoricalReconReport } from './historical-recon-report';

function fmtAmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const v = r2(n);
  const abs = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `-${abs}` : abs;
}

interface PdfCol {
  label: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

export function buildHistoricalReconPdf(report: HistoricalReconReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 28,
      bufferPages: true,
      info: {
        Title: `Historical Bill-wise GST Reconciliation — ${report.meta.companyLabel}`,
        Author: 'GST Control ERP',
        Subject: `Purchase Register vs GSTR-2B Reconciliation (${report.meta.fyLabel})`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right; // ~785pt
    const leftX = doc.page.margins.left;
    const bottomLimit = doc.page.height - doc.page.margins.bottom - 22;

    const drawBanner = () => {
      doc.save();
      doc.rect(leftX, 24, pageW, 56).fill('#0f172a');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(14)
        .text('GST CONTROL ERP — HISTORICAL BILL-WISE RECONCILIATION REPORT', leftX + 12, 32, { width: pageW - 24 });
      doc.fillColor('#cbd5e1').font('Helvetica').fontSize(8.5)
        .text(
          `Company: ${report.meta.companyLabel}   |   GSTIN: ${report.meta.gstinLabel}   |   FY: ${report.meta.fyLabel}   |   Reporting Date: ${report.meta.reportingDate}`,
          leftX + 12, 52, { width: pageW - 24 },
        );
      doc.fillColor('#94a3b8').fontSize(7.5)
        .text(`Scope: ${report.meta.filterSummary}   |   Parity Validated: ${report.allParityOk ? 'PASS (10/10)' : 'CHECK'}`, leftX + 12, 65, { width: pageW - 24 });
      doc.restore();
      doc.y = 90;
    };

    const drawSectionHeading = (title: string) => {
      if (doc.y > bottomLimit - 60) doc.addPage();
      doc.moveDown(0.4);
      const y = doc.y;
      doc.save();
      doc.rect(leftX, y, pageW, 18).fill('#eef2ff');
      doc.fillColor('#1e1b4b').font('Helvetica-Bold').fontSize(9.5).text(title, leftX + 8, y + 4, { width: pageW - 16 });
      doc.restore();
      doc.y = y + 22;
    };

    const drawTable = (cols: PdfCol[], rows: string[][], totalRow?: string[]) => {
      const rowH = 15;
      const drawHeader = () => {
        const y = doc.y;
        doc.save();
        doc.rect(leftX, y, pageW, 16).fill('#1e293b');
        let x = leftX;
        doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.2);
        for (const col of cols) {
          doc.text(col.label, x + 3, y + 4, { width: col.width - 6, align: col.align || 'left', ellipsis: true, lineBreak: false });
          x += col.width;
        }
        doc.restore();
        doc.y = y + 16;
      };

      if (doc.y > bottomLimit - 40) doc.addPage();
      drawHeader();

      for (let i = 0; i < rows.length; i++) {
        if (doc.y + rowH > bottomLimit) {
          doc.addPage();
          drawHeader();
        }
        const y = doc.y;
        if (i % 2 === 1) {
          doc.save();
          doc.rect(leftX, y, pageW, rowH).fill('#f8fafc');
          doc.restore();
        }
        let x = leftX;
        doc.fillColor('#0f172a').font('Helvetica').fontSize(7);
        for (let c = 0; c < cols.length; c++) {
          doc.text(rows[i][c] ?? '', x + 3, y + 3.5, {
            width: cols[c].width - 6,
            align: cols[c].align || 'left',
            ellipsis: true,
            lineBreak: false,
          });
          x += cols[c].width;
        }
        doc.save();
        doc.moveTo(leftX, y + rowH).lineTo(leftX + pageW, y + rowH).lineWidth(0.3).strokeColor('#e2e8f0').stroke();
        doc.restore();
        doc.y = y + rowH;
      }

      if (totalRow) {
        if (doc.y + rowH + 2 > bottomLimit) {
          doc.addPage();
          drawHeader();
        }
        const y = doc.y;
        doc.save();
        doc.rect(leftX, y, pageW, rowH + 2).fill('#e0e7ff');
        let x = leftX;
        doc.fillColor('#1e1b4b').font('Helvetica-Bold').fontSize(7.3);
        for (let c = 0; c < cols.length; c++) {
          doc.text(totalRow[c] ?? '', x + 3, y + 4, {
            width: cols[c].width - 6,
            align: cols[c].align || 'left',
            ellipsis: true,
            lineBreak: false,
          });
          x += cols[c].width;
        }
        doc.restore();
        doc.y = y + rowH + 4;
      }
    };

    // 1. Header Banner + KPI Strip
    drawBanner();
    const kpis = [
      { k: 'Books Docs', v: String(report.booksSummary.docs) },
      { k: 'Books Taxable (INR)', v: fmtAmt(report.booksSummary.taxableValue) },
      { k: 'Books Total GST', v: fmtAmt(report.booksSummary.totalGst) },
      { k: 'GSTR-2B Docs', v: String(report.twobSummary.docs) },
      { k: 'Recon % (Count)', v: `${report.controlTotals.reconPctByCount}%` },
      { k: 'Recon % (Value)', v: `${report.controlTotals.reconPctByTaxable}%` },
    ];
    const kpiW = (pageW - 25) / 6;
    const ky = doc.y;
    kpis.forEach((kp, idx) => {
      const kx = leftX + idx * (kpiW + 5);
      doc.save();
      doc.roundedRect(kx, ky, kpiW, 34, 4).fillAndStroke('#f8fafc', '#cbd5e1');
      doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(6.8).text(kp.k.toUpperCase(), kx + 6, ky + 5, { width: kpiW - 12 });
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10).text(kp.v, kx + 6, ky + 16, { width: kpiW - 12 });
      doc.restore();
    });
    doc.y = ky + 40;

    // 2. Executive Population Summary (Books vs GSTR-2B — all 8 heads separated)
    drawSectionHeading('1. Executive Summary — Books vs GSTR-2B Population (UTGST Separated)');
    drawTable(
      [
        { label: 'Source Population', width: 155 },
        { label: 'Docs', width: 45, align: 'right' },
        { label: 'Invoice Value', width: 85, align: 'right' },
        { label: 'Taxable Value', width: 85, align: 'right' },
        { label: 'IGST', width: 70, align: 'right' },
        { label: 'CGST', width: 70, align: 'right' },
        { label: 'SGST', width: 70, align: 'right' },
        { label: 'UTGST', width: 70, align: 'right' },
        { label: 'Cess', width: 55, align: 'right' },
        { label: 'Total GST', width: 80, align: 'right' },
      ],
      [
        [
          'Purchase Register (Books)',
          String(report.booksSummary.docs),
          fmtAmt(report.booksSummary.invoiceValue),
          fmtAmt(report.booksSummary.taxableValue),
          fmtAmt(report.booksSummary.igst),
          fmtAmt(report.booksSummary.cgst),
          fmtAmt(report.booksSummary.sgst),
          fmtAmt(report.booksSummary.utgst),
          fmtAmt(report.booksSummary.cess),
          fmtAmt(report.booksSummary.totalGst),
        ],
        [
          'GSTR-2B Portal (Canonical)',
          String(report.twobSummary.docs),
          fmtAmt(report.twobSummary.invoiceValue),
          fmtAmt(report.twobSummary.taxableValue),
          fmtAmt(report.twobSummary.igst),
          fmtAmt(report.twobSummary.cgst),
          fmtAmt(report.twobSummary.sgst),
          fmtAmt(report.twobSummary.utgst),
          fmtAmt(report.twobSummary.cess),
          fmtAmt(report.twobSummary.totalGst),
        ],
      ],
    );

    // 3. 13-Bucket Reconciliation Summary
    drawSectionHeading('2. Reconciliation Category Summary (Mutually Exclusive — Zero Double-Counting)');
    drawTable(
      [
        { label: 'Reconciliation Category', width: 205 },
        { label: 'Side', width: 55, align: 'center' },
        { label: 'Docs', width: 45, align: 'right' },
        { label: 'Invoice Value', width: 80, align: 'right' },
        { label: 'Taxable Value', width: 80, align: 'right' },
        { label: 'Total GST', width: 75, align: 'right' },
        { label: 'Diff Taxable', width: 75, align: 'right' },
        { label: 'Diff GST', width: 70, align: 'right' },
        { label: '% Cnt', width: 50, align: 'right' },
        { label: '% Val', width: 50, align: 'right' },
      ],
      report.reconciliationSummary.map((x) => [
        x.bucket, x.side, String(x.docs), fmtAmt(x.invoiceValue), fmtAmt(x.taxableValue),
        fmtAmt(x.totalGst), fmtAmt(x.diffTaxable), fmtAmt(x.diffGst), `${x.pctByCount}%`, `${x.pctByValue}%`,
      ]),
    );

    // 4. Month-wise Reconciliation Movement
    drawSectionHeading('3. Month-wise Reconciliation Movement (Grouped by Original Books Month)');
    drawTable(
      [
        { label: 'Books Month', width: 75 },
        { label: 'FY', width: 60 },
        { label: 'Docs', width: 45, align: 'right' },
        { label: 'Books Taxable', width: 90, align: 'right' },
        { label: 'Books GST', width: 80, align: 'right' },
        { label: 'Same M', width: 50, align: 'right' },
        { label: 'Subseq M', width: 55, align: 'right' },
        { label: 'Cross-FY', width: 55, align: 'right' },
        { label: 'Corrected', width: 55, align: 'right' },
        { label: 'With Diff', width: 55, align: 'right' },
        { label: 'Books Only', width: 65, align: 'right' },
        { label: 'Recon %', width: 100, align: 'right' },
      ],
      report.monthMovement.map((m) => [
        `${m.booksMonth} (${m.label})`, m.booksFy, String(m.totalDocs), fmtAmt(m.totalTaxable), fmtAmt(m.totalGst),
        String(m.sameMonthDocs), String(m.subseqMonthDocs), String(m.subseqFyDocs), String(m.afterCorrDocs),
        String(m.withDiffDocs), String(m.pendingBooksOnlyDocs), `${m.reconPctByCount}% / ${m.reconPctByValue}%`,
      ]),
      [
        'TOTAL', '', String(report.booksSummary.docs), fmtAmt(report.booksSummary.taxableValue), fmtAmt(report.booksSummary.totalGst),
        String(report.monthMovement.reduce((s, m) => s + m.sameMonthDocs, 0)),
        String(report.monthMovement.reduce((s, m) => s + m.subseqMonthDocs, 0)),
        String(report.monthMovement.reduce((s, m) => s + m.subseqFyDocs, 0)),
        String(report.monthMovement.reduce((s, m) => s + m.afterCorrDocs, 0)),
        String(report.monthMovement.reduce((s, m) => s + m.withDiffDocs, 0)),
        String(report.monthMovement.reduce((s, m) => s + m.pendingBooksOnlyDocs, 0)),
        `${report.controlTotals.reconPctByCount}% / ${report.controlTotals.reconPctByTaxable}%`,
      ],
    );

    // 5. Supplier-wise Summary
    drawSectionHeading('4. Supplier-wise Reconciliation Summary');
    drawTable(
      [
        { label: 'Supplier GSTIN', width: 105 },
        { label: 'Supplier Name', width: 145 },
        { label: 'Docs', width: 40, align: 'right' },
        { label: 'Books Taxable', width: 85, align: 'right' },
        { label: 'Books GST', width: 75, align: 'right' },
        { label: '2B Taxable', width: 85, align: 'right' },
        { label: 'Matched Val', width: 80, align: 'right' },
        { label: 'Books Only', width: 75, align: 'right' },
        { label: 'Pend', width: 40, align: 'right' },
        { label: 'Age(d)', width: 55, align: 'right' },
      ],
      report.supplierSummary.map((s) => [
        s.supplierGstin, s.supplierName, String(s.booksDocs), fmtAmt(s.booksTaxable), fmtAmt(s.booksGst),
        fmtAmt(s.twobTaxable), fmtAmt(s.fullyMatchedTaxable), fmtAmt(s.onlyInBooksTaxable),
        String(s.pendingCount), s.oldestPendingAgeDays !== null ? String(s.oldestPendingAgeDays) : '—',
      ]),
    );

    // 6. Mismatch & Pending Details
    drawSectionHeading(`5. Mismatch & Pending Details (${report.mismatchAndPending.length} Records)`);
    drawTable(
      [
        { label: 'Books M', width: 55 },
        { label: 'Supplier GSTIN', width: 100 },
        { label: 'Books Inv No', width: 95 },
        { label: 'Doc Type', width: 65 },
        { label: 'Books Taxable', width: 75, align: 'right' },
        { label: 'Books GST', width: 65, align: 'right' },
        { label: '2B Taxable', width: 75, align: 'right' },
        { label: 'Diff GST', width: 65, align: 'right' },
        { label: 'Status', width: 100 },
        { label: 'Reasons', width: 90 },
      ],
      report.mismatchAndPending.map((b) => [
        b.booksMonth, b.supplierGstin, b.originalBooksInvNo, b.docType,
        fmtAmt(b.taxableValue), fmtAmt(b.totalGst), fmtAmt(b.twobTaxable), fmtAmt(b.diffGst),
        b.bucket, b.mismatchReasons.join(', ') || b.reasonRemarks,
      ]),
    );

    // 7. Complete Historical Books Bill-wise Register
    drawSectionHeading(`6. Complete Historical Books Bill-wise Register (${report.booksRegister.length} Records)`);
    drawTable(
      [
        { label: 'Books M', width: 42 },
        { label: '2B M', width: 42 },
        { label: 'Supplier GSTIN', width: 82 },
        { label: 'Books Inv No', width: 74 },
        { label: 'Type', width: 46 },
        { label: 'Inv Val', width: 58, align: 'right' },
        { label: 'Taxable', width: 58, align: 'right' },
        { label: 'IGST', width: 48, align: 'right' },
        { label: 'CGST', width: 44, align: 'right' },
        { label: 'SGST', width: 44, align: 'right' },
        { label: 'UTGST', width: 44, align: 'right' },
        { label: 'Cess', width: 42, align: 'right' },
        { label: 'Total GST', width: 56, align: 'right' },
        { label: 'Status', width: 105 },
      ],
      report.booksRegister.map((b) => [
        b.booksMonth, b.actual2bMonth || '—', b.supplierGstin, b.originalBooksInvNo, b.docType,
        fmtAmt(b.originalBooksInvValue), fmtAmt(b.taxableValue), fmtAmt(b.igst), fmtAmt(b.cgst),
        fmtAmt(b.sgst), fmtAmt(b.utgst), fmtAmt(b.cess), fmtAmt(b.totalGst), b.bucket,
      ]),
      [
        'TOTAL', '', '', `${report.booksSummary.docs} docs`, '',
        fmtAmt(report.booksSummary.invoiceValue), fmtAmt(report.booksSummary.taxableValue),
        fmtAmt(report.booksSummary.igst), fmtAmt(report.booksSummary.cgst),
        fmtAmt(report.booksSummary.sgst), fmtAmt(report.booksSummary.utgst),
        fmtAmt(report.booksSummary.cess), fmtAmt(report.booksSummary.totalGst), '',
      ],
    );

    // 8. GSTR-2B Only Register
    drawSectionHeading(`7. GSTR-2B Only Register — Unbooked Portal Documents (${report.twobOnlyRegister.length} Records)`);
    drawTable(
      [
        { label: '2B Month', width: 60 },
        { label: 'Supplier GSTIN', width: 105 },
        { label: 'Supplier Name', width: 135 },
        { label: 'Doc No', width: 95 },
        { label: 'Date', width: 65 },
        { label: 'Type', width: 65 },
        { label: 'Taxable', width: 75, align: 'right' },
        { label: 'UTGST', width: 55, align: 'right' },
        { label: 'Total GST', width: 65, align: 'right' },
        { label: 'Status', width: 65 },
      ],
      report.twobOnlyRegister.map((t) => [
        t.twobMonth, t.supplierGstin, t.supplierName, t.docNo, t.docDate || '—', t.docType,
        fmtAmt(t.taxableValue), fmtAmt(t.utgst), fmtAmt(t.totalGst), t.pendingStatus,
      ]),
      [
        'TOTAL', '', '', `${report.twobOnlyRegister.length} docs`, '', '',
        fmtAmt(report.controlTotals.twobUnmatchedTaxable),
        fmtAmt(r2(report.twobOnlyRegister.reduce((s, t) => s + t.utgst, 0))),
        fmtAmt(report.controlTotals.twobUnmatchedGst), '',
      ],
    );

    // Add Page X of Y footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.save();
      doc.fillColor('#64748b').font('Helvetica').fontSize(7.5).text(
        `GST Control ERP — Confidential Tax Working   |   Page ${i + 1} of ${range.count}`,
        leftX,
        doc.page.height - 22,
        { width: pageW, align: 'right', lineBreak: false },
      );
      doc.restore();
    }

    doc.end();
  });
}
