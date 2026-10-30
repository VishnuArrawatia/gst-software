/**
 * The standard purchase register template.
 *
 * Accounts keeps re-typing the same register in slightly different column
 * orders. The parser matches columns by name, not position, so a template is
 * what removes the guesswork: the header spellings below are the *canonical*
 * ones, and every one of them is an alias the parser recognises.
 *
 * The file is generated rather than checked in so the header list can never
 * drift away from `FIELD_ALIASES` — a test asserts the two agree.
 *
 * CREDIT / DEBIT NOTES
 *   One register holds all three document kinds. The user picks the type from a
 *   dropdown and types every amount POSITIVE, exactly as printed. The sheet
 *   shows the sign effect and the signed figures so the arithmetic is visible
 *   before upload, and the importer recomputes the same sign from the type —
 *   the calculated columns are for the human, never trusted as input.
 */

import XLSX from 'xlsx';
import { addListValidations, polishWorkbook } from './xlsx-format';
import { DOC_TYPES } from '../engine/core';

/** One column of the template: the header to print and why it is needed. */
export interface TemplateColumn {
  /** Exact header to print in the sheet. */
  header: string;
  /** Shown in the Instructions sheet. */
  note: string;
  /** Whether the parser refuses a row without it. */
  required: boolean;
  /** Placeholder written into the example row. */
  sample: string;
  /**
   * Computed by a formula in the sheet. The importer ignores it (it recomputes
   * the sign from the document type), so a user who overwrites it cannot move a
   * rupee — and a test skips these when checking that every template header is
   * a field the parser reads.
   */
  derived?: boolean;
}

/**
 * The canonical order. `our_gstin` comes first because without it a row cannot
 * be attributed to a company or a unit; `supplier_gstin` and `invoice_no`
 * together identify the document the way GSTR-2B does, and `document_type`
 * decides which way its money moves.
 */
export const PURCHASE_TEMPLATE_COLUMNS: TemplateColumn[] = [
  { header: 'Our GSTIN', required: true, sample: '26AALCS9985J1ZC',
    note: 'Aapki company ka GSTIN. Har row me zaroori — iske bina row kis unit ko jayegi, ye pata nahi chalta.' },
  { header: 'Our Location No.', required: false, sample: 'Sakar-I',
    note: 'Apne unit / plant / branch ka code ya naam — jaise "Sakar-I" ya plant code "1000". Optional. ' +
      'GSTIN ke saath milkar batata hai ki kaunsa unit kharid raha hai, isliye GSTIN-wise consolidation me helpful hai.' },
  { header: 'Period', required: false, sample: '2026-04',
    note: 'Jis GST month ki books me ye row jaani hai — YYYY-MM (jaise 2026-04). ' +
      'EK FILE ME KAI MAHINE chalte hain: har row apne Period se apne mahine me jaati hai, isliye 12 mahine ek hi upload me ho sakte hain. ' +
      'Khaali chhodne par Document Date se month nikal liya jaata hai (aur wo date na ho to Book Entry Date se). ' +
      'Yeh books ka month hai — GSTR-2B ka month nahi; 2B to apni file se aata hai.' },
  { header: 'Document Type', required: false, sample: 'Tax Invoice',
    note: 'Dropdown se chuniye: Tax Invoice / Debit Note / Credit Note. Yahi decide karta hai ki amount ' +
      'jodna hai ya ghatana. Invoice aur Debit Note ka sign +, Credit Note ka sign −. ' +
      'Aliases bhi chalte hain (Invoice, Purchase Invoice, DN, CN) — lekin jo type samajh nahi aaya, ' +
      'wo row REJECT hogi, chupchaap invoice nahi maani jayegi.' },
  { header: 'Document Number', required: true, sample: 'INV-889012',
    note: 'Supplier ka invoice / note number. GSTR-2B se match isi se hota hai. Purane file me "Invoice No" ' +
      'likha ho to bhi chalega.' },
  { header: 'Document Date', required: false, sample: '2026-04-15',
    note: 'Supplier ke document ki date. YYYY-MM-DD. Month (period) isse banta hai, isliye dene se accha hai. ' +
      'Purane file me "Invoice Date" bhi chalega.' },
  { header: 'Book Entry Date', required: false, sample: '2026-04-20',
    note: 'Jis date par hamari books me entry hui. Supplier ki document date se ALAG ho sakti hai — ' +
      'yehi woh gap hai jisse koi purchase ek mahine ki books me aur doosre mahine ki GSTR-2B me dikhta hai. ' +
      'Bahut se register me yehi date PO/GRN Reference ki date bhi hoti hai, isliye alag Reference Date column nahi hai. ' +
      'YYYY-MM-DD. Isse book ka mahina nikal jaata hai.' },
  { header: 'Reference No', required: false, sample: 'PO-4500123456',
    note: 'PO ya GRN reference — document number se ALAG. Reconciliation document number se match karta hai, ' +
      'isliye ye kabhi document number ki jagah use nahi hoga.' },
  { header: 'Supplier GSTIN', required: true, sample: '27AAFCC9473R1ZP',
    note: 'Supplier ka 15-digit GSTIN. Iske bina row skip ho jaati hai.' },
  { header: 'Supplier Name', required: false, sample: 'CROMPTON GREAVES',
    note: 'Supplier ka naam — sirf reports aur follow-up me dikhta hai.' },
  { header: 'Taxable Amount', required: true, sample: '100000.00',
    note: 'IGST/CGST/SGST se pehle ka amount. HAMESHA POSITIVE likhiye — sign Document Type se lagega. ' +
      'Agar source file me pehle se minus laga hai to wahi rehne dijiye: system use dobara negate nahi karta.' },
  { header: 'IGST', required: false, sample: '18000.00',
    note: 'Integrated tax. Positive likhiye; Credit Note ka minus system lagayega.' },
  { header: 'CGST', required: false, sample: '0.00', note: 'Central tax.' },
  { header: 'SGST/UTGST', required: false, sample: '0.00', note: 'State/UT tax.' },
  { header: 'Cess', required: false, sample: '0.00', note: 'Health & education cess.' },
  { header: 'Reverse Charge', required: false, sample: 'No',
    note: 'Yes / No. Agar inward supply Reverse Charge Mechanism (RCM) me aati hai to Yes likhein — GSTR-3B Table 3.1(d) aur Table 4(A)(3) me jaata hai.' },
  { header: 'HSN', required: false, sample: '8536',
    note: 'Goods ka HSN ya services ka SAC code (4 / 6 / 8 digits). Optional.' },
  { header: 'Remarks', required: false, sample: '',
    note: 'Koi bhi note — follow-up list me dikhta hai.' },
  { header: 'E-Invoice', required: false, sample: 'Yes',
    note: 'Yes / No / khaali. Is invoice par e-invoice (IRN) bana ya nahi. GSTR-2B me ye nahi hota, isliye yahin se darj hota hai. Khaali mat chhodein — reconciliation me dekhna hai.' },
  { header: 'E-Invoice IRN', required: false, sample: 'a1b2c3d4e5f6...',
    note: 'Supplier ka IRN / IRN hash. E-Invoice = Yes ho tabhi bharein.' },
  { header: 'E-Way Bill', required: false, sample: 'Yes',
    note: 'Yes / No / khaali. Is invoice par e-way bill bana ya nahi. GSTR-2B me ye bhi nahi hota.' },
  { header: 'E-Way Bill No', required: false, sample: '361012345678',
    note: 'E-way bill number (16 digits). E-Way Bill = Yes ho tabhi bharein.' },
  { header: 'Sign Effect', derived: true, required: false, sample: '',
    note: 'CALCULATED (formula). Tax Invoice / Debit Note = +1, Credit Note = −1. Ise badalne ki zaroorat nahi; ' +
      'import ke waqt system Document Type se sign dobara khud lagata hai.' },
  { header: 'Signed Taxable Amount', derived: true, required: false, sample: '',
    note: 'CALCULATED (formula) = Taxable Amount × Sign Effect.' },
  { header: 'Signed IGST', derived: true, required: false, sample: '',
    note: 'CALCULATED (formula) = IGST × Sign Effect.' },
  { header: 'Signed CGST', derived: true, required: false, sample: '',
    note: 'CALCULATED (formula) = CGST × Sign Effect.' },
  { header: 'Signed SGST/UTGST', derived: true, required: false, sample: '',
    note: 'CALCULATED (formula) = SGST/UTGST × Sign Effect.' },
  { header: 'Signed Cess', derived: true, required: false, sample: '',
    note: 'CALCULATED (formula) = Cess × Sign Effect.' },
  { header: 'Signed Total Tax', derived: true, required: false, sample: '',
    note: 'CALCULATED (formula) = Signed IGST + CGST + SGST/UTGST + Cess. Credit Note me ye negative aayega.' },
];

export interface PurchaseTemplateOptions {
  /** Repeated on the Instructions sheet, e.g. "Sakar" or "SVN Opto". */
  companyName?: string;
  /** How many rows carry the calculated columns. Default 500. */
  formulaRows?: number;
}

/** Excel column letters: A..Z, AA.. (the template is 27 columns). */
function colLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Column letter of a header, so formulas never hard-code a position. */
function letterOf(header: string): string {
  const i = PURCHASE_TEMPLATE_COLUMNS.findIndex((c) => c.header === header);
  if (i < 0) throw new Error(`template: no column "${header}"`);
  return colLetter(i);
}

/**
 * The calculated block for row `r`.
 *
 * A blank Document Type gives blank cells instead of a misleading zero, and a
 * Credit Note flips the magnitude to negative — the same rule the importer
 * applies, so what the sheet shows is what will be stored.
 */
function signedFormulas(r: number): string[] {
  const type = `$${letterOf('Document Type')}${r}`;
  const source = (h: string) => `$${letterOf(h)}${r}`;
  const isCredit = `${type}="Credit Note"`;
  const signed = (h: string) => `IF(${isCredit},-ABS(${source(h)}),${source(h)})`;
  const blank = `IF(${type}="","",`;
  const igst = letterOf('Signed IGST');
  const cgst = letterOf('Signed CGST');
  const sgst = letterOf('Signed SGST/UTGST');
  const cess = letterOf('Signed Cess');
  return [
    `${blank}IF(${isCredit},-1,IF(OR(${type}="Tax Invoice",${type}="Debit Note"),1,"")))`,
    `${blank}${signed('Taxable Amount')})`,
    `${blank}${signed('IGST')})`,
    `${blank}${signed('CGST')})`,
    `${blank}${signed('SGST/UTGST')})`,
    `${blank}${signed('Cess')})`,
    `${blank}ROUND(${igst}${r}+${cgst}${r}+${sgst}${r}+${cess}${r},2))`,
  ];
}

/** The workbook the accounts team fills in and uploads back. */
export function purchaseTemplateBuffer(opts: PurchaseTemplateOptions = {}): Buffer {
  const wb = XLSX.utils.book_new();

  // ---- Instructions ------------------------------------------------------
  const head = [
    ['GST CONTROL ERP — PURCHASE REGISTER TEMPLATE'],
    [],
    ['Is file me SAP ka purchase register bhar kar wahi upload kar dijiye.'],
    ['Har mahine nayi file banani zaroori nahi — isi template ko copy kar lijiye.'],
    [],
    ['Zaroori baatein:'],
    ['1.  Header row ko hamesha row 1 me rakhiye. Columns ka order badal sakta hai, naam nahi badlne chahiye.'],
    ['2.  "Document Number" aur "Reference No" alag columns hain — inhe mix mat kijiye.'],
    ['3.  "Our GSTIN" har row me chahiye, warna row company/unit se attach nahi hoti. "Our Location No." me unit ka code ya naam daaliye.'],
    ['3b. "Document Date" supplier ki date hai, "Book Entry Date" hamari books me entry ki date. Ye dono alag ho sakti hain — yahi sabse zaroori column hai.'],
    ['3e. "Period" (YYYY-MM) batata hai ki row kis GST month ki books me jaayegi. Ek hi file me kai mahine bhar sakte hain — ' +
      'har row apne Period se apne mahine me jaati hai. Khaali chhodiye to Document Date se month nikal liya jaayega.'],
    ['3c. "Document Type" dropdown se chuniye. Tax Invoice aur Debit Note amount JODTE hain; Credit Note GHATATA hai. ' +
      'Amounts hamesha positive likhiye — minus system khud lagayega (Sign Effect aur Signed... columns formula se dikhate hain).'],
    ['3d. Agar source file me amount pehle se minus laga hua hai to use waise hi rakhiye: system sign sirf EK BAAR lagata hai, ' +
      'Double minus kabhi nahi karta. Credit Note par minus aur bhi galat nahi hota.'],
    ['4.  Date format: YYYY-MM-DD.  Period/2B Month format: YYYY-MM.'],
    ['5.  Numbers me comma ya currency symbol mat rakhiye — 100000.00 likhiye.'],
    ['6.  Total / Grand Total wali row hata dijiye, warna ek fake line ban jaati hai.'],
    ['6b. Neeche diye gaye TEEN example rows (INV-889012, DN-889013, CN-889014) upload se pehle zaroor DELETE kar dijiye — ' +
      'warna ye bhi asli documents maan kar import ho jaayenge. Note kijiye ki examples me do mahine hain (April aur May): ' +
      'yahi dikhata hai ki ek file me kai mahine chalte hain.'],
    ['7.  Isi file ko dobara upload karna safe hai — purani lines update ho jaati hain, duplicate nahi banti.'],
    [],
    [`Company: ${opts.companyName || '(apni company chuniye — GSTIN se pehchan ho jaati hai)'}`],
    [],
    ['COLUMNS — kya zaroori hai'],
    ['Header', 'Zaroori?', 'Kya karta hai', 'Example'],
  ];
  for (const c of PURCHASE_TEMPLATE_COLUMNS) {
    head.push([c.header, c.required ? 'HAAN' : (c.derived ? 'Formula' : 'Nahi'), c.note, c.sample]);
  }
  const wsHelp = XLSX.utils.aoa_to_sheet(head);
  wsHelp['!cols'] = [
    { wch: 24 }, { wch: 10 }, { wch: 84 }, { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(wb, wsHelp, 'Instructions');

  // ---- The register itself ----------------------------------------------
  const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);
  const example = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.sample);

  // Three examples, one of each document type, so the sign rule is visible:
  // an invoice, a debit note and a credit note netting to 105000 taxable.
  const rowOf = (over: Record<string, string>): string[] =>
    headers.map((h) => over[h] ?? PURCHASE_TEMPLATE_COLUMNS.find((c) => c.header === h)!.sample);

  const invoiceRow = rowOf({
    'Document Type': 'Tax Invoice',
    'Document Number': 'INV-889012',
    'Document Date': '2026-04-15',
    'Book Entry Date': '2026-04-20',
    'Period': '2026-04',
    'Supplier GSTIN': '27AAFCC9473R1ZP',
    'Supplier Name': 'CROMPTON GREAVES',
    'Taxable Amount': '100000.00',
    'IGST': '18000.00',
    'CGST': '0.00',
    'SGST/UTGST': '0.00',
    'Cess': '0.00',
    'Reference No': 'PO-4500123456',
    'Our Location No.': 'Sakar-I',
    'E-Invoice': 'Yes',
    'E-Invoice IRN': 'a1b2c3d4e5f6',
    'E-Way Bill': 'Yes',
    'E-Way Bill No': '361012345678',
  });

  const debitRow = rowOf({
    'Our GSTIN': '26AALCS9985J1ZC',
    'Our Location No.': 'Sakar-III',
    'Document Type': 'Debit Note',
    'Document Number': 'DN-889013',
    'Document Date': '2026-04-18',
    'Book Entry Date': '2026-05-02',
    // Deliberately a different month from the invoice: the Period column, not
    // the document date, decides which month's books the row lands in.
    'Period': '2026-05',
    'Reference No': 'PO-4500123457',
    'Supplier GSTIN': '24AABCU9604R1ZX',
    'Supplier Name': 'TATA STEEL LIMITED',
    'Taxable Amount': '10000.00',
    'IGST': '0.00',
    'CGST': '900.00',
    'SGST/UTGST': '900.00',
    'Cess': '0.00',
    'E-Invoice': 'No',
    'E-Invoice IRN': '',
    'E-Way Bill': 'Yes',
    'E-Way Bill No': '361012345679',
  });

  const creditRow = rowOf({
    'Our GSTIN': '26AALCS9985J1ZC',
    'Our Location No.': 'Sakar-I',
    'Document Type': 'Credit Note',
    'Document Number': 'CN-889014',
    'Document Date': '2026-04-22',
    'Book Entry Date': '2026-04-25',
    'Period': '2026-04',
    'Reference No': 'PO-4500123458',
    'Supplier GSTIN': '27AAFCC9473R1ZP',
    'Supplier Name': 'CROMPTON GREAVES',
    'Taxable Amount': '5000.00',
    'IGST': '900.00',
    'CGST': '0.00',
    'SGST/UTGST': '0.00',
    'Cess': '0.00',
    'E-Invoice': 'Yes',
    'E-Invoice IRN': 'a1b2c3d4e5f7',
    'E-Way Bill': 'Yes',
    'E-Way Bill No': '361012345680',
  });

  const blankRow = headers.map(() => '');
  const ws = XLSX.utils.aoa_to_sheet([headers, invoiceRow, debitRow, creditRow, blankRow]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(14, Math.min(28, h.length + 2)) }));

  // Calculated columns for the example rows and for the next `formulaRows`
  // rows, so a user who adds a line gets the sign arithmetic without copying a
  // formula down.
  const derivedIdx = PURCHASE_TEMPLATE_COLUMNS
    .map((c, i) => (c.derived ? i : -1))
    .filter((i) => i >= 0);
  const lastRow = 1 + Math.max(3, opts.formulaRows ?? 500);
  for (let r = 2; r <= lastRow; r++) {
    const f = signedFormulas(r);
    derivedIdx.forEach((ci, k) => {
      ws[`${colLetter(ci)}${r}`] = { t: 'n', f: f[k] };
    });
  }
  // Excel must compute the formulas when the file opens; SheetJS writes no
  // cached values.
  (wb as unknown as { Workbook: Record<string, unknown> }).Workbook = { CalcPr: { fullCalcOnLoad: true } };

  XLSX.utils.book_append_sheet(wb, ws, 'Purchase Register');

  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const polished = polishWorkbook(raw, { freezeRows: 1, styleHeader: true });
  return addListValidations(polished, [
    {
      sheet: 'Purchase Register',
      sqref: `${letterOf('Document Type')}2:${letterOf('Document Type')}5000`,
      values: [...DOC_TYPES],
      title: 'Document Type',
      prompt: 'Tax Invoice / Debit Note / Credit Note',
    },
  ]);
}

/** The same template as a CSV, for teams without Excel. */
export function purchaseTemplateCsv(): string {
  const headers = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.header);
  const example = PURCHASE_TEMPLATE_COLUMNS.map((c) => c.sample);
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers, example].map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}
