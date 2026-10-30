/**
 * The standard SALES register template — the input to GSTR-1.
 *
 * Mirrors `template.ts` (the purchase register): the header spellings below are
 * the *canonical* ones, and every one of them is an alias the sales parser
 * recognises, so the accounts team never has to guess which column the engine
 * wants. Position does not matter — `columns.ts` matches by name — but the
 * names do, because a header the parser does not recognise is silently dropped
 * and the resulting GSTR-1 is quietly wrong.
 *
 * The file is generated rather than checked in so the header list can never
 * drift away from `FIELD_ALIASES`; a test asserts the two agree.
 *
 * ONE ROW = ONE ITEM / TAX-RATE LINE.
 *
 * This register is item-wise, because GSTR-1's HSN summary (table 12) is grouped
 * by HSN/SAC + UQC + rate and reports a QUANTITY, and that cannot be built from
 * an invoice total. So an invoice with two goods at 18% and 12% is two rows:
 *
 *   - the invoice's own fields (Our GSTIN, Invoice No, Invoice Date,
 *     `Invoice Value`, party, place of supply) are repeated on every line, and
 *     `Invoice Value` must be the SAME on all of them — it is the invoice total,
 *     not the line's value;
 *   - the money columns are per LINE and are summed per invoice
 *     (`Taxable Value`, IGST, CGST, SGST, CESS);
 *   - `Line No` is the serial inside the invoice. It is what keeps two items of
 *     one invoice apart — without it the importer falls back to the line's
 *     position.
 *
 * A freight charge on which GST is charged is written as its OWN item line
 * (HSN of the goods, the applicable rate, its own taxable value), which keeps
 * the invoice's arithmetic true to the printed invoice. The optional `Freight` /
 * `Other Charges` columns are a BREAK-UP of that line's taxable value for the
 * CA's trace — they are never added on top of it.
 *
 * WHY THERE IS NO \"TABLE\" COLUMN:
 * The return table is DERIVED, not typed. `gstr1.ts` decides B2B / B2CL / B2CS
 * / CDNR / CDNUR from the customer GSTIN, the place of supply and the invoice
 * value. Asking the operator to also declare the table would create a second
 * source of truth that can contradict the first, and a GSTR-1 filed on a
 * contradicted classification is exactly the error this template avoids.
 */

import XLSX from 'xlsx';
import { polishWorkbook } from './xlsx-format';
import type { TemplateColumn } from './template';

/**
 * The canonical column order.
 *
 * `Our GSTIN` first (which registration is filing), then the invoice identity,
 * then the item line, then money, then the note link, then the columns the
 * portal asks for once per period (document series) or per amendment.
 * `Invoice Value` sits with the money because the B2CL threshold is a test on
 * the invoice value, not on the taxable value.
 */
export const SALES_TEMPLATE_COLUMNS: TemplateColumn[] = [
  {
    header: 'Our GSTIN', required: true, sample: '26AALCS9985J1ZC',
    note: 'Aapki company ka GSTIN jis par ye sale hui. Har row me zaroori — iske bina row kis registration ki GSTR-1 me jayegi pata nahi chalta, ' +
      'aur run us row ko chhod deta hai ("sales rows carry no GSTIN"). Ek hi file me teen registration ke rows chalte hain — separation isi column se hoti hai.',
  },
  {
    header: 'Unit', required: false, sample: 'Sakar-I',
    note: 'Apne unit / plant / branch ka code ya naam — jaise "Sakar-I" ya plant code "1000". Optional. Reporting ke liye. ' +
      'GSTIN badalne par unit khud badal jaata hai, isliye yahan GSTIN dobara likhne ki zaroorat nahi.',
  },
  {
    header: 'Customer Code', required: false, sample: 'C00001',
    note: 'SAP card code / party code. Optional. Master mapping ke liye — GSTIN se pehchan hoti hai, isliye khaali bhi chalega.',
  },
  {
    header: 'Customer Name', required: false, sample: 'CROMPTON GREAVES',
    note: 'Customer / party ka naam. GSTR-1 me counterparty name ke roop me jaata hai. B2B me bharna chahiye.',
  },
  {
    header: 'Customer GSTIN', required: false, sample: '27AAFCC9473R1ZP',
    note: 'Customer ka 15-digit GSTIN. Bhara ho to sale B2B (table 4A) me jaati hai aur IGST-vs-CGST+SGST GSTIN ke state se tay hota hai. ' +
      'Khaali chhoda to B2C — phir "Place of Supply" se decide hota hai ki B2CL (inter-state, invoice value ₹1 lakh se upar) hai ya B2CS.',
  },
  {
    header: 'Recipient Type', required: false, sample: 'Registered',
    note: 'Registered / Unregistered. GSTR-1 me nahi jaata — sirf check ke liye: "Unregistered" likha ho aur GSTIN bhara ho to run warning deta hai.',
  },
  {
    header: 'Place of Supply', required: false, sample: '27',
    note: 'Supply ki jagah — state ka naam ("Maharashtra", "Gujarat") ya 2-digit code ("27", "24"). B2C sale me sirf yehi B2CL-vs-B2CS ' +
      'aur IGST-vs-CGST/SGST tay karta hai, isliye unregistered customer wali rows me ise zaroor bharein.',
  },
  {
    header: 'Reverse Charge', required: false, sample: 'No',
    note: 'Yes / No. Aam sale me No. Sirf tab "Yes" jab tax customer ne reverse charge par dena ho.',
  },
  {
    header: 'Invoice Type', required: false, sample: 'R',
    note: 'Khaali chhodne par "R" (regular sale) maana jaata hai. CN = credit note, DN = debit note, SEZWP / SEWOP = SEZ supply, ' +
      'DE = deemed export. Credit / debit note B2B me nahi jaata — uska apna table hota hai (9A registered customer ke liye, 9B unregistered ke liye).',
  },
  {
    header: 'Invoice No', required: true, sample: 'INV-889012',
    note: 'Sales invoice number. GSTR-1 me yahi number jaata hai, aur filed return se reconciliation isi se hoti hai — ' +
      'isliye SAP ka document number hi likhein, koi internal serial nahi. Ek invoice ki saari item lines par WAHI number.',
  },
  {
    header: 'Invoice Date', required: true, sample: '2026-04-15',
    note: 'Invoice ki date, YYYY-MM-DD. MAHINA (period) sirf isi se banta hai — is template me period ka alag column nahi hai. ' +
      'Date galat daali to poori row galat mahine ki GSTR-1 me chali jayegi.',
  },
  {
    header: 'Line No', required: true, sample: '1',
    note: 'Invoice ke andar item ka serial (1, 2, 3…). Ek invoice ki do lines ko alag rakhne wala yahi column hai — ' +
      'iske bina importer line ki position use karta hai. Portal me yahi `itms[].num` ban jaata hai.',
  },
  {
    header: 'Invoice Value', required: true, sample: '118000.00',
    note: 'PURA invoice amount (taxable + tax) — line ka amount nahi. Ek invoice ki saari lines par SAME likhein; ' +
      'usi se B2CL ka ₹1 lakh threshold lagta hai, aur ise sirf EK BAAR gina jaata hai. Iske bina file sales register ke roop me pehchani hi nahi jaati.',
  },
  {
    header: 'Original Invoice No', required: false, sample: '',
    note: 'Sirf credit / debit note par (Invoice Type = CN/DN): jis ORIGINAL invoice ko correct kar rahe ho uska number. ' +
      'Registered customer ke note me ye mandatory hai — bina iske portal us note ko reject kar dega. Unregistered (9B) par optional hai, phir bhi bharein.',
  },
  {
    header: 'Original Invoice Date', required: false, sample: '',
    note: 'Us original invoice ki DATE — note ki apni date nahi. "Original Invoice No" ke saath hi bharein; ek ke bina doosra kaam nahi karta.',
  },
  {
    header: 'Item Description', required: true, sample: 'Relay 24V DC',
    note: 'Item ka naam. HSN summary (table 12) ke "Description" column me jaata hai. Freight ki line ho to "Freight and other charges" likhein.',
  },
  {
    header: 'HSN', required: true, sample: '8536',
    note: 'HSN / SAC code. GSTR-1 ki HSN summary (HSN/SAC + UQC + rate par grouped) isi se banti hai — code khaali chhoda to summary me "NA" ke neeche chala jayega.',
  },
  {
    header: 'UQC', required: true, sample: 'PCS',
    note: 'Unit quantity code — PCS / KGS / MTR / NOS / LTR etc. HSN summary ka UQC column yahi banta hai. Khaali chhoda to "PCS" maana jaata hai, ' +
      'jo KGS/MTR wale item ke liye galat hoga — isliye bharein.',
  },
  {
    header: 'Quantity', required: true, sample: '100',
    note: 'Is line ki quantity (item ki unit me). HSN summary me quantity ka sum jaata hai. Credit note / freight line par 0 likhein. ' +
      'Khaali chhodne par 0 liya jaata hai — koi quantity invent nahi hoti.',
  },
  {
    header: 'GST Rate', required: true, sample: '18',
    note: 'Is line par lagne wala rate — 0 / 0.25 / 3 / 5 / 12 / 18 / 28 / 40. Portal me `itm_det.rt` yahi ban jaata hai. ' +
      'Ye rate file se hi liya jaata hai (tax se derive nahi hota), aur tax isse match karna chahiye warna run error deta hai.',
  },
  {
    header: 'Taxable Value', required: true, sample: '100000.00',
    note: 'Is LINE ka GST se pehle ka amount. Invoice ke saare lines ka sum invoice-level taxable banata hai — ' +
      'isi se rate aur HSN buckets bante hain.',
  },
  {
    header: 'IGST', required: false, sample: '18000.00',
    note: 'Inter-state sale par integrated tax.',
  },
  {
    header: 'CGST', required: false, sample: '0.00',
    note: 'Intra-state sale par central tax.',
  },
  {
    header: 'SGST', required: false, sample: '0.00',
    note: 'Intra-state sale par state / UT tax — UTGST ka amount bhi isi column me likhein (GSTR-1 me ek hi `samt` field hai).',
  },
  {
    header: 'CESS', required: false, sample: '0.00',
    note: 'Compensation cess, agar lagta ho.',
  },
  {
    header: 'Freight', required: false, sample: '0.00',
    note: 'Is line ke taxable value me se freight kitna hai — sirf BREAK-UP. Isko taxable value me JODNA nahi hai, wo pehle se `Taxable Value` me hai ' +
      '(GST freight par bhi lagta hai). Freight ki apni GST rate ho to uske liye alag item line banayein.',
  },
  {
    header: 'Other Charges', required: false, sample: '0.00',
    note: 'Freight ki tarah — `Taxable Value` ka hi break-up. Freight + other charges taxable value se zyada ho gaye to run error deta hai.',
  },
  {
    header: 'Amendment Of Invoice No', required: false, sample: '',
    note: 'Sirf tab jab pehle FILE kiye gaye invoice ko is mahine correct kar rahe ho (B2BA / CDNRA): us filed invoice ka number. ' +
      'Aam sale me khaali chhodein.',
  },
  {
    header: 'Amendment Of Invoice Date', required: false, sample: '',
    note: '"Amendment Of Invoice No" ke saath us filed invoice ki date.',
  },
  {
    header: 'E-Commerce GSTIN', required: false, sample: '',
    note: 'Sale e-commerce operator (jaise Amazon / Flipkart) ke through hui ho to operator ka GSTIN. Aam sale me khaali.',
  },
  {
    header: 'Doc Nature', required: false, sample: 'Invoices for outward supply',
    note: 'DOC_ISSUED table ke liye — document series ka nature. Ek series ke saare invoice par ek hi likhein. ' +
      'Khaali chhoda to "Invoices for outward supply" maana jaata hai.',
  },
  {
    header: 'Doc Series From', required: false, sample: '1001',
    note: 'Us series ka pehla invoice number (sirf digits). Ye invoice-level hai — series ke saare rows par same.',
  },
  {
    header: 'Doc Series To', required: false, sample: '1200',
    note: 'Us series ka aakhri invoice number (sirf digits).',
  },
  {
    header: 'Doc Series Cancelled', required: false, sample: '3',
    note: 'Us series me cancel hue invoice ki ginti. DOC_ISSUED me total − cancelled = net issued jaata hai.',
  },
];

export interface SalesTemplateOptions {
  /** Repeated on the Instructions sheet, e.g. "Sakar" or "SVN Opto". */
  companyName?: string;
}

/** The workbook the accounts team fills in and uploads back for GSTR-1. */
export function salesTemplateBuffer(opts: SalesTemplateOptions = {}): Buffer {
  const wb = XLSX.utils.book_new();

  // ---- Instructions ------------------------------------------------------
  const head: unknown[][] = [
    ['GST CONTROL ERP — SALES REGISTER TEMPLATE (GSTR-1)'],
    [],
    ['Is file me apni SALES (outward supply) ki rows bharein — isi se GSTR-1 banti hai.'],
    ['Purchase register ki rows yahan NAHI daalni. Dono ka table alag hai.'],
    [],
    ['EKA ROW = EK ITEM LINE'],
    ['1.  Ek invoice me do item (ya do GST rate) ho to DO rows likhein — "Line No" 1, 2 se.'],
    ['2.  Invoice ke apne fields (Our GSTIN, Invoice No, Invoice Date, Invoice Value, party, POS)'],
    ['      HAR line par repeat karein, aur "Invoice Value" SAME rakhein — wo pura invoice hai, line nahi.'],
    ['3.  "Invoice Value" sirf EK BAAR gina jaata hai. Yahi multi-item invoice ka sabse bada trap hai.'],
    ['4.  Money columns (Taxable Value, IGST, CGST, SGST, CESS) line-wise hote hain aur invoice par sum hote hain.'],
    ['5.  Freight par GST lagta hai — uski apni item line banayein (HSN, rate aur taxable value ke saath).'],
    ['      "Freight" / "Other Charges" columns sirf taxable value ka break-up dikhate hain, jodte nahi.'],
    [],
    ['GSTR-1 kaise banegi:'],
    ['1.  Ye file bhar kar "Data Intake & Run" screen par upload kar dein — purchase register aur GSTR-2B ke SAATH.'],
    ['2.  Run ke baad workbook ki "GSTR-1" sheet me B2B / B2CL / B2CS / CDNR / CDNUR break-up likhi hoti hai,'],
    ['      aur "HSN Summary" sheet me HSN + UQC + rate wise taxable, qty aur tax.'],
    ['3.  Portal par upload karne wali file yahan banti hai:  output/returns/<GSTIN>_<period>_GSTR1.json'],
    ['4.  CLI se chalana ho:  npm run cli -- --input "<folder>" --out "F:\\GST-SOFTWARE\\output"'],
    [],
    ['Zaroori baatein:'],
    ['1.  Header row hamesha row 1 me. Columns ka order badal sakta hai, NAAM nahi badalna.'],
    ['2.  Table (B2B / B2CL / B2CS) ka column isliye nahi hai — software khud decide karta hai:'],
    ['      Customer GSTIN mila        -> B2B'],
    ['      GSTIN nahi + inter-state   -> B2CL (invoice value ₹1,00,000 se zyada)'],
    ['      baaki sab                  -> B2CS (rate-wise summary)'],
    ['      Invoice Type CN/DN         -> CDNR (registered) / CDNUR (unregistered)'],
    ['3.  Date format: YYYY-MM-DD. Numbers me comma (1,00,000) ya ₹ mat likhiye — 100000.00 likhiye.'],
    ['4.  Credit note ke amount MINUS me likhiye (taxable -1000, CGST -90, SGST -90).'],
    ['4b. "Invoice Value" column kabhi hataiye mat. Iske bina file sales register ke bajaye PURCHASE register samajh li jaati hai —'],
    ['      aur poori sales purchase ki tarah file ho jaati hai. Taxable + tax se khud nahi banega.'],
    ['5.  Total / Grand Total wali row hata dijiye, warna ek fake invoice ban jaati hai.'],
    ['6.  Ek invoice ki do lines par alag-alag "Invoice Value" likh di to run ERROR deta hai —'],
    ['      aur wahi line dobara aa gayi to bhi (duplicate line). Ek bhi error chup nahi rehta.'],
    ['7.  "Invoice No" unique hona chahiye — ek hi GSTIN par wahi number do baar aaya to GSTR-1 me'],
    ['      duplicate invoice ka ERROR milega (portal bhi reject karta hai).'],
    ['8.  Isi file ko dobara upload karna safe hai — purani lines update ho jaati hain, duplicate nahi banti.'],
    [],
    [`Company: ${opts.companyName || '(apni company chuniye — GSTIN se pehchan ho jaati hai)'}`],
    [],
    ['COLUMNS — kya zaroori hai'],
    ['Header', 'Zaroori?', 'Kya karta hai', 'Example'],
  ];
  for (const c of SALES_TEMPLATE_COLUMNS) {
    head.push([c.header, c.required ? 'HAAN' : 'Nahi', c.note, c.sample]);
  }
  const wsHelp = XLSX.utils.aoa_to_sheet(head);
  wsHelp['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 96 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsHelp, 'Instructions');

  // ---- The register itself ----------------------------------------------
  const headers = SALES_TEMPLATE_COLUMNS.map((c) => c.header);
  const names = SALES_TEMPLATE_COLUMNS.map((c) => c.header);

  const fill = (over: Record<string, string>): string[] =>
    names.map((h) => over[h] ?? SALES_TEMPLATE_COLUMNS.find((c) => c.header === h)!.sample);

  // Five examples, because the cases that go to four different tables are the
  // ones a reader gets wrong from a single example:
  //   rows 1-2 — one invoice, TWO rate lines (registered, inter-state) -> B2B
  //   row 3    — unregistered, intra-state, small                      -> B2CS
  //   row 4    — unregistered, inter-state, over Rs 1 lakh             -> B2CL
  //   row 5    — registered Credit Note linked to original invoice     -> CDNR
  const exampleB2BLine1 = fill({
    'Invoice Value': '146000.00',
  });
  // The multi-item example is the one that shows the rule: the SAME invoice
  // value on both lines, each with its own HSN, rate and tax (118000 + 28000 = 146000).
  const exampleB2BLine2 = fill({
    'Line No': '2', 'Item Description': 'Contactor 32A', HSN: '8537', Quantity: '40',
    'GST Rate': '12', 'Taxable Value': '25000.00', IGST: '3000.00', 'Invoice Value': '146000.00',
    'Doc Series From': '', 'Doc Series To': '', 'Doc Series Cancelled': '',
  });
  // The intra-state example keeps the place of supply in the SAME state as the
  // registration (26), otherwise the CGST+SGST split contradicts an inter-state
  // classification and the example teaches the opposite of what the note says.
  const exampleB2CS = fill({
    'Invoice No': 'INV-889013', 'Invoice Date': '2026-04-18', 'Invoice Type': 'R',
    'Customer GSTIN': '', 'Customer Name': 'CASH CUSTOMER — SILVASSA', 'Recipient Type': 'Unregistered',
    'Place of Supply': '26', 'Taxable Value': '25000.00', IGST: '0.00',
    CGST: '2250.00', SGST: '2250.00', 'Invoice Value': '29500.00', HSN: '8536',
    'Doc Series From': '', 'Doc Series To': '', 'Doc Series Cancelled': '',
  });
  const exampleB2CL = fill({
    'Invoice No': 'INV-889014', 'Invoice Date': '2026-04-22', 'Invoice Type': 'R',
    'Customer GSTIN': '', 'Customer Name': 'UNREGISTERED DEALER — JAIPUR', 'Recipient Type': 'Unregistered',
    'Place of Supply': '08', 'Taxable Value': '120000.00', IGST: '21600.00',
    CGST: '0.00', SGST: '0.00', 'Invoice Value': '141600.00', HSN: '8536',
    'Doc Series From': '', 'Doc Series To': '', 'Doc Series Cancelled': '',
  });
  const exampleCDNR = fill({
    'Invoice No': 'CN-889015', 'Invoice Date': '2026-04-25', 'Invoice Type': 'CN',
    'Original Invoice No': 'INV-889012', 'Original Invoice Date': '2026-04-15',
    'Quantity': '0', 'Taxable Value': '-10000.00', IGST: '-1800.00',
    CGST: '0.00', SGST: '0.00', 'Invoice Value': '-11800.00',
    'Doc Nature': 'Credit Note', 'Doc Series From': '', 'Doc Series To': '', 'Doc Series Cancelled': '',
  });
  const blankRow = headers.map(() => '');

  const ws = XLSX.utils.aoa_to_sheet([headers, exampleB2BLine1, exampleB2BLine2, exampleB2CS, exampleB2CL, exampleCDNR, blankRow]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(16, h.length + 2) }));
  ws['!freeze'] = 1;
  XLSX.utils.book_append_sheet(wb, ws, 'Sales Register');

  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return polishWorkbook(raw, { freezeRows: 1, styleHeader: true });
}

/** The same template as a CSV, for teams without Excel. */
export function salesTemplateCsv(): string {
  const headers = SALES_TEMPLATE_COLUMNS.map((c) => c.header);
  const example = SALES_TEMPLATE_COLUMNS.map((c) => c.sample);
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers, example].map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}
