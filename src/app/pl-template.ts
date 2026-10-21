/**
 * The P&L upload template.
 *
 * The parser matches by head NAME, so the template is what stops the same
 * twelve lines being spelled twelve different ways across twelve months. The
 * header list is generated from the same alias table the parser uses, and a
 * test asserts the two agree — a renamed head that the parser does not know
 * would quietly drop every amount on that line.
 *
 * A P&L is one amount per head per month, so the file is a two-column shape:
 * which line, and how much. Everything else is context the company controls
 * in the head master, not something to be retyped each month.
 */

import XLSX from 'xlsx';
import { polishWorkbook } from './xlsx-format';

export interface PlTemplateColumn {
  header: string;
  note: string;
  required: boolean;
  sample: string;
}

export const PL_TEMPLATE_COLUMNS: PlTemplateColumn[] = [
  { header: 'P&L Head', required: true, sample: 'Taxable Sales',
    note: 'Company ke P&L me line ka naam. Ye master list se exactly match hona chahiye (naam badal sakta hai, par parser ko wahi spelling chahiye).' },
  { header: 'Period', required: true, sample: '2026-04',
    note: 'YYYY-MM. Mahina jiske liye amount hai.' },
  { header: 'Amount', required: true, sample: '1000000.00',
    note: 'GST se PEHLE ka taxable amount (tax exclusive). Gross amount mat daaliye, warna har line par tax jitna fake difference dikhega.' },
  { header: 'Remarks', required: false, sample: '',
    note: 'Koi bhi note — optional, reconciliation me dikhta hai.' },
];

/** The five GST outward heads plus Other Income, in reporting order. */
export const PL_DEFAULT_HEADS: Array<{ name: string; group_name: string; sequence: number }> = [
  { name: 'Taxable Sales', group_name: 'Turnover', sequence: 10 },
  { name: 'Export Sales', group_name: 'Turnover', sequence: 20 },
  { name: 'Exempt Sales', group_name: 'Turnover', sequence: 30 },
  { name: 'Nil / Zero Rated Sales', group_name: 'Turnover', sequence: 40 },
  { name: 'Credit Notes / Sales Returns', group_name: 'Turnover', sequence: 50 },
  { name: 'Other Income', group_name: 'Other Income', sequence: 60 },
];

export interface PlTemplateOptions {
  companyName?: string;
  period?: string;
  heads?: string[];
}

export function plTemplateBuffer(opts: PlTemplateOptions = {}): Buffer {
  const wb = XLSX.utils.book_new();

  const head: unknown[][] = [
    ['GST CONTROL ERP — P&L UPLOAD TEMPLATE'],
    [],
    ['Har mahine ek row per P&L line. Period ek hi rakhiye — file ek company, ek mahina ke liye hai.'],
    ['Amount GST se PEHLE ka taxable value daaliye (tax exclusive).'],
    [],
    ['Zaroori baatein:'],
    ['1.  "P&L Head" ka naam master list se exact match hona chahiye.'],
    ['2.  Har company ke liye master list alag ho sakti hai — Company Master me dekhiye.'],
    ['3.  Period format: YYYY-MM. Amount me comma ya currency symbol nahi.'],
    ['4.  Credit Notes alag line par rakhiye — kabhi Turnover me net na karein.'],
    ['5.  Total / Grand Total wali row hata dijiye, warna ek fake head ban jaata hai.'],
    ['6.  Sahi P&L file dobara upload karna safe hai — duplicate nahi banti.'],
    [],
    [`Company: ${opts.companyName || '(apni company chuniye — GSTIN se pehchan ho jaati hai)'}`],
    [`Period:  ${opts.period || '(YYYY-MM, jaise 2026-04)'}`],
    [],
    ['COLUMNS — kya zaroori hai'],
    ['Header', 'Zaroori?', 'Kya karta hai', 'Example'],
  ];
  for (const c of PL_TEMPLATE_COLUMNS) head.push([c.header, c.required ? 'HAAN' : 'Nahi', c.note, c.sample]);

  // The company's own head list, so nobody has to guess a spelling.
  head.push([]);
  head.push(['AAPKI COMPANY KE P&L HEADS — inhi naam ka use kijiye']);
  head.push(['Head', 'Group', 'Order']);
  const heads = opts.heads && opts.heads.length ? opts.heads : PL_DEFAULT_HEADS.map((h) => h.name);
  for (const h of PL_DEFAULT_HEADS) {
    if (heads.some((x) => x.toLowerCase() === h.name.toLowerCase())) {
      head.push([h.name, h.group_name, String(h.sequence)]);
    }
  }
  for (const extra of heads) {
    if (!PL_DEFAULT_HEADS.some((h) => h.name.toLowerCase() === extra.toLowerCase())) {
      head.push([extra, '(company ki apni line)', '']);
    }
  }

  const wsHelp = XLSX.utils.aoa_to_sheet(head);
  wsHelp['!cols'] = [{ wch: 34 }, { wch: 12 }, { wch: 86 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsHelp, 'Instructions');

  const headers = PL_TEMPLATE_COLUMNS.map((c) => c.header);
  const example = PL_TEMPLATE_COLUMNS.map((c) => c.sample);
  const example2 = ['Other Income', opts.period || '2026-04', '25000.00', 'interest'];
  const blankRow = headers.map(() => '');
  const ws = XLSX.utils.aoa_to_sheet([headers, example, example2, blankRow]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(14, h.length + 2) }));
  ws['!freeze'] = 1;
  XLSX.utils.book_append_sheet(wb, ws, 'P&L Upload');

  const raw = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return polishWorkbook(raw, { freezeRows: 1, styleHeader: true });
}

export function plTemplateCsv(opts: PlTemplateOptions = {}): string {
  const headers = PL_TEMPLATE_COLUMNS.map((c) => c.header);
  const example = PL_TEMPLATE_COLUMNS.map((c) => c.sample);
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers, example].map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}