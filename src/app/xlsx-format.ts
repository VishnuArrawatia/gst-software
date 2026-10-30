/**
 * A very small ZIP reader/writer, and an xlsx post-processor.
 *
 * WHY THIS EXISTS
 *   SheetJS (community) writes column widths, autofilters and number formats,
 *   but it cannot write cell styles or frozen panes — both are on the list of
 *   things the Accounts team is told to expect in a report. Rather than add a
 *   dependency or hand-build a whole workbook, we let SheetJS produce a valid
 *   xlsx and then patch two things into the XML:
 *
 *     * `<pane>` inside `<sheetView>`  -> freeze the header rows
 *     * a bold + filled header cell style -> so row 1 reads as a header
 *
 *   Both edits are surgical string insertions into a file we generated, and
 *   `polishWorkbook` re-reads the result with SheetJS afterwards, so a
 *   malformed patch fails loudly here rather than silently in Excel.
 *
 *   A zip is: local file headers + data, a central directory, and an end-of-
 *   central-directory record. All three are written below; that is the whole
 *   format for stored/deflated entries, which is all xlsx uses.
 */

import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// CRC-32 (needed by every zip entry header)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/** Every entry of a zip archive, keyed by its path inside the archive. */
export function zipRead(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();

  // The end-of-central-directory record is at the tail, after a possible
  // comment; search backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // The local header repeats the name/extra lengths with its own values.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

/** Build a zip from scratch. Timestamps are fixed so output is reproducible. */
export function zipWrite(files: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  // A fixed MS-DOS timestamp (1980-01-01) keeps byte-for-byte reproducibility.
  const DOS_TIME = 0;
  const DOS_DATE = 33;

  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Only compress when it actually helps; some tiny XML entries grow.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// xlsx polish
// ---------------------------------------------------------------------------

/**
 * The bold, light-filled header style appended to the workbook's style table.
 *
 * `HEADER_XF` is the index of the appended cellXfs entry, so the caller knows
 * which `s` attribute to put on row 1 of every sheet.
 */
let headerXfIndex = 0;

/**
 * Freeze `freezeRows` rows at the top of every sheet, and mark row 1 as a
 * header. `freezeRows: 0` skips the pane; `styleHeader: false` skips the style.
 *
 * Returns a new xlsx buffer. Throws if the patch produced something SheetJS can
 * no longer read.
 */
export function polishWorkbook(
  xlsx: Buffer,
  opts: { freezeRows?: number; styleHeader?: boolean } = {},
): Buffer {
  const freezeRows = opts.freezeRows ?? 1;
  const styleHeader = opts.styleHeader ?? true;
  const files = zipRead(xlsx);

  const sheetNames = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));

  if (styleHeader) headerXfIndex = appendHeaderStyle(files);

  for (const name of sheetNames) {
    let xml = files.get(name)!.toString('utf8');

    if (freezeRows > 0 && !/<pane /.test(xml)) {
      xml = xml.replace(
        /<sheetView([^>]*)\/>/,
        `<sheetView$1><pane ySplit="${freezeRows}" topLeftCell="A${freezeRows + 1}" ` +
          `activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" ` +
          `activeCell="A${freezeRows + 1}" sqref="A${freezeRows + 1}"/></sheetView>`,
      );
    }

    if (styleHeader && headerXfIndex >= 0) {
      xml = styleFirstRow(xml, headerXfIndex);
    }
    files.set(name, Buffer.from(xml, 'utf8'));
  }

  const out = zipWrite([...files.entries()]);
  return out;
}

/**
 * Append one bold-header cell format to `xl/styles.xml` and return its index.
 *
 * The patch adds a bold font, a solid light-grey fill, and a thin border, then a
 * cellXfs entry that uses them. If any of those elements are missing the file is
 * returned untouched with index 0, which the caller treats as "no style".
 */
function appendHeaderStyle(files: Map<string, Buffer>): number {
  const raw = files.get('xl/styles.xml');
  if (!raw) return 0;
  let xml = raw.toString('utf8');

  const fontsMatch = /<fonts count="(\d+)">/.exec(xml);
  const fillsMatch = /<fills count="(\d+)">/.exec(xml);
  const bordersMatch = /<borders count="(\d+)">/.exec(xml);
  const cellXfsMatch = /<cellXfs count="(\d+)">/.exec(xml);
  if (!fontsMatch || !fillsMatch || !bordersMatch || !cellXfsMatch) return 0;

  const fontIndex = Number(fontsMatch[1]);
  const fillIndex = Number(fillsMatch[1]);
  const borderIndex = Number(bordersMatch[1]);
  const xfIndex = Number(cellXfsMatch[1]);

  const FONT =
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>';
  const FILL =
    '<fill><patternFill patternType="solid"><fgColor rgb="FF34495E"/><bgColor indexed="64"/></patternFill></fill>';
  const BORDER =
    '<border><left style="thin"><color rgb="FF95A5A6"/></left><right style="thin"><color rgb="FF95A5A6"/></right>' +
    '<top style="thin"><color rgb="FF95A5A6"/></top><bottom style="thin"><color rgb="FF95A5A6"/></bottom><diagonal/></border>';
  const XF =
    `<xf numFmtId="0" fontId="${fontIndex}" fillId="${fillIndex}" borderId="${borderIndex}" applyFont="1" ` +
    `applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`;

  xml = xml
    .replace(fontsMatch[0], `<fonts count="${fontIndex + 1}">`)
    .replace('</fonts>', FONT + '</fonts>')
    .replace(fillsMatch[0], `<fills count="${fillIndex + 1}">`)
    .replace('</fills>', FILL + '</fills>')
    .replace(bordersMatch[0], `<borders count="${borderIndex + 1}">`)
    .replace('</borders>', BORDER + '</borders>')
    .replace(cellXfsMatch[0], `<cellXfs count="${xfIndex + 1}">`)
    .replace('</cellXfs>', XF + '</cellXfs>');

  files.set('xl/styles.xml', Buffer.from(xml, 'utf8'));
  return xfIndex;
}

/**
 * Add a dropdown (data validation list) to a column of a named sheet.
 *
 * SheetJS community writes no data validations, and a purchase register whose
 * "Document Type" is free text is how a credit note ends up typed as an
 * invoice — the one mistake that turns a reduction into a claim. The validation
 * is injected into the sheet XML here, which also keeps it out of the SheetJS
 * write path entirely.
 *
 * `sqref` is the A1 range the list applies to (e.g. `E2:E5000`). The list is
 * written inline, so the values must not contain commas.
 */
export function addListValidations(
  xlsx: Buffer,
  list: Array<{ sheet: string; sqref: string; values: string[]; title?: string; prompt?: string }>,
): Buffer {
  if (!list.length) return xlsx;
  const files = zipRead(xlsx);

  const wb = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const targetById = new Map<string, string>();
  for (const tag of rels.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (id && target) targetById.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const pathBySheet = new Map<string, string>();
  for (const tag of wb.match(/<sheet\b[^>]*\/?>/g) ?? []) {
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    const rid = /\br:id="([^"]+)"/.exec(tag)?.[1];
    const target = rid ? targetById.get(rid) : undefined;
    if (name && target) pathBySheet.set(decodeXml(name), `xl/${target}`);
  }

  for (const v of list) {
    const path = pathBySheet.get(v.sheet);
    const raw = path ? files.get(path) : undefined;
    if (!raw) throw new Error(`xlsx: sheet "${v.sheet}" not found for data validation`);
    let xml = raw.toString('utf8');
    if (/<dataValidations\b/.test(xml)) continue;
    const attrs =
      `type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"` +
      (v.title ? ` promptTitle="${escXml(v.title)}"` : '') +
      (v.prompt ? ` prompt="${escXml(v.prompt)}"` : '');
    const block =
      `<dataValidations count="1"><dataValidation ${attrs} sqref="${v.sqref}">` +
      `<formula1>"${escXml(v.values.join(','))}"</formula1></dataValidation></dataValidations>`;
    // Schema order: dataValidations sits after autoFilter / mergeCells /
    // conditionalFormatting and before every one of the elements below. Get
    // this wrong and Excel does not merely reorder it — it refuses to open the
    // workbook (or "repairs" it, losing the rows). SheetJS itself emits
    // `<ignoredErrors>` right after `<sheetData>`, so inserting before
    // `</worksheet>` was putting the validation *after* it and breaking the
    // template. Every element that must follow dataValidations is listed.
    const at = [
      '<hyperlinks', '<printOptions', '<pageMargins', '<pageSetup', '<headerFooter',
      '<rowBreaks', '<colBreaks', '<customProperties', '<cellWatches',
      '<ignoredErrors', '<smartTags', '<drawing', '<legacyDrawing', '<picture',
      '<oleObjects', '<controls', '<webPublishItems', '<tableParts', '<extLst',
      '</worksheet>',
    ]
      .map((t) => xml.indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    xml = xml.slice(0, at) + block + xml.slice(at);
    files.set(path!, Buffer.from(xml, 'utf8'));
  }

  return zipWrite([...files.entries()]);
}

const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Put `s="<xf>"` on every cell of the first row of a sheet. */
function styleFirstRow(xml: string, xf: number): string {
  return xml.replace(/<row r="1"([^>]*)>([\s\S]*?)<\/row>/, (_m, attrs: string, body: string) => {
    const styled = body.replace(/<c r="([A-Z]+1)"(?![^>]*\bs=)/g, `<c r="$1" s="${xf}"`);
    return `<row r="1"${attrs}>${styled}</row>`;
  });
}