/**
 * Guarded UTGST Reclassification Script (Phase 1).
 *
 * Reclassifies Union Territory registrations without legislature
 * (state codes 04, 26, 31, 35, 38 — e.g. 26AALCS9985J1ZC) from SGST -> UTGST
 * WITHOUT changing:
 *   - original transaction values (`book_taxable_value`, `source_sgst`)
 *   - total tax liability (`igst + cgst + sgst + utgst + cess`)
 *   - non-UT State registrations (e.g. 24 Gujarat stays in SGST)
 *
 * Runs strictly through `scripts/test-db.ts` (assertTestDbTarget + server check).
 * Pass `--rollback` to reverse the reclassification cleanly and verify totals.
 */

import { Client } from 'pg';
import { loadEnv, pgConfig } from '../src/config/env';
import { assertConnectedDatabase, assertTestDbTarget } from '../src/config/test-db';

const UT_CODES = ['04', '26', '31', '35', '38'];

async function snapshot(c: Client) {
  const books = await c.query(`
    SELECT our_gstin,
           count(*)::int AS docs,
           round(coalesce(sum(book_taxable_value),0),2) AS taxable,
           round(coalesce(sum(book_igst),0),2) AS igst,
           round(coalesce(sum(book_cgst),0),2) AS cgst,
           round(coalesce(sum(book_sgst),0),2) AS sgst,
           round(coalesce(sum(book_utgst),0),2) AS utgst,
           round(coalesce(sum(book_cess),0),2) AS cess,
           round(coalesce(sum(book_igst + book_cgst + book_sgst + book_utgst + book_cess),0),2) AS total_tax
      FROM purchase_lines
     GROUP BY 1 ORDER BY 1
  `);
  const twob = await c.query(`
    SELECT our_gstin,
           count(*)::int AS docs,
           round(coalesce(sum(taxable_value),0),2) AS taxable,
           round(coalesce(sum(igst),0),2) AS igst,
           round(coalesce(sum(cgst),0),2) AS cgst,
           round(coalesce(sum(sgst),0),2) AS sgst,
           round(coalesce(sum(utgst),0),2) AS utgst,
           round(coalesce(sum(cess),0),2) AS cess,
           round(coalesce(sum(igst + cgst + sgst + utgst + cess),0),2) AS total_tax
      FROM gstr2b_lines
     GROUP BY 1 ORDER BY 1
  `);
  return { books: books.rows, twob: twob.rows };
}

async function main() {
  const rollback = process.argv.includes('--rollback');
  loadEnv();
  assertTestDbTarget('UTGST reclassification (scripts/reclassify-utgst.ts)');

  const c = new Client(pgConfig());
  await c.connect();
  try {
    const db = String((await c.query('SELECT current_database() d')).rows[0]?.d ?? '');
    assertConnectedDatabase(db, 'UTGST reclassification');

    const before = await snapshot(c);
    console.log('=== BEFORE ===');
    console.log('BOOKS:', JSON.stringify(before.books));
    console.log('TWOB :', JSON.stringify(before.twob));

    await c.query('BEGIN');
    await c.query(`SET LOCAL gst.allow_utgst_reclass = 'on'`);

    let bookMoved = 0;
    let twobOnBookMoved = 0;
    let twobMoved = 0;

    if (!rollback) {
      const r1 = await c.query(
        `UPDATE purchase_lines
            SET book_utgst = book_sgst,
                book_sgst  = 0,
                updated_at = now()
          WHERE left(our_gstin, 2) = ANY($1::text[])
            AND book_sgst <> 0
            AND book_utgst = 0`,
        [UT_CODES],
      );
      bookMoved = r1.rowCount ?? 0;

      const r2 = await c.query(
        `UPDATE purchase_lines
            SET twob_utgst = twob_sgst,
                twob_sgst  = 0,
                updated_at = now()
          WHERE left(our_gstin, 2) = ANY($1::text[])
            AND twob_sgst IS NOT NULL
            AND twob_sgst <> 0
            AND coalesce(twob_utgst, 0) = 0`,
        [UT_CODES],
      );
      twobOnBookMoved = r2.rowCount ?? 0;

      const r3 = await c.query(
        `UPDATE gstr2b_lines
            SET utgst = sgst,
                sgst  = 0
          WHERE left(our_gstin, 2) = ANY($1::text[])
            AND sgst <> 0
            AND utgst = 0`,
        [UT_CODES],
      );
      twobMoved = r3.rowCount ?? 0;
    } else {
      const r1 = await c.query(
        `UPDATE purchase_lines
            SET book_sgst  = book_sgst + book_utgst,
                book_utgst = 0,
                updated_at = now()
          WHERE left(our_gstin, 2) = ANY($1::text[])
            AND book_utgst <> 0`,
        [UT_CODES],
      );
      bookMoved = r1.rowCount ?? 0;

      const r2 = await c.query(
        `UPDATE purchase_lines
            SET twob_sgst  = coalesce(twob_sgst, 0) + twob_utgst,
                twob_utgst = 0,
                updated_at = now()
          WHERE left(our_gstin, 2) = ANY($1::text[])
            AND coalesce(twob_utgst, 0) <> 0`,
        [UT_CODES],
      );
      twobOnBookMoved = r2.rowCount ?? 0;

      const r3 = await c.query(
        `UPDATE gstr2b_lines
            SET sgst  = sgst + utgst,
                utgst = 0
          WHERE left(our_gstin, 2) = ANY($1::text[])
            AND utgst <> 0`,
        [UT_CODES],
      );
      twobMoved = r3.rowCount ?? 0;
    }

    const after = await snapshot(c);

    // Strict invariant check: total_tax & (sgst + utgst) MUST be identical for every GSTIN!
    for (const b of before.books) {
      const a = after.books.find((x: any) => x.our_gstin === b.our_gstin);
      if (!a || Number(a.total_tax) !== Number(b.total_tax) || Number(a.taxable) !== Number(b.taxable)) {
        throw new Error(`INVARIANT FAILED on Books ${b.our_gstin}: before=${JSON.stringify(b)} after=${JSON.stringify(a)}`);
      }
      const bSum = Math.round((Number(b.sgst) + Number(b.utgst)) * 100) / 100;
      const aSum = Math.round((Number(a.sgst) + Number(a.utgst)) * 100) / 100;
      if (bSum !== aSum) {
        throw new Error(`SGST+UTGST INVARIANT FAILED on Books ${b.our_gstin}: ${bSum} vs ${aSum}`);
      }
    }
    for (const b of before.twob) {
      const a = after.twob.find((x: any) => x.our_gstin === b.our_gstin);
      if (!a || Number(a.total_tax) !== Number(b.total_tax) || Number(a.taxable) !== Number(b.taxable)) {
        throw new Error(`INVARIANT FAILED on 2B ${b.our_gstin}: before=${JSON.stringify(b)} after=${JSON.stringify(a)}`);
      }
    }

    await c.query(
      `INSERT INTO audit_trail (changed_by, action, reason, details)
       VALUES ($1, $2, $3, $4)`,
      [
        'phase1-migration',
        rollback ? 'UTGST_ROLLBACK' : 'UTGST_RECLASS',
        rollback
          ? 'Rolled back UT UTGST -> SGST reclassification'
          : 'Reclassified Union Territory (04,26,31,35,38) SGST -> UTGST without altering total tax or source columns',
        JSON.stringify({ bookMoved, twobOnBookMoved, twobMoved, before, after }),
      ],
    );

    await c.query('COMMIT');
    console.log('=== AFTER ===');
    console.log('BOOKS:', JSON.stringify(after.books));
    console.log('TWOB :', JSON.stringify(after.twob));
    console.log(`DONE (${rollback ? 'ROLLBACK' : 'RECLASS'}): bookMoved=${bookMoved}, twobOnBookMoved=${twobOnBookMoved}, twobMoved=${twobMoved}`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
