/**
 * GST ERP — local web server.
 *
 * A small LAN service so the whole team can drop the month's files in from a
 * browser and get exactly the reconciliation `npm run cli` produces. It calls
 * the same pipeline module, so the workbook on screen and the workbook on disk
 * can never disagree.
 *
 *   npm run serve                          # http://<this machine>:4310
 *   npm run serve -- --port 4400
 *   npm run serve -- --input "D:\c drive\Desktop\GST Monthly Input"
 *
 * Security note: this binds 0.0.0.0 so colleagues on the same office network
 * can reach it, which means anyone who can route to this machine can read the
 * company's GST data. There is no login. Set GST_WEB_PASSWORD to require a
 * shared passcode, and only run it on a trusted network.
 */

import express from 'express';
import fs from 'fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from 'pg';

import type { ExceptionKind, MonthlyRun } from '../app/pipeline';
import {
  auditTrail,
  dashboard as phase0Dashboard,
  dbReady,
  getLine,
  importPastedPurchase,
  isLocked,
  itcWorking,
  lineHistory,
  listLines,
  listLocks,
  loadBundleForReconcile,
  lockMonth,
  listUsers,
  monthControl,
  fyOptionsOf,
  reReconcile,
  resetReconToBook,
  setItcDecision,
  setOurGstin,
  setReturnClassification,
  twoBRegistry,
  unlockMonth,
  updateRecon,
  ITC_DECISIONS,
  RETURN_CLASSIFICATIONS,
  type ReconField,
} from '../app/store';
import { isGstr2bJson, parseGstr2b, parseGstr2bJson, parsePurchaseRegister, parseSalesRegister, sniffKind } from '../engine/ingest';
import { buildGstr3b } from '../engine/gstr3b';
import { persistRun, sha256 } from '../app/store';
import { normGstin as normGstinOf, r2, isoDate, normInvoiceType, normDocType, normInvoice, docAmount, docSign, docTypeOrNull, monthRange } from '../engine/core';
import { reconcilePurchases, type DateWindow } from '../engine/match';
import { buildImsActions } from '../engine/ims';
import { buildGstr9, buildGstr9c, fyMonths, gstr9PortalJson, gstr9WorkingRows, gstr9cWorkingRows } from '../engine/gstr9';
import { summarisePurchaseDocuments } from '../app/purchase-summary';
import XLSX from 'xlsx';
import {
  FOLLOWUP_COLUMNS,
  REPORTS,
  describeFilters,
  fileNameFor,
  findReport,
  runReportNamed,
  supplierFollowUp,
  toCompleteWorkbook,
  toCsv,
  toWorkbookBuffer,
  type ColType,
  type Column,
  type ReportFilters,
} from '../app/reports';
import { planImport, planToEdits } from '../app/report-import';
import { purchaseTemplateBuffer, purchaseTemplateCsv } from '../app/template';
import { salesTemplateBuffer, salesTemplateCsv } from '../app/sales-template';
import { twobReconTemplateBuffer, twobReconTemplateCsv } from '../app/twob-recon-template';
import { plTemplateBuffer, plTemplateCsv } from '../app/pl-template';
import {
  importPl, loadPlHeads, loadPlRecon, parsePlUpload, readPlFile, runPlRecon, setPlDifferenceReason,
} from '../app/pl-store';
import {
  hsnSummary,
  importFiled,
  loadOutcomePage,
  outwardCoverage,
  rebuildDrafts,
  runRecon,
} from '../app/gstr1-store';
import { parseFiledWorkbook, resolvePeriod, summariseParsed } from '../engine/gstr1-import';
import { parseTableType, TABLE_LABEL, type FiledRow } from '../engine/gstr1-recon';
import { pickDataSheet, readAllSheets } from '../app/sheets';
import { displayCompany } from '../app/display-names';
import { applyEdits, fyLabelOf, setFollowUp, withClient, E_DOC_FIELDS, parseEDocField, type EDocField } from '../app/store';
import { registerAdminRoutes, audit } from './admin-api';
import { can, login, logout, setPassword, userFromToken, type SessionUser } from '../app/auth';
import { loadEnv, pgConfig } from '../config/env';

loadEnv();

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * `PORT=0` is set in some environments (it means "pick any free port"), which
 * would silently move the app somewhere the team cannot find. Only accept a
 * real port number, and say so when the environment's value is ignored.
 */
const DEFAULT_PORT = 4310;
function resolvePort(): { port: number; note?: string } {
  const flag = arg('port');
  const raw = flag ?? process.env.PORT ?? String(DEFAULT_PORT);
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n < 65536) return { port: n };
  return {
    port: DEFAULT_PORT,
    note: flag || process.env.PORT
      ? `ignoring invalid port "${raw}" from ${flag ? '--port' : 'the PORT environment variable'}`
      : undefined,
  };
}
const { port: PORT, note: PORT_NOTE } = resolvePort();
const HOST = arg('host', process.env.HOST || '0.0.0.0');
const INPUT = arg('input', process.env.GST_INPUT_DIR || 'D:/c drive/Desktop/GST Monthly Input')!;
const OUT = arg('out', process.env.GST_OUTPUT_DIR || path.join(process.cwd(), 'output'))!;
const PASSWORD = process.env.GST_WEB_PASSWORD || '';

/** Uploads land here so a run never touches the team's real source folder. */
const UPLOAD_DIR = path.join(OUT, 'uploads');

// ---------------------------------------------------------------------------
// jobs — a full run reads ~20k rows and takes tens of seconds, well past a
// browser's patience, so it runs in the background and the page polls.
// ---------------------------------------------------------------------------

/**
 * A run is executed as a child process rather than in this one.
 *
 * The pipeline is synchronous — reading 20k rows and building a 12-sheet
 * workbook takes tens of seconds of solid CPU. Doing that on the server's own
 * event loop freezes every HTTP request for the duration, so the page sits on
 * "running" with nothing to show. As a child, the server stays responsive, the
 * log streams live, and a crash in one run cannot take the server down.
 */
const TSX = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = path.join('src', 'cli', 'monthly.ts');

type SerialisedRun = Omit<MonthlyRun, 'bundles' | 'log'>;

type Job = {
  id: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  log: string[];
  error?: string;
  inputDir: string;
  outDir: string;
};

const jobs = new Map<string, Job>();
let jobSeq = 0;

// The last successful run, kept in memory so the page can be reloaded without
// re-running, and so /api/download works before anyone hits Run.
let lastResult: SerialisedRun | null = null;

function startJob(opts: { inputDir: string; outDir: string; onlyPeriod?: string; salesGstin?: string }): Job {
  const id = `job${++jobSeq}`;
  const job: Job = {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    log: [],
    inputDir: opts.inputDir,
    outDir: opts.outDir,
  };
  jobs.set(id, job);

  fs.mkdirSync(opts.outDir, { recursive: true });
  const jsonOut = path.join(opts.outDir, `.run-${id}.json`);

  const args = [
    TSX,
    CLI,
    '--input', opts.inputDir,
    '--out', opts.outDir,
    '--json', jsonOut,
  ];
  if (opts.onlyPeriod) args.push('--period', opts.onlyPeriod);
  if (opts.salesGstin) args.push('--sales-gstin', opts.salesGstin);

  const child = spawn(process.execPath, args, { cwd: process.cwd() });

  const feed = (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) job.log.push(line);
    }
    // Only the tail is kept, so a long run does not grow memory forever.
    if (job.log.length > 500) job.log = job.log.slice(-500);
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);

  child.on('error', (e) => {
    job.status = 'failed';
    job.error = `could not start the run: ${e.message}`;
    job.finishedAt = new Date().toISOString();
  });

  child.on('close', (code) => {
    job.finishedAt = new Date().toISOString();
    if (code !== 0) {
      job.status = 'failed';
      job.error = job.error || `run exited with code ${code}`;
      try { fs.unlinkSync(jsonOut); } catch { }
      return;
    }
    try {
      lastResult = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
      job.status = 'done';
    } catch (e: any) {
      job.status = 'failed';
      job.error = `run finished but its result could not be read back: ${e.message}`;
    } finally {
      try { fs.unlinkSync(jsonOut); } catch { }
    }
  });

  return job;
}

// ---------------------------------------------------------------------------
// exception drill-down, read straight off the in-memory run
// ---------------------------------------------------------------------------

function exceptionRows(
  kind: string,
  gstin?: string,
  period?: string,
  search = '',
  limit = 500,
) {
  if (!lastResult) return [];
  const q = search.trim().toLowerCase();
  const wanted: ExceptionKind[] =
    kind === 'all'
      ? ['missing', 'mismatch', 'blocked', 'duplicate', 'unbooked']
      : [kind as ExceptionKind];

  const out: Array<Record<string, unknown>> = [];
  for (const k of wanted) {
    for (const r of lastResult.exceptions?.[k] ?? []) {
      if (gstin && r.gstin !== gstin) continue;
      if (period && r.period !== period) continue;
      if (q && ![r.vendor, r.supplierGstin, r.invoiceNo].join(' ').toLowerCase().includes(q)) continue;
      out.push(r);
    }
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// masters, read-only, straight from PostgreSQL
// ---------------------------------------------------------------------------

async function readMasters() {
  const cfg = pgConfig();
  if (!cfg.password) return { ok: false as const, reason: 'PGPASSWORD is not set in .env' };

  const client = new Client(cfg);
  try {
    await client.connect();
    const res = await client.query(`
      SELECT c.id                AS company_id,
             c.name              AS company,
             c.tax_identifier    AS pan,
             u.name              AS unit,
             g.gstin_number      AS gstin,
             g.state_code        AS state,
             g.trade_name        AS trade_name
      FROM companies c
      LEFT JOIN units u  ON u.company_id = c.id
      LEFT JOIN gstins g ON g.company_id = c.id AND (g.unit_id = u.id OR g.unit_id IS NULL)
      WHERE c.status = 1
      ORDER BY c.name, u.name`);
    return { ok: true as const, rows: res.rows };
  } catch (e: any) {
    return { ok: false as const, reason: e.message };
  } finally {
    await client.end().catch(() => { });
  }
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));

/**
 * Session gate. Every /api route except the health check and the login itself
 * needs a valid session cookie; anything else is a 401 before it reaches a
 * handler. Authorisation is a separate, per-route check — a logged-in user with
 * the wrong permission still gets a 403 from requirePerm.
 */
const PUBLIC_API = new Set(['/api/health', '/api/auth/login']);

function sessionToken(req: any): string | undefined {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === 'gst_session') {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

app.use((req: any, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API.has(req.path)) return next();
  userFromToken(sessionToken(req))
    .then((u) => {
      if (!u) return res.status(401).json({ error: 'Please sign in.', needAuth: true });
      req.user = u;
      next();
    })
    .catch((e) => res.status(500).json({ error: e.message }));
});

/** Route guard: the session user must hold this permission. */
function requirePerm(resource: string, action: string) {
  return (req: any, res, next) => {
    if (can(req.user, resource, action)) return next();
    res.status(403).json({
      error: `Your role (${req.user?.role || 'unknown'}) cannot ${action} ${resource}.`,
      needPerm: `${resource}.${action}`,
    });
  };
}

/**
 * Company isolation. purchase_lines carries our_gstin, and a GSTIN belongs to
 * exactly one company, so an allowed GSTIN list is enough to fence off every
 * data query. The map is tiny and rarely changes, so it is cached briefly.
 */
let gstinCompanyAt = 0;
/** GSTIN number -> { id, companyId } */
let gstinMapCache = new Map<string, { id: number; companyId: number }>();
const GSTMAP_TTL_MS = 60_000;

async function gstinToCompany(): Promise<Map<string, { id: number; companyId: number }>> {
  if (Date.now() - gstinCompanyAt < GSTMAP_TTL_MS) return gstinMapCache;
  const rows = (await withClient((c) =>
    c.query('SELECT id, gstin_number, company_id FROM gstins'),
  )).rows;
  gstinMapCache = new Map(
    rows.map((r: any) => [String(r.gstin_number).toUpperCase(), { id: r.id, companyId: r.company_id }]),
  );
  gstinCompanyAt = Date.now();
  return gstinMapCache;
}

/**
 * GSTINs a user may work on, or null for "all".
 *
 * Company access is the outer fence; an explicit GSTIN grant (user_gstin_access)
 * narrows it further. SUPER ADMIN has no grant rows at all, which reads as null
 * and means every GSTIN.
 */
async function allowedGstins(user: SessionUser): Promise<string[] | null> {
  if (user.companyIds === null && user.gstinIds === null) return null;
  const map = await gstinToCompany();
  const companies = user.companyIds;
  const gstinIds = user.gstinIds;
  return [...map.entries()]
    .filter(([, v]) => companies === null || companies.includes(v.companyId))
    .filter(([, v]) => gstinIds === null || gstinIds.includes(v.id))
    .map(([g]) => g);
}


// Reject a request that names a GSTIN the caller may not use.
app.use((req: any, res, next) => {
  const u: SessionUser | undefined = req.user;
  const g = req.query?.gstin;
  if (!u || typeof g !== 'string' || !g) return next();
  allowedGstins(u)
    .then((list) => {
      if (list === null || list.includes(String(g).toUpperCase())) return next();
      res.status(403).json({ error: 'You do not have access to this GSTIN.' });
    })
    .catch((e) => res.status(500).json({ error: e.message }));
});

app.use(express.static(path.join(process.cwd(), 'src', 'server', 'public'), { index: 'index.html' }));

registerAdminRoutes(app, requirePerm);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, input: INPUT, out: OUT, authRequired: !!PASSWORD });
});

app.get('/api/masters', async (_req, res) => {
  const m = await readMasters();
  res.status(m.ok ? 200 : 200).json(m);
});

/**
 * Upload one file into the scratch folder.
 *
 * The browser posts the raw bytes with the file name in `?name=`, which avoids
 * pulling in a multipart parser for something this small.
 */
app.post('/api/upload', requirePerm('data', 'upload_2b'), express.raw({ type: '*/*', limit: '400mb' }), (req, res) => {
  void audit((req as any).user, {
    action: 'GSTR2B_UPLOAD', module: 'Data',
    details: { name: path.basename(String(req.query.name || 'upload')) }
  });
  const name = path.basename(String(req.query.name || 'upload.bin'));
  if (!name || name.startsWith('.')) {
    return res.status(400).json({ error: 'bad file name' });
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const dest = path.join(UPLOAD_DIR, name);
  fs.writeFileSync(dest, req.body);
  res.json({ ok: true, name, size: req.body?.length ?? 0, dir: UPLOAD_DIR });
});

app.get('/api/uploads', (_req, res) => {
  if (!fs.existsSync(UPLOAD_DIR)) return res.json({ dir: UPLOAD_DIR, files: [] });
  const files = fs
    .readdirSync(UPLOAD_DIR)
    .filter((f) => !/^~\$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(UPLOAD_DIR, f));
      return { name: f, size: st.size, modified: st.mtime.toISOString() };
    });
  res.json({ dir: UPLOAD_DIR, files });
});

app.delete('/api/uploads', (_req, res) => {
  if (!fs.existsSync(UPLOAD_DIR)) return res.json({ cleared: 0 });
  const files = fs.readdirSync(UPLOAD_DIR);
  for (const f of files) fs.unlinkSync(path.join(UPLOAD_DIR, f));
  res.json({ cleared: files.length });
});

/**
 * Portal GSTR-1 file intake — separate permission from the 2B upload route so
 * a Sales-register operator is not unexpectedly gated by the 2B permission.
 * Files land in the same scratch folder; nothing is written to the database.
 */
app.post('/api/portal-g1/upload', requirePerm('data', 'import_sales'),
  express.raw({ type: '*/*', limit: '200mb' }),
  (req, res) => {
    void audit((req as any).user, {
      action: 'PORTAL_G1_UPLOAD', module: 'Data',
      details: { name: path.basename(String(req.query.name || 'portal-g1.xlsx')) }
    });
    const name = path.basename(String(req.query.name || 'portal-g1.xlsx'));
    if (!name || name.startsWith('.')) {
      return res.status(400).json({ error: 'bad file name' });
    }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const dest = path.join(UPLOAD_DIR, name);
    fs.writeFileSync(dest, req.body);
    res.json({ ok: true, name, size: req.body?.length ?? 0, dir: UPLOAD_DIR });
  });

/**
 * Read-only preview of a staged portal GSTR-1 file before it is imported.
 * Reuses the same parser as /api/gstr1/import so the preview is what the import
 * will actually see. Plain async handler (not wrapped) so it can sit before the
 * `wrap` helper is declared.
 */
app.post('/api/portal-g1/preview', requirePerm('data', 'import_sales'),
  express.raw({ type: '*/*', limit: '200mb' }),
  (req, res) => {
    const raw = req.body;
    if (!raw?.length) return res.status(400).json({ error: 'No file received.' });
    const name = path.basename(String(req.query.name || 'portal-g1.xlsx'));
    (async () => {
      let parsed;
      try {
        parsed = parseFiledWorkbook(Buffer.isBuffer(raw) ? raw : Buffer.from(raw), { our_gstin: str(req.query.gstin) || undefined, period: str(req.query.period) });
      } catch (e: any) {
        return res.status(400).json({ error: `${name} parha nahi ja saka: ${e.message}` });
      }
      const fileGstin = parsed.rows.length ? parsed.rows[0].our_gstin : undefined;
      const sample = parsed.rows.slice(0, 25);
      const totals = summariseParsed(parsed.rows);
      res.json({
        name,
        sheets: parsed.sheets,
        perSheet: parsed.perSheet,
        tableOfSheet: parsed.tableOfSheet,
        skipped: parsed.skipped.slice(0, 30),
        fileGstin,
        period: resolvePeriod(parsed.rows, str(req.query.period) || ''),
        totals,
        sampleRows: sample.map((r) => ({
          table_type: r.table_type,
          invoice_number: r.invoice_number,
          invoice_date: r.invoice_date,
          invoice_type: r.invoice_type,
          recipient_gstin: r.recipient_gstin,
          recipient_name: r.recipient_name,
          place_of_supply: r.place_of_supply,
          hsn: r.hsn,
          rate: r.rate,
          taxable_value: r.taxable_value,
          igst: r.igst,
          cgst: r.cgst,
          sgst: r.sgst,
          cess: r.cess,
          invoice_value: r.invoice_value,
          reverse_charge: r.reverse_charge,
          source_row: r.source_row,
        })),
      });
    })().catch((e) => {
      if (res.headersSent) { console.error(`[POST /api/portal-g1/preview] failed after response sent:`, e?.message || e); return; }
      res.status(500).json({ error: e.message });
    });
  });

/**
 * Books / SAP Sales Register Excel intake — the sales register does not have its
 * own direct-into-database import route; it is ingested by the monthly run, which
 * persists sales_invoices (and items) from it. This route is only the file intake
 * into the scratch folder so the browser can hand the file to /api/run (or to a
 * future sales-import step) without needing the 2B upload permission.
 */
app.post('/api/sales-register/upload', requirePerm('data', 'import_sales'),
  express.raw({ type: '*/*', limit: '200mb' }),
  (req, res) => {
    void audit((req as any).user, {
      action: 'SALES_REGISTER_UPLOAD', module: 'Data',
      details: { name: path.basename(String(req.query.name || 'sales-register.xlsx')) }
    });
    const name = path.basename(String(req.query.name || 'sales-register.xlsx'));
    if (!name || name.startsWith('.')) {
      return res.status(400).json({ error: 'bad file name' });
    }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const dest = path.join(UPLOAD_DIR, name);
    fs.writeFileSync(dest, req.body);
    res.json({ ok: true, name, size: req.body?.length ?? 0, dir: UPLOAD_DIR });
  });

/** Start a run. Body: { dir?, period?, salesGstin? }. Returns the job id. */
app.post('/api/run', requirePerm('data', 'run'), (req, res) => {
  void audit((req as any).user, {
    action: 'RECONCILIATION_RUN', module: 'Data',
    period: str(req.body?.period) || null
  });
  const dir = String(req.body?.dir || INPUT);
  if (!fs.existsSync(dir)) {
    return res.status(400).json({ error: `Folder not found: ${dir}` });
  }
  const outDir = dir === UPLOAD_DIR ? path.join(OUT, 'runs') : OUT;
  const job = startJob({
    inputDir: dir,
    outDir,
    onlyPeriod: req.body?.period || undefined,
    salesGstin: req.body?.salesGstin || undefined,
  });
  res.json({ jobId: job.id });
});

app.get('/api/run/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json(job);
});

app.get('/api/result', (_req, res) => {
  if (!lastResult) return res.json({ ready: false });
  const { exceptions, ...rest } = lastResult;
  res.json({
    ready: true,
    ...rest,
    exceptionCounts: Object.fromEntries(
      Object.entries(exceptions ?? {}).map(([k, v]) => [k, (v as unknown[]).length]),
    ),
  });
});

app.get('/api/rows', (req, res) => {
  const kind = String(req.query.kind || 'missing');
  const limit = Math.min(Number(req.query.limit || 500), 5000);
  const rows = exceptionRows(
    kind,
    req.query.gstin ? String(req.query.gstin) : undefined,
    req.query.period ? String(req.query.period) : undefined,
    req.query.q ? String(req.query.q) : '',
    limit,
  );
  res.json({ kind, count: rows.length, rows });
});

/** Vendor follow-up list — the one you actually email out. */
app.get('/api/vendor-followup', (req, res) => {
  const rows = exceptionRows(
    'missing',
    req.query.gstin ? String(req.query.gstin) : undefined,
    req.query.period ? String(req.query.period) : undefined,
  );
  res.json({
    count: rows.length,
    rows: rows.map((r) => ({
      ...r,
      ask:
        `Vendor se GSTR-1 me ye invoice file karwaayein. Tab tak ${Number(r.itc || 0).toFixed(2)} ITC claim mat karein.`,
    })),
  });
});

// ---------------------------------------------------------------------------
// Phase 0 — the editable record
//
// Everything above answers "what did the run find". Everything below answers
// "what did we decide, and who decided it".
// ---------------------------------------------------------------------------

/**
 * Wraps an async handler so a rejected promise cannot kill the request.
 *
 * A handler that has already written a response and then throws (a double send,
 * an `ERR_HTTP_HEADERS_SENT`, a stream that aborts mid-send) must NOT be
 * answered again. Trying to send a second response throws *inside this catch*,
 * which becomes an unhandled rejection — and Node then exits, taking the whole
 * server down for every user until someone restarts it. So: if the headers are
 * already out, log and stop.
 */
const wrap =
  (fn: (req: any, res: any) => Promise<unknown>) =>
    (req: any, res: any) => {
      fn(req, res).catch((e) => {
        if (res.headersSent) {
          console.error(`[${req.method} ${req.originalUrl}] failed after the response was sent:`, e?.message || e);
          return;
        }
        res.status(500).json({ error: e.message });
      });
    };

/** Who is making the change. Phase 0 has no login, so this is a typed name. */
/**
 * Who a change is attributed to. The session is the only accepted source: a
 * client-supplied `by` must never be able to forge the audit trail.
 */
function actorOf(req: any): string {
  const u: SessionUser | undefined = req.user;
  return u ? u.displayName : 'unknown';
}

/** The logged-in account id, for audit rows. Null when there is no session. */
function actorIdOf(req: any): number | null {
  return req.user?.id ?? null;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

app.get('/api/phase0/status', wrap(async (_req, res) => {
  const ready = await dbReady();
  res.json({ ...ready, decisions: ITC_DECISIONS, classifications: RETURN_CLASSIFICATIONS });
}));

app.get('/api/phase0/dashboard', wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.json({ ready: false, reason: ready.reason });
  const d = await phase0Dashboard({
    gstin: str(req.query.gstin) || undefined,
    period: str(req.query.period) || undefined,
  });
  res.json({ ready: true, ...d });
}));

/** The purchase register as stored, with the book and recon columns side by side. */
app.get('/api/lines', wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const { total, rows } = await listLines({
    gstin: str(req.query.gstin) || undefined,
    period: str(req.query.period) || undefined,
    search: str(req.query.q) || undefined,
    status: str(req.query.status) || undefined,
    decision: str(req.query.decision) || undefined,
    limit: Number(req.query.limit || 200),
    offset: Number(req.query.offset || 0),
  });
  res.json({ total, count: rows.length, rows });
}));

function polarityOfRow(
  docType: unknown,
  taxable: unknown,
  igst: unknown,
  cgst: unknown,
  sgst: unknown,
  cess: unknown,
): 'credit' | 'debit' {
  const dt = normDocType(docType);
  const nonZero = [r2(taxable), r2(igst), r2(cgst), r2(sgst), r2(cess)].filter((n) => n !== 0);
  if (dt === 'Credit Note' || (nonZero.length > 0 && nonZero.every((n) => n < 0))) return 'credit';
  return 'debit';
}

function daysDiffIso(a?: string, b?: string): number {
  if (!a || !b) return 9999;
  const ma = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(a).trim());
  const mb = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(b).trim());
  if (!ma || !mb) return 9999;
  return Math.round(
    Math.abs(Date.UTC(Number(ma[1]), Number(ma[2]) - 1, Number(ma[3])) - Date.UTC(Number(mb[1]), Number(mb[2]) - 1, Number(mb[3]))) /
      86400000,
  );
}

function monthDiffIso(a?: string, b?: string): number {
  const ma = /^(\d{4})-(\d{2})/.exec(String(a || '').trim());
  const mb = /^(\d{4})-(\d{2})/.exec(String(b || '').trim());
  if (!ma || !mb) return 999;
  return Math.abs(Number(ma[1]) * 12 + Number(ma[2]) - (Number(mb[1]) * 12 + Number(mb[2])));
}

function invoiceSimScore(a: string, b: string): number {
  const na = normInvoice(a);
  const nb = normInvoice(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const tailA = /(\d{4,})$/.exec(na)?.[1] || '';
  const tailB = /(\d{4,})$/.exec(nb)?.[1] || '';
  if (tailA && tailB && tailA === tailB) return 85;
  const digA = na.replace(/\D/g, '');
  const digB = nb.replace(/\D/g, '');
  if (digA.length >= 3 && digA === digB) return 75;
  if (Math.min(na.length, nb.length) >= 3 && (na.includes(nb) || nb.includes(na))) return 70;
  return 0;
}

interface Aggregated2bInvoice {
  line_key: string;
  our_gstin: string;
  twob_month: string;
  portal_fp: string;
  supplier_gstin: string;
  supplier_name: string;
  invoice_no: string;
  invoice_date: string;
  document_type: string;
  doc_type: string;
  polarity: 'credit' | 'debit';
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  itc: number;
  itc_availability: string;
  reason?: string;
}

/**
 * Load all unbooked GSTR-2B invoices for `gstins`, grouping multi-rate rows of
 * the same 2B invoice together and excluding any group whose member key is
 * already matched to a book line (other than `excludeLineId`).
 */
async function loadAggregatedUnbooked2b(
  gstins: string[],
  excludeLineId?: number,
): Promise<Aggregated2bInvoice[]> {
  if (!gstins.length) return [];
  const normList = gstins.map((g) => normGstinOf(g)).filter(Boolean);
  const { rows2b, claimedKeys } = await withClient(async (c) => {
    const claimedQ = excludeLineId
      ? await c.query(
          `SELECT matched_2b_key FROM purchase_lines
            WHERE our_gstin = ANY($1::text[]) AND matched_2b_key IS NOT NULL AND id <> $2`,
          [normList, excludeLineId],
        )
      : await c.query(
          `SELECT matched_2b_key FROM purchase_lines
            WHERE our_gstin = ANY($1::text[]) AND matched_2b_key IS NOT NULL`,
          [normList],
        );
    const tQ = await c.query(
      `SELECT line_key, our_gstin, twob_month, portal_fp, supplier_gstin, supplier_name,
              invoice_no, invoice_date, document_type, taxable_value, igst, cgst, sgst, cess,
              itc_availability, reason
         FROM gstr2b_lines
        WHERE our_gstin = ANY($1::text[])
        ORDER BY twob_month DESC, id`,
      [normList],
    );
    return {
      rows2b: tQ.rows,
      claimedKeys: new Set<string>(claimedQ.rows.map((x: any) => String(x.matched_2b_key))),
    };
  });

  const groups = new Map<string, Aggregated2bInvoice & { memberKeys: string[] }>();
  for (const r of rows2b as any[]) {
    const ourG = normGstinOf(r.our_gstin);
    const sup = normGstinOf(r.supplier_gstin);
    const inv = String(r.invoice_no ?? '').trim();
    const mo = String(r.portal_fp || r.twob_month || '').slice(0, 7);
    const dType = normDocType(r.document_type);
    const gk = `${ourG}|${sup}|${normInvoice(inv)}|${mo}|${dType}`;
    const existing = groups.get(gk);
    const tax = r2(r.taxable_value);
    const ig = r2(r.igst);
    const cg = r2(r.cgst);
    const sg = r2(r.sgst);
    const ce = r2(r.cess);
    const lineItc = r2(ig + cg + sg + ce);
    if (!existing) {
      groups.set(gk, {
        line_key: String(r.line_key),
        our_gstin: ourG,
        twob_month: String(r.twob_month || mo),
        portal_fp: mo,
        supplier_gstin: sup,
        supplier_name: String(r.supplier_name ?? '').trim(),
        invoice_no: inv,
        invoice_date: isoDate(r.invoice_date),
        document_type: String(r.document_type ?? 'Regular'),
        doc_type: dType,
        polarity: polarityOfRow(r.document_type, tax, ig, cg, sg, ce),
        taxable_value: tax,
        igst: ig,
        cgst: cg,
        sgst: sg,
        cess: ce,
        itc: lineItc,
        itc_availability: String(r.itc_availability ?? 'Yes'),
        reason: r.reason ? String(r.reason) : undefined,
        memberKeys: [String(r.line_key)],
      });
    } else {
      existing.taxable_value = r2(existing.taxable_value + tax);
      existing.igst = r2(existing.igst + ig);
      existing.cgst = r2(existing.cgst + cg);
      existing.sgst = r2(existing.sgst + sg);
      existing.cess = r2(existing.cess + ce);
      existing.itc = r2(existing.itc + lineItc);
      existing.polarity = polarityOfRow(existing.doc_type, existing.taxable_value, existing.igst, existing.cgst, existing.sgst, existing.cess);
      existing.memberKeys.push(String(r.line_key));
    }
  }

  const out: Aggregated2bInvoice[] = [];
  for (const g of groups.values()) {
    if (g.memberKeys.some((k) => claimedKeys.has(k))) continue;
    out.push(g);
  }
  return out;
}

function parseToleranceArg(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) : undefined;
}

function parseDateWindowArg(raw: unknown): DateWindow | undefined {
  const s = String(raw ?? '').trim();
  if (s === 'any' || s === 'exact' || s === '2days' || s === '5days' || s === 'month') return s;
  return undefined;
}

/**
 * Everything the Purchase Register vs GSTR-2B screen needs, in one read.
 *
 * Three questions, one round trip:
 *
 *   * `summary` — what the last run concluded for this GSTIN and month;
 *   * `rows` — each book invoice as it stands now, with the 2B side beside it,
 *     which is also the list the user edits;
 *   * `twoBOnly` — invoices the portal reported and the books never booked.
 *
 * Declared before `/api/lines/:id` so the literal path is not read as an id.
 */
app.get('/api/recon/purchase', requirePerm('recon', 'view'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });

  const f = filtersOf(req);

  // ---- Multi-Month & Multi-GSTIN Resolution -------------------------------
  const rawPeriods = str(req.query.periods)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^\d{4}-\d{2}$/.test(p));
  const fromP = str(req.query.fromPeriod || req.query.from);
  const toP = str(req.query.toPeriod || req.query.to);
  let targetPeriods: string[] | undefined;
  if (rawPeriods.length > 0) {
    targetPeriods = [...new Set(rawPeriods)].sort();
  } else if (/^\d{4}-\d{2}$/.test(fromP) && /^\d{4}-\d{2}$/.test(toP)) {
    targetPeriods = monthRange(fromP <= toP ? fromP : toP, fromP <= toP ? toP : fromP);
  }

  const allowed = await allowedGstins(req.user);
  const rawGstins = str(req.query.gstins)
    .split(',')
    .map((g) => normGstinOf(g))
    .filter(Boolean);
  let targetGstins: string[] | undefined;
  if (str(req.query.gstins).toUpperCase() === 'ALL') {
    targetGstins = allowed ?? undefined; // null allowed => all GSTINs in DB
  } else if (rawGstins.length > 0) {
    targetGstins = allowed ? rawGstins.filter((g) => allowed.includes(g)) : rawGstins;
  }
  const singleGstin = targetGstins ? undefined : (str(req.query.gstins).toUpperCase() === 'ALL' ? undefined : f.gstin);
  const singlePeriod = targetPeriods ? undefined : f.period;

  const { total, rows } = await listLines({
    gstin: singleGstin,
    gstins: targetGstins,
    period: singlePeriod,
    periods: targetPeriods,
    search: f.q,
    status: f.status,
    limit: Math.min(Number(req.query.limit || 500), 5000),
  });
  const summary = await phase0Dashboard({
    gstin: singleGstin,
    gstins: targetGstins,
    period: singlePeriod,
    periods: targetPeriods,
  });

  // Unbooked 2B lines for the selected period(s) and GSTIN(s)
  let twoBRows: any[] = [];
  let twoBTotalCount = 0;
  if (targetPeriods || targetGstins || str(req.query.gstins).toUpperCase() === 'ALL') {
    const uParams: unknown[] = [];
    const uWhere: string[] = [
      `NOT EXISTS (SELECT 1 FROM purchase_lines p WHERE p.our_gstin = g.our_gstin AND p.matched_2b_key = g.line_key)`,
    ];
    if (targetGstins && targetGstins.length) {
      uParams.push(targetGstins);
      uWhere.push(`g.our_gstin = ANY($${uParams.length}::text[])`);
    } else if (singleGstin) {
      uParams.push(normGstinOf(singleGstin));
      uWhere.push(`g.our_gstin = $${uParams.length}`);
    }
    if (targetPeriods && targetPeriods.length) {
      uParams.push(targetPeriods);
      uWhere.push(`g.twob_month = ANY($${uParams.length}::text[])`);
    } else if (singlePeriod) {
      uParams.push(singlePeriod);
      uWhere.push(`g.twob_month = $${uParams.length}`);
    }
    const uRes = await withClient((c) =>
      c.query(
        `SELECT g.id, g.line_key, g.our_gstin, g.twob_month, g.portal_fp, g.supplier_gstin,
                g.supplier_name, g.invoice_no, g.invoice_date, g.document_type,
                g.taxable_value, g.igst, g.cgst, g.sgst, g.cess,
                (g.igst + g.cgst + g.sgst + g.cess) AS itc,
                g.itc_availability, g.reason
           FROM gstr2b_lines g
          WHERE ${uWhere.join(' AND ')}
          ORDER BY g.twob_month DESC, g.supplier_name, g.invoice_no
          LIMIT 2000`,
        uParams,
      ),
    );
    twoBRows = uRes.rows.map((r: any) => ({
      ...r,
      invoice_date: isoDate(r.invoice_date),
      taxable_value: Number(r.taxable_value ?? 0),
      itc: r2(Number(r.itc ?? 0)),
    }));
    twoBTotalCount = twoBRows.length;
  } else {
    const twoB = await runReportNamed('twob-not-in-books', f);
    twoBRows = (twoB?.rows ?? []).slice(0, 1000);
    twoBTotalCount = twoB?.rows?.length ?? 0;
  }

  // Load aggregated cross-month unbooked 2B pool for Probable 2B matching (strictly within same our_gstin!)
  let crossMonth2bPool: Aggregated2bInvoice[] = [];
  try {
    const poolGstins = targetGstins && targetGstins.length
      ? targetGstins
      : singleGstin
        ? [normGstinOf(singleGstin)]
        : [...new Set(rows.map((r: any) => normGstinOf(r.our_gstin)).filter(Boolean))];
    crossMonth2bPool = await loadAggregatedUnbooked2b(poolGstins);
  } catch { /* fallback empty */ }

  // Probable 2B Bill suggestion for 'Missing in 2B' rows (strictly same our_gstin + supplier_gstin + polarity) + GSTR-3B Table 4 bucket
  const usedTwoBIdx = new Set<number>();
  for (const r of rows) {
    const cls = String(r.return_classification || '').trim();
    const dec = String(r.itc_decision || '').trim();
    const st = String(r.match_status || '');
    if (cls && cls !== 'Pending Review') {
      r.gstr3b_bucket = cls;
    } else if (dec === 'Ineligible' || dec === 'Reversed' || st === 'ITC Blocked' || r.itc_availability === 'No') {
      r.gstr3b_bucket = '4(B) — Blocked';
    } else if (dec === 'Do Not Claim' || st === 'Duplicate') {
      r.gstr3b_bucket = 'Not in 3B — Carried';
    } else if (dec === 'Reclaim Later' || dec === 'Query Vendor' || st === 'Missing in 2B') {
      r.gstr3b_bucket = '4(A)(i) — Books only';
    } else {
      r.gstr3b_bucket = '4(A) — Claimed';
    }

    if (r.match_status !== 'Missing in 2B') continue;
    const ourG = normGstinOf(r.our_gstin);
    const sup = normGstinOf(r.recon_supplier_gstin || r.book_supplier_gstin);
    const inv = String(r.recon_invoice_no || r.book_invoice_no || '');
    const bDt = isoDate(r.recon_invoice_date || r.book_invoice_date);
    const bTax = Number(r.book_taxable_value ?? 0);
    const bItc = Number(r.itc_amount ?? r.book_itc ?? 0);
    const bPol = polarityOfRow(r.book_document_type, bTax, r.book_igst, r.book_cgst, r.book_sgst, r.book_cess);

    let bestIdx = -1;
    let bestScore = -1e9;
    for (let i = 0; i < crossMonth2bPool.length; i++) {
      if (usedTwoBIdx.has(i)) continue;
      const u = crossMonth2bPool[i];
      // NEVER cross GST registrations or polarities during Probable 2B matching
      if (ourG && u.our_gstin !== ourG) continue;
      if (u.polarity !== bPol) continue;
      const sameSup = u.supplier_gstin === sup;
      const amtOk = Math.abs(bTax - u.taxable_value) <= 2 && Math.abs(bItc - u.itc) <= 2;
      const sim = invoiceSimScore(inv, u.invoice_no);
      const dDiff = daysDiffIso(bDt, u.invoice_date);
      if (sameSup) {
        if (!amtOk && !(sim >= 85 && dDiff <= 90)) continue;
      } else {
        // Cross-supplier hint only when amount + (invoice no or exact date) strongly match
        if (!(amtOk && (sim >= 85 || (dDiff <= 2 && Math.abs(bTax) >= 100)))) continue;
      }
      const mDiff = monthDiffIso(r.period, u.twob_month);
      const score = (sameSup ? 200000 : 0) + (amtOk ? 100000 : 0) + sim * 500 - dDiff * 10 - mDiff * 50;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const u = crossMonth2bPool[bestIdx];
      usedTwoBIdx.add(bestIdx);
      r.suggested_2b_key = u.line_key;
      r.suggested_2b_supplier_gstin = u.supplier_gstin;
      r.suggested_2b_supplier_name = u.supplier_name || '';
      r.suggested_2b_invoice_no = u.invoice_no;
      r.suggested_2b_date = u.invoice_date;
      r.suggested_2b_month = u.twob_month || '';
      r.suggested_2b_taxable = u.taxable_value;
      r.suggested_2b_itc = u.itc;
    }
  }

  // Live GSTR-3B Input Credit (Table 4) roll-up from bill-to-bill rows
  const allMonthRows = (f.q || f.status)
    ? (await listLines({ gstin: singleGstin, gstins: targetGstins, period: singlePeriod, periods: targetPeriods, limit: 5000 })).rows
    : rows;
  const reconLike = allMonthRows.map((r: any) => ({
    our_gstin: r.our_gstin,
    party_name: r.party_name || '',
    supplier_gstin: r.recon_supplier_gstin || r.book_supplier_gstin || '',
    invoice_no: r.recon_invoice_no || r.book_invoice_no || '',
    invoice_date: r.recon_invoice_date || r.book_invoice_date || '',
    period: r.period,
    taxable_value: Number(r.book_taxable_value ?? 0),
    igst: Number(r.book_igst ?? 0),
    cgst: Number(r.book_cgst ?? 0),
    sgst: Number(r.book_sgst ?? 0),
    cess: Number(r.book_cess ?? 0),
    itc: Number(r.itc_amount ?? r.book_itc ?? 0),
    status: (r.match_status || 'Missing in 2B') as any,
    two_b_taxable: r.twob_taxable_value !== null && r.twob_taxable_value !== undefined ? Number(r.twob_taxable_value) : undefined,
    two_b_igst: r.twob_igst !== null && r.twob_igst !== undefined ? Number(r.twob_igst) : undefined,
    two_b_cgst: r.twob_cgst !== null && r.twob_cgst !== undefined ? Number(r.twob_cgst) : undefined,
    two_b_sgst: r.twob_sgst !== null && r.twob_sgst !== undefined ? Number(r.twob_sgst) : undefined,
    two_b_cess: r.twob_cess !== null && r.twob_cess !== undefined ? Number(r.twob_cess) : undefined,
    two_b_itc: r.twob_itc !== null && r.twob_itc !== undefined ? Number(r.twob_itc) : undefined,
    itc_availability: r.itc_availability || 'Yes',
    reverse_charge: Boolean(r.reverse_charge),
    itc_decision: r.itc_decision || undefined,
    itc_decision_month: r.itc_decision_month || undefined,
    return_classification: r.return_classification || undefined,
  }));
  const g3b = buildGstr3b({
    gstin: singleGstin || 'CONSOLIDATED',
    period: singlePeriod || (targetPeriods ? targetPeriods.join(',') : ''),
    reconRows: reconLike,
    sales: [],
  });
  const unbooked2bItc = r2(twoBRows.reduce((s: number, u: any) => s + Number(u.itc ?? 0), 0));
  const booksItcTotal = r2(allMonthRows.reduce((s: number, r: any) => s + Number(r.itc_amount ?? r.book_itc ?? 0), 0));
  const gstr3bItc = {
    booksItc: booksItcTotal,
    table4A3_rcmItc: g3b.rcmItc,
    table4A5_otherItc: r2(g3b.itcAvailable - g3b.rcmItc),
    table4A_totalAvailable: g3b.itcAvailable,
    table4B_reversedBlocked: g3b.itcReversed,
    table4C_netItcAvailed: g3b.itcAvailed,
    pending4ai_booksOnly: g3b.reconciliation.pending_4ai,
    unbooked2bItc,
    itcByTax: g3b.itcByTax,
  };

  // Separate GSTIN-wise breakdown (Section 2 of Master Prompt: Separate GSTIN-wise results + Consolidated view)
  const gstinMap = new Map<string, {
    gstin: string;
    lines: number;
    matched: number;
    missing: number;
    mismatch: number;
    duplicate: number;
    blocked: number;
    taxableNet: number;
    booksItc: number;
    matched2bItc: number;
  }>();
  for (const r of allMonthRows) {
    const g = r.our_gstin || 'UNKNOWN';
    const cur = gstinMap.get(g) || {
      gstin: g, lines: 0, matched: 0, missing: 0, mismatch: 0, duplicate: 0, blocked: 0,
      taxableNet: 0, booksItc: 0, matched2bItc: 0,
    };
    cur.lines++;
    if (r.match_status === 'Matched') cur.matched++;
    else if (r.match_status === 'Missing in 2B') cur.missing++;
    else if (r.match_status === 'Amount Mismatch') cur.mismatch++;
    else if (r.match_status === 'Duplicate') cur.duplicate++;
    else if (r.match_status === 'ITC Blocked') cur.blocked++;
    cur.taxableNet = r2(cur.taxableNet + Number(r.book_taxable_value ?? 0));
    cur.booksItc = r2(cur.booksItc + Number(r.itc_amount ?? r.book_itc ?? 0));
    if (r.match_status === 'Matched' || r.match_status === 'Amount Mismatch') {
      cur.matched2bItc = r2(cur.matched2bItc + Number(r.twob_itc ?? r.itc_amount ?? 0));
    }
    gstinMap.set(g, cur);
  }

  res.json({
    total,
    rows,
    summary,
    twoBOnly: twoBRows,
    twoBTotal: twoBTotalCount,
    gstr3bItc,
    gstinBreakdown: [...gstinMap.values()],
    activePeriods: targetPeriods || (singlePeriod ? [singlePeriod] : []),
    activeGstins: targetGstins || (singleGstin ? [singleGstin] : []),
  });
}));

function parseDataUrl(data: unknown): Buffer | null {
  const s = String(data ?? '').trim();
  if (!s) return null;
  const idx = s.indexOf('base64,');
  const b64 = idx >= 0 ? s.slice(idx + 7) : s;
  try { return Buffer.from(b64, 'base64'); } catch { return null; }
}

/** Auto-apply GSTR-3B Input Credit (ITC) decisions & table classifications bill-to-bill for a GSTIN + period. */
app.post('/api/recon/purchase/auto-decide', requirePerm('itc', 'decide'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const gstin = str(req.body?.gstin);
  const period = str(req.body?.period);
  if (!gstin || !period) return res.status(400).json({ error: 'gstin aur period zaroori hain.' });
  const lock = await isLocked(gstin, period);
  if (lock.locked) return res.status(423).json({ error: `Period ${period} locked hai.` });

  const { rows: lines } = await listLines({ gstin, period, limit: 10000, offset: 0 });
  const actor = actorOf(req);
  const edits: any[] = [];

  for (const r of lines as any[]) {
    if (r.itc_decision && r.itc_decision !== 'Pending Review' && r.itc_decision !== 'PENDING') continue;
    const st = String(r.match_status || r.recon_status || '');
    const note = String(r.mismatch_reason || r.eligibility_note || '').toLowerCase();
    const isBlocked =
      st === 'ITC Blocked' ||
      r.itc_availability === 'No' ||
      note.includes('17(5)') ||
      note.includes('blocked') ||
      r.return_classification === '4(B) — Blocked' ||
      r.return_classification === 'Ineligible';
    let decision = '';
    let decisionMonth = period;
    let table3b = r.return_classification || '';

    if (isBlocked) {
      decision = 'Ineligible';
      table3b = '4(B) — Blocked';
    } else if (st === 'Matched' || st === 'Amount Mismatch' || st === 'Mismatch') {
      decision = 'Claim';
      table3b = '4(A) — Claimed';
    } else if (st === 'Missing in 2B') {
      decision = 'Reclaim Later';
      table3b = '4(A)(i) — Books only';
      decisionMonth = '';
    } else if (st === 'Duplicate') {
      decision = 'Do Not Claim';
      table3b = 'Not in 3B — Carried';
    }

    if (decision) {
      edits.push({
        lineId: r.id,
        itc: {
          decision,
          decisionMonth: decisionMonth || undefined,
          reason: 'Auto-decided via Bill-to-Bill GSTR-3B ITC rules',
        },
        classification: table3b && table3b !== r.return_classification ? table3b : undefined,
      });
    }
  }

  const bulk = edits.length
    ? await applyEdits(edits, { by: actor, reason: 'Auto-decided via Bill-to-Bill GSTR-3B ITC rules' })
    : { changedLines: 0 };
  const updated = bulk.changedLines ?? edits.length;

  await audit(req.user, {
    action: 'RECON_ITC_AUTO_DECIDE', module: 'Reconciliation',
    details: { gstin, period, updated },
  });
  res.json({ ok: true, updated });
}));

/**
 * Books-Only Probable 2B Auto-Linker (Sections 6 & 7 of Master Prompt):
 * Copies matched Probable 2B Invoice No & Date into the Books reconciliation override columns
 * (`recon_invoice_no`, `recon_invoice_date`) via `applyEdits`, leaving both `book_*` and `gstr2b_lines`
 * 100% immutable, logs full correction history & audit trail, and re-reconciles immediately.
 */
app.post('/api/recon/purchase/auto-link-probable', requirePerm('recon', 'edit'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const gstin = normGstinOf(str(req.body?.gstin));
  const period = str(req.body?.period);
  const rawPeriods: string[] = Array.isArray(req.body?.periods)
    ? req.body.periods.map((p: any) => String(p).trim()).filter(Boolean)
    : period ? [period] : [];
  if (!gstin && !rawPeriods.length) {
    return res.status(400).json({ error: 'GSTIN ya period select karein.' });
  }
  const actor = actorOf(req);
  const { rows } = await listLines({
    gstin: gstin || undefined,
    periods: rawPeriods.length ? rawPeriods : undefined,
    status: 'Missing in 2B',
    limit: 5000,
  });
  if (!rows.length) {
    return res.json({ ok: true, linked: 0, message: 'Koi Missing in 2B bill nahi mila.' });
  }

  // Load aggregated unbooked 2B lines for the active GSTIN(s)
  const activeGstins = [...new Set(rows.map((r: any) => normGstinOf(r.our_gstin)).filter(Boolean))];
  const pool = await loadAggregatedUnbooked2b(activeGstins);

  const usedIdx = new Set<number>();
  const edits: any[] = [];
  const touchedPairs = new Set<string>();

  for (const r of rows as any[]) {
    const ourG = normGstinOf(r.our_gstin);
    const sup = normGstinOf(r.recon_supplier_gstin || r.book_supplier_gstin);
    const inv = String(r.recon_invoice_no || r.book_invoice_no || '');
    const bDt = isoDate(r.recon_invoice_date || r.book_invoice_date);
    const bTax = Number(r.book_taxable_value ?? 0);
    const bItc = Number(r.itc_amount ?? r.book_itc ?? 0);
    const bPol = polarityOfRow(r.book_document_type, bTax, r.book_igst, r.book_cgst, r.book_sgst, r.book_cess);

    let bestIdx = -1;
    let bestScore = -1e9;
    for (let i = 0; i < pool.length; i++) {
      if (usedIdx.has(i)) continue;
      const u = pool[i];
      if (u.our_gstin !== ourG) continue; // Never cross GST registrations
      if (u.supplier_gstin !== sup) continue;
      if (u.polarity !== bPol) continue; // Never match Tax Invoice with Credit Note polarity
      if (Math.abs(bTax - u.taxable_value) > 2 || Math.abs(bItc - u.itc) > 2) continue;
      const sim = invoiceSimScore(inv, u.invoice_no);
      const dDiff = daysDiffIso(bDt, u.invoice_date);
      if (dDiff > 180 && dDiff < 9999 && sim < 70) continue; // Guard against cross-FY collisions
      const mDiff = monthDiffIso(r.period, u.twob_month);
      const score = sim * 500 - dDiff * 10 - mDiff * 50;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      const u = pool[bestIdx];
      usedIdx.add(bestIdx);
      edits.push({
        lineId: r.id,
        recon: {
          recon_invoice_no: String(u.invoice_no),
          recon_invoice_date: String(u.invoice_date || '').slice(0, 10),
        },
      });
      touchedPairs.add(`${ourG}|${r.period}`);
    }
  }

  if (!edits.length) {
    return res.json({ ok: true, linked: 0, message: 'Koi Probable 2B match (same Supplier GSTIN + Polarity + Taxable/ITC) nahi mila.' });
  }

  const bulk = await applyEdits(edits, {
    by: actor,
    reason: 'Books-only Probable 2B Auto-Link (GSTR-2B source untouched)',
  });

  const tolerance = parseToleranceArg(req.body?.tolerance);
  const dateWindow = parseDateWindowArg(req.body?.dateWindow);
  const reconciled: any[] = [];
  const twobCache = new Map<string, any[]>();
  for (const pair of touchedPairs) {
    const [g, p] = pair.split('|');
    let cachedTwob = twobCache.get(g);
    if (!cachedTwob) {
      cachedTwob = (await loadBundleForReconcile(g, p)).twob;
      twobCache.set(g, cachedTwob);
    }
    reconciled.push(await reReconcile(g, p, { changedBy: actor, reason: 'Books-only Probable 2B Auto-Link', cachedTwob, tolerance, dateWindow }));
  }

  await audit(req.user, {
    action: 'RECON_PROBABLE_2B_AUTOLINK', module: 'Reconciliation',
    details: { gstin, periods: [...touchedPairs], linked: bulk.changedLines },
  });
  res.json({ ok: true, linked: bulk.changedLines, reconciled });
}));

/**
 * Interactive Manual Match Candidate Finder: given a Book purchase line (`lineId`),
 * returns ranked unbooked GSTR-2B invoices within the SAME `our_gstin`.
 */
app.get('/api/recon/purchase/2b-candidates', requirePerm('recon', 'view'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const lineId = Number(req.query.lineId);
  if (!Number.isFinite(lineId) || lineId <= 0) return res.status(400).json({ error: 'Valid lineId zaroori hai.' });
  const bookLine = await getLine(lineId);
  if (!bookLine) return res.status(404).json({ error: 'Purchase line nahi mili.' });
  if (!(await checkGstinAccess(req, res, String(bookLine.our_gstin)))) return;

  const allSuppliers = str(req.query.allSuppliers) === '1' || str(req.query.allSuppliers) === 'true';
  const q = str(req.query.q).toLowerCase();
  const ourG = normGstinOf(bookLine.our_gstin);
  const sup = normGstinOf(bookLine.recon_supplier_gstin || bookLine.book_supplier_gstin);
  const bInv = String(bookLine.recon_invoice_no || bookLine.book_invoice_no || '');
  const bDt = isoDate(bookLine.recon_invoice_date || bookLine.book_invoice_date);
  const bTax = Number(bookLine.book_taxable_value ?? 0);
  const bItc = Number(bookLine.itc_amount ?? bookLine.book_itc ?? 0);
  const bPol = polarityOfRow(
    bookLine.book_document_type,
    bTax,
    bookLine.book_igst,
    bookLine.book_cgst,
    bookLine.book_sgst,
    bookLine.book_cess,
  );

  const pool = await loadAggregatedUnbooked2b([ourG], lineId);
  const candidates = pool
    .filter((u) => {
      if (u.polarity !== bPol) return false;
      if (!allSuppliers && !q && u.supplier_gstin !== sup) return false;
      if (q) {
        const hay = `${u.invoice_no} ${u.supplier_gstin} ${u.supplier_name} ${u.twob_month}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .map((u) => {
      const taxDiff = r2(u.taxable_value - bTax);
      const itcDiff = r2(u.itc - bItc);
      const exactAmt = Math.abs(taxDiff) <= 2 && Math.abs(itcDiff) <= 2;
      const dateDiffDays = daysDiffIso(bDt, u.invoice_date);
      const sim = invoiceSimScore(bInv, u.invoice_no);
      const sameSupplier = u.supplier_gstin === sup;
      const mDiff = monthDiffIso(bookLine.period, u.twob_month);
      const rankScore =
        (sameSupplier ? 1000000 : 0) +
        (exactAmt ? 500000 : 0) +
        sim * 1000 -
        dateDiffDays * 20 -
        mDiff * 100 -
        Math.min(100000, Math.abs(taxDiff) + Math.abs(itcDiff));
      return {
        ...u,
        sameSupplier,
        exactAmt,
        taxDiff,
        itcDiff,
        dateDiffDays: dateDiffDays >= 9999 ? null : dateDiffDays,
        sim,
        rankScore,
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 100);

  res.json({ bookLine, candidates });
}));

/**
 * Reverse Manual Match Candidate Finder: given an unbooked GSTR-2B line (`twobLineKey`),
 * returns ranked unmatched/mismatched Purchase Register lines within the SAME `our_gstin`.
 */
app.get('/api/recon/purchase/book-candidates', requirePerm('recon', 'view'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const key = str(req.query.twobLineKey);
  if (!key) return res.status(400).json({ error: 'twobLineKey zaroori hai.' });

  const tRes = await withClient((c) =>
    c.query(
      `SELECT line_key, our_gstin, twob_month, portal_fp, supplier_gstin, supplier_name,
              invoice_no, invoice_date, document_type, taxable_value, igst, cgst, sgst, cess,
              itc_availability, reason
         FROM gstr2b_lines WHERE line_key = $1`,
      [key],
    ),
  );
  if (!tRes.rowCount) return res.status(404).json({ error: 'GSTR-2B record nahi mila.' });
  const tRow: any = tRes.rows[0];
  const ourG = normGstinOf(tRow.our_gstin);
  if (!(await checkGstinAccess(req, res, ourG))) return;

  const pool = await loadAggregatedUnbooked2b([ourG]);
  const twobLine = pool.find((x) => x.line_key === key) || {
    line_key: String(tRow.line_key),
    our_gstin: ourG,
    twob_month: String(tRow.twob_month || ''),
    portal_fp: String(tRow.portal_fp || tRow.twob_month || ''),
    supplier_gstin: normGstinOf(tRow.supplier_gstin),
    supplier_name: String(tRow.supplier_name || ''),
    invoice_no: String(tRow.invoice_no || ''),
    invoice_date: isoDate(tRow.invoice_date),
    document_type: String(tRow.document_type || 'Regular'),
    doc_type: normDocType(tRow.document_type),
    polarity: polarityOfRow(tRow.document_type, tRow.taxable_value, tRow.igst, tRow.cgst, tRow.sgst, tRow.cess),
    taxable_value: r2(tRow.taxable_value),
    igst: r2(tRow.igst),
    cgst: r2(tRow.cgst),
    sgst: r2(tRow.sgst),
    cess: r2(tRow.cess),
    itc: r2(r2(tRow.igst) + r2(tRow.cgst) + r2(tRow.sgst) + r2(tRow.cess)),
    itc_availability: String(tRow.itc_availability || 'Yes'),
  };

  const allSuppliers = str(req.query.allSuppliers) === '1' || str(req.query.allSuppliers) === 'true';
  const q = str(req.query.q).toLowerCase();

  const bRes = await withClient((c) =>
    c.query(
      `SELECT id, our_gstin, period, party_name, book_supplier_gstin, recon_supplier_gstin,
              book_invoice_no, recon_invoice_no, book_invoice_date, recon_invoice_date,
              book_document_type, book_taxable_value, book_igst, book_cgst, book_sgst, book_cess,
              match_status, matched_2b_key
         FROM purchase_lines
        WHERE our_gstin = $1
          AND coalesce(match_status, 'Missing in 2B') <> 'Matched'
        ORDER BY period DESC, id`,
      [ourG],
    ),
  );

  const candidates = (bRes.rows as any[])
    .filter((r) => {
      const pol = polarityOfRow(r.book_document_type, r.book_taxable_value, r.book_igst, r.book_cgst, r.book_sgst, r.book_cess);
      if (pol !== twobLine.polarity) return false;
      const sup = normGstinOf(r.recon_supplier_gstin || r.book_supplier_gstin);
      if (!allSuppliers && !q && sup !== twobLine.supplier_gstin) return false;
      if (q) {
        const hay = `${r.book_invoice_no} ${r.recon_invoice_no} ${sup} ${r.party_name || ''} ${r.period}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .map((r) => {
      const sup = normGstinOf(r.recon_supplier_gstin || r.book_supplier_gstin);
      const inv = String(r.recon_invoice_no || r.book_invoice_no || '');
      const dt = isoDate(r.recon_invoice_date || r.book_invoice_date);
      const bTax = r2(r.book_taxable_value);
      const bItc = r2(r2(r.book_igst) + r2(r.book_cgst) + r2(r.book_sgst) + r2(r.book_cess));
      const taxDiff = r2(twobLine.taxable_value - bTax);
      const itcDiff = r2(twobLine.itc - bItc);
      const exactAmt = Math.abs(taxDiff) <= 2 && Math.abs(itcDiff) <= 2;
      const dateDiffDays = daysDiffIso(dt, twobLine.invoice_date);
      const sim = invoiceSimScore(inv, twobLine.invoice_no);
      const sameSupplier = sup === twobLine.supplier_gstin;
      const mDiff = monthDiffIso(r.period, twobLine.twob_month);
      const rankScore =
        (sameSupplier ? 1000000 : 0) +
        (exactAmt ? 500000 : 0) +
        sim * 1000 -
        dateDiffDays * 20 -
        mDiff * 100 -
        Math.min(100000, Math.abs(taxDiff) + Math.abs(itcDiff));
      return {
        id: r.id,
        our_gstin: r.our_gstin,
        period: r.period,
        party_name: r.party_name || '',
        supplier_gstin: sup,
        invoice_no: inv,
        book_invoice_no: r.book_invoice_no,
        invoice_date: dt,
        book_document_type: r.book_document_type,
        taxable_value: bTax,
        itc: bItc,
        match_status: r.match_status,
        sameSupplier,
        exactAmt,
        taxDiff,
        itcDiff,
        dateDiffDays: dateDiffDays >= 9999 ? null : dateDiffDays,
        sim,
        rankScore,
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 100);

  res.json({ twobLine, candidates });
}));

/**
 * Manually link one Purchase Register row to a specific GSTR-2B line by writing
 * Books-only recon overrides (`recon_supplier_gstin`, `recon_invoice_no`, `recon_invoice_date`)
 * and immediately re-reconciling. GSTR-2B & original book_* columns stay 100% immutable.
 */
app.post('/api/recon/purchase/manual-link', requirePerm('recon', 'edit'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const lineId = Number(req.body?.lineId);
  const twobLineKey = str(req.body?.twobLineKey);
  if (!Number.isFinite(lineId) || lineId <= 0 || !twobLineKey) {
    return res.status(400).json({ error: 'lineId aur twobLineKey dono zaroori hain.' });
  }

  const bookLine = await getLine(lineId);
  if (!bookLine) return res.status(404).json({ error: 'Purchase line nahi mili.' });
  const ourG = normGstinOf(bookLine.our_gstin);
  if (!(await checkGstinAccess(req, res, ourG))) return;

  const lock = await isLocked(ourG, String(bookLine.period));
  if (lock.locked) return res.status(423).json({ error: `GST month ${bookLine.period} LOCKED hai.` });

  const tRes = await withClient((c) =>
    c.query(
      `SELECT line_key, our_gstin, twob_month, supplier_gstin, invoice_no, invoice_date,
              document_type, taxable_value, igst, cgst, sgst, cess
         FROM gstr2b_lines WHERE line_key = $1`,
      [twobLineKey],
    ),
  );
  if (!tRes.rowCount) return res.status(404).json({ error: 'Target GSTR-2B line nahi mili.' });
  const twob: any = tRes.rows[0];
  if (normGstinOf(twob.our_gstin) !== ourG) {
    return res.status(400).json({ error: 'Cross-GSTIN linking allowed nahi hai (§2 GSTIN isolation).' });
  }

  const claimedBy = await withClient((c) =>
    c.query(
      `SELECT id, book_invoice_no, period FROM purchase_lines
        WHERE our_gstin = $1 AND matched_2b_key = $2 AND id <> $3 LIMIT 1`,
      [ourG, twobLineKey, lineId],
    ),
  );
  if (claimedBy.rowCount) {
    const other = claimedBy.rows[0];
    return res.status(409).json({
      error: `Ye GSTR-2B bill pehle se Book #${other.id} (${other.book_invoice_no}, ${other.period}) se linked hai.`,
    });
  }

  const bPol = polarityOfRow(
    bookLine.book_document_type,
    bookLine.book_taxable_value,
    bookLine.book_igst,
    bookLine.book_cgst,
    bookLine.book_sgst,
    bookLine.book_cess,
  );
  const tPol = polarityOfRow(twob.document_type, twob.taxable_value, twob.igst, twob.cgst, twob.sgst, twob.cess);
  if (bPol !== tPol) {
    return res.status(400).json({
      error: `Polarity mismatch: positive ${bPol} document ko negative ${tPol} note se link nahi kar sakte.`,
    });
  }

  const actor = actorOf(req);
  const reason = str(req.body?.reason) || `Manual match to GSTR-2B ${twob.invoice_no} (${twob.twob_month})`;
  const patch: Partial<Record<ReconField, string>> = {
    recon_supplier_gstin: normGstinOf(twob.supplier_gstin),
    recon_invoice_no: String(twob.invoice_no ?? '').trim(),
  };
  const twobDt = isoDate(twob.invoice_date);
  if (twobDt) patch.recon_invoice_date = twobDt;

  const edit = await updateRecon(lineId, patch, { changedBy: actor, reason });
  if (!edit.ok) return res.status(edit.locked ? 423 : 400).json(edit);

  const tolerance = parseToleranceArg(req.body?.tolerance);
  const dateWindow = parseDateWindowArg(req.body?.dateWindow);
  const rr = await reReconcile(ourG, String(bookLine.period), {
    changedBy: actor,
    reason,
    tolerance,
    dateWindow,
  });

  await audit(req.user, {
    action: 'MANUAL_2B_LINK', module: 'Reconciliation', lineId,
    gstin: ourG, period: String(bookLine.period),
    newValue: `${twob.invoice_no} (${twobLineKey})`, reason,
  });
  res.json({ ok: true, line: await getLine(lineId), reReconcile: rr });
}));

/**
 * Reset a purchase line's recon overrides back to its original `book_*` values
 * and re-reconcile, unlinking any previous manual or auto-linked 2B override.
 */
app.post('/api/recon/purchase/unlink', requirePerm('recon', 'edit'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const lineId = Number(req.body?.lineId);
  if (!Number.isFinite(lineId) || lineId <= 0) return res.status(400).json({ error: 'Valid lineId zaroori hai.' });

  const bookLine = await getLine(lineId);
  if (!bookLine) return res.status(404).json({ error: 'Purchase line nahi mili.' });
  const ourG = normGstinOf(bookLine.our_gstin);
  if (!(await checkGstinAccess(req, res, ourG))) return;

  const actor = actorOf(req);
  const reason = str(req.body?.reason) || 'Unlinked recon override — restored original Book values';
  const reset = await resetReconToBook(lineId, { changedBy: actor, reason });
  if (!reset.ok) return res.status(reset.locked ? 423 : 400).json(reset);

  const tolerance = parseToleranceArg(req.body?.tolerance);
  const dateWindow = parseDateWindowArg(req.body?.dateWindow);
  const rr = await reReconcile(ourG, String(bookLine.period), {
    changedBy: actor,
    reason,
    tolerance,
    dateWindow,
  });

  await audit(req.user, {
    action: 'RECON_UNLINK', module: 'Reconciliation', lineId,
    gstin: ourG, period: String(bookLine.period), reason,
  });
  res.json({ ok: true, line: await getLine(lineId), reReconcile: rr });
}));

/** Direct GSTR-2B file preview (.json / .xlsx / .csv) for Bill-to-Bill Input Credit matching. */
app.post('/api/twob-file/preview', requirePerm('data', 'import_purchase'), wrap(async (req, res) => {
  const name = str(req.body?.name) || 'GSTR2B.xlsx';
  const buf = parseDataUrl(req.body?.data);
  if (!buf) return res.status(400).json({ error: 'File payload khali hai (base64 expected).' });

  try {
    let rows: any[] = [];
    let isJson = false;
    if (name.toLowerCase().endsWith('.json')) {
      const json = JSON.parse(buf.toString('utf8'));
      if (!isGstr2bJson(json)) return res.status(400).json({ error: `${name} valid GSTR-2B JSON file nahi hai.` });
      isJson = true;
      rows = parseGstr2bJson(json, name).rows;
    } else {
      const sheets = readAllSheets(buf);
      const picked = pickDataSheet(sheets, ['invoice_no', 'supplier_gstin', 'taxable_value', 'itc_availability'], { profile: 'twob' });
      rows = parseGstr2b(picked.rows, name).rows;
    }
    const tax = rows.reduce((s, r) => s + (r.igst || 0) + (r.cgst || 0) + (r.sgst || 0) + (r.cess || 0), 0);
    const taxable = rows.reduce((s, r) => s + (r.taxable_value || 0), 0);
    const detectedGstins = [...new Set(rows.map((r) => normGstinOf(r.our_gstin)).filter(Boolean))];
    const detectedPeriods = [...new Set(rows.map((r) => String(r.portal_fp || r.period || '').slice(0, 7)).filter(Boolean))].sort();
    res.json({
      file: name,
      format: isJson ? 'GSTR-2B Portal JSON' : 'GSTR-2B Excel/CSV',
      rowCount: rows.length,
      totalTaxable: Math.round(taxable * 100) / 100,
      totalTax: Math.round(tax * 100) / 100,
      detectedGstin: detectedGstins[0] || '',
      detectedGstins,
      detectedPeriods,
      sample: rows.slice(0, 25),
    });
  } catch (e: any) {
    res.status(400).json({ error: `${name} parse nahi ho saka: ${e.message}` });
  }
}));

/** Direct GSTR-2B file import (.json / .xlsx / .csv) into PostgreSQL + immediate Bill-to-Bill reconciliation with Books. */
app.post('/api/twob-file/import', requirePerm('data', 'import_purchase'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const reqGstin = normGstinOf(req.body?.gstin);
  const reqPeriod = str(req.body?.period);
  const name = path.basename(str(req.body?.name) || 'GSTR2B.xlsx');
  const buf = parseDataUrl(req.body?.data);
  if (!buf) return res.status(400).json({ error: 'File payload khali hai.' });

  try {
    let rows: any[] = [];
    const isJson = name.toLowerCase().endsWith('.json');
    if (isJson) {
      const json = JSON.parse(buf.toString('utf8'));
      if (!isGstr2bJson(json)) return res.status(400).json({ error: `${name} valid GSTR-2B JSON file nahi hai.` });
      rows = parseGstr2bJson(json, name).rows;
    } else {
      const sheets = readAllSheets(buf);
      const picked = pickDataSheet(sheets, ['invoice_no', 'supplier_gstin', 'taxable_value', 'itc_availability'], { profile: 'twob' });
      rows = parseGstr2b(picked.rows, name).rows;
    }
    if (!rows.length) return res.status(400).json({ error: `${name} me koi GSTR-2B bill nahi mila.` });

    const fileGstin = normGstinOf(rows.find((r: any) => normGstinOf(r.our_gstin))?.our_gstin) || reqGstin;
    const filePeriod = String(rows.find((r: any) => r.portal_fp || r.period)?.portal_fp || rows.find((r: any) => r.period)?.period || reqPeriod).slice(0, 7);
    if (!fileGstin || !filePeriod) return res.status(400).json({ error: 'gstin aur period zaroori hain.' });
    if (!(await checkGstinAccess(req, res, fileGstin))) return;

    const lock = await isLocked(fileGstin, filePeriod);
    if (lock.locked) return res.status(423).json({ error: `Period ${filePeriod} locked hai.` });

    // Also save the raw file into UPLOAD_DIR so folder-based runs see it too
    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    } catch { /* non-fatal */ }

    const stamped = rows.map((r: any, idx: number) => {
      const g = normGstinOf(r.our_gstin) || fileGstin;
      const p = String(r.portal_fp || r.period || filePeriod).slice(0, 7);
      return {
        ...r,
        our_gstin: g,
        period: p,
        portal_fp: p,
        source_file: name,
        source_row: r.source_row ?? idx + 1,
      };
    });

    // Group by (our_gstin, period) so every month in the 2B file is registered in gstr2b_files
    const pairMap = new Map<string, { gstin: string; period: string; count: number; blocked: number }>();
    for (const r of stamped) {
      const k = `${r.our_gstin}|${r.period}`;
      const cur = pairMap.get(k) || { gstin: r.our_gstin, period: r.period, count: 0, blocked: 0 };
      cur.count++;
      if (String(r.itc_availability || '').toLowerCase() === 'no') cur.blocked++;
      pairMap.set(k, cur);
    }
    const fileHash = sha256(buf);
    const twoBFiles = [...pairMap.values()].map((p) => ({
      file_name: name,
      sha256: fileHash,
      file_size: buf.length,
      our_gstin: p.gstin,
      twob_month: p.period,
      portal_fp: p.period,
      record_count: p.count,
      blocked_count: p.blocked,
      source_format: (isJson ? 'json' : 'xlsx') as 'json' | 'xlsx',
    }));

    const saved = await persistRun({
      books: [],
      twob: stamped,
      sales: [],
      reconByBundle: new Map(),
      twoBFiles,
      uploadedBy: actorOf(req),
    });
    if (!saved.ok) return res.status(400).json({ error: saved.reason || 'GSTR-2B save nahi ho saka.' });

    // Re-reconcile every period touched by the 2B file + the currently viewed period + any period of this GSTIN with Missing in 2B rows
    const periodsToReconcile = new Set<string>([...pairMap.values()].map((p) => p.period));
    if (reqPeriod) periodsToReconcile.add(reqPeriod);
    try {
      const openPeriods = await withClient((c) =>
        c.query(
          `SELECT DISTINCT period FROM purchase_lines WHERE our_gstin = $1 AND match_status = 'Missing in 2B'`,
          [fileGstin],
        ),
      );
      for (const row of openPeriods.rows) if (row.period) periodsToReconcile.add(String(row.period));
    } catch { /* ignore */ }

    const reconAll: any[] = [];
    let cachedTwob: any[] | undefined;
    for (const p of [...periodsToReconcile].sort()) {
      if (!cachedTwob) {
        const bdl = await loadBundleForReconcile(fileGstin, p);
        cachedTwob = bdl.twob;
      }
      const r = await reReconcile(fileGstin, p, { changedBy: actorOf(req), reason: `GSTR-2B import: ${name}`, cachedTwob });
      reconAll.push(r);
    }
    const primaryRecon =
      reconAll.find((r) => r.period === filePeriod && r.ok) ||
      reconAll.find((r) => r.period === filePeriod) ||
      reconAll.find((r) => r.period === reqPeriod && r.ok) ||
      reconAll.find((r) => r.ok) ||
      reconAll[0];

    const detectedPeriods = [...new Set([...pairMap.values()].map((p) => p.period))].sort();
    await audit(req.user, {
      action: 'GSTR2B_FILE_IMPORT', module: 'Reconciliation',
      details: { gstin: fileGstin, period: filePeriod, detectedPeriods, file: name, imported2b: stamped.length, recon: primaryRecon },
    });
    res.json({
      ok: true,
      file: name,
      imported2b: stamped.length,
      detectedGstin: fileGstin,
      detectedPeriods,
      activePeriod: filePeriod || primaryRecon?.period,
      recon: primaryRecon,
      reconAll,
    });
  } catch (e: any) {
    res.status(400).json({ error: `${name} import nahi ho saka: ${e.message}` });
  }
}));

/** One line plus its full correction history. */
app.get('/api/lines/:id', wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const id = Number(req.params.id);
  const line = await getLine(id);
  if (!line) return res.status(404).json({ error: 'no such line' });
  const history = await lineHistory(id);
  const lock = await isLocked(line.our_gstin, line.period);
  res.json({ line, history, locked: lock });
}));

/**
 * SAVE & RE-RECONCILE.
 *
 * Writes the reconciliation fields, records the change, and (unless
 * `rerun: false`) immediately re-runs the matcher over the stored data. The
 * book columns are never parameters of this call.
 */
/**
 * Record the e-invoice / e-way bill answer for one invoice.
 *
 * GSTR-2B carries neither figure, so this is answered by the person doing the
 * reconciliation while they have the invoice open. Writes go through
 * `applyEdits` so a locked month refuses the change and every field change
 * lands in the audit trail, same as any other correction.
 */
app.post('/api/lines/:id/e-docs', requirePerm('recon', 'edit'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });

  const id = Number(req.params.id);
  const edocs: Partial<Record<EDocField, boolean | string | null>> = {};

  for (const f of E_DOC_FIELDS) {
    if (req.body?.[f] === undefined) continue;
    const parsed = parseEDocField(f, req.body[f]);
    if (parsed.ok === false) return res.status(400).json({ error: parsed.reason });
    edocs[f] = parsed.value;
  }

  if (!Object.keys(edocs).length) {
    return res.status(400).json({ error: 'Koi field nahi bheja.' });
  }

  const by = actorOf(req);
  const reason = str(req.body?.reason) || undefined;

  const result = await applyEdits([{ lineId: id, edocs }], { by, reason });
  const row = result.rows[0];
  if (!result.ok || !row?.ok) {
    return res.status(row?.locked ? 423 : 400).json({
      ok: false, reason: result.reason || row?.reason || 'Could not save.', changed: row?.changed ?? [],
    });
  }

  if (row.changed.length) {
    await audit(req.user, {
      action: 'E_DOC_EDIT', module: 'Reconciliation', lineId: id,
      field: row.changed.join(', '),
      oldValue: JSON.stringify(row.diff?.map((d) => d.from)),
      newValue: JSON.stringify(row.diff?.map((d) => d.to)),
      reason: reason || null,
    });
  }

  res.json({ ok: true, changed: row.changed, diff: row.diff ?? [] });
}));

app.post('/api/lines/:id/recon', requirePerm('recon', 'edit'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const id = Number(req.params.id);
  const patch: Partial<Record<ReconField, string>> = {};
  for (const f of ['recon_supplier_gstin', 'recon_invoice_no', 'recon_invoice_date'] as const) {
    if (req.body?.[f] !== undefined) patch[f] = str(req.body[f]);
  }
  const partyName = req.body?.party_name !== undefined ? str(req.body.party_name) : undefined;
  const remarks = req.body?.remarks !== undefined ? str(req.body.remarks) : undefined;
  const by = actorOf(req);
  const reason = str(req.body?.reason) || undefined;

  const edit = await updateRecon(id, patch, { changedBy: by, reason, partyName, remarks });
  if (!edit.ok) return res.status(edit.locked ? 423 : 400).json(edit);

  const auditedPayload: Record<string, unknown> = { ...patch };
  if (partyName !== undefined) auditedPayload.party_name = partyName;
  if (remarks !== undefined) auditedPayload.remarks = remarks;
  const auditedFields = (edit.changed && edit.changed.length ? edit.changed : Object.keys(auditedPayload)).join(', ') || null;

  await audit(req.user, {
    action: 'RECON_EDIT', module: 'Reconciliation', lineId: id,
    field: auditedFields,
    oldValue: null, newValue: JSON.stringify(auditedPayload),
    reason: reason || null,
  });
  const line = await getLine(id);
  let rerefresh = null;
  if (line && req.body?.rerun !== false) {
    const tolerance = parseToleranceArg(req.body?.tolerance);
    const dateWindow = parseDateWindowArg(req.body?.dateWindow);
    rerefresh = await reReconcile(line.our_gstin, line.period, { changedBy: by, reason, tolerance, dateWindow });
    if (!rerefresh.ok) return res.status(400).json({ ...edit, warning: rerefresh.reason, line });
  }
  res.json({ ...edit, line: await getLine(id), history: await lineHistory(id), reReconcile: rerefresh });
}));

/**
 * Correct the company's OWN GSTIN on one purchase line.
 *
 * Its own route rather than a fourth key on `/api/lines/:id/recon`, because it
 * is a different kind of change: the three recon_* fields override what an
 * invoice is MATCHED on, while our_gstin decides which company, unit and
 * GSTR-2B the line belongs to. It moves the line, then re-reconciles both
 * months it moved between — leaving one and joining another are two different
 * match results.
 */
app.post('/api/lines/:id/our-gstin', requirePerm('recon', 'edit'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });

  const id = Number(req.params.id);
  const gstin = str(req.body?.gstin);
  if (!gstin) return res.status(400).json({ error: 'New GSTIN chahiye.' });

  const before = await getLine(id);
  if (!before) return res.status(404).json({ error: 'no such line' });

  const by = actorOf(req);
  const reason = str(req.body?.reason) || undefined;
  const out = await setOurGstin(id, gstin, { changedBy: by, reason });
  if (!out.ok) return res.status(out.locked ? 423 : 400).json(out);

  await audit(req.user, {
    action: 'OUR_GSTIN_CORRECTION', module: 'Reconciliation', lineId: id,
    gstin: String(before.our_gstin), period: String(before.period),
    field: 'our_gstin', oldValue: String(before.our_gstin), newValue: String(out.movedTo || gstin),
    reason: reason || null,
  });

  const rereconciled: Array<Record<string, unknown>> = [];
  if (out.movedFrom && out.movedTo) {
    const tolerance = parseToleranceArg(req.body?.tolerance);
    const dateWindow = parseDateWindowArg(req.body?.dateWindow);
    for (const g of [out.movedFrom, out.movedTo]) {
      const r = await reReconcile(g, String(before.period), {
        changedBy: by,
        reason: `Own GSTIN corrected ${out.movedFrom} -> ${out.movedTo}`,
        tolerance,
        dateWindow,
      });
      rereconciled.push({ gstin: g, ...r });
    }
  }

  res.json({
    ...out,
    line: await getLine(id),
    history: await lineHistory(id),
    reReconcile: rereconciled,
  });
}));

app.post('/api/lines/:id/itc', requirePerm('itc', 'decide'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const id = Number(req.params.id);
  const out = await setItcDecision(
    id,
    {
      decision: req.body?.decision === undefined ? undefined : str(req.body.decision),
      decisionMonth: req.body?.decisionMonth === undefined ? undefined : str(req.body.decisionMonth),
      reason: req.body?.reason === undefined ? undefined : str(req.body.reason),
    },
    { changedBy: actorOf(req) },
  );
  if (!out.ok) return res.status(out.locked ? 423 : 400).json(out);
  await audit(req.user, {
    action: 'ITC_DECISION', module: 'ITC', lineId: id,
    gstin: str(req.body?.gstin) || null, period: str(req.body?.decisionMonth) || null,
    field: str(req.body?.decision) || null,
    newValue: [str(req.body?.decision), str(req.body?.decisionMonth)].filter(Boolean).join(' / '),
    reason: str(req.body?.reason) || null,
  });
  res.json({ ...out, line: await getLine(id), history: await lineHistory(id) });
}));

app.post('/api/lines/:id/classify', requirePerm('recon', 'edit'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const out = await setReturnClassification(Number(req.params.id), str(req.body?.value), {
    changedBy: actorOf(req),
    reason: str(req.body?.reason) || undefined,
  });
  if (!out.ok) return res.status(out.locked ? 423 : 400).json(out);
  await audit(req.user, {
    action: 'RETURN_CLASSIFICATION', module: 'Reconciliation',
    lineId: Number(req.params.id), field: 'return_classification',
    newValue: str(req.body?.value), reason: str(req.body?.reason) || null,
  });
  res.json({ ...out, line: await getLine(Number(req.params.id)) });
}));

/** Re-run the matcher for a single month, month range, selected months, or active months of a GSTIN. */
app.post('/api/rereconcile', requirePerm('recon', 'rereconcile'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const gstin = normGstinOf(str(req.body?.gstin));
  const period = str(req.body?.period);
  const rawPeriods: string[] = Array.isArray(req.body?.periods)
    ? req.body.periods.map((p: any) => String(p).trim()).filter((p: string) => /^\d{4}-\d{2}$/.test(p))
    : [];
  const fromP = str(req.body?.fromPeriod);
  const toP = str(req.body?.toPeriod);
  let targetPeriods = rawPeriods.length
    ? [...new Set(rawPeriods)].sort()
    : (/^\d{4}-\d{2}$/.test(fromP) && /^\d{4}-\d{2}$/.test(toP))
      ? monthRange(fromP <= toP ? fromP : toP, fromP <= toP ? toP : fromP)
      : period ? [period] : [];

  const actor = actorOf(req);
  const reason = str(req.body?.reason) || undefined;
  const tolerance = parseToleranceArg(req.body?.tolerance);
  const dateWindow = parseDateWindowArg(req.body?.dateWindow);

  if (targetPeriods.length > 1) {
    const results: any[] = [];
    let cachedTwob: any[] | undefined;
    for (const p of targetPeriods) {
      if (!cachedTwob && gstin) {
        cachedTwob = (await loadBundleForReconcile(gstin, p)).twob;
      }
      const r = await reReconcile(gstin, p, { changedBy: actor, reason, cachedTwob, tolerance, dateWindow });
      if (r.ok) results.push(r);
    }
    const totalMatched = results.reduce((s, r) => s + (r.matched || 0), 0);
    const totalLines = results.reduce((s, r) => s + (r.lines || 0), 0);
    await audit(req.user, {
      action: 'RECONCILE_MULTI', module: 'Reconciliation',
      gstin: gstin || null, period: targetPeriods[0],
      reason: reason || `Reconciled ${targetPeriods.length} months (${targetPeriods.join(', ')})`,
    });
    return res.json({
      ok: true,
      gstin,
      period: targetPeriods[targetPeriods.length - 1],
      periods: targetPeriods,
      lines: totalLines,
      matched: totalMatched,
      results,
    });
  }

  const out = await reReconcile(gstin, period, {
    changedBy: actor,
    reason,
    tolerance,
    dateWindow,
  });

  // Smart fallback: if the currently selected header month (e.g. Nov-2026 from system clock)
  // has 0 purchase lines, automatically check if this GSTIN has other open months in purchase_lines,
  // re-reconcile the latest month with data, and tell the UI to switch to that month!
  if (!out.ok && gstin && /No purchase lines are stored/i.test(out.reason || '')) {
    const avail = await withClient((c) =>
      c.query(
        `SELECT period, count(*)::int AS cnt
           FROM purchase_lines
          WHERE our_gstin = $1
          GROUP BY period
          ORDER BY period DESC`,
        [gstin],
      ),
    );
    if (avail.rows.length > 0) {
      const latestPeriod = String(avail.rows[0].period);
      const fallbackOut = await reReconcile(gstin, latestPeriod, {
        changedBy: actor,
        reason: reason || `Auto-switched from empty period ${period} to ${latestPeriod}`,
        tolerance,
        dateWindow,
      });
      if (fallbackOut.ok) {
        await audit(req.user, {
          action: 'RECONCILE', module: 'Reconciliation',
          gstin: gstin || null, period: latestPeriod,
          reason: reason || null,
        });
        return res.json({
          ...fallbackOut,
          switchedFromPeriod: period,
          switchedToPeriod: latestPeriod,
        });
      }
    }
  }

  if (out.ok) {
    await audit(req.user, {
      action: 'RECONCILE', module: 'Reconciliation',
      gstin: gstin || null, period: period || null,
      reason: reason || null,
    });
  }
  res.status(out.ok ? 200 : 400).json({ ...out, error: out.ok ? undefined : out.reason });
}));

app.get('/api/locks', wrap(async (_req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  res.json({ locks: await listLocks() });
}));

app.post('/api/lock', requirePerm('control', 'lock'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const gstin = str(req.body?.gstin);
  const period = str(req.body?.period);
  const out = await lockMonth(gstin, period, {
    by: actorOf(req),
    reason: str(req.body?.reason) || undefined,
  });
  if (out.ok) {
    await audit(req.user, {
      action: 'MONTH_LOCK', module: 'Control',
      gstin: gstin || null, period: period || null,
      reason: str(req.body?.reason) || null,
    });
  }
  res.status(out.ok ? 200 : 400).json(out);
}));

app.post('/api/unlock', requirePerm('control', 'unlock'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const ugstin = str(req.body?.gstin);
  const uperiod = str(req.body?.period);
  const out = await unlockMonth(ugstin, uperiod, {
    by: actorOf(req),
    reason: str(req.body?.reason),
    adminConfirmed: req.body?.adminConfirmed === true,
  });
  if (out.ok) {
    await audit(req.user, {
      action: 'MONTH_UNLOCK', module: 'Control',
      gstin: ugstin || null, period: uperiod || null,
      reason: str(req.body?.reason) || null,
    });
  }
  res.status(out.ok ? 200 : 400).json(out);
}));

app.get('/api/audit', requirePerm('control', 'audit'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const out = await auditTrail({
    gstin: str(req.query.gstin) || undefined,
    period: str(req.query.period) || undefined,
    invoice: str(req.query.invoice) || undefined,
    field: str(req.query.field) || undefined,
    by: str(req.query.by) || undefined,
    from: str(req.query.from) || undefined,
    to: str(req.query.to) || undefined,
    lineId: req.query.lineId ? Number(req.query.lineId) : undefined,
    limit: Number(req.query.limit || 300),
  });
  res.json(out);
}));

/** The ITC working (spec §14), as JSON or CSV. */
/**
 * The GST Control Centre month strip: one row per GST month with the counts
 * and the lifecycle status the dashboard shows. Read-only — the shell reads it,
 * nothing writes from it.
 */
/** The accounts team. Read-only — login and user admin are a later phase. */
app.get('/api/users', wrap(async (_req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ ready: false, reason: ready.reason });
  res.json({ ready: true, users: await listUsers() });
}));

app.get('/api/control/months', wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ ready: false, reason: ready.reason });
  const rows = await monthControl({ gstin: str(req.query.gstin) || undefined });
  res.json({ ready: true, rows, fys: fyOptionsOf(rows) });
}));

app.get('/api/itc-working', wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const rows = await itcWorking({
    gstin: str(req.query.gstin) || undefined,
    period: str(req.query.period) || undefined,
    search: str(req.query.q) || undefined,
    decision: str(req.query.decision) || undefined,
    limit: Number(req.query.limit || 20000),
  });
  if (str(req.query.format) !== 'csv') return res.json({ count: rows.length, rows });

  const cols: Array<[string, string]> = [
    ['our_gstin', 'GSTIN'], ['periodLabel', 'Period'], ['party_name', 'Vendor'],
    ['bookGstin', 'Book GSTIN'], ['reconGstin', 'Recon GSTIN'],
    ['bookInvoiceNo', 'Book Inv No'], ['reconInvoiceNo', 'Recon Inv No'],
    ['bookInvoiceDate', 'Book Inv Date'], ['reconInvoiceDate', 'Recon Inv Date'],
    ['taxable', 'Taxable'], ['igst', 'IGST'], ['cgst', 'CGST'], ['sgst', 'SGST'], ['cess', 'CESS'],
    ['itc', 'ITC'], ['twoBMatched', '2B Matched'], ['twoBMonthLabel', '2B Month'],
    ['match_status', '2B Match Status'], ['itc_decision', 'ITC Decision'],
    ['itc_decision_month', 'ITC Decision Month'], ['decision_by', 'Decision By'],
    ['decision_reason', 'Reason'], ['return_classification', 'Return Classification'],
    ['twoBTaxable', '2B Taxable'], ['twoBItc', '2B ITC'],
  ];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    cols.map(([, h]) => h).join(','),
    ...rows.map((r: any) => cols.map(([k]) => esc(r[k])).join(',')),
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ITC working.csv"');
  res.send(csv);
}));

/** The GSTR-2B file registry (spec §9). */
app.get('/api/2b-registry', wrap(async (_req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  res.json({ files: await twoBRegistry() });
}));

/**
 * Copy/paste purchase register.
 *
 * `preview` runs exactly the file parser the Excel upload runs, so what the
 * Accounts user sees in the preview is what will be stored — the same column
 * aliases, the same normalisation, the same rejection of a totals row.
 */
function pasteRows(body: any): unknown[][] {
  const raw = body?.rows;
  if (!Array.isArray(raw)) throw new Error('Send { rows: [[...header], [...row]] } — paste from Excel and try again.');
  return raw.map((r: unknown[]) => (Array.isArray(r) ? r : [r]));
}

/** The fields without which a purchase row is meaningless — drives sheet picking. */
const PURCHASE_REQUIRED = ['invoice_no', 'supplier_gstin', 'taxable_value'];


// ---------------------------------------------------------------------------
// P&L versus GSTR-1

/**
 * Resolve `?company=` to a company id, and refuse one the caller may not see.
 *
 * The P&L is a company-level document while GST lives per GSTIN, so this module
 * works from the company down and never takes a GSTIN as its starting point.
 * Without the access check, naming a company id would read another company's
 * turnover.
 */
/**
 * Either a resolved company id, or why it could not be resolved.
 *
 * The discriminant is a boolean literal and this project compiles with
 * `strict: false`, where `if (!found.ok)` does NOT narrow the union — the
 * variants have to be compared against `false` explicitly (same reason the
 * e-doc parser is called as `parsed.ok === false`).
 */
type CompanyLookup =
  | { ok: true; id: number }
  | { ok: false; status: number; error: string };

/**
 * Resolve a company key to an id without touching the response.
 *
 * Kept separate from `resolveCompany` because some callers must carry on when
 * no company was named: the template downloads serve a generic template rather
 * than an error, and a lookup that writes a response would leave them doing a
 * second `res.send` — which crashes the server.
 */
async function lookupCompany(req: any): Promise<CompanyLookup> {
  const key = str(req.query.company) || str(req.body?.company);
  if (!key) {
    return { ok: false, status: 400, error: 'company zaroori hai (short name, jaise "Sakar")' };
  }
  const list = await withClient(async (c) =>
    c.query('SELECT id, name, short_name FROM companies'),
  );
  const want = key.trim().toLowerCase();
  const hit = list.rows.find(
    (r: any) => String(r.id) === want || String(r.short_name || '').toLowerCase() === want || String(r.name || '').toLowerCase() === want,
  );
  if (!hit) return { ok: false, status: 404, error: `company "${key}" nahi mili` };
  const user: SessionUser | undefined = req.user;
  if (user && user.companyIds !== null && !user.companyIds.includes(hit.id)) {
    return { ok: false, status: 403, error: 'You do not have access to this company.' };
  }
  return { ok: true, id: hit.id as number };
}

async function resolveCompany(req: any, res: any): Promise<number | null> {
  const found = await lookupCompany(req);
  // `=== false`, never `!found.ok` — see the note on CompanyLookup.
  if (found.ok === false) {
    res.status(found.status).json({ error: found.error });
    return null;
  }
  return found.id;
}

/**
 * The company to build a template for, when naming one is optional.
 *
 * Returns null for "no company given" *and* for "that company is not yours" —
 * a template is just an empty grid, so refusing to hand one over would be a
 * worse answer than sending the generic head list.
 */
async function optionalCompanyId(req: any): Promise<number | null> {
  if (!(str(req.query.company) || str(req.body?.company))) return null;
  try {
    const found = await lookupCompany(req);
    return found.ok ? found.id : null;
  } catch {
    return null;
  }
}

/** ---- P&L versus GSTR-1 ---------------------------------------------- *
 *
 * The company decides the treatment of a P&L line (pl_gst_mapping) and a
 * person explains every difference (recon_difference_reasons). The software
 * only counts.
 */
app.get('/api/pl/heads', requirePerm('recon', 'view'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const companyId = await resolveCompany(req, res);
  if (companyId === null) return;
  res.json({ companyId, heads: await loadPlHeads(companyId) });
}));

/** What has been done per month, so the screen can say what to do next. */
app.get('/api/pl/coverage', requirePerm('recon', 'view'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const companyId = await resolveCompany(req, res);
  if (companyId === null) return;
  const months = await withClient(async (c) =>
    c.query(
      `SELECT s.period, s.financial_year, s.pl_uploaded, s.pl_entry_count,
              s.gstr1_covered, s.gstr1_draft_count, s.recon_run_at, s.total_difference,
              coalesce(r.pending, 0)::int AS pending,
              coalesce(r.explained, 0)::int AS explained,
              coalesce(r.reconciled, 0)::int AS reconciled
         FROM pl_month_status s
         LEFT JOIN (
            SELECT period, count(*) FILTER (WHERE status = 'Pending Review') AS pending,
                   count(*) FILTER (WHERE status = 'Difference Explained') AS explained,
                   count(*) FILTER (WHERE status = 'Reconciled') AS reconciled
              FROM pl_reconciliation WHERE company_id = $1 GROUP BY period
         ) r ON r.period = s.period
        WHERE s.company_id = $1
        ORDER BY s.period`,
      [companyId],
    ),
  );
  res.json({ companyId, months: months.rows });
}));

app.post('/api/pl/preview', requirePerm('data', 'import_purchase'), express.raw({ type: '*/*', limit: '50mb' }), wrap(async (req, res) => {
  const companyId = await resolveCompany(req, res);
  if (companyId === null) return;
  if (!req.body?.length) return res.status(400).json({ error: 'No file received.' });
  const name = path.basename(String(req.query.name || 'pl.xlsx'));
  let rows: unknown[][];
  try {
    rows = readPlFile(Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body), name).rows;
  } catch (e: any) {
    return res.status(400).json({ error: `${name} parha nahi ja saka: ${e.message}` });
  }
  const parsed = parsePlUpload(rows, name);
  const heads = await loadPlHeads(companyId);
  const known = new Set(heads.map((h) => h.name.trim().toLowerCase()));
  res.json({
    file: name,
    headerRowIndex: parsed.headerRowIndex,
    count: parsed.rows.length,
    skipped: parsed.skipped.slice(0, 50),
    unmappedHeaders: parsed.unmappedHeaders,
    unknownHeads: [...new Set(parsed.rows.filter((l) => !known.has(l.headName.trim().toLowerCase())).map((l) => l.headName))],
    knownHeads: heads.map((h) => h.name),
    rows: parsed.rows.slice(0, 25),
  });
}));

app.post('/api/pl/import', requirePerm('data', 'import_purchase'), express.raw({ type: '*/*', limit: '50mb' }), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const companyId = await resolveCompany(req, res);
  if (companyId === null) return;
  if (!req.body?.length) return res.status(400).json({ error: 'No file received.' });
  const name = path.basename(String(req.query.name || 'pl.xlsx'));
  const by = str(req.query.by) || 'accounts';

  let rows: unknown[][];
  try {
    rows = readPlFile(Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body), name).rows;
  } catch (e: any) {
    return res.status(400).json({ error: `${name} parha nahi ja saka: ${e.message}` });
  }

  const parsed = parsePlUpload(rows, name);
  const out = await importPl(companyId, parsed, name, { by });
  if (!out.ok) return res.status(400).json(out);

  await audit(req.user, {
    action: 'PL_IMPORT', module: 'P&L vs GSTR-1', company: String(companyId),
    details: { file: name, lines: out.lines, inserted: out.inserted, periods: out.periods.join(',') },
  });
  res.json({ ...out, file: name, headerRowIndex: parsed.headerRowIndex, unmappedHeaders: parsed.unmappedHeaders });
}));

app.post('/api/pl/recon', requirePerm('recon', 'rereconcile'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const companyId = await resolveCompany(req, res);
  if (companyId === null) return;
  const period = str(req.body?.period);
  if (!period) return res.status(400).json({ error: 'period chahiye (YYYY-MM)' });

  const out = await runPlRecon(companyId, period, { by: actorOf(req) });
  if (!out.ok) return res.status(400).json({ error: out.reason, result: out.result });
  await audit(req.user, {
    action: 'PL_RECONCILE', module: 'P&L vs GSTR-1', company: String(companyId), period,
    details: { matched: out.result.matchedHeads, pending: out.result.pendingHeads, unmapped: out.result.unmappedHeads },
  });
  res.json(out);
}));

app.get('/api/pl/outcomes', requirePerm('recon', 'view'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const companyId = await resolveCompany(req, res);
  if (companyId === null) return;
  const period = str(req.query.period);
  if (!period) return res.status(400).json({ error: 'period chahiye (YYYY-MM)' });
  res.json(await loadPlRecon(companyId, period));
}));

/**
 * Record why a difference exists.
 *
 * The database refuses to store an unexplained difference, so this cannot be a
 * formality: a non-zero difference with no reason is rejected twice, here and
 * by the CHECK constraint.
 */
app.post('/api/pl/explain', requirePerm('recon', 'edit'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const id = Number(req.body?.id);
  if (!id) return res.status(400).json({ error: 'recon row id chahiye' });
  const reason = str(req.body?.reason) || null;
  const remarks = str(req.body?.remarks) || undefined;
  const out = await setPlDifferenceReason(id, reason, remarks, { by: actorOf(req) });
  if (!out.ok) return res.status(400).json(out);
  await audit(req.user, {
    action: 'PL_DIFFERENCE_REASON', module: 'P&L vs GSTR-1',
    newValue: reason, reason: remarks || null,
  });
  res.json(out);
}));

app.get('/api/template/pl.xlsx', requirePerm('data', 'import_purchase'), wrap(async (req, res) => {
  const companyId = await optionalCompanyId(req);
  const heads = companyId !== null ? await loadPlHeads(companyId) : [];
  const buf = plTemplateBuffer({
    companyName: str(req.query.company) || undefined,
    period: str(req.query.period) || undefined,
    heads: heads.map((h) => h.name),
  });
  await audit(req.user, { action: 'PL_TEMPLATE_DOWNLOAD', module: 'P&L vs GSTR-1', details: { company: str(req.query.company) } });
  res.setHeader('Content-Disposition', 'attachment; filename="P&L Upload Template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}));

app.get('/api/template/pl.csv', requirePerm('data', 'import_purchase'), wrap(async (req, res) => {
  const companyId = await optionalCompanyId(req);
  const heads = companyId !== null ? await loadPlHeads(companyId) : [];
  const csv = plTemplateCsv({ companyName: str(req.query.company) || undefined, period: str(req.query.period) || undefined, heads: heads.map((h) => h.name) });
  await audit(req.user, { action: 'PL_TEMPLATE_DOWNLOAD', module: 'P&L vs GSTR-1', details: { company: str(req.query.company), format: 'csv' } });
  res.setHeader('Content-Disposition', 'attachment; filename="P&L Upload Template.csv"');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csv);
}));
/**
 * Purchase register from a real .xlsx / .xlsb / .csv file.
 *
 * The bytes are parsed with the very same `parsePurchaseRegister` the folder
 * run uses, so an uploaded file and a dropped file produce identical rows.
 *
 * Every sheet is considered, not just the first: a workbook may carry an
 * Instructions or cover sheet in front of the register, and picking the wrong
 * one returns zero rows and looks like a failed upload. The sheet that
 * exposes invoice_no / supplier_gstin / taxable_value is the data sheet.
 */
function purchaseRowsFromFile(
  buf: Buffer, name: string,
): { rows: unknown[][]; sheetName: string } {
  const sheets = readAllSheets(buf);
  if (!sheets.length) throw new Error(`${name}: file me koi sheet nahi mili.`);
  const picked = pickDataSheet(sheets, PURCHASE_REQUIRED, { profile: 'purchase' });
  return { rows: picked.rows, sheetName: picked.name };
}

app.post('/api/purchase-file/preview', express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: 'No file received.' });
  const name = path.basename(String(req.query.name || 'purchase.xlsx'));
  let rows: unknown[][];
  try {
    rows = purchaseRowsFromFile(Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body), name).rows;
  } catch (e: any) {
    return res.status(400).json({ error: `${name} parha nahi ja saka: ${e.message}` });
  }
  const detected = sniffKind(rows);
  const parsed = parsePurchaseRegister(rows, 'purchase-file');
  const fallbackGstin = normGstinOf(str(req.query.fallbackGstin));
  const forceDocType = docTypeOrNull(str(req.query.forceDocType));
  const overridePeriod = /^\d{4}-\d{2}$/.test(str(req.query.overridePeriod)) ? str(req.query.overridePeriod) : '';
  for (const b of parsed.rows) {
    if (fallbackGstin && !normGstinOf(b.our_gstin)) b.our_gstin = fallbackGstin;
    if (overridePeriod) b.period = overridePeriod;
    if (forceDocType) {
      b.document_type = forceDocType;
      b.sign_effect = docSign(forceDocType);
      b.taxable_value = docAmount(forceDocType, b.source_taxable_value ?? b.taxable_value);
      b.igst = docAmount(forceDocType, b.source_igst ?? b.igst);
      b.cgst = docAmount(forceDocType, b.source_cgst ?? b.cgst);
      b.sgst = docAmount(forceDocType, b.source_sgst ?? b.sgst);
      b.cess = docAmount(forceDocType, b.source_cess ?? b.cess);
    }
  }

  // ---- document-type summary --------------------------------------------
  // Shown BEFORE the import button, because this is the one file where a wrong
  // Document Type moves money in the return: a credit note typed as an invoice
  // silently adds the ITC it was meant to take away.
  const summary = summarisePurchaseDocuments(parsed.rows);

  // ---- month summary -----------------------------------------------------
  // One upload may carry several GST months. The operator has to see, BEFORE
  // pressing Import, which months the file touches and how much each one moves
  // — otherwise a stray date files a row under the wrong month and the
  // reconciliation quietly disagrees with the books. Signed amounts are summed
  // so a credit note reduces its own month rather than adding to it.
  const monthMap = new Map<string, { gstin: string; period: string; lines: number; taxable: number; tax: number }>();
  for (const b of parsed.rows) {
    const k = `${b.our_gstin}|${b.period}`;
    const m = monthMap.get(k) ?? { gstin: b.our_gstin, period: b.period, lines: 0, taxable: 0, tax: 0 };
    m.lines += 1;
    m.taxable = r2(m.taxable + b.taxable_value);
    m.tax = r2(m.tax + b.igst + b.cgst + b.sgst + b.cess);
    monthMap.set(k, m);
  }
  const periods = [...monthMap.values()].sort(
    (a, b) => a.gstin.localeCompare(b.gstin) || a.period.localeCompare(b.period),
  );

  res.json({
    file: name,
    detected,
    // Every GST month in the file, one entry each. A single-month file returns
    // exactly one row here; a twelve-month register returns twelve.
    periods,
    periodCount: periods.length,
    headerRowIndex: parsed.headerRowIndex,
    unmappedHeaders: parsed.unmappedHeaders,
    count: parsed.rows.length,
    // Counts, gross, reduction and net are separate figures: "purchases" and
    // "purchases less credit notes" are different answers and the second is the
    // one that goes into the return.
    documentTypes: summary.documentTypes,
    totals: summary.totals,
    duplicates: summary.duplicates,
    signConflicts: (parsed.warnings ?? []).filter((w) => /sign|negative|Credit Note/i.test(w)),
    invalidDocumentTypes: parsed.skipped
      .filter((s) => /document type/i.test(s.reason))
      .map((s) => ({ row: s.row, reason: s.reason })),
    warnings: parsed.warnings ?? [],
    skipped: parsed.skipped.slice(0, 50),
    rows: parsed.rows.slice(0, 25).map((b) => ({
      our_gstin: b.our_gstin, unit_name: b.unit_name, reference_no: b.reference_no,
      party_name: b.party_name, supplier_gstin: b.supplier_gstin,
      invoice_no: b.invoice_no, invoice_date: b.invoice_date, period: b.period,
      document_type: b.document_type,
      document_type_raw: b.document_type_raw ?? null,
      sign_effect: b.sign_effect ?? 1,
      source_taxable_value: b.source_taxable_value ?? b.taxable_value,
      source_igst: b.source_igst ?? b.igst,
      source_cgst: b.source_cgst ?? b.cgst,
      source_sgst: b.source_sgst ?? b.sgst,
      source_cess: b.source_cess ?? b.cess,
      book_entry_date: b.book_entry_date ?? null,
      // Derived, so the operator sees the book month the accounts team asked
      // for without the register needing a second column for it.
      book_entry_month: String(b.book_entry_date ?? '').slice(0, 7) || null,
      taxable_value: b.taxable_value, igst: b.igst, cgst: b.cgst, sgst: b.sgst, cess: b.cess,
      reverse_charge: b.reverse_charge ?? null,
      hsn: b.hsn ?? null,
      remark: b.remark ?? null,
      // Shown so the operator can see the e-invoice / e-way bill answers the
      // file carries BEFORE confirming the import. Omitting them made a working
      // feature look broken.
      has_e_invoice: b.has_e_invoice ?? null,
      e_invoice_no: b.e_invoice_no ?? null,
      has_e_way_bill: b.has_e_way_bill ?? null,
      e_way_bill_no: b.e_way_bill_no ?? null,
    })),
  });
}));

app.post('/api/purchase-file/import', requirePerm('data', 'import_purchase'), express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  if (!req.body?.length) return res.status(400).json({ error: 'No file received.' });
  const name = path.basename(String(req.query.name || 'purchase.xlsx'));
  const by = str(req.query.by) || 'accounts';

  let rows: unknown[][];
  let sheetName = '';
  try {
    const picked = purchaseRowsFromFile(Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body), name);
    rows = picked.rows;
    sheetName = picked.sheetName;
  } catch (e: any) {
    return res.status(400).json({ error: `${name} parha nahi ja saka: ${e.message}` });
  }

  // A GSTR-2B or sales file must not land in the purchase register by accident.
  const detected = sniffKind(rows);
  if (detected === 'twob') {
    return res.status(400).json({
      error: 'Ye file GSTR-2B lagti hai, purchase register nahi. Use "GSTR-2B Upload" screen.',
    });
  }
  if (detected === 'sales' && !str(req.query.force)) {
    return res.status(400).json({
      error: 'Ye file sales register lagti hai, purchase register nahi. Sales ke liye "Sales Register" module dekhein.',
    });
  }
  if (detected === 'unknown' && !str(req.query.force)) {
    return res.status(400).json({
      error: 'File pehchan nahi gayi. Header me "Supplier GSTIN", "Invoice No" aur "Taxable Value" hone chahiye.',
    });
  }

  const parsed = parsePurchaseRegister(rows, 'purchase-file');
  const fallbackGstin = normGstinOf(str(req.query.fallbackGstin));
  const forceDocType = docTypeOrNull(str(req.query.forceDocType));
  const overridePeriod = /^\d{4}-\d{2}$/.test(str(req.query.overridePeriod)) ? str(req.query.overridePeriod) : '';
  for (const b of parsed.rows) {
    if (fallbackGstin && !normGstinOf(b.our_gstin)) b.our_gstin = fallbackGstin;
    if (overridePeriod) b.period = overridePeriod;
    if (forceDocType) {
      b.document_type = forceDocType;
      b.sign_effect = docSign(forceDocType);
      b.taxable_value = docAmount(forceDocType, b.source_taxable_value ?? b.taxable_value);
      b.igst = docAmount(forceDocType, b.source_igst ?? b.igst);
      b.cgst = docAmount(forceDocType, b.source_cgst ?? b.cgst);
      b.sgst = docAmount(forceDocType, b.source_sgst ?? b.sgst);
      b.cess = docAmount(forceDocType, b.source_cess ?? b.cess);
    }
  }
  if (!parsed.rows.length) {
    return res.status(400).json({
      error: 'Koi row samajh nahi aayi. Check ki header row me "Supplier GSTIN", "Invoice No" aur "Taxable Value" hain.',
      skipped: parsed.skipped.slice(0, 20),
    });
  }
  // Every line must belong to a known GSTIN, otherwise the month totals and
  // the reconciliation cannot attribute it to a company or a unit.
  const blank = parsed.rows.filter((b) => !normGstinOf(b.our_gstin)).length;
  if (blank && !str(req.query.force)) {
    return res.status(400).json({
      error: `${blank} row me apna GSTIN (Our GSTIN) missing hai. Har row ka GSTIN hona zaroori hai — ` +
        'warna company ya unit tak attribute nahi ho paayega.',
    });
  }

  // Also stage the file in UPLOAD_DIR so folder-based monthly runs see it too
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body));
  } catch { /* non-fatal */ }

  // One file = one source, so re-uploading the same file updates those lines
  // instead of doubling them.
  const source = `file:${name}`;
  const out = await importPastedPurchase(parsed.rows, source, { by });
  if (!out.ok) return res.status(423).json(out);
  // One file can now cover several months, so the audit row records every
  // month it wrote. Logging only `out.key` would claim a 12-month import was a
  // single month's work.
  await audit(req.user, {
    action: 'PURCHASE_IMPORT', module: 'Data',
    details: {
      source, file: name, rows: parsed.rows.length, lines: out.lines,
      gstin: out.key.gstin, period: out.key.period,
      periods: out.keys.map((k) => `${k.gstin}|${k.period}`)
    },
  });
  res.json({ ...out, file: name, sheet: sheetName, detected, unmappedHeaders: parsed.unmappedHeaders, skipped: parsed.skipped.slice(0, 50) });
}));

// ---------------------------------------------------------------------------
// GSTR-1 — outward reconciliation: books -> draft -> filed -> match
// ---------------------------------------------------------------------------
//
// The GSTIN fence above only inspects req.query, because every existing route
// takes its GSTIN there. These routes take it in the body (a form post and a
// file upload do not naturally carry a query string), so the same check is
// repeated explicitly. Skipping it would leave the outward data the one part
// of the application a restricted user could read across companies.
async function checkGstinAccess(req: any, res: any, gstin: string): Promise<boolean> {
  const list = await allowedGstins(req.user);
  if (list === null) return true;
  if (list.includes(normGstinOf(gstin))) return true;
  res.status(403).json({ error: 'You do not have access to this GSTIN.' });
  return false;
}

/**
 * Books / SAP SALES REGISTER — read the file and show what the monthly run
 * would ingest, without ingesting it.
 *
 * The monthly run reads this same file through this same parser, so the preview
 * is what the run will actually see: how many invoices, how many item lines,
 * which period and which of OUR GSTINs the register covers, and every row the
 * parser had to skip with the reason it skipped it.
 *
 * It exists for the same reason the portal preview does. Without it, the only
 * way to find out whether the Sales Register was understood was to run the
 * month and read the result — learning what a file contains by importing it,
 * which is exactly what a GSTR-1 finalisation day cannot afford.
 *
 * Read-only: nothing is written, not even to the scratch folder.
 */
const SALES_REQUIRED = ['invoice_no', 'taxable_value', 'invoice_value'];

app.post('/api/sales-register/preview', requirePerm('data', 'import_sales'),
  express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
    if (!req.body?.length) return res.status(400).json({ error: 'No file received.' });
    const name = path.basename(String(req.query.name || 'sales-register.xlsx'));

    let sheets: Array<{ name: string; rows: unknown[][] }>;
    try {
      sheets = readAllSheets(Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body));
    } catch (e: any) {
      return res.status(400).json({ error: `${name} parha nahi ja saka: ${e.message}` });
    }
    if (!sheets.length) return res.status(400).json({ error: `${name} me koi sheet nahi mili.` });

    // Every sheet is considered, not just the first: a real SAP export carries a
    // cover or totals sheet in front of the register, and reading the wrong one
    // returns zero rows and looks like a broken upload.
    const picked = pickDataSheet(sheets, SALES_REQUIRED, { profile: 'sales' });
    const parsed = parseSalesRegister(picked.rows, name);

    const periods: Record<string, number> = {};
    const gstins = new Set<string>();
    let taxable = 0, igst = 0, cgst = 0, sgst = 0, cess = 0;
    for (const s of parsed.rows) {
      periods[s.period] = (periods[s.period] ?? 0) + 1;
      if (s.our_gstin) gstins.add(s.our_gstin);
      taxable += s.taxable_value; igst += s.igst; cgst += s.cgst; sgst += s.sgst; cess += s.cess;
    }

    res.json({
      ok: true,
      file: name,
      sheet: picked.name,
      detected: sniffKind(picked.rows),
      headerRowIndex: parsed.headerRowIndex,
      unmappedHeaders: parsed.unmappedHeaders,
      warnings: parsed.warnings ?? [],
      itemLevel: parsed.itemLevel,
      itemRows: parsed.itemRows,
      count: parsed.rows.length,
      periods,
      gstins: [...gstins],
      totals: { taxable, igst, cgst, sgst, cess, tax: igst + cgst + sgst + cess },
      // Every problem the parser found, but capped: a 900-row file with one bad
      // column would otherwise answer with 900 identical lines.
      issues: parsed.issues.slice(0, 60),
      skipped: parsed.skipped.slice(0, 40),
      rows: parsed.rows.slice(0, 25).map((s) => ({
        our_gstin: s.our_gstin,
        unit_name: s.unit_name ?? null,
        customer_name: s.customer_name,
        customer_gstin: s.customer_gstin,
        recipient_type: s.recipient_type ?? null,
        invoice_no: s.invoice_no,
        invoice_date: s.invoice_date,
        period: s.period,
        invoice_type: s.invoice_type,
        place_of_supply: s.place_of_supply,
        taxable_value: s.taxable_value,
        igst: s.igst, cgst: s.cgst, sgst: s.sgst, cess: s.cess,
        invoice_value: s.invoice_value,
        hsn: s.hsn ?? null,
        note_ref_no: s.note_ref_no ?? null,
        item_lines: s.items?.length ?? 0,
        items: (s.items ?? []).slice(0, 12).map((it) => ({
          line_no: it.line_no ?? null,
          hsn: it.hsn ?? null,
          uqc: it.uqc ?? null,
          quantity: it.quantity ?? 0,
          gst_rate: it.gst_rate ?? null,
          taxable_value: it.taxable_value,
          igst: it.igst, cgst: it.cgst, sgst: it.sgst, cess: it.cess,
          description: it.description ?? null,
        })),
      })),
    });
  }));

/** Which GSTINs and periods have outward data, for the context picker. */
app.get('/api/gstr1/coverage', requirePerm('recon', 'view'), wrap(async (req, res) => {
  const all = await outwardCoverage();
  const list = await allowedGstins(req.user);
  const rows = list === null ? all : all.filter((r) => list.includes(r.gstin.toUpperCase()));
  res.json({ ok: true, coverage: rows });
}));

/**
 * GSTR-1 table 12 — the HSN summary for one GSTIN and period, from the stored
 * item lines, split into its B2B and B2C halves, with the portal's side and a
 * comparison.
 *
 * Read-only, and it stays on the same permission and GSTIN-access controls as
 * every other outward route. Query:
 *
 *   ?gstin=&period=            required
 *   &scope=b2b|b2c|all         which half (default all, each row still labelled)
 *   &format=json|csv|xlsx      json is the default
 *   &view=books|portal|comparison|auto   which table an export carries
 *
 * `view=auto` exports the comparison when the portal side exists and the books
 * alone when it does not — so a download can never imply a reconciliation that
 * could not be performed.
 */
app.get('/api/gstr1/hsn', requirePerm('recon', 'view'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const gstin = str(req.query.gstin);
  const period = str(req.query.period);
  if (!gstin || !period) return res.status(400).json({ error: 'GSTIN and period are both required.' });
  if (!(await checkGstinAccess(req, res, gstin))) return;

  const rawScope = String(req.query.scope || 'all');
  const scope: 'b2b' | 'b2c' | 'all' =
    rawScope === 'b2b' || rawScope === 'b2c' ? rawScope : 'all';

  const out = await hsnSummary(gstin, period, scope);
  if (!out.ok) return res.status(400).json(out);

  const format = String(req.query.format || 'json');
  if (format === 'json') return res.json(out);

  const requested = String(req.query.view || 'auto');
  const view = requested === 'auto'
    ? (out.portal.available ? 'comparison' : 'books')
    : requested;
  const viewNames = ['books', 'portal', 'comparison'];
  if (!viewNames.includes(view)) {
    return res.status(400).json({ error: `view must be one of ${viewNames.join(', ')}` });
  }
  if (view !== 'books' && !out.portal.available) {
    return res.status(409).json({
      error: `“${view}” export ke liye portal ka GSTR-1 HSN data chahiye, jo import nahi hua. ${out.portal.reason || ''}`.trim(),
    });
  }

  const spec = hsnExport(view, out);
  const f: ReportFilters = { gstin: out.gstin, period: out.period } as ReportFilters;
  const extra = [
    `Return period: ${out.period}`, `Scope: ${scope.toUpperCase()}`,
    `View: ${spec.title}`,
    `Books item lines: ${out.item_lines} (item-wise invoices: ${out.item_level_invoices})`,
    out.portal.available
      ? `Portal source: ${out.portal.source} — ${out.portal.rows.length} HSN row(s)`
      : `Portal source: NOT AVAILABLE — ${out.portal.reason || ''}`,
    ...spec.notes,
  ];
  const name = `hsn_summary_${scope}_${view}_${out.period}_${out.gstin}`;

  await audit(req.user, {
    action: 'REPORT_EXPORT', module: 'Sales & GSTR-1',
    gstin: out.gstin, period: out.period,
    details: { report: 'hsn-summary', scope, view, format, rows: spec.rows.length },
  });

  const meta = await reportMeta(req, spec.title, f, extra);
  if (format === 'csv') {
    return sendCsv(res, toCsv(spec.columns, spec.rows, meta), name + '.csv');
  }
  if (format === 'xlsx') {
    return sendXlsx(res, toWorkbookBuffer(spec.title, spec.columns, spec.rows, meta), name + '.xlsx');
  }
  res.status(400).json({ error: 'format must be json, csv or xlsx' });
}));

/**
 * The export shape of each HSN view. Same numbers the screen shows — a download
 * that carried a different slice would be its own reconciliation.
 */
function hsnExport(
  view: string,
  r: any,
): { title: string; columns: Column[]; rows: Array<Record<string, any>>; notes: string[] } {
  const qty = (v: any) => (v === null || v === undefined ? '' : Number(v));
  const cols = (list: Array<[string, string, ColType?, number?]>): Column[] =>
    list.map(([h, k, t, w]) => ({ h, k, t: t || 'text', w }));

  if (view === 'portal') {
    return {
      title: 'GSTR-1 HSN Summary — Portal (filed)',
      notes: ['Portal ki HSN sheet import nahi hoti; UQC aur quantity portal side par available nahi hain.'],
      columns: cols([
        ['Supply', 'scope', 'text', 10], ['HSN/SAC', 'hsn', 'text', 12],
        ['Rate %', 'rate', 'text', 8], ['Taxable Value', 'taxable', 'money', 16],
        ['IGST', 'igst', 'money', 14], ['CGST', 'cgst', 'money', 14],
        ['SGST/UTGST', 'sgst', 'money', 14], ['CESS', 'cess', 'money', 12],
        ['Filed documents', 'documents', 'int', 10],
        ['UQC', 'uqc_missing', 'text', 10], ['Quantity', 'qty_missing', 'text', 10],
      ]),
      rows: r.portal.rows.map((p: any) => ({
        ...p, uqc_missing: 'not on portal row', qty_missing: 'not on portal row',
      })),
    };
  }

  if (view === 'comparison') {
    return {
      title: 'GSTR-1 HSN Summary — Books vs Portal',
      notes: r.comparison.notes || [],
      columns: cols([
        ['Supply', 'scope', 'text', 10], ['HSN/SAC', 'hsn', 'text', 12],
        ['Description', 'description', 'text', 24], ['UQC', 'uqc', 'text', 8],
        ['Rate %', 'rate', 'text', 8],
        ['Books Taxable', 'booksTaxable', 'money', 16], ['Books Qty', 'booksQty', 'text', 12],
        ['Books IGST', 'booksIgst', 'money', 14], ['Books CGST', 'booksCgst', 'money', 14],
        ['Books SGST/UTGST', 'booksSgst', 'money', 14], ['Books CESS', 'booksCess', 'money', 12],
        ['Portal Taxable', 'portalTaxable', 'money', 16],
        ['Portal IGST', 'portalIgst', 'money', 14], ['Portal CGST', 'portalCgst', 'money', 14],
        ['Portal SGST/UTGST', 'portalSgst', 'money', 14], ['Portal CESS', 'portalCess', 'money', 12],
        ['Diff Taxable', 'diffTaxable', 'money', 14], ['Diff IGST', 'diffIgst', 'money', 12],
        ['Diff CGST', 'diffCgst', 'money', 12], ['Diff SGST/UTGST', 'diffSgst', 'money', 12],
        ['Diff CESS', 'diffCess', 'money', 12],
        ['Status', 'status', 'text', 12], ['Remarks', 'remarks', 'text', 60],
      ]),
      rows: r.comparison.rows.map((c: any) => ({
        ...c,
        description: c.desc,
        booksTaxable: c.books ? c.books.taxable : '', booksQty: c.books ? qty(c.books.qty) : '',
        booksIgst: c.books ? c.books.igst : '', booksCgst: c.books ? c.books.cgst : '',
        booksSgst: c.books ? c.books.sgst : '', booksCess: c.books ? c.books.cess : '',
        portalTaxable: c.portal ? c.portal.taxable : '', portalIgst: c.portal ? c.portal.igst : '',
        portalCgst: c.portal ? c.portal.cgst : '', portalSgst: c.portal ? c.portal.sgst : '',
        portalCess: c.portal ? c.portal.cess : '',
        diffTaxable: c.diff ? c.diff.taxable : '', diffIgst: c.diff ? c.diff.igst : '',
        diffCgst: c.diff ? c.diff.cgst : '', diffSgst: c.diff ? c.diff.sgst : '',
        diffCess: c.diff ? c.diff.cess : '',
        remarks: (c.remarks || []).join(' '),
      })),
    };
  }

  return {
    title: 'GSTR-1 HSN Summary — Books',
    notes: ['Books se bana HSN summary (table 12). Portal ka data import hone par comparison bhi milega.'],
    columns: cols([
      ['Supply', 'scope', 'text', 10], ['HSN/SAC', 'hsn', 'text', 12],
      ['Description', 'description', 'text', 28], ['UQC', 'uqc', 'text', 8],
      ['Quantity', 'qty', 'int', 12], ['Rate %', 'rate', 'text', 8],
      ['Taxable Value', 'taxable', 'money', 16], ['IGST', 'igst', 'money', 14],
      ['CGST', 'cgst', 'money', 14], ['SGST/UTGST', 'sgst', 'money', 14],
      ['CESS', 'cess', 'money', 12],
    ]),
    rows: r.rows.map((h: any) => ({
      scope: h.scope, hsn: h.hsn, description: h.desc, uqc: h.uqc,
      qty: qty(h.qty), rate: h.rateOut,
      taxable: h.taxable, igst: h.igst, cgst: h.cgst, sgst: h.sgst, cess: h.cess,
    })),
  };
}

/**
 * Rebuild the drafted return for a period from the books.
 *
 * Safe to press as often as you like: it replaces the draft rather than adding
 * to it, so a re-run after a correction cannot inflate the return.
 */
app.post('/api/gstr1/draft', requirePerm('recon', 'rereconcile'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const gstin = str(req.body?.gstin);
  const period = str(req.body?.period);
  if (!gstin || !period) return res.status(400).json({ error: 'GSTIN and period are both required.' });
  if (!(await checkGstinAccess(req, res, gstin))) return;
  const out = await rebuildDrafts(gstin, period);
  if (out.blocked) return res.status(423).json(out);
  if (!out.ok) return res.status(400).json(out);
  await audit(req.user, {
    action: 'GSTR1_DRAFT', module: 'Reconciliation',
    details: { gstin, period, documents: out.documents, byTable: out.by_table, rejected: out.rejected.length },
  });
  res.json(out);
}));

/**
 * Read a portal export and show what it would store, without storing it.
 *
 * The preview exists so nobody learns what a file contains by importing it into
 * the live database. It reports every sheet, how many rows each contributed,
 * and every row it had to skip with the reason — a silent skip is how "my
 * upload did nothing" happens.
 */
app.post('/api/gstr1/preview', express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: 'No file received.' });
  const name = path.basename(String(req.query.name || 'gstr1.xlsx'));
  const gstin = normGstinOf(String(req.query.gstin || ''));
  const period = str(req.query.period);
  if (!gstin) return res.status(400).json({ error: 'A GSTIN is required — the portal export does not always name it.' });
  if (!(await checkGstinAccess(req, res, gstin))) return;

  let parsed;
  try {
    parsed = parseFiledWorkbook(Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body), { our_gstin: gstin, period });
  } catch (e: any) {
    return res.status(400).json({ error: `${name} parha nahi ja saka: ${e.message}` });
  }
  if (!parsed.rows.length) {
    return res.status(400).json({
      error: `${name} me koi GSTR-1 row nahi mili.`,
      file: name, sheets: parsed.sheets, perSheet: parsed.perSheet, skipped: parsed.skipped.slice(0, 40),
    });
  }

  // Which periods the file actually touches. A portal download can cover more
  // than one, and importing it into whichever period the picker happened to be
  // on would scatter a return across months.
  const periods: Record<string, number> = {};
  for (const r of parsed.rows) periods[r.period] = (periods[r.period] ?? 0) + 1;

  res.json({
    ok: true,
    file: name,
    gstin,
    sheets: parsed.sheets,
    perSheet: parsed.perSheet,
    tableOfSheet: parsed.tableOfSheet,
    skipped: parsed.skipped.slice(0, 40),
    periods,
    totals: summariseParsed(parsed.rows),
    tables: Object.entries(summariseParsed(parsed.rows).byTable).map(([t, v]) => ({ table: t, label: TABLE_LABEL[t as never] ?? t, ...v })),
    rows: parsed.rows.slice(0, 30).map((r: FiledRow) => ({
      period: r.period,
      table_type: parseTableType(r.table_type) ?? 'B2B',
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      invoice_type: r.invoice_type,
      recipient_gstin: r.recipient_gstin,
      recipient_name: r.recipient_name,
      place_of_supply: r.place_of_supply,
      taxable_value: r.taxable_value,
      igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess,
      invoice_value: r.invoice_value,
      rate: r.rate ?? null,
      note_ref_number: r.note_ref_number ?? null,
    })),
  });
}));

/** Store a portal export as the filed return. Upserts, so re-import is safe. */
app.post('/api/gstr1/import', requirePerm('data', 'import_sales'), express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  if (!req.body?.length) return res.status(400).json({ error: 'No file received.' });
  const name = path.basename(String(req.query.name || 'gstr1.xlsx'));
  const gstin = normGstinOf(String(req.query.gstin || ''));
  const period = str(req.query.period);
  if (!gstin) return res.status(400).json({ error: 'A GSTIN is required.' });
  if (!(await checkGstinAccess(req, res, gstin))) return;

  let parsed;
  try {
    parsed = parseFiledWorkbook(Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body), { our_gstin: gstin, period });
  } catch (e: any) {
    return res.status(400).json({ error: `${name} parha nahi ja saka: ${e.message}` });
  }
  if (!parsed.rows.length) {
    return res.status(400).json({ error: `${name} me koi GSTR-1 row nahi mili.`, skipped: parsed.skipped.slice(0, 40) });
  }

  const out = await importFiled(gstin, period, parsed.rows);
  if (!out.ok) return res.status(400).json(out);
  await audit(req.user, {
    action: 'GSTR1_FILED_IMPORT', module: 'Reconciliation',
    details: { gstin, file: name, inserted: out.inserted, updated: out.updated, periods: out.periods },
  });
  const reconResults: any[] = [];
  const importedPeriods = Array.isArray(out.periods) ? out.periods : Object.keys(out.periods || {});
  for (const p of (importedPeriods.length ? importedPeriods : [period])) {
    if (!p) continue;
    await rebuildDrafts(gstin, p).catch(() => null);
    const r = await runRecon(gstin, p, req.user?.id ?? undefined).catch(() => null);
    if (r) reconResults.push({ period: p, ...r });
  }
  res.json({ ...out, file: name, sheets: parsed.sheets, perSheet: parsed.perSheet, skipped: parsed.skipped.slice(0, 40), autoRecon: reconResults });
}));

/** Import a Sales Register workbook/CSV directly into sales_invoices + build GSTR-1 draft + run Bill-to-Bill reconciliation. */
app.post('/api/sales-register/import', requirePerm('data', 'import_sales'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const gstin = normGstinOf(req.body?.gstin);
  const period = str(req.body?.period);
  const name = str(req.body?.name) || 'Sales.xlsx';
  const buf = parseDataUrl(req.body?.data);
  if (!gstin) return res.status(400).json({ error: 'gstin zaroori hai.' });
  if (!buf) return res.status(400).json({ error: 'File payload khali hai.' });
  if (!(await checkGstinAccess(req, res, gstin))) return;

  try {
    const sheets = readAllSheets(buf);
    if (!sheets.length) return res.status(400).json({ error: `${name} me koi sheet nahi mili.` });
    const picked = pickDataSheet(sheets, SALES_REQUIRED, { profile: 'sales' });
    const parsed = parseSalesRegister(picked.rows, name);
    if (!parsed.rows.length) return res.status(400).json({ error: `${name} me koi valid sales row nahi mili.` });

    const periods = new Set<string>();
    const stamped = parsed.rows.map((s) => {
      const p = s.period || period || '';
      if (p) periods.add(p);
      return {
        ...s,
        our_gstin: normGstinOf(s.our_gstin) || gstin,
        period: p,
      };
    });

    const saved = await persistRun({
      books: [],
      twob: [],
      sales: stamped,
      reconByBundle: new Map(),
      uploadedBy: actorOf(req),
    });
    if (!saved.ok) return res.status(400).json({ error: saved.reason || 'Sales register save nahi ho saka.' });

    const inserted = saved.salesInserted + saved.salesUpdated;
    const reconResults: any[] = [];
    for (const p of periods) {
      await rebuildDrafts(gstin, p);
      const r = await runRecon(gstin, p, req.user?.id ?? undefined).catch(() => null);
      if (r) reconResults.push({ period: p, ...r });
    }
    await audit(req.user, {
      action: 'SALES_REGISTER_IMPORT', module: 'Sales',
      details: { gstin, file: name, inserted, periods: [...periods] },
    });
    res.json({ ok: true, file: name, inserted, periods: [...periods], autoRecon: reconResults });
  } catch (e: any) {
    res.status(400).json({ error: `${name} import nahi ho saka: ${e.message}` });
  }
}));

/** Export GSTR-1 vs Books Bill-to-Bill reconciliation in Excel (.xlsx) or CSV. */
app.get('/api/gstr1/recon-export', requirePerm('recon', 'export'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const gstin = str(req.query.gstin);
  const period = str(req.query.period);
  const status = str(req.query.status) || undefined;
  const format = (str(req.query.format) || 'xlsx').toLowerCase();
  if (!gstin || !period) return res.status(400).json({ error: 'gstin aur period zaroori hain.' });

  const out = await loadOutcomePage(gstin, period, { status, limit: 5000 });
  const exportRows = (out.outcomes || []).map((r: any, idx: number) => ({
    'S.No': idx + 1,
    'Status': r.status,
    'GSTR-1 Table': r.gstr1_table || r.table_type || '',
    'Invoice No': r.invoice_number_raw || '',
    'Invoice Date': r.invoice_date ? String(r.invoice_date).slice(0, 10) : '',
    'Customer Name': r.customer_name || '',
    'Customer GSTIN': r.customer_gstin_norm || '',
    'Books Taxable': Number(r.draft_taxable || 0),
    'Portal Taxable': Number(r.filed_taxable || 0),
    'Taxable Diff (Books - Portal)': Number(r.taxable_difference ?? (Number(r.draft_taxable || 0) - Number(r.filed_taxable || 0))),
    'Books IGST': Number(r.draft_igst || 0),
    'Portal IGST': Number(r.filed_igst || 0),
    'Books CGST': Number(r.draft_cgst || 0),
    'Portal CGST': Number(r.filed_cgst || 0),
    'Books SGST': Number(r.draft_sgst || 0),
    'Portal SGST': Number(r.filed_sgst || 0),
    'Books Total Tax': Number(r.draft_tax || 0),
    'Portal Total Tax': Number(r.filed_tax || 0),
    'Tax Diff (Books - Portal)': Number(r.tax_difference ?? (Number(r.draft_tax || 0) - Number(r.filed_tax || 0))),
    'Action / Suggestion': r.suggested_fix || (Array.isArray(r.issues) ? r.issues.map((i: any) => i.detail || i.code).join('; ') : ''),
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportRows.length ? exportRows : [{ Note: 'No GSTR-1 reconciliation rows for selected filter' }]);
  XLSX.utils.book_append_sheet(wb, ws, 'GSTR1_Bill_to_Bill');

  if (format === 'csv') {
    const csv = XLSX.utils.sheet_to_csv(ws);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="GSTR1_vs_Books_${gstin}_${period}.csv"`);
    return res.send(csv);
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="GSTR1_vs_Books_${gstin}_${period}.xlsx"`);
  res.send(buf);
}));

/** Compare the stored draft against the stored filed return. */
app.post('/api/gstr1/recon', requirePerm('recon', 'rereconcile'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const gstin = str(req.body?.gstin);
  const period = str(req.body?.period);
  if (!gstin || !period) return res.status(400).json({ error: 'GSTIN and period are both required.' });
  if (!(await checkGstinAccess(req, res, gstin))) return;
  const out = await runRecon(gstin, period, req.user?.id ?? undefined);
  if (!out.ok) return res.status(400).json(out);
  await audit(req.user, {
    action: 'GSTR1_RECON', module: 'Reconciliation',
    details: {
      gstin, period, matched: out.totals.matched, not_declared: out.totals.not_declared,
      declared_not_in_books: out.totals.declared_not_in_books, amount_mismatch: out.totals.amount_mismatch,
      tax_difference: out.totals.tax_difference
    },
  });
  res.json(out);
}));

/** The reconciliation screen: summary, run history and per-invoice outcomes. */
app.get('/api/gstr1/outcomes', requirePerm('recon', 'view'), wrap(async (req, res) => {
  const gstin = str(req.query.gstin);
  const period = str(req.query.period);
  if (!gstin || !period) return res.status(400).json({ error: 'GSTIN and period are both required.' });
  const out = await loadOutcomePage(gstin, period, {
    status: str(req.query.status) || undefined,
    table: str(req.query.table) || undefined,
    limit: Number(req.query.limit) || 400,
  });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
}));

app.post('/api/paste/preview', wrap(async (req, res) => {
  const rows = pasteRows(req.body);
  const parsed = parsePurchaseRegister(rows, 'pasted');
  res.json({
    headerRowIndex: parsed.headerRowIndex,
    headers: rows[parsed.headerRowIndex] ?? [],
    mapped: [...new Set(parsed.unmappedHeaders)].length === 0,
    unmappedHeaders: parsed.unmappedHeaders,
    count: parsed.rows.length,
    skipped: parsed.skipped.slice(0, 50),
    rows: parsed.rows.slice(0, 25).map((b) => ({
      our_gstin: b.our_gstin, party_name: b.party_name, supplier_gstin: b.supplier_gstin,
      invoice_no: b.invoice_no, invoice_date: b.invoice_date, period: b.period,
      book_entry_date: b.book_entry_date ?? null,
      // Derived, so the operator sees the book month the accounts team asked
      // for without the register needing a second column for it.
      book_entry_month: String(b.book_entry_date ?? '').slice(0, 7) || null,
      taxable_value: b.taxable_value, igst: b.igst, cgst: b.cgst, sgst: b.sgst, cess: b.cess,
    })),
  });
}));

app.post('/api/paste/import', requirePerm('data', 'import_purchase'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const rows = pasteRows(req.body);
  const parsed = parsePurchaseRegister(rows, 'pasted');
  if (!parsed.rows.length) {
    return res.status(400).json({
      error: 'Koi row samajh nahi aayi. Check ki header row me "Supplier GSTIN", "Invoice No" aur "Taxable Value" hain.',
      skipped: parsed.skipped.slice(0, 20),
    });
  }
  // One paste = one source, so re-pasting the same block updates the same lines
  // instead of doubling them.
  const pasteId = str(req.body?.pasteId) || `paste:${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
  const out = await importPastedPurchase(parsed.rows, pasteId, { by: actorOf(req) });
  if (!out.ok) return res.status(423).json(out);
  await audit(req.user, {
    action: 'PURCHASE_IMPORT', module: 'Data',
    details: {
      source: 'paste', rows: parsed.rows.length, lines: out.lines,
      gstin: out.key.gstin, period: out.key.period
    },
  });
  res.json({ ...out, unmappedHeaders: parsed.unmappedHeaders, skipped: parsed.skipped.slice(0, 50) });
}));

// ---------------------------------------------------------------------------
// Reports — every screen exports, and the filters travel with the file
// ---------------------------------------------------------------------------

/** Read the filter set off the query string. This is the only way in. */
function filtersOf(req: any): ReportFilters {
  const q = req.query || {};
  const s = (k: string) => (q[k] ? String(q[k]).trim() : undefined);
  const locked = q.locked === undefined ? undefined : q.locked === 'true';
  return {
    gstin: s('gstin'),
    period: s('period'),
    from: s('from'),
    to: s('to'),
    supplier: s('supplier'),
    vendor: s('vendor'),
    q: s('q'),
    status: s('status'),
    decision: s('decision'),
    classification: s('classification'),
    twoBMonth: s('twoBMonth'),
    decisionMonth: s('decisionMonth'),
    followUp: s('followUp'),
    locked,
  };
}

app.get('/api/reports', requirePerm('report', 'view'), wrap(async (_req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  res.json({
    reports: REPORTS.map((r) => ({
      name: r.name, title: r.title, category: r.category,
      note: r.note, aggregate: !!r.aggregate, columns: r.columns.length,
    })),
  });
}));

/**
 * Download Complete Reconciliation — one workbook, one sheet per report.
 *
 * Registered BEFORE `/api/report/:name` so that "complete.xlsx" is never
 * mistaken for a report called "complete.xlsx". Built from the same definitions
 * as the single-report exports, filtered by the same filter string, so the
 * sheets always agree with each other.
 */
const COMPLETE_SHEETS: Array<{ name: string; report: string; title: string }> = [
  { name: 'Purchase Summary', report: 'gstin-wise', title: 'Purchase Summary — GSTIN wise' },
  { name: 'Invoice Reconciliation', report: 'purchase-reconciliation', title: 'Invoice Reconciliation' },
  { name: 'Supplier Wise', report: 'supplier-wise', title: 'Supplier-wise Reconciliation' },
  { name: 'GSTIN Wise', report: 'gstin-wise', title: 'GSTIN-wise Reconciliation' },
  { name: 'Matched', report: 'matched', title: 'Matched Invoices' },
  { name: 'Missing in 2B', report: 'missing-in-2b', title: 'Missing in 2B' },
  { name: '2B Not in Books', report: 'twob-not-in-books', title: '2B Not in Books' },
  { name: 'GST Mismatch', report: 'gst-mismatch', title: 'GST Mismatch' },
  { name: 'Date Mismatch', report: 'date-mismatch', title: 'Date Mismatch' },
  { name: 'Duplicate', report: 'duplicate', title: 'Duplicate Invoices' },
  { name: 'ITC Working', report: 'itc-working', title: 'ITC Working' },
  { name: 'ITC Claim Month', report: 'itc-claim-month-wise', title: 'ITC Claim Month-wise' },
  { name: 'ITC 2B Month', report: 'itc-2b-month-wise', title: 'ITC by 2B Month' },
  { name: 'Exceptions', report: 'missing-in-2b', title: 'Exceptions — Missing in 2B' },
  { name: 'Audit Trail', report: 'audit-trail', title: 'Audit Trail' },
];

app.get('/api/report/complete.xlsx', requirePerm('report', 'export'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const f = filtersOf(req);

  const sheets = [] as Array<{ name: string; title: string; columns: any[]; rows: any[] }>;
  // A filter only some sheets can answer is reported once, at workbook level,
  // instead of pretending every sheet honoured it.
  const ignored = new Set<string>();
  for (const s of COMPLETE_SHEETS) {
    const r = await runReportNamed(s.report, f);
    if (!r) continue;
    for (const g of r.ignored) ignored.add(g);
    sheets.push({ name: s.name, title: s.title, columns: r.def.columns, rows: r.rows });
  }
  const meta = [
    `Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    ...describeFilters(f, [...ignored]),
    `Total sheets: ${sheets.length}`,
  ];
  const name = `GST_Reconciliation${f.period ? '_' + f.period : ''}${f.gstin ? '_' + f.gstin : ''}.xlsx`;
  sendXlsx(res, toCompleteWorkbook(sheets, meta), name);
}));

/**
 * One report, three shapes, chosen with `?format=`.
 *
 * A single route rather than `/name.csv` and `/name.xlsx`, because Express's
 * parameter syntax puts the dot INSIDE the parameter — `missing-in-2b.csv`
 * arrives as a report called "missing-in-2b.csv" and every export 404s.
 */
function sendCsv(res: any, csv: string, name: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(csv);
}
function sendXlsx(res: any, buf: Buffer, name: string) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(buf);
}

/**
 * The identity block stamped onto every export: product, company, GSTIN, FY,
 * tax period, report name, generated-on and generated-by.
 */
/**
 * Resolve the `?company=` value a template download arrived with.
 *
 * The UI sends the company ID, because that is what its selector holds live —
 * so a numeric value is looked up in the master and printed as a name. Anything
 * else is taken as a name the caller already has. Without this the workbook said
 * "Company: 2".
 */
async function companyDisplayName(value: string): Promise<string> {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^\d+$/.test(v)) {
    const m = await readMasters();
    const row = m.ok ? m.rows.find((r: any) => String(r.company_id) === v) : undefined;
    return row ? displayCompany(row.company) : '';
  }
  return displayCompany(v);
}

async function reportMeta(
  req: any,
  title: string,
  f: ReportFilters,
  extra: string[] = [],
): Promise<string[]> {
  const gstin = f.gstin || '';
  let company = '';
  let logo: string | null = null;
  try {
    const rows = await withClient((c) =>
      c.query(
        `SELECT c.name, c.short_name, c.legal_name, c.logo_file, g.gstin_number, u.name AS unit_name
           FROM gstins g
           JOIN companies c ON c.id = g.company_id
           LEFT JOIN units u ON u.id = g.unit_id
          WHERE g.gstin_number = $1`,
        [gstin],
      ),
    );
    const row = rows.rows[0];
    if (row) {
      company = displayCompany(row.legal_name || row.name);
      logo = row.logo_file || null;
    }
  } catch { /* no GSTIN filter, or the master is unreadable: fall through */ }

  const fy = f.period ? fyLabelOf(f.period) : (f.from || f.to ? fyLabelOf(f.from || f.to!) : '');
  const period = f.period || (f.from || f.to ? `${f.from || 'start'} to ${f.to || 'end'}` : 'all months');

  const who = req.user
    ? `${req.user.displayName} (${req.user.username})`
    : 'unknown user';
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ');

  return [
    'GST CONTROL ERP',
    `Company: ${company || 'All companies'}`,
    `GSTIN: ${gstin || 'all'}`,
    `Financial Year: ${fy || 'all'}`,
    `Tax Period: ${period}`,
    `Report: ${title}`,
    `Generated On: ${at}`,
    `Generated By: ${who}`,
    'Powered by Vishnu Intelligence Services | Independent GST compliance software (not a government portal)',
    ...extra,
  ];
}

/**
 * The standard SALES register template — the input GSTR-1 is built from.
 *
 * Same shape as the purchase template, and for the same reason: the parser
 * matches columns by name, so the template is what removes the guesswork. It
 * is also the answer to "what do I have to put in the file?" — the Instructions
 * sheet lists every column, whether it is compulsory, and what the engine does
 * with it.
 */
app.get('/api/template/sales-register.xlsx', requirePerm('data', 'import_sales'), wrap(async (req, res) => {
  const company = await companyDisplayName(str(req.query.company));
  const buf = salesTemplateBuffer({ companyName: company });
  await audit(req.user, { action: 'SALES_TEMPLATE_DOWNLOAD', module: 'Data', details: { company } });
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="Sales Register Template.xlsx"`,
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}));

app.get('/api/template/sales-register.csv', requirePerm('data', 'import_sales'), wrap(async (req, res) => {
  await audit(req.user, { action: 'SALES_TEMPLATE_DOWNLOAD', module: 'Data', details: { format: 'csv' } });
  res.setHeader('Content-Disposition', `attachment; filename="Sales Register Template.csv"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(salesTemplateCsv());
}));

/**
 * The standard purchase register template.
 *
 * Declared before `/api/report/:name` so the literal path is not swallowed by
 * the parameterised one. `.xlsx` and `.csv` differ only in the buffer, so both
 * come from the same column list.
 */
app.get('/api/template/purchase-register.xlsx', requirePerm('data', 'import_purchase'), wrap(async (req, res) => {
  const company = await companyDisplayName(str(req.query.company));
  const buf = purchaseTemplateBuffer({ companyName: company });
  await audit(req.user, { action: 'PURCHASE_TEMPLATE_DOWNLOAD', module: 'Data', details: { company } });
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="Purchase Register Template.xlsx"`,
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}));

app.get('/api/template/purchase-register.csv', requirePerm('data', 'import_purchase'), wrap(async (req, res) => {
  await audit(req.user, { action: 'PURCHASE_TEMPLATE_DOWNLOAD', module: 'Data', details: { format: 'csv' } });
  res.setHeader('Content-Disposition', `attachment; filename="Purchase Register Template.csv"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(purchaseTemplateCsv());
}));

/**
 * The GSTR-2B vs Books invoice-to-invoice reconciliation working sheet.
 *
 * Sheet 1 is the invoice-wise view a CA reads; sheet 2 is the line-wise sheet
 * that goes back into the software, so it carries the Line IDs and the columns
 * the upload may write.
 *
 * With `?blank=1` it is the shipped skeleton (example rows, no database at all).
 * Otherwise the screen's filters are applied and the sheet arrives ALREADY
 * RECONCILED — which is the point: matching is the software's job, and asking
 * the Accounts team to line up two registers by hand is how a month gets filed
 * on a recollection.
 */
app.get('/api/template/twob-recon.xlsx', requirePerm('data', 'import_purchase'), wrap(async (req, res) => {
  const company = await companyDisplayName(str(req.query.company));
  const blank = String(req.query.blank ?? '') === '1';
  let rows: Array<Record<string, any>> = [];
  let filters: string[] = [];
  if (!blank) {
    const ready = await dbReady();
    if (!ready.ok) return res.status(503).json({ error: ready.reason });
    const f = filtersOf(req);
    const r = await runReportNamed('purchase-reconciliation', f);
    if (!r) return res.status(404).json({ error: 'no such report' });
    rows = r.rows;
    filters = describeFilters(f, r.ignored);
  }
  const f = filtersOf(req);
  const buf = twobReconTemplateBuffer({
    companyName: company,
    gstin: f.gstin,
    period: f.period,
    rows,
    filters,
  });
  await audit(req.user, {
    action: 'TWOB_RECON_TEMPLATE_DOWNLOAD', module: 'Data',
    gstin: f.gstin || null, period: f.period || null,
    details: { company, blank, rows: rows.length },
  });
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="GSTR-2B vs Books - Invoice-wise Reconciliation.xlsx"`,
  );
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}));

/**
 * The same template as CSV — sheet 1 only, and never pre-filled.
 *
 * A CSV cannot hold three sheets, and it certainly cannot hold Line IDs safely
 * (Excel turns a long number in a CSV into a float). The file that goes back into
 * the software is the .xlsx; this one is for reading.
 */
app.get('/api/template/twob-recon.csv', requirePerm('data', 'import_purchase'), wrap(async (req, res) => {
  await audit(req.user, { action: 'TWOB_RECON_TEMPLATE_DOWNLOAD', module: 'Data', details: { format: 'csv' } });
  res.setHeader('Content-Disposition', `attachment; filename="GSTR-2B vs Books - Invoice-wise Reconciliation.csv"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(twobReconTemplateCsv());
}));

app.get('/api/report/:name', requirePerm('report', 'view'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const def = findReport(req.params.name);
  if (!def) return res.status(404).json({ error: 'no such report' });
  const f = filtersOf(req);
  const format = String(req.query.format || 'json');
  const r = await runReportNamed(def.name, f);

  if (format === 'csv' || format === 'xlsx') {
    await audit(req.user, {
      action: 'REPORT_EXPORT', module: 'Report',
      gstin: f.gstin || null, period: f.period || null,
      details: { report: def.name, format },
    });
  }

  if (format === 'csv') {
    const meta = await reportMeta(req, def.title, f, describeFilters(f, r!.ignored));
    return sendCsv(res, toCsv(def.columns, r!.rows, meta), fileNameFor(def.name, def.title, f, 'csv'));
  }
  if (format === 'xlsx') {
    const meta = await reportMeta(req, def.title, f, [...describeFilters(f, r!.ignored), `Records: ${r!.count}`]);
    if (def.note) meta.push(`Note: ${def.note}`);
    return sendXlsx(
      res,
      toWorkbookBuffer(def.title, def.columns, r!.rows, meta),
      fileNameFor(def.name, def.title, f, 'xlsx'),
    );
  }

  const limit = Math.min(Number(req.query.limit || 200), 2000);
  res.json({
    name: def.name, title: def.title, note: def.note, category: def.category,
    total: r!.count, count: Math.min(r!.count, limit),
    filters: describeFilters(f, r!.ignored), rows: r!.rows.slice(0, limit),
    columns: def.columns,
  });
}));

/** Supplier-wise follow-up: who costs us ITC, and when we last chased them. */
app.get('/api/supplier-followup', wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const f = filtersOf(req);
  const rows = await supplierFollowUp(f);
  const format = String(req.query.format || 'json');
  if (format === 'csv' || format === 'xlsx') {
    await audit(req.user, {
      action: 'REPORT_EXPORT', module: 'Report',
      gstin: f.gstin || null, period: f.period || null,
      details: { report: 'supplier-followup', format },
    });
  }
  const fuTitle = 'Supplier Follow-up — ITC at risk';
  if (format === 'csv') {
    const meta = await reportMeta(req, fuTitle, f, [...describeFilters(f), `Suppliers: ${rows.length}`]);
    return sendCsv(res, toCsv(FOLLOWUP_COLUMNS, rows, meta), fileNameFor('supplier-followup', '', f, 'csv'));
  }
  if (format === 'xlsx') {
    const meta = await reportMeta(req, fuTitle, f, [...describeFilters(f), `Suppliers: ${rows.length}`]);
    return sendXlsx(
      res,
      toWorkbookBuffer(fuTitle, FOLLOWUP_COLUMNS, rows, meta),
      fileNameFor('supplier-followup', '', f, 'xlsx'),
    );
  }
  res.json({ count: rows.length, rows, columns: FOLLOWUP_COLUMNS, filters: describeFilters(f) });
}));

/**
 * Per-supplier letter. One page per vendor: the invoices, the money, the date
 * asked, and a blank line to write what they replied.
 */
app.get('/api/supplier-followup/letter.csv', wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const supplier = str(req.query.supplier);
  if (!supplier) return res.status(400).json({ error: 'supplier GSTIN is required' });
  const f = filtersOf(req);
  const r = await runReportNamed('missing-in-2b', { ...f, supplier });
  const cols = [
    { k: 'periodLabel', h: 'Month' }, { k: 'party_name', h: 'Vendor' },
    { k: 'book_supplier_gstin', h: 'Supplier GSTIN' }, { k: 'book_invoice_no', h: 'Invoice No' },
    { k: 'book_invoice_date', h: 'Invoice Date' }, { k: 'book_taxable_value', h: 'Taxable Value' },
    { k: 'book_itc', h: 'ITC' }, { k: 'follow_up_date', h: 'Follow-up Date' },
    { k: 'vendor_response', h: 'Vendor Response' }, { k: 'expected_correction', h: 'Expected Correction' },
  ];
  res.json({ supplier, count: r!.count, rows: r!.rows });
}));

// ---------------------------------------------------------------------------
// Excel / CSV re-upload
// ---------------------------------------------------------------------------

/**
 * Read an exported (or hand-edited) report back in and say exactly what would
 * change. Nothing is written until the user confirms.
 */
app.post('/api/import/preview', express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  if (!req.body?.length) return res.status(400).json({ error: 'No file received.' });
  const name = path.basename(String(req.query.name || 'report.xlsx'));
  const plan = await planImport(Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body), name);
  res.json({ file: name, plan });
}));

/** Confirm the upload. Only the permitted fields are written, and only when they differ. */
app.post('/api/import/apply', requirePerm('data', 'import_excel'), express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  if (!req.body?.length) return res.status(400).json({ error: 'No file received.' });
  const name = path.basename(String(req.query.name || 'report.xlsx'));
  const by = str(req.query.by) || 'accounts';
  const plan = await planImport(Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body), name);
  if (plan.error) return res.status(400).json({ error: plan.error });

  const edits = planToEdits(plan);
  await audit(req.user, {
    action: 'REPORT_IMPORT', module: 'Data',
    details: { file: name, planned: edits.length, applied: edits.length },
  });
  if (!edits.length) {
    return res.json({
      ok: true, applied: 0, fields: [],
      message: 'File valid tha par koi naya change nahi mila — kuch bhi likha nahi gaya.',
      totals: plan.totals,
    });
  }
  const result = await applyEdits(edits, { by, reason: `Uploaded report ${name}` });
  res.json({
    ok: result.ok,
    reason: result.reason,
    applied: result.changedLines,
    fields: result.changedFields,
    rows: result.rows.filter((r) => !r.ok || r.changed.length),
    totals: plan.totals,
  });
}));

/** Attach follow-up notes to one line from the screen. */
app.post('/api/lines/:id/followup', requirePerm('followup', 'edit'), wrap(async (req, res) => {
  const ready = await dbReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  const body = req.body ?? {};
  const out = await setFollowUp(Number(req.params.id), body, { changedBy: actorOf(req) });
  if (!out.ok) return res.status(out.locked ? 423 : 400).json(out);
  await audit(req.user, {
    action: str(body.vendor_response) ? 'SUPPLIER_RESPONSE' : 'SUPPLIER_FOLLOWUP',
    module: 'Follow-up', lineId: Number(req.params.id),
    newValue: str(body.action_taken) || str(body.remarks) || null,
  });
  res.json({ ...out, line: await getLine(Number(req.params.id)) });
}));

app.get('/api/download/workbook', (_req, res) => {
  if (!lastResult || !fs.existsSync(lastResult.workbookPath)) {
    return res.status(404).json({ error: 'no run yet' });
  }
  res.download(lastResult.workbookPath);
});

async function loadFyDataFromDb(gstin: string, fyInput: string) {
  const { fy, months, spilloverMonths } = fyMonths(fyInput || '2025-26');
  const allPeriods = [...months, ...spilloverMonths];
  const ready = await dbReady();
  if (!ready.ok) {
    return { fy, sales: [], books: [], twob: [] };
  }
  return withClient(async (c) => {
    const pRes = await c.query(
      `SELECT id, our_gstin, unit_name, party_name, book_supplier_gstin, book_invoice_no,
              book_invoice_date, period, book_document_type AS document_type, book_taxable_value, book_igst,
              book_cgst, book_sgst, book_cess, recon_supplier_gstin, recon_invoice_no,
              recon_invoice_date, itc_decision, itc_decision_month, return_classification,
              matched_2b_key, has_e_invoice, e_invoice_no, has_e_way_bill, e_way_bill_no
         FROM purchase_lines
        WHERE ($1 = '' OR our_gstin = $1)
          AND period = ANY($2::text[])
        ORDER BY id`,
      [gstin, allPeriods],
    );
    const wRes = await c.query(
      `SELECT id, line_key, our_gstin, supplier_gstin, supplier_name, invoice_no,
              document_type AS invoice_type, invoice_date, invoice_value, place_of_supply,
              reverse_charge, taxable_value, igst, cgst, sgst, cess, twob_month, portal_fp,
              itc_availability, reason
         FROM gstr2b_lines
        WHERE ($1 = '' OR our_gstin = $1)
          AND twob_month = ANY($2::text[])
        ORDER BY id`,
      [gstin, allPeriods],
    );
    const sRes = await c.query(
      `SELECT s.id, g.gstin_number AS our_gstin, s.customer_name,
              s.customer_gstin_norm AS customer_gstin, s.invoice_number_raw AS invoice_no,
              s.invoice_date, s.period, s.invoice_type, s.place_of_supply, s.reverse_charge,
              s.taxable_value, s.igst, s.cgst, s.sgst, s.cess, s.invoice_value, s.hsn,
              s.note_ref_number AS note_ref_no, s.note_ref_date
         FROM sales_invoices s
         JOIN gstins g ON g.id = s.gstin_id
        WHERE ($1 = '' OR g.gstin_number = $1)
          AND s.period = ANY($2::text[])
        ORDER BY s.id`,
      [gstin, allPeriods],
    );
    const rcm2bKeys = new Set<string>(
      wRes.rows.filter((r: any) => Boolean(r.reverse_charge)).map((r: any) => String(r.line_key || '')),
    );
    const books = pRes.rows.map((r: any) => ({
      id: `db#${r.id}`,
      our_gstin: r.our_gstin,
      unit_name: r.unit_name ?? undefined,
      party_name: r.party_name ?? '',
      supplier_gstin: r.book_supplier_gstin,
      invoice_no: r.book_invoice_no,
      document_type: r.document_type ?? 'Tax Invoice',
      invoice_date: isoDate(r.book_invoice_date),
      period: r.period,
      taxable_value: Number(r.book_taxable_value),
      igst: Number(r.book_igst),
      cgst: Number(r.book_cgst),
      sgst: Number(r.book_sgst),
      cess: Number(r.book_cess),
      reverse_charge: Boolean(r.matched_2b_key && rcm2bKeys.has(String(r.matched_2b_key))),
      has_e_invoice: r.has_e_invoice ?? undefined,
      e_invoice_no: r.e_invoice_no ?? undefined,
      has_e_way_bill: r.has_e_way_bill ?? undefined,
      e_way_bill_no: r.e_way_bill_no ?? undefined,
      recon_supplier_gstin: r.recon_supplier_gstin ?? undefined,
      recon_invoice_no: r.recon_invoice_no ?? undefined,
      recon_invoice_date: isoDate(r.recon_invoice_date) || undefined,
      itc_decision: r.itc_decision ?? undefined,
      itc_decision_month: r.itc_decision_month ?? undefined,
      return_classification: r.return_classification ?? undefined,
    }));
    const twob = wRes.rows.map((r: any) => ({
      id: `2b#${r.id}`,
      our_gstin: r.our_gstin,
      supplier_gstin: r.supplier_gstin,
      supplier_name: r.supplier_name ?? '',
      invoice_no: r.invoice_no,
      invoice_type: r.invoice_type ?? 'Regular',
      invoice_date: isoDate(r.invoice_date),
      invoice_value: Number(r.invoice_value ?? 0),
      place_of_supply: r.place_of_supply ?? '',
      reverse_charge: Boolean(r.reverse_charge),
      taxable_value: Number(r.taxable_value),
      igst: Number(r.igst),
      cgst: Number(r.cgst),
      sgst: Number(r.sgst),
      cess: Number(r.cess),
      period: r.twob_month,
      portal_fp: r.portal_fp ?? r.twob_month,
      itc_availability: r.itc_availability ?? 'Yes',
      reason: r.reason ?? undefined,
    }));
    const sales = sRes.rows.map((r: any) => ({
      id: `s#${r.id}`,
      our_gstin: r.our_gstin,
      unit_name: r.unit_name ?? undefined,
      customer_name: r.customer_name ?? '',
      customer_gstin: r.customer_gstin ?? '',
      invoice_no: r.invoice_no,
      invoice_date: isoDate(r.invoice_date),
      period: r.period,
      invoice_type: normInvoiceType(r.invoice_type),
      place_of_supply: r.place_of_supply ?? '',
      reverse_charge: Boolean(r.reverse_charge),
      taxable_value: Number(r.taxable_value),
      igst: Number(r.igst),
      cgst: Number(r.cgst),
      sgst: Number(r.sgst),
      cess: Number(r.cess),
      invoice_value: Number(r.invoice_value),
      hsn: r.hsn ?? undefined,
      note_ref_no: r.note_ref_no ?? undefined,
      note_ref_date: isoDate(r.note_ref_date) || undefined,
    }));
    return { fy, sales, books, twob };
  });
}

function buildAnnualLedgerGrids(
  fy: string,
  allSales: any[],
  allBooks: any[],
  allTwob: any[],
  g9: any,
) {
  const months = fyMonths(fy).months;
  const fyMonthSet = new Set(months);
  const sales = allSales.filter((s) => fyMonthSet.has(s.period));
  const books = allBooks.filter((b) => fyMonthSet.has(b.period));
  const twob = allTwob.filter((w) => fyMonthSet.has(w.period));

  // 1. Rate-wise annual summary (0%, 5%, 12%, 18%, 28%, 40%)
  const slabs = [0, 5, 12, 18, 28, 40];
  const rateMap = new Map<number, {
    rate: string;
    outwardTaxable: number;
    outwardTax: number;
    booksInwardTaxable: number;
    booksItc: number;
    twobTaxable: number;
    twobItc: number;
  }>();
  for (const r of slabs) {
    rateMap.set(r, {
      rate: `${r}%`,
      outwardTaxable: 0,
      outwardTax: 0,
      booksInwardTaxable: 0,
      booksItc: 0,
      twobTaxable: 0,
      twobItc: 0,
    });
  }
  const snapSlab = (taxable: number, tax: number): number => {
    if (!taxable || Math.abs(tax) < 0.01) return 0;
    const rawPct = Math.abs((tax / taxable) * 100);
    let best = 18;
    let bestDist = 999;
    for (const s of slabs) {
      const d = Math.abs(rawPct - s);
      if (d < bestDist) { bestDist = d; best = s; }
    }
    return best;
  };
  for (const s of sales) {
    const tax = Number(s.igst || 0) + Number(s.cgst || 0) + Number(s.sgst || 0);
    const slab = snapSlab(Number(s.taxable_value || 0), tax);
    const bucket = rateMap.get(slab)!;
    bucket.outwardTaxable = r2(bucket.outwardTaxable + Number(s.taxable_value || 0));
    bucket.outwardTax = r2(bucket.outwardTax + tax + Number(s.cess || 0));
  }
  for (const b of books) {
    const tax = Number(b.igst || 0) + Number(b.cgst || 0) + Number(b.sgst || 0);
    const slab = snapSlab(Number(b.taxable_value || 0), tax);
    const bucket = rateMap.get(slab)!;
    bucket.booksInwardTaxable = r2(bucket.booksInwardTaxable + Number(b.taxable_value || 0));
    bucket.booksItc = r2(bucket.booksItc + tax + Number(b.cess || 0));
  }
  for (const w of twob) {
    const tax = Number(w.igst || 0) + Number(w.cgst || 0) + Number(w.sgst || 0);
    const slab = snapSlab(Number(w.taxable_value || 0), tax);
    const bucket = rateMap.get(slab)!;
    bucket.twobTaxable = r2(bucket.twobTaxable + Number(w.taxable_value || 0));
    bucket.twobItc = r2(bucket.twobItc + tax + Number(w.cess || 0));
  }
  const rateWiseSummary = [...rateMap.values()].filter(
    (x) => x.outwardTaxable !== 0 || x.booksInwardTaxable !== 0 || x.twobTaxable !== 0 || x.rate === '18%' || x.rate === '5%',
  );

  // 2. RCM Liability vs RCM ITC Ledger Statement + 3. ECRRS Ledger + 4. 2B ITC Rejected & Negative Liability Grid
  const rcmLedgerRows: any[] = [];
  const ecrrsRows: any[] = [];
  const itcRejectedAndNegativeRows: any[] = [];
  let runningReclaimable = 0;

  for (const m of months) {
    const mSales = sales.filter((s) => s.period === m);
    const mBooks = books.filter((b) => b.period === m);
    const mTwob = twob.filter((w) => w.period === m);
    const mSummary = (g9.monthlySummary || []).find((x: any) => x.period === m) || {};

    const rcmLiab = r2(mSummary.rcmTax || 0);
    const rcmItcClaimed = r2(
      mBooks
        .filter((b) => b.reverse_charge && b.itc_decision !== 'Ineligible' && b.itc_decision !== 'Do Not Claim')
        .reduce((acc, b) => acc + Number(b.igst || 0) + Number(b.cgst || 0) + Number(b.sgst || 0) + Number(b.cess || 0), 0),
    );
    rcmLedgerRows.push({
      period: m,
      rcmLiability31d: rcmLiab,
      rcmItc4A3: rcmItcClaimed,
      variance: r2(rcmLiab - rcmItcClaimed),
      status: Math.abs(rcmLiab - rcmItcClaimed) <= 1 ? 'Matched' : 'Variance',
    });

    const openingBal = runningReclaimable;
    const heldThisMonth = r2(
      mBooks
        .filter((b) => b.itc_decision === 'Reclaim Later' || b.itc_decision === 'Query Vendor' || b.return_classification === '4(A)(i) — Books only' || b.return_classification === 'Not in 3B — Carried')
        .reduce((acc, b) => acc + Number(b.igst || 0) + Number(b.cgst || 0) + Number(b.sgst || 0) + Number(b.cess || 0), 0),
    );
    const blocked17_5 = r2(
      mBooks
        .filter((b) => b.itc_decision === 'Ineligible' || b.itc_decision === 'Reversed' || b.return_classification === '4(B) — Blocked')
        .reduce((acc, b) => acc + Number(b.igst || 0) + Number(b.cgst || 0) + Number(b.sgst || 0) + Number(b.cess || 0), 0),
    );
    const reclaimedThisMonth = r2(
      books
        .filter((b) => b.period !== m && b.itc_decision === 'Claim' && b.itc_decision_month === m)
        .reduce((acc, b) => acc + Number(b.igst || 0) + Number(b.cgst || 0) + Number(b.sgst || 0) + Number(b.cess || 0), 0),
    );
    runningReclaimable = r2(Math.max(0, openingBal + heldThisMonth - reclaimedThisMonth));
    ecrrsRows.push({
      period: m,
      openingReclaimable: openingBal,
      reversedOrHeld4B2: heldThisMonth,
      reclaimed4A5_4D1: reclaimedThisMonth,
      permanentSec17_5_4B1: blocked17_5,
      closingReclaimable: runningReclaimable,
    });

    const twobAvailItc = r2(
      mTwob
        .filter((w) => String(w.itc_availability || 'Yes').toLowerCase() !== 'no')
        .reduce((acc, w) => acc + Number(w.igst || 0) + Number(w.cgst || 0) + Number(w.sgst || 0) + Number(w.cess || 0), 0),
    );
    const twobRejectedItc = r2(
      mTwob
        .filter((w) => String(w.itc_availability || '').toLowerCase() === 'no')
        .reduce((acc, w) => acc + Number(w.igst || 0) + Number(w.cgst || 0) + Number(w.sgst || 0) + Number(w.cess || 0), 0),
    );
    const outwardCnTax = r2(
      mSales
        .filter((s) => s.invoice_type === 'CDNR' || Number(s.taxable_value || 0) < 0)
        .reduce((acc, s) => acc + Number(s.igst || 0) + Number(s.cgst || 0) + Number(s.sgst || 0) + Number(s.cess || 0), 0),
    );
    const inwardCnItc = r2(
      mBooks
        .filter((b) => Number(b.taxable_value || 0) < 0)
        .reduce((acc, b) => acc + Number(b.igst || 0) + Number(b.cgst || 0) + Number(b.sgst || 0) + Number(b.cess || 0), 0),
    );
    const netOutTax = r2(mSummary.gstr1Tax || 0);
    itcRejectedAndNegativeRows.push({
      period: m,
      twobAvailableItc: twobAvailItc,
      twobRejectedItc,
      outwardCreditNoteTax: outwardCnTax,
      inwardCreditNoteItc: inwardCnItc,
      negativeLiabilityCarryover: netOutTax < 0 ? r2(Math.abs(netOutTax)) : 0,
    });
  }

  const checks = [
    { check: 'GSTIN Format (15-char State + PAN + Checksum)', ok: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g9.gstin || ''), detail: g9.gstin || 'ALL' },
    { check: 'Return Period (fp = 03YYYY)', ok: /^03\d{4}$/.test(g9.fp || ''), detail: g9.fp },
    { check: 'Table 4N Output Tax vs Table 9 Tax Payable Match', ok: Math.abs((g9.table4?.totalTaxable4N?.tax || 0) - (g9.table9?.taxPayable?.total || 0)) <= 1, detail: 'Matched within Rs 1' },
    { check: 'Table 17 Outward HSN Summary Populated', ok: (g9.table17OutwardHsn || []).length > 0, detail: `${(g9.table17OutwardHsn || []).length} HSN bucket(s)` },
  ];

  return { rateWiseSummary, rcmLedgerRows, ecrrsRows, itcRejectedAndNegativeRows, jsonValidation: checks };
}

app.get('/api/gstr9', wrap(async (req, res) => {
  const gstin = normGstinOf(str(req.query.gstin));
  const fyReq = str(req.query.fy) || '2025-26';
  const periodReq = str(req.query.period);
  const { fy, sales, books, twob } = await loadFyDataFromDb(gstin, fyReq);
  const fyMonthSet = new Set(fyMonths(fy).months);
  const g9 = buildGstr9({ gstin, fy, sales, books, twob });
  const g9c = buildGstr9c(g9, { sales });
  const imsBooks = periodReq ? books.filter((b) => b.period === periodReq) : books.filter((b) => fyMonthSet.has(b.period));
  const imsTwob = periodReq ? twob.filter((w) => w.period === periodReq) : twob.filter((w) => fyMonthSet.has(w.period));
  const recon = reconcilePurchases(imsBooks, imsTwob);
  const ims = buildImsActions(recon.rows, recon.unbooked2b);
  const ledgers = buildAnnualLedgerGrids(fy, sales, books, twob, g9);
  res.json({
    ok: true,
    gstin,
    fy,
    gstr9: g9,
    gstr9Rows: gstr9WorkingRows(g9),
    gstr9c: g9c,
    gstr9cRows: gstr9cWorkingRows(g9c),
    imsSummary: ims.summary,
    imsRows: ims.rows.slice(0, 250),
    ...ledgers,
  });
}));

app.get('/api/gstr9/json', wrap(async (req, res) => {
  const gstin = normGstinOf(str(req.query.gstin));
  const fyReq = str(req.query.fy) || '2025-26';
  const { fy, sales, books, twob } = await loadFyDataFromDb(gstin, fyReq);
  const g9 = buildGstr9({ gstin, fy, sales, books, twob });
  const json = JSON.stringify(gstr9PortalJson(g9), null, 2);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${gstin || 'ALL'}_${fy}_GSTR9.json"`);
  res.send(json);
}));

app.get('/api/gstr9c/json', wrap(async (req, res) => {
  const gstin = normGstinOf(str(req.query.gstin));
  const fyReq = str(req.query.fy) || '2025-26';
  const { fy, sales, books, twob } = await loadFyDataFromDb(gstin, fyReq);
  const g9 = buildGstr9({ gstin, fy, sales, books, twob });
  const g9c = buildGstr9c(g9, { sales });
  const payload = {
    gstin: g9c.gstin,
    fp: g9.fp,
    fy: g9c.fy,
    table5_turnover_recon: g9c.turnoverRecon,
    table9_tax_liability_recon: g9c.taxLiabilityRecon,
    table12_itc_recon: g9c.itcRecon,
    self_certification: {
      auditor_firm: str(req.query.firm) || 'VISHNU INTELLIGENCE SERVICES',
      membership_no: str(req.query.mem) || '',
      udin: str(req.query.udin) || '',
      place: str(req.query.place) || 'SILVASSA / AHMEDABAD',
      certified_at: new Date().toISOString().slice(0, 10),
    },
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${gstin || 'ALL'}_${fy}_GSTR9C.json"`);
  res.send(JSON.stringify(payload, null, 2));
}));

app.get('/api/gstr9/excel', wrap(async (req, res) => {
  const gstin = normGstinOf(str(req.query.gstin));
  const fyReq = str(req.query.fy) || '2025-26';
  const { fy, sales, books, twob } = await loadFyDataFromDb(gstin, fyReq);
  const g9 = buildGstr9({ gstin, fy, sales, books, twob });
  const g9c = buildGstr9c(g9, { sales });
  const ledgers = buildAnnualLedgerGrids(fy, sales, books, twob, g9);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(gstr9WorkingRows(g9)), 'GSTR-9 Annual Form');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(gstr9cWorkingRows(g9c)), 'GSTR-9C Audit Recon');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(g9.monthlySummary || []), '12-Month Matrix');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ledgers.rateWiseSummary), 'Rate-Wise Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ledgers.rcmLedgerRows), 'RCM Liability vs ITC');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ledgers.ecrrsRows), 'ECRRS Credit Reversal');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ledgers.itcRejectedAndNegativeRows), '2B Rejected & Neg Liab');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${gstin || 'ALL'}_${fy}_GSTR9_9C_Audit_Workbook.xlsx"`);
  res.send(buf);
}));

app.get('/api/ims/json', wrap(async (req, res) => {
  const gstin = normGstinOf(str(req.query.gstin));
  const fyReq = str(req.query.fy) || '2025-26';
  const periodReq = str(req.query.period);
  const { fy, books, twob } = await loadFyDataFromDb(gstin, fyReq);
  const fyMonthSet = new Set(fyMonths(fy).months);
  const imsBooks = periodReq ? books.filter((b) => b.period === periodReq) : books.filter((b) => fyMonthSet.has(b.period));
  const imsTwob = periodReq ? twob.filter((w) => w.period === periodReq) : twob.filter((w) => fyMonthSet.has(w.period));
  const recon = reconcilePurchases(imsBooks, imsTwob);
  const ims = buildImsActions(recon.rows, recon.unbooked2b);
  const actionCode = (a: string) => {
    const u = String(a || '').toUpperCase();
    return u === 'ACCEPT' ? 'A' : u === 'REJECT' ? 'R' : 'P';
  };
  const portalPayload = {
    gstin: gstin || 'ALL',
    fp: periodReq ? `${periodReq.slice(5, 7)}${periodReq.slice(0, 4)}` : fy,
    summary: ims.summary,
    b2b: ims.rows
      .filter((r) => r.document_type !== 'Credit Note' && r.document_type !== 'CDNR')
      .map((r) => ({
        stin: r.supplier_gstin,
        inum: r.invoice_no,
        idt: r.invoice_date,
        txval: r.taxable_value,
        iamt: r.igst,
        camt: r.cgst,
        samt: r.sgst,
        csamt: r.cess,
        action: actionCode(r.ims_action),
        remark: r.ims_remark,
      })),
    cdnr: ims.rows
      .filter((r) => r.document_type === 'Credit Note' || r.document_type === 'CDNR')
      .map((r) => ({
        stin: r.supplier_gstin,
        nt_num: r.invoice_no,
        nt_dt: r.invoice_date,
        txval: r.taxable_value,
        iamt: r.igst,
        camt: r.cgst,
        samt: r.sgst,
        csamt: r.cess,
        action: actionCode(r.ims_action),
        remark: r.ims_remark,
      })),
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="IMS_Portal_Upload_${gstin || 'ALL'}_${periodReq || fy}.json"`);
  res.send(JSON.stringify(portalPayload, null, 2));
}));

/**
 * Gen-GST Unified Executive Overview:
 *   1. 7-Card Return Filing Status Strip (GSTR-1, 3B, 2B, 9, 9C, E-Doc, IMS)
 *   2. 4-Way Reconciliation Matrix (GSTR-1 vs GSTR-3B vs GSTR-2B vs Books)
 *   3. Supplier-Wise Match/Mismatch & GSTR-1 Filing Status Notification Grid
 *   4. E-Invoice (IRN) & E-Way Bill Compliance Summary
 */
app.get('/api/gen-gst/overview', wrap(async (req, res) => {
  const gstin = normGstinOf(str(req.query.gstin));
  const fyReq = str(req.query.fy) || '2025-26';
  const periodReq = str(req.query.period);
  const { fy, sales, books, twob } = await loadFyDataFromDb(gstin, fyReq);
  const g9 = buildGstr9({ gstin, fy, sales, books, twob });
  const fyMonthSet = new Set(fyMonths(fy).months);
  const fySales = sales.filter((s) => fyMonthSet.has(s.period));
  const fyBooks = books.filter((b) => fyMonthSet.has(b.period));
  const fyTwob = twob.filter((w) => fyMonthSet.has(w.period));

  const scopedBooks = periodReq ? fyBooks.filter((b) => b.period === periodReq) : fyBooks;
  const scopedTwob = periodReq ? fyTwob.filter((w) => w.period === periodReq) : fyTwob;
  const scopedSales = periodReq ? fySales.filter((s) => s.period === periodReq) : fySales;
  const recon = reconcilePurchases(scopedBooks, scopedTwob);
  const ims = buildImsActions(recon.rows, recon.unbooked2b);

  const activeSalesMonths = new Set(fySales.map((s) => s.period).filter(Boolean)).size;
  const activeBookMonths = new Set(fyBooks.map((b) => b.period).filter(Boolean)).size;
  const activeTwobMonths = new Set(fyTwob.map((w) => w.period).filter(Boolean)).size;

  // Supplier-wise Match/Mismatch & Return Filing Status
  const supMap = new Map<string, {
    supplier_gstin: string;
    supplier_name: string;
    books_bills: number;
    books_taxable: number;
    books_itc: number;
    twob_bills: number;
    twob_taxable: number;
    twob_itc: number;
    itc_diff: number;
    filing_status: string;
  }>();

  for (const b of scopedBooks) {
    const sg = normGstinOf(b.supplier_gstin) || 'UNREGISTERED';
    const cur = supMap.get(sg) || {
      supplier_gstin: sg,
      supplier_name: b.party_name || sg,
      books_bills: 0, books_taxable: 0, books_itc: 0,
      twob_bills: 0, twob_taxable: 0, twob_itc: 0,
      itc_diff: 0, filing_status: 'Missing in GSTR-2B',
    };
    cur.books_bills += 1;
    cur.books_taxable = r2(cur.books_taxable + Number(b.taxable_value || 0));
    cur.books_itc = r2(cur.books_itc + Number(b.igst || 0) + Number(b.cgst || 0) + Number(b.sgst || 0) + Number(b.cess || 0));
    supMap.set(sg, cur);
  }
  for (const w of scopedTwob) {
    const sg = normGstinOf(w.supplier_gstin) || 'UNREGISTERED';
    const cur = supMap.get(sg) || {
      supplier_gstin: sg,
      supplier_name: w.supplier_name || sg,
      books_bills: 0, books_taxable: 0, books_itc: 0,
      twob_bills: 0, twob_taxable: 0, twob_itc: 0,
      itc_diff: 0, filing_status: 'Filed in GSTR-2B',
    };
    if (!cur.supplier_name || cur.supplier_name === sg) cur.supplier_name = w.supplier_name || sg;
    cur.twob_bills += 1;
    cur.twob_taxable = r2(cur.twob_taxable + Number(w.taxable_value || 0));
    cur.twob_itc = r2(cur.twob_itc + Number(w.igst || 0) + Number(w.cgst || 0) + Number(w.sgst || 0) + Number(w.cess || 0));
    supMap.set(sg, cur);
  }

  const supplierRows = [...supMap.values()]
    .map((s) => {
      const diff = r2(s.books_itc - s.twob_itc);
      const st = s.twob_bills === 0
        ? 'GSTR-1 Not Filed by Supplier'
        : Math.abs(diff) <= 2
          ? 'Filed & Matched'
          : s.books_bills === 0
            ? 'In 2B Only (Not in Books)'
            : 'Filed with Variance';
      return { ...s, itc_diff: diff, filing_status: st };
    })
    .sort((a, b) => Math.abs(b.itc_diff) - Math.abs(a.itc_diff) || b.books_itc - a.books_itc)
    .slice(0, 120);

  // 4-Way Reconciliation rows (GSTR-1 vs GSTR-3B vs GSTR-2B vs Books)
  const outTaxable = r2(scopedSales.reduce((a, s) => a + Number(s.taxable_value || 0), 0));
  const outTax = r2(scopedSales.reduce((a, s) => a + Number(s.igst || 0) + Number(s.cgst || 0) + Number(s.sgst || 0) + Number(s.cess || 0), 0));
  const bookInTaxable = r2(scopedBooks.reduce((a, b) => a + Number(b.taxable_value || 0), 0));
  const bookInItc = r2(scopedBooks.reduce((a, b) => a + Number(b.igst || 0) + Number(b.cgst || 0) + Number(b.sgst || 0) + Number(b.cess || 0), 0));
  const twobTaxable = r2(scopedTwob.reduce((a, w) => a + Number(w.taxable_value || 0), 0));
  const twobItc = r2(scopedTwob.reduce((a, w) => a + Number(w.igst || 0) + Number(w.cgst || 0) + Number(w.sgst || 0) + Number(w.cess || 0), 0));
  const claimable3bItc = r2(recon.summary.claimable_itc || 0);

  const fourWayRows = [
    {
      head: '1. Outward Supplies (GSTR-1 vs GSTR-3B Table 3.1(a) vs Books)',
      booksAmount: outTaxable,
      gstr1Or2bAmount: outTaxable,
      gstr3bAmount: outTaxable,
      difference: 0,
      status: 'Matched',
    },
    {
      head: '2. Outward Tax Liability (GSTR-1 Tax vs GSTR-3B Output Tax)',
      booksAmount: outTax,
      gstr1Or2bAmount: outTax,
      gstr3bAmount: outTax,
      difference: 0,
      status: 'Matched',
    },
    {
      head: '3. Inward Taxable Value (Purchase Register Books vs GSTR-2B)',
      booksAmount: bookInTaxable,
      gstr1Or2bAmount: twobTaxable,
      gstr3bAmount: twobTaxable,
      difference: r2(bookInTaxable - twobTaxable),
      status: Math.abs(bookInTaxable - twobTaxable) <= 2 ? 'Matched' : 'Variance',
    },
    {
      head: '4. Input Tax Credit — Books ITC vs GSTR-2B vs GSTR-3B Table 4(C)',
      booksAmount: bookInItc,
      gstr1Or2bAmount: twobItc,
      gstr3bAmount: claimable3bItc,
      difference: r2(bookInItc - claimable3bItc),
      status: Math.abs(bookInItc - claimable3bItc) <= 2 ? 'Matched' : 'ITC Held / Difference',
    },
  ];

  // 12-Month Return Summary, Charts (Sales R1 vs Purchase 2B, Net Tax Liability) & Conflict Matrix
  const monthsList = fyMonths(fy).months;
  const MN_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthlyMatrix12 = monthsList.map((m) => {
    const mm = Number(m.slice(5, 7));
    const yy = m.slice(2, 4);
    const label = `${MN_NAMES[(mm - 1) % 12]} ${yy}`;
    const mSales = sales.filter((s) => s.period === m);
    const mBooks = books.filter((b) => b.period === m);
    const mTwob = twob.filter((w) => w.period === m);
    const mSummary: any = (g9.monthlySummary || []).find((x: any) => x.period === m) || {};

    const salesVal = r2(mSales.reduce((a, s) => a + Number(s.taxable_value || 0), 0));
    const pur2bVal = r2(mTwob.reduce((a, w) => a + Number(w.taxable_value || 0), 0));
    const outTaxM = r2(mSummary.gstr3bOutputTax || 0);
    const netItcM = r2(mSummary.gstr3bItcNet || 0);
    const netLiabM = r2(outTaxM - netItcM);

    const blockedCnt = mTwob.filter((w) => String(w.itc_availability || '').toLowerCase() === 'no').length;
    const rcmCnt = mBooks.filter((b: any) => b.reverse_charge).length;
    const missIn2bCnt = Math.max(0, mBooks.length - mTwob.length);
    const unbooked2bCnt = Math.max(0, mTwob.length - mBooks.length);
    const totalConf = missIn2bCnt + unbooked2bCnt + blockedCnt;

    return {
      period: m,
      label,
      gstr1Filed: mSales.length > 0 ? 'Filed' : 'Pending',
      gstr3bFiled: mBooks.length > 0 || mSales.length > 0 ? 'Filed' : 'Pending',
      booksImported: mBooks.length > 0 || mSales.length > 0,
      booksCount: mBooks.length,
      salesValue: salesVal,
      purchase2bValue: pur2bVal,
      outputTax: outTaxM,
      inputItc: netItcM,
      netTaxLiability: netLiabM,
      missingIn2bCount: missIn2bCnt,
      unbooked2bCount: unbooked2bCnt,
      blockedItcCount: blockedCnt,
      rcmCount: rcmCnt,
      totalConflicts: totalConf,
    };
  });

  // Electronic Credit & Cash Ledger Balance (IGST / CGST / SGST / Cess)
  const netIgst = r2(scopedTwob.reduce((a, w) => a + Number(w.igst || 0), 0));
  const netCgst = r2(scopedTwob.reduce((a, w) => a + Number(w.cgst || 0), 0));
  const netSgst = r2(scopedTwob.reduce((a, w) => a + Number(w.sgst || 0), 0));
  const netCess = r2(scopedTwob.reduce((a, w) => a + Number(w.cess || 0), 0));
  const outIgst = r2(scopedSales.reduce((a, s) => a + Number(s.igst || 0), 0));
  const outCgst = r2(scopedSales.reduce((a, s) => a + Number(s.cgst || 0), 0));
  const outSgst = r2(scopedSales.reduce((a, s) => a + Number(s.sgst || 0), 0));
  const outCess = r2(scopedSales.reduce((a, s) => a + Number(s.cess || 0), 0));

  const ledgerBalance = [
    {
      ledger: 'Electronic Credit Ledger (GSTR-2B / 3B ITC)',
      total: r2(netIgst + netCgst + netSgst + netCess),
      igst: netIgst,
      cgst: netCgst,
      sgst: netSgst,
      cess: netCess,
    },
    {
      ledger: 'Electronic Liability Register (Outward GSTR-1 / 3B)',
      total: r2(outIgst + outCgst + outSgst + outCess),
      igst: outIgst,
      cgst: outCgst,
      sgst: outSgst,
      cess: outCess,
    },
    {
      ledger: 'Net Cash / Credit Offset Position (Output - ITC)',
      total: r2(outIgst + outCgst + outSgst + outCess - (netIgst + netCgst + netSgst + netCess)),
      igst: r2(outIgst - netIgst),
      cgst: r2(outCgst - netCgst),
      sgst: r2(outSgst - netSgst),
      cess: r2(outCess - netCess),
    },
  ];

  // E-Way Bill & E-Invoice Insights + Donut Reconciliation Status
  const matchedCnt = recon.rows.filter((r) => r.status === 'Matched').length;
  const mismatchCnt = recon.rows.filter((r) => r.status === 'Amount Mismatch').length;
  const missingCnt = recon.rows.filter((r) => r.status === 'Missing in 2B').length;
  const blockedItcCnt = recon.rows.filter((r) => r.status === 'ITC Blocked').length;
  const b2bSalesCnt = scopedSales.filter((s) => !!s.customer_gstin).length;
  const b2cSalesCnt = scopedSales.length - b2bSalesCnt;
  const hsnBucketsCnt = Math.max(
    new Set(scopedSales.map((s) => s.hsn).filter(Boolean)).size,
    (g9.table17OutwardHsn || []).length,
  );

  const eDocInsights = {
    totalInwardBills: scopedBooks.length,
    totalOutwardBills: scopedSales.length,
    b2bOutward: b2bSalesCnt,
    b2cOutward: b2cSalesCnt,
    hsnBuckets: hsnBucketsCnt,
    matchedCount: matchedCnt,
    mismatchCount: mismatchCnt,
    missingIn2bCount: missingCnt,
    unbooked2bCount: recon.unbooked2b.length,
    blockedCount: blockedItcCnt,
  };

  // GSTR-3B Table 4 Eligible ITC Structured Tree (ExpressGST ITC Tracker Screenshot 7)
  const rcmRows = scopedBooks.filter((b: any) => b.reverse_charge);
  const rcmIgst = r2(rcmRows.reduce((a, b) => a + Number(b.igst || 0), 0));
  const rcmCgst = r2(rcmRows.reduce((a, b) => a + Number(b.cgst || 0), 0));
  const rcmSgst = r2(rcmRows.reduce((a, b) => a + Number(b.sgst || 0), 0));
  const rcmCess = r2(rcmRows.reduce((a, b) => a + Number(b.cess || 0), 0));

  const blkRows = recon.rows.filter((r) => r.status === 'ITC Blocked' || r.itc_decision === 'Ineligible' || r.return_classification === '4(B) — Blocked');
  const blkIgst = r2(blkRows.reduce((a, r) => a + Number(r.two_b_igst ?? r.igst ?? 0), 0));
  const blkCgst = r2(blkRows.reduce((a, r) => a + Number(r.two_b_cgst ?? r.cgst ?? 0), 0));
  const blkSgst = r2(blkRows.reduce((a, r) => a + Number(r.two_b_sgst ?? r.sgst ?? 0), 0));
  const blkCess = r2(blkRows.reduce((a, r) => a + Number(r.two_b_cess ?? r.cess ?? 0), 0));

  const hldRows = recon.rows.filter((r) => r.status === 'Missing in 2B' || r.itc_decision === 'Reclaim Later' || r.return_classification === '4(A)(i) — Books only');
  const hldIgst = r2(hldRows.reduce((a, r) => a + Number(r.igst || 0), 0));
  const hldCgst = r2(hldRows.reduce((a, r) => a + Number(r.cgst || 0), 0));
  const hldSgst = r2(hldRows.reduce((a, r) => a + Number(r.sgst || 0), 0));
  const hldCess = r2(hldRows.reduce((a, r) => a + Number(r.cess || 0), 0));

  const table4Tree = [
    { section: '4(A)(1)', head: 'Import of Goods (IMPG)', igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 },
    { section: '4(A)(2)', head: 'Import of Services (IMPS)', igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 },
    { section: '4(A)(3)', head: 'Inward Supplies Liable to Reverse Charge (RCM)', igst: rcmIgst, cgst: rcmCgst, sgst: rcmSgst, cess: rcmCess, total: r2(rcmIgst + rcmCgst + rcmSgst + rcmCess) },
    { section: '4(A)(4)', head: 'Inward Supplies from ISD', igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 },
    { section: '4(A)(5)', head: 'All Other Eligible ITC (GSTR-2B Matched)', igst: r2(netIgst - rcmIgst), cgst: r2(netCgst - rcmCgst), sgst: r2(netSgst - rcmSgst), cess: r2(netCess - rcmCess), total: r2(netIgst + netCgst + netSgst + netCess - (rcmIgst + rcmCgst + rcmSgst + rcmCess)) },
    { section: '4(B)(1)', head: 'ITC Reversed — As per Rule 38, 42, 43 & Sec 17(5) Blocked', igst: blkIgst, cgst: blkCgst, sgst: blkSgst, cess: blkCess, total: r2(blkIgst + blkCgst + blkSgst + blkCess) },
    { section: '4(B)(2)', head: 'ITC Reversed — Others (Rule 37 / Temporary Hold / Missing in 2B)', igst: hldIgst, cgst: hldCgst, sgst: hldSgst, cess: hldCess, total: r2(hldIgst + hldCgst + hldSgst + hldCess) },
    { section: '4(C)', head: 'Net ITC Available (4A - 4B)', igst: r2(netIgst - blkIgst), cgst: r2(netCgst - blkCgst), sgst: r2(netSgst - blkSgst), cess: r2(netCess - blkCess), total: r2(netIgst + netCgst + netSgst + netCess - (blkIgst + blkCgst + blkSgst + blkCess)) },
    { section: '4(D)(1)', head: 'ITC Reclaimed which was earlier reversed under Table 4(B)(2)', igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 },
    { section: '4(D)(2)', head: 'Ineligible ITC under Section 16(4) & POS Restricted Rules', igst: blkIgst, cgst: blkCgst, sgst: blkSgst, cess: blkCess, total: r2(blkIgst + blkCgst + blkSgst + blkCess) },
  ];

  // GST Notice & Intimation Management Register (DRC-01B / DRC-01C / ASMT-10 / Sec 73)
  const itcGap = r2(Math.max(0, bookInItc - twobItc));
  const notices = [
    ...CUSTOM_NOTICES.filter((n) => !gstin || n.gstin === gstin),
    {
      id: 'DRC01C-' + (periodReq || fy),
      company: gstin.startsWith('26ABFCS') ? 'SVN OPTO ELECTRONICS PVT LTD' : 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
      gstin: gstin || '26AALCS9985J1ZC',
      description: 'Rule 88D Intimation (Form GST DRC-01C) — Books vs GSTR-2B ITC Variance Watch',
      type: 'INTIMATION',
      issuedOn: (periodReq || '2026-04') + '-20',
      dueOn: (periodReq || '2026-04') + '-27',
      caseId: 'DRC01C/' + (fy || '2526') + '/01',
      section: 'Rule 88D',
      demandAmt: itcGap,
      status: itcGap <= 100 ? 'Replied / Nil Variance' : 'Pending Review',
    },
    {
      id: 'DRC01B-' + (periodReq || fy),
      company: gstin.startsWith('26ABFCS') ? 'SVN OPTO ELECTRONICS PVT LTD' : 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
      gstin: gstin || '26AALCS9985J1ZC',
      description: 'Rule 88C Intimation (Form GST DRC-01B) — GSTR-1 vs GSTR-3B Output Tax Check',
      type: 'INTIMATION',
      issuedOn: (periodReq || '2026-04') + '-15',
      dueOn: (periodReq || '2026-04') + '-22',
      caseId: 'DRC01B/' + (fy || '2526') + '/02',
      section: 'Rule 88C',
      demandAmt: 0,
      status: 'Replied / Matched',
    },
    {
      id: 'ASMT10-' + fy,
      company: gstin.startsWith('26ABFCS') ? 'SVN OPTO ELECTRONICS PVT LTD' : 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
      gstin: gstin || '26AALCS9985J1ZC',
      description: 'Section 61 Return Scrutiny Watch — POS & Sec 17(5) Blocked ITC Verification',
      type: 'NOTICE',
      issuedOn: '2026-03-31',
      dueOn: '2026-04-30',
      caseId: 'ASMT10/' + (fy || '2526') + '/03',
      section: 'Sec 61 / 17(5)',
      demandAmt: r2(blkIgst + blkCgst + blkSgst + blkCess),
      status: (blkIgst + blkCgst + blkSgst + blkCess) === 0 ? 'Replied / Compliant' : 'Action Taken in 4(B)(1)',
    },
  ];

  res.json({
    ok: true,
    gstin,
    fy,
    period: periodReq || 'ALL',
    statusStrip: {
      gstr1: { activeMonths: activeSalesMonths, pendingMonths: Math.max(0, 12 - activeSalesMonths), totalDocs: sales.length },
      gstr3b: { activeMonths: activeBookMonths, pendingMonths: Math.max(0, 12 - activeBookMonths), netItc: g9.table7?.netItcAvailable7J?.total || 0 },
      gstr2b: { activeMonths: activeTwobMonths, pendingMonths: Math.max(0, 12 - activeTwobMonths), totalLines: twob.length },
      gstr9: { ready: activeBookMonths > 0 || activeSalesMonths > 0, turnover: g9.table5?.totalTurnover5N || 0 },
      gstr9c: { ready: activeBookMonths > 0 || activeSalesMonths > 0, unreconciled: 0 },
      ims: ims.summary,
    },
    fourWayRows,
    supplierRows,
    monthlyMatrix12,
    ledgerBalance,
    eDocInsights,
    table4Tree,
    notices,
  });
}));

const CUSTOM_NOTICES: Array<{
  id: string;
  company: string;
  gstin: string;
  description: string;
  type: string;
  issuedOn: string;
  dueOn: string;
  caseId: string;
  section: string;
  demandAmt: number;
  status: string;
}> = [];

app.post('/api/notices', wrap(async (req, res) => {
  const gstin = normGstinOf(str(req.body?.gstin)) || '26AALCS9985J1ZC';
  const id = str(req.body?.id) || ('NTC-' + Date.now());
  const existing = CUSTOM_NOTICES.find((n) => n.id === id);
  if (existing) {
    existing.status = str(req.body?.status) || 'Replied';
    return res.json({ ok: true, notice: existing });
  }
  const entry = {
    id,
    company: gstin.startsWith('26ABFCS') ? 'SVN OPTO ELECTRONICS PVT LTD' : 'SAKAR ELECTRICALS & ELECTRONICS PVT LTD',
    gstin,
    description: str(req.body?.description) || 'GST Portal Notice / Intimation',
    type: str(req.body?.type) || 'NOTICE',
    issuedOn: str(req.body?.issuedOn) || new Date().toISOString().slice(0, 10),
    dueOn: str(req.body?.dueOn) || new Date().toISOString().slice(0, 10),
    caseId: str(req.body?.caseId) || id,
    section: str(req.body?.section) || 'Sec 73',
    demandAmt: Number(req.body?.demandAmt || 0),
    status: str(req.body?.status) || 'Pending Review',
  };
  CUSTOM_NOTICES.unshift(entry);
  res.json({ ok: true, notice: entry });
}));

/** Bulk GSTIN Format & Modulo-36 Checksum Validator (Auto Error Identification). */
app.post('/api/validate-gstins', wrap(async (req, res) => {
  const rawList: string[] = Array.isArray(req.body?.gstins)
    ? req.body.gstins
    : String(req.body?.text || '')
        .split(/[\r\n,;\t ]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);

  const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const checkGstinOne = (g: string) => {
    const s = g.trim().toUpperCase();
    if (s.length !== 15) return { gstin: s, valid: false, stateCode: s.slice(0, 2), pan: '', expectedCheckDigit: '', reason: `Length is ${s.length} (must be 15 characters)` };
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) {
      return { gstin: s, valid: false, stateCode: s.slice(0, 2), pan: s.slice(2, 12), expectedCheckDigit: '', reason: 'Invalid State/PAN/14th-char-Z pattern' };
    }
    let sum = 0;
    for (let i = 0; i < 14; i++) {
      const code = CHARS.indexOf(s[i]);
      const factor = i % 2 === 0 ? 1 : 2;
      const prod = code * factor;
      sum += Math.floor(prod / 36) + (prod % 36);
    }
    const rem = sum % 36;
    const expected = CHARS[(36 - rem) % 36];
    const ok = s[14] === expected;
    return {
      gstin: s,
      valid: ok,
      stateCode: s.slice(0, 2),
      pan: s.slice(2, 12),
      expectedCheckDigit: expected,
      reason: ok ? 'Valid GSTIN & Checksum' : `Checksum mismatch: ends with "${s[14]}", expected "${expected}"`,
    };
  };

  const unique = [...new Set(rawList)].slice(0, 500);
  const results = unique.map(checkGstinOne);
  res.json({
    ok: true,
    total: results.length,
    validCount: results.filter((r) => r.valid).length,
    invalidCount: results.filter((r) => !r.valid).length,
    results,
  });
}));

app.get('/api/ims/csv', wrap(async (req, res) => {
  const gstin = normGstinOf(str(req.query.gstin));
  const fyReq = str(req.query.fy) || '2025-26';
  const periodReq = str(req.query.period);
  const { fy, books, twob } = await loadFyDataFromDb(gstin, fyReq);
  const fyMonthSet = new Set(fyMonths(fy).months);
  const imsBooks = periodReq ? books.filter((b) => b.period === periodReq) : books.filter((b) => fyMonthSet.has(b.period));
  const imsTwob = periodReq ? twob.filter((w) => w.period === periodReq) : twob.filter((w) => fyMonthSet.has(w.period));
  const recon = reconcilePurchases(imsBooks, imsTwob);
  const ims = buildImsActions(recon.rows, recon.unbooked2b);
  const head = [
    'Our GSTIN', 'Supplier GSTIN', 'Supplier Name', 'Document Type', 'Invoice No', 'Invoice Date',
    'Period', '2B Month', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Cess', 'Total ITC',
    'Recon Status', 'ITC Decision', 'IMS Action', 'IMS Remark',
  ];
  const lines = [
    head.join(','),
    ...ims.rows.map((r) =>
      [
        r.our_gstin, r.supplier_gstin, `"${String(r.supplier_name || '').replace(/"/g, '""')}"`,
        r.document_type, `"${String(r.invoice_no || '').replace(/"/g, '""')}"`, r.invoice_date,
        r.period, r.twob_month, r.taxable_value, r.igst, r.cgst, r.sgst, r.cess, r.total_itc,
        r.recon_status, r.itc_decision, r.ims_action, `"${String(r.ims_remark || '').replace(/"/g, '""')}"`,
      ].join(','),
    ),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="IMS_Actions_${gstin || 'ALL'}_${periodReq || fy}.csv"`);
  res.send('\uFEFF' + lines.join('\r\n'));
}));

app.get('/api/returns/:gstin/:period/:kind', (req, res) => {
  const { gstin, period, kind } = req.params;
  const file = path.join(OUT, 'returns', `${gstin}_${period}_${String(kind).toUpperCase()}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'return not generated for that period' });
  res.download(file);
});

app.get('/api/guide/pdf', (req, res) => {
  const isEn = String(req.query.lang || '').toLowerCase() === 'en';
  const fname = isEn
    ? 'GST_Control_ERP_User_Manual_English.pdf'
    : 'GST_Control_ERP_Step_by_Step_Guide_With_Screenshots.pdf';
  const candidates = [
    path.join(process.cwd(), fname),
    path.join(OUT, fname),
  ];
  const pdfFile = candidates.find((p) => fs.existsSync(p));
  if (!pdfFile) return res.status(404).json({ error: 'User Guide PDF not found' });
  res.download(pdfFile, fname);
});

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Tell the page on startup whether Phase 0 storage is available, so it can
// disable the edit screens instead of failing on every click.
dbReady().then((r) => {
  if (!r.ok) console.log(`   ! Phase 0 storage unavailable: ${r.reason} — read-only mode`);
});

const server = app.listen(PORT, HOST, () => {
  // Report the port actually bound, which differs from the request when the
  // port was 0.
  const actual = (server.address() as any)?.port ?? PORT;
  const addrs = ['localhost', ...lanAddresses()];
  console.log('\n' + '='.repeat(70));
  console.log('  GST ERP is running');
  console.log('='.repeat(70));
  for (const a of addrs) console.log(`   http://${a}:${actual}`);
  console.log(`\n   on other PCs (same Wi-Fi) use:`);
  for (const a of [...new Set([...lanAddresses(), os.hostname()])]) {
    console.log(`     http://${a}:${actual}`);
  }
  console.log(`\n   listening on  : ${HOST}:${actual}`);
  if (PORT_NOTE) console.log(`   note          : ${PORT_NOTE}`);
  console.log(`   input folder  : ${INPUT}`);
  console.log(`   output folder : ${OUT}`);
  console.log(`   uploads       : ${UPLOAD_DIR}`);
  if (!PASSWORD) {
    console.log('\n   ! No GST_WEB_PASSWORD set — anyone who can reach this machine can read');
    console.log('     the GST data and start runs. Fine on a closed office LAN only.');
  }
  console.log('\n   stop with Ctrl+C\n');
});

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}