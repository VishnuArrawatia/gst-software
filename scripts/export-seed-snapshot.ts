/**
 * Export the authoritative local `gst_erp` data snapshot (compressed `.json.gz`)
 * so a fresh Coolify deployment starts with all 9,641 purchase lines, 10,952
 * GSTR-2B lines, 4,099 sales invoices, 443 GSTR-1 documents, and user-company
 * access pre-populated out of the box.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { withClient } from '../src/app/store';

const TABLES = [
  'companies',
  'units',
  'gstins',
  'financial_years',
  'periods',
  'users',
  'user_roles',
  'user_company_access',
  'user_gstin_access',
  'gstr2b_files',
  'gstr2b_lines',
  'purchase_lines',
  'recon_corrections',
  'sales_invoices',
  'sales_invoice_items',
  'gstr1_documents',
  'pl_heads',
  'pl_gst_mapping',
  'pl_monthly_lines',
  'pl_reconciliation',
];

async function main() {
  const payload: Record<string, any[]> = {};
  await withClient(async (c) => {
    for (const t of TABLES) {
      try {
        const res = await c.query(`SELECT * FROM ${t} ORDER BY 1`);
        payload[t] = res.rows;
        console.log(`  exported ${t.padEnd(24)} : ${res.rows.length} rows`);
      } catch (e: any) {
        console.warn(`  skip ${t}: ${e.message}`);
      }
    }
  });

  const outFile = path.join(process.cwd(), 'templates', 'gst-erp-seed-snapshot.json.gz');
  const jsonBuf = Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), tables: payload }), 'utf8');
  const gzBuf = zlib.gzipSync(jsonBuf, { level: 9 });
  fs.writeFileSync(outFile, gzBuf);
  console.log(`\nWrote ${outFile} (${(gzBuf.length / 1024 / 1024).toFixed(2)} MB compressed from ${(jsonBuf.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
