/**
 * What the purchase upload preview must say BEFORE the import button.
 *
 * The register is the one file where a wrong Document Type moves money in the
 * return: a credit note booked as an invoice adds the ITC it was meant to take
 * away, and the month's 4(A) figure is overstated by twice the note. So the
 * preview answers four questions separately:
 *
 *   how many of each document, how much the invoices + debit notes add, how
 *   much the credit notes take away, and what is left net.
 *
 * Pure: no database, no request, so the screen's numbers can be tested without
 * starting a server. The route formats this and adds the parser's warnings.
 */

import { normDocType, normGstin, normInvoice, r2, taxOf, type DocType, type PurchaseBill } from '../engine/core';

export interface AmountBlock {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  tax: number;
}

export interface DuplicateDocument {
  document_type: DocType;
  supplier_gstin: string;
  invoice_no: string;
  count: number;
}

export interface PurchaseDocSummary {
  documentTypes: { invoice: number; debit: number; credit: number };
  totals: {
    /** Tax Invoice + Debit Note only. */
    gross: AmountBlock;
    /** The magnitude credit notes reduce by (always positive here). */
    creditNotes: AmountBlock;
    /** Everything, signed — this is the month's net. */
    net: AmountBlock;
    netTax: number;
  };
  duplicates: DuplicateDocument[];
}

const zero = (): AmountBlock => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax: 0 });

function add(into: AmountBlock, b: PurchaseBill, sign: 1 | -1): void {
  const f = (n: number) => r2(Math.abs(r2(n)) * sign);
  into.taxable = r2(into.taxable + f(b.taxable_value));
  into.igst = r2(into.igst + f(b.igst));
  into.cgst = r2(into.cgst + f(b.cgst));
  into.sgst = r2(into.sgst + f(b.sgst));
  into.cess = r2(into.cess + f(b.cess));
  into.tax = r2(into.tax + Math.abs(taxOf(b)));
}

export function summarisePurchaseDocuments(rows: PurchaseBill[]): PurchaseDocSummary {
  const gross = zero();
  const creditNotes = zero();
  const net = zero();
  const documentTypes = { invoice: 0, debit: 0, credit: 0 };
  const dupes = new Map<string, DuplicateDocument>();

  for (const b of rows) {
    const type = normDocType(b.document_type);
    if (type === 'Credit Note') {
      documentTypes.credit++;
      add(creditNotes, b, 1);
    } else {
      if (type === 'Debit Note') documentTypes.debit++;
      else documentTypes.invoice++;
      add(gross, b, 1);
    }
    // The net block takes the stored sign as-is: for a credit note that is
    // negative, and a negative invoice (a sign conflict the parser reported)
    // must not be flipped into an addition here either.
    net.taxable = r2(net.taxable + r2(b.taxable_value));
    net.igst = r2(net.igst + r2(b.igst));
    net.cgst = r2(net.cgst + r2(b.cgst));
    net.sgst = r2(net.sgst + r2(b.sgst));
    net.cess = r2(net.cess + r2(b.cess));
    net.tax = r2(net.tax + taxOf(b));

    const key = `${normGstin(b.supplier_gstin)}|${normInvoice(b.invoice_no)}|${type}`;
    const seen = dupes.get(key);
    if (seen) seen.count++;
    else {
      dupes.set(key, {
        document_type: type,
        supplier_gstin: b.supplier_gstin,
        invoice_no: b.invoice_no,
        count: 1,
      });
    }
  }

  return {
    documentTypes,
    totals: {
      gross,
      creditNotes,
      net,
      netTax: net.tax,
    },
    duplicates: [...dupes.values()].filter((d) => d.count > 1),
  };
}
