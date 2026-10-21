/**
 * The company and unit names the Accounts team asked for, applied on the way
 * OUT of the database.
 *
 * These are DISPLAY names only. The company row keeps its id, the GSTIN row
 * keeps its number, and PAN never changes — only the spelling printed on a
 * screen or in a workbook header is normalised here. That matters because the
 * production master still holds the short spellings ("Sakar", "SVN Opto") while
 * the office has asked for the expanded legal form everywhere; mapping at the
 * edge is what lets the whole application show one name without the export
 * silently disagreeing with the screen it came from.
 *
 * The browser carries the same small table in src/server/public/index.html,
 * because the page is served as one static file with no build step, so it
 * cannot import this module. If a name is added here, add it there too.
 */

/** Lower-cased key -> the exact spelling to show. */
const COMPANY_NAMES: Record<string, string> = {
  'sakar': 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
  'sakar electricals': 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
  'sakar electricals & electronics pvt ltd': 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
  'svn opto': 'SVN OPTO ELECTRONICS PVT LTD',
  'svn': 'SVN OPTO ELECTRONICS PVT LTD',
  'svn opto electronics pvt ltd': 'SVN OPTO ELECTRONICS PVT LTD',
};

/** Unit labels stay short: they are a location, and the GSTIN is printed beside them. */
const UNIT_NAMES: Record<string, string> = {
  'sakar-i': 'Sakar Unit-I',
  'sakar-ii': 'Sakar Unit-II',
  'sakar-iii': 'Sakar Unit-III',
  'svn unit-i': 'SVN Unit-I',
  'svn unit-ii': 'SVN Unit-II',
};

/** A name we do not know is passed through untouched, never blanked. */
function mapName(table: Record<string, string>, value: unknown): string {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return table[raw.toLowerCase()] || raw;
}

/** 'Sakar' -> 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD'. */
export function displayCompany(name: unknown): string {
  return mapName(COMPANY_NAMES, name);
}

/** 'Sakar-III' -> 'Sakar Unit-III'. */
export function displayUnit(unit: unknown): string {
  return mapName(UNIT_NAMES, unit);
}
