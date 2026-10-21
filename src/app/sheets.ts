/**
 * Choosing which sheet of a workbook holds the data.
 *
 * A purchase register is one table, but the file around it is not: the
 * template this project hands out carries an Instructions sheet in front of
 * the register, and SAP exports often carry a cover or a "totals" sheet.
 * Reading `SheetNames[0]` therefore silently parses the wrong sheet — the rows
 * come back empty and the import looks like a failed upload rather than a
 * layout problem.
 *
 * So each sheet is scored by how many of the fields we *require* it exposes,
 * and the best one wins. Ties go to the earliest sheet so a plain single-sheet
 * file behaves exactly as before.
 */

import XLSX from 'xlsx';
import { detectField, findHeaderRow, type HeaderContext, type HeaderDetector } from '../engine/columns';

/** Read every sheet as a plain row array, keeping the name for diagnostics. */
export function readAllSheets(buf: Buffer): Array<{ name: string; rows: unknown[][] }> {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const out: Array<{ name: string; rows: unknown[][] }> = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1, raw: true, defval: null, blankrows: false,
    }) as unknown[][];
    out.push({ name, rows });
  }
  return out;
}

/** How well a sheet's best header row matches what we need. */
function scoreSheet(
  rows: unknown[][],
  required: string[],
  ctx?: HeaderContext,
  detect: HeaderDetector = (cell) => detectField(cell, ctx),
): { score: number; headerRowIndex: number } {
  if (!rows.length) return { score: 0, headerRowIndex: 0 };
  const headerRowIndex = findHeaderRow(rows, required, ctx, detect);
  const header = rows[headerRowIndex] || [];
  const fields = new Set(
    header.map((cell) => detect(cell)).filter((f): f is string => !!f),
  );
  let hits = 0;
  for (const req of required) if (fields.has(req)) hits++;

  // Counting required fields alone is not enough. An Instructions sheet names
  // "Invoice No" and "Taxable Value" in its note text, so it can score a full
  // 3/3 while the real register scores the same. `fields.size` is what tells
  // them apart: a genuine register maps every one of its columns, a note
  // sheet maps only the few words it happens to mention.
  //
  // Required hits dominate, so a sheet that is merely missing one required
  // column can never beat one that has them all.
  const score = hits * 1000 + fields.size;
  return { score, headerRowIndex };
}

/** Maps one header cell to a canonical field, or null when unrecognised. */
export type { HeaderDetector };

/**
 * The sheet most likely to hold `required` fields, with its header row index.
 *
 * Returns the first sheet when none of them match, which keeps the caller's
 * "missing required column(s)" message pointing at a real sheet.
 *
 * `detect` exists so a caller with its own vocabulary — the GSTR-1 portal
 * export has a completely different column set from the purchase register — can
 * reuse this scoring rather than reimplement it. Getting that scoring subtly
 * wrong is what made multi-sheet workbooks parse to zero rows in the first
 * place, so there is no reason to let it be reimplemented badly twice.
 */
export function pickDataSheet(
  sheets: Array<{ name: string; rows: unknown[][] }>,
  required: string[],
  ctx?: HeaderContext,
  detect?: HeaderDetector,
): { name: string; rows: unknown[][]; headerRowIndex: number } {
  if (!sheets.length) return { name: '', rows: [], headerRowIndex: 0 };

  let best = sheets[0];
  let bestScore = -1;
  let bestHeader = 0;

  for (const sheet of sheets) {
    const { score, headerRowIndex } = scoreSheet(sheet.rows, required, ctx, detect);
    // Strictly greater, so the earliest sheet wins a genuine tie and
    // single-sheet files are unaffected.
    if (score > bestScore) {
      bestScore = score;
      best = sheet;
      bestHeader = headerRowIndex;
    }
  }

  return { name: best.name, rows: best.rows, headerRowIndex: bestHeader };
}