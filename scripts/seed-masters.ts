/**
 * Seed the company / unit / GSTIN masters from what the source files actually
 * say, so the database layer and any future screen have real registrations
 * instead of blanks.
 *
 * Every GSTIN below was read out of the team's own files, not typed from
 * memory — see scripts/scan-gstins.ts, scripts/find-svn-gstin.ts and
 * scripts/probe-pans.ts:
 *
 *   26AALCS9985J1ZC  "GSTIN of Company" column of GSTR-2B download Apr25-Mar26
 *                    (10,732 lines) — Sakar's Gujarat registration
 *   24AALCS9985J1ZG  same column, 220 lines — Sakar's Madhya Pradesh one
 *                    Both carry PAN AALCS9985J, so they are two registrations
 *                    of ONE company, not two companies.
 *   26ABFCS9511H1Z7  the supplier GSTIN on 2,919 purchase-register lines and
 *                    2,929 2B lines, always filed as "SVN OPTO ELECTRONICS
 *                    PVT.LTD." with two invoice series — SVN/2526/xxxx
 *                    (Unit-I) and SVN2/25/xxxxxx ("UNIT- II (PURCHASE)") —
 *                    under the SAME GSTIN. PAN ABFCS9511H.
 *
 * Re-running is safe: every insert is an upsert keyed on the natural key.
 *
 * Usage:  npm run seed
 */

import fs from 'fs';
import path from 'node:path';
import { Client } from 'pg';

import { loadEnv, pgConfig } from '../src/config/env';

loadEnv();
const cfg = pgConfig();

interface SeedGstin {
  gstin: string;
  state: string;
  trade_name?: string;
  legal_name?: string;
}

interface SeedUnit {
  name: string;
  gstins: SeedGstin[];
}

interface SeedCompany {
  name: string;
  legal_name?: string;
  tax_identifier: string;
  units: SeedUnit[];
}

const MASTERS: SeedCompany[] = [
  {
    // Display name as the Accounts team asked for it (2026-10): the exact
    // expanded legal form, everywhere the selector prints it. `name` is the
    // upsert conflict key, so a re-seed with a NEW spelling cannot take until
    // the name-update branch below (UPPER-cased compare, swipe-safe) runs.
    name: 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
    // Both registrations carry PAN AALCS9985J — one legal entity, two states.
    tax_identifier: 'AALCS9985J',
    units: [
      {
        name: 'Sakar-I',
        gstins: [
          {
            gstin: '26AALCS9985J1ZC',
            state: '26',
            trade_name: 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
            legal_name: 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
          },
        ],
      },
      {
        name: 'Sakar-III',
        gstins: [
          {
            gstin: '24AALCS9985J1ZG',
            state: '24',
            trade_name: 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
            legal_name: 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
          },
        ],
      },
    ],
  },
  {
    name: 'SVN OPTO ELECTRONICS PVT LTD',
    legal_name: 'SVN OPTO ELECTRONICS PVT LTD',
    tax_identifier: 'ABFCS9511H',
    units: [
      {
        // Both SVN units are registered under ONE GSTIN, so it can only be
        // attached to a single unit row (uq_gstins_number is unique). Unit-II
        // deliberately has no gstin row — it is the same registration.
        name: 'SVN Unit-I',
        gstins: [
          {
            gstin: '26ABFCS9511H1Z7',
            state: '26',
            trade_name: 'SVN OPTO ELECTRONICS PVT LTD',
            legal_name: 'SVN OPTO ELECTRONICS PVT LTD',
          },
        ],
      },
      { name: 'SVN Unit-II', gstins: [] },
    ],
  },
];

/** Financial years to pre-create, so returns have a period to hang off.
 *
 * 2027-28 is deliberately seeded AHEAD of the wall clock: the month picker
 * affords working a year early (advance filing planning), and a period that
 * exists in the master but has no filings is simply an empty selection, not a
 * data-availability claim.
 */
const YEARS = [
  { year_code: '2024-25', start_date: '2024-04-01', end_date: '2025-03-31' },
  { year_code: '2025-26', start_date: '2025-04-01', end_date: '2026-03-31' },
  { year_code: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' },
  { year_code: '2027-28', start_date: '2027-04-01', end_date: '2028-03-31' },
];

const MONTHS = [
  ['04', '05'], ['05', '06'], ['06', '07'], ['07', '08'], ['08', '09'], ['09', '10'],
  ['10', '11'], ['11', '12'], ['12', '01'], ['01', '02'], ['02', '03'], ['03', '04'],
] as const;

const main = async () => {
  const client = new Client(cfg);
  try {
    await client.connect();
  } catch (e: any) {
    console.error(`Cannot connect to ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);
    console.error(`  ${e.message}`);
    process.exit(3);
  }

  console.log(`connected: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}\n`);
  await client.query('BEGIN');

  try {
    for (const c of MASTERS) {
      // `name` is the conflict key, so an EXISTING row kept an older spelling
      // ('Sakar', 'SVN Opto'). Rectify spellings by PAN — the PAN is the
      // company's real identity; display-name rewrites must never cross it.
      const existing = await client.query(
        `SELECT id FROM companies
          WHERE tax_identifier = $1
            AND UPPER(name) <> UPPER($2)
          ORDER BY id`,
        [c.tax_identifier, c.name],
      );
      for (const row of existing.rows) {
        await client.query(`UPDATE companies SET name = $2, updated_at = now() WHERE id = $1`,
          [row.id, c.name]);
        console.log(`company  ${row.id}: display name -> ${c.name}`);
      }
      const co = await client.query(
        `INSERT INTO companies (name, legal_name, tax_identifier)
         VALUES ($1, $2, $3)
         ON CONFLICT (LOWER(name)) DO UPDATE
           SET legal_name = COALESCE(EXCLUDED.legal_name, companies.legal_name),
               tax_identifier = COALESCE(companies.tax_identifier, EXCLUDED.tax_identifier),
               updated_at = now()
         RETURNING id`,
        [c.name, c.legal_name ?? null, c.tax_identifier],
      );
      // Fresh insert carries the display spelling; an upsert path that landed
      // on the row the spelling-rectify branch missed keeps legal_name fresh.
      if (c.legal_name) {
        await client.query(`UPDATE companies SET legal_name = $2 WHERE id = $1 AND (legal_name IS DISTINCT FROM $2)`,
          [co.rows[0].id, c.legal_name]);
      }
      const companyId = co.rows[0].id;
      console.log(`company  ${c.name.padEnd(10)} id=${companyId}  PAN ${c.tax_identifier}`);

      for (const u of c.units) {
        const un = await client.query(
          `INSERT INTO units (company_id, name) VALUES ($1, $2)
           ON CONFLICT (company_id, LOWER(name)) DO UPDATE SET updated_at = now()
           RETURNING id`,
          [companyId, u.name],
        );
        const unitId = un.rows[0].id;

        for (const g of u.gstins) {
          const gr = await client.query(
            `INSERT INTO gstins (company_id, unit_id, gstin_number, legal_name, trade_name, state_code)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (gstin_number) DO UPDATE
               SET company_id = EXCLUDED.company_id,
                   unit_id = EXCLUDED.unit_id,
                   legal_name = COALESCE(EXCLUDED.legal_name, gstins.legal_name),
                   trade_name = COALESCE(EXCLUDED.trade_name, gstins.trade_name),
                   state_code = COALESCE(EXCLUDED.state_code, gstins.state_code),
                   updated_at = now()
             RETURNING id`,
            [companyId, unitId, g.gstin, g.legal_name ?? null, g.trade_name ?? null, g.state],
          );
          console.log(`   unit  ${u.name.padEnd(12)} GSTIN ${g.gstin}  state ${g.state}  id=${gr.rows[0].id}`);
        }
        if (u.gstins.length === 0) {
          console.log(`   unit  ${u.name.padEnd(12)} (no separate GSTIN — shares the unit above)`);
        }
      }
    }

    // ---- financial years and their 12 periods ---------------------------
    for (const y of YEARS) {
      const fy = await client.query(
        `INSERT INTO financial_years (year_code, start_date, end_date) VALUES ($1, $2, $3)
         ON CONFLICT (year_code) DO UPDATE SET updated_at = now() RETURNING id`,
        [y.year_code, y.start_date, y.end_date],
      );
      const fyId = fy.rows[0].id;
      for (const [startMm, endMm] of MONTHS) {
        const yy = y.year_code.slice(0, 4);
        const nextYy = endMm === '01' ? String(Number(yy) + 1) : yy;
        const periodCode = `${yy}-${startMm}`;
        await client.query(
          `INSERT INTO periods (financial_year_id, period_code, start_date, end_date)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (financial_year_id, period_code) DO NOTHING`,
          [fyId, periodCode, `${yy}-${startMm}-01`, `${nextYy}-${endMm}-01`],
        );
      }
      console.log(`FY       ${y.year_code}  12 periods`);
    }

    await client.query('COMMIT');
  } catch (e: any) {
    await client.query('ROLLBACK');
    console.error('\nSeed failed, nothing written.');
    console.error(`  ${e.message}`);
    process.exit(4);
  }

  const counts = await client.query(
    `SELECT (SELECT count(*) FROM companies) AS companies,
            (SELECT count(*) FROM units) AS units,
            (SELECT count(*) FROM gstins) AS gstins,
            (SELECT count(*) FROM periods) AS periods`,
  );
  console.log('\nnow in the database:', counts.rows[0]);
  console.log('\ngstins:');
  const list = await client.query(
    `SELECT g.gstin_number, g.state_code, c.name AS company, u.name AS unit
     FROM gstins g JOIN companies c ON c.id = g.company_id LEFT JOIN units u ON u.id = g.unit_id
     ORDER BY c.name, g.gstin_number`,
  );
  for (const r of list.rows) {
    console.log(`  ${r.gstin_number}  ${String(r.company).padEnd(10)} ${r.unit}`);
  }
  await client.end();
};

main();