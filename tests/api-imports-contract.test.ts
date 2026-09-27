/**
 * Import Center HTTP contract tests — `npx tsx tests/api-imports-contract.test.ts`.
 *
 * Regression guard for the "POST /api/imports/analyze -> 404" incident: spawns a
 * REAL `next start` server (production build) on an ephemeral port backed by a
 * DISPOSABLE SQLite temp database, and exercises the exact routes the Import
 * Center wizard calls — /api/imports/analyze, /api/imports/:id/execute (sync),
 * /api/import-jobs (the wizard's actual execute path), and the legacy
 * /api/imports endpoint — through real HTTP with real session cookies.
 *
 * Runs fully isolated: DB_PATH points at a temp file, REQUIRE_AUTH=true so
 * sessions/roles are exercised for real, and the child environment is scrubbed
 * of any MATERIALIQ_* production targeting (scripts/test-env-guard.js guards
 * the parent; this suite re-checks the child env by construction). Production
 * data/materialiq.db and Supabase are never touched.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/lib/db/migrate';
import { hashPassword } from '../src/lib/auth/password';
import * as XLSX from 'xlsx';

const failures: string[] = [];
let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  FAIL - ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
    srv.on('error', reject);
  });
}

const MATERIAL_ROWS = [
  ['TEST-BRG-0001', 'SKF BALL BEARING 6205-2RS', 'Bearings', 'SKF', '6205-2RS', 'NOS'],
  ['TEST-BRG-0002', 'FAG BALL BEARING 6308 ZZ', 'Bearings', 'FAG', '6308-ZZ', 'NOS'],
  ['TEST-BRG-0003', 'NTN BALL BEARING 6205 ZZ', 'Bearings', 'NTN', '6205-ZZ', 'NOS'],
];

function csvForm(org: string, rows: string[][]): FormData {
  const header = 'material_code,material_description,category,manufacturer,part_number,uom\n';
  const csv = header + rows.map((r) => r.join(',')).join('\n');
  const form = new FormData();
  form.append('file', new File([csv], 'contract-test.csv', { type: 'text/csv' }));
  form.append('organizationCode', org);
  return form;
}

function xlsxBuffer(rows: string[][]): Buffer {
  const aoa = [
    ['material_code', 'material_description', 'category', 'manufacturer', 'part_number', 'uom'],
    ...rows,
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function xlsxForm(org: string, rows: string[][], name = 'contract-test.xlsx'): FormData {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(xlsxBuffer(rows))], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  form.append('organizationCode', org);
  return form;
}

async function main(): Promise<void> {
  // The suite boots the PRODUCTION build (next start). Skip gracefully when it
  // has not been built yet so a fresh `npm test` checkout is not blocked.
  if (!fs.existsSync(path.join(process.cwd(), '.next', 'BUILD_ID'))) {
    console.log('SKIP: .next/BUILD_ID missing — run `npm run build` first to enable the HTTP contract suite.');
    process.exit(0);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-api-contract-'));
  const dbFile = path.join(tmpDir, 'contract.db');
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;

  // Schema + seed data in the PARENT (same file the child server opens).
  const tokens: Record<string, string> = {};
  {
    const db = new DatabaseSync(dbFile);
    migrate(db);
    const now = new Date().toISOString();
    const orgIds: Record<string, number> = {};
    for (const code of ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL']) {
      const r = db
        .prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
        .run(code, `${code} Test Corp`, now, now);
      orgIds[code] = Number(r.lastInsertRowid);
    }
    const pwd = await hashPassword('contract-test-password');
    const addUser = (email: string, role: string, orgId: number | null): number => {
      const r = db
        .prepare(`INSERT INTO users (name, email, password_hash, role, organization_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
        .run(email.split('@')[0], email, pwd, role, orgId, now, now);
      return Number(r.lastInsertRowid);
    };
    const users: Record<string, { id: number }> = {
      admin: { id: addUser('admin@test.local', 'platform_admin', null) },
      cpclManager: { id: addUser('cpcl-mgr@test.local', 'cpse_material_manager', orgIds.CPCL) },
      ntpcManager: { id: addUser('ntpc-mgr@test.local', 'cpse_material_manager', orgIds.NTPC) },
    };
    for (const [key, u] of Object.entries(users)) {
      const token = crypto.randomBytes(24).toString('hex');
      const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_via) VALUES (?, ?, ?, 'login')`).run(token, u.id, exp);
      tokens[key] = token;
    }
    db.close();
  }

  const cookie = (who: string): string => `materialiq_session=${tokens[who]}`;

  async function request(
    method: string,
    urlPath: string,
    opts: { who?: string | null; body?: FormData | string | Buffer; contentType?: string } = {}
  ): Promise<{ status: number; json: any; text: string }> {
    const headers: Record<string, string> = {};
    if (opts.who) headers.cookie = cookie(opts.who);
    let body: BodyInit | undefined;
    if (opts.body instanceof FormData) {
      body = opts.body;
    } else if (typeof opts.body === 'string') {
      body = opts.body;
      headers['content-type'] = opts.contentType ?? 'application/json';
    } else if (Buffer.isBuffer(opts.body)) {
      body = new Uint8Array(opts.body);
      headers['content-type'] = opts.contentType ?? 'application/octet-stream';
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  }

  console.log(`spawning next start on :${port} (temp db: ${dbFile})`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith('MATERIALIQ_') || k === 'PORT') delete childEnv[k];
  }
  // next start re-loads .env.local on boot; dotenv never overrides EXISTING
  // vars, so the SQLite target must be pinned explicitly or the child would
  // silently connect to the production Supabase database.
  childEnv.MATERIALIQ_DB_DIALECT = 'sqlite';
  childEnv.MATERIALIQ_DATABASE_URL = '';
  childEnv.DB_PATH = dbFile;
  childEnv.REQUIRE_AUTH = 'true';
  childEnv.PORT = String(port);
  const child = spawn('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childLogs: string[] = [];
  child.stdout.on('data', (d) => childLogs.push(String(d)));
  child.stderr.on('data', (d) => childLogs.push(String(d)));

  const deadline = Date.now() + 60000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.status < 600) { up = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) {
    console.error(`server did not start:\n${childLogs.join('').slice(-2000)}`);
    child.kill();
    process.exit(1);
  }

  function cleanup(): void {
    try { child.kill(); } catch { /* gone */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.on('exit', cleanup);

  /* ---------------------------- A. analyze -------------------------------- */

  await test('A1: analyze requires authentication when REQUIRE_AUTH=true (401, not 404)', async () => {
    const res = await request('POST', '/api/imports/analyze', { who: null, body: csvForm('CPCL', MATERIAL_ROWS) });
    assert.equal(res.status, 401, `expected 401, got ${res.status}`);
    assert.equal(res.json?.error?.code, 'unauthorized');
  });

  await test('A2: analyze responds (NOT 404) with the full wizard contract', async () => {
    const res = await request('POST', '/api/imports/analyze', { who: 'admin', body: csvForm('CPCL', MATERIAL_ROWS) });
    assert.notEqual(res.status, 404, 'analyze route must exist');
    assert.equal(res.status, 200);
    const d = res.json?.data;
    assert.equal(typeof d.importId, 'number');
    assert.ok(Array.isArray(d.headers) && d.headers.length >= 6);
    assert.equal(typeof d.mappingUsable, 'boolean');
    assert.ok(d.mappingUsable, 'contract headers must auto-map');
    assert.ok(Array.isArray(d.suggestions));
    assert.ok(Array.isArray(d.parseWarnings));
    assert.equal(d.totalRows, 3);
    assert.equal(d.validRows, 3);
    assert.equal(d.invalidRows, 0);
    assert.ok(Array.isArray(d.previewRows) && d.previewRows.length === 3);
    assert.ok(Array.isArray(d.validationErrors));
    assert.equal(d.canExecute, true);
  });

  await test('A3: analyze XLSX works and returns the same contract shape', async () => {
    const res = await request('POST', '/api/imports/analyze', { who: 'admin', body: xlsxForm('CPCL', MATERIAL_ROWS) });
    assert.equal(res.status, 200);
    const d = res.json?.data;
    assert.equal(typeof d.importId, 'number');
    assert.equal(d.totalRows, 3);
    assert.equal(d.canExecute, true);
  });

  await test('A4: analyze with explicit mapping field is accepted and echoed', async () => {
    const form = csvForm('CPCL', MATERIAL_ROWS);
    form.append('mapping', JSON.stringify({ originalCode: 'material_code', originalDescription: 'material_description', uom: 'uom' }));
    const res = await request('POST', '/api/imports/analyze', { who: 'admin', body: form });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.mapping.originalCode, 'material_code');
  });

  await test('A5: malformed mapping JSON returns 400', async () => {
    const form = csvForm('CPCL', MATERIAL_ROWS);
    form.append('mapping', '{not json');
    const res = await request('POST', '/api/imports/analyze', { who: 'admin', body: form });
    assert.equal(res.status, 400);
  });

  await test('A6: missing file returns 400', async () => {
    const form = new FormData();
    form.append('organizationCode', 'CPCL');
    const res = await request('POST', '/api/imports/analyze', { who: 'admin', body: form });
    assert.equal(res.status, 400);
  });

  await test('A7: invalid file type returns 400', async () => {
    const form = new FormData();
    form.append('file', new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    form.append('organizationCode', 'CPCL');
    const res = await request('POST', '/api/imports/analyze', { who: 'admin', body: form });
    assert.equal(res.status, 400);
  });

  await test('A8: unknown organization returns 404', async () => {
    const res = await request('POST', '/api/imports/analyze', { who: 'admin', body: csvForm('NOPE', MATERIAL_ROWS) });
    assert.equal(res.status, 404);
    assert.equal(res.json?.error?.code, 'not_found');
  });

  await test('A9: malformed multipart body returns 400 (previously an unhandled 500)', async () => {
    const res = await request('POST', '/api/imports/analyze', {
      who: 'admin',
      body: 'this is not multipart',
      contentType: 'multipart/form-data; boundary=zzz',
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
    assert.equal(res.json?.error?.code, 'bad_request');
  });

  await test('A10: unauthenticated GET on analyze is not 200', async () => {
    const res = await request('GET', '/api/imports/analyze', { who: null });
    assert.ok(res.status === 405 || res.status === 401, `expected 405/401, got ${res.status}`);
  });

  await test('A11: CPSE manager cannot analyze for another CPSE (org scoping)', async () => {
    const res = await request('POST', '/api/imports/analyze', { who: 'cpclManager', body: csvForm('NTPC', MATERIAL_ROWS) });
    assert.equal(res.status, 403);
  });

  /* ---------------------------- B. execute -------------------------------- */

  let skipImportId = 0;
  let updateImportId = 0;
  let cancelImportId = 0;
  let ntpcImportId = 0;

  await test('B0: setup - analyze three CPCL imports + one NTPC import', async () => {
    skipImportId = (await request('POST', '/api/imports/analyze', { who: 'admin', body: csvForm('CPCL', MATERIAL_ROWS) })).json.data.importId;
    updateImportId = (await request('POST', '/api/imports/analyze', { who: 'admin', body: csvForm('CPCL', MATERIAL_ROWS) })).json.data.importId;
    cancelImportId = (await request('POST', '/api/imports/analyze', { who: 'admin', body: csvForm('CPCL', MATERIAL_ROWS) })).json.data.importId;
    ntpcImportId = (await request('POST', '/api/imports/analyze', { who: 'admin', body: csvForm('NTPC', MATERIAL_ROWS) })).json.data.importId;
    assert.ok(skipImportId && updateImportId && cancelImportId && ntpcImportId);
  });

  await test('B1: execute unknown import returns 404', async () => {
    const res = await request('POST', '/api/imports/99999999/execute', { who: 'admin', body: JSON.stringify({ duplicateStrategy: 'skip' }) });
    assert.equal(res.status, 404);
  });

  await test('B2: malformed import id returns 400', async () => {
    const res = await request('POST', '/api/imports/not-a-number/execute', { who: 'admin', body: JSON.stringify({}) });
    assert.equal(res.status, 400);
  });

  await test('B3: invalid duplicateStrategy returns 400', async () => {
    const res = await request('POST', `/api/imports/${skipImportId}/execute`, { who: 'admin', body: JSON.stringify({ duplicateStrategy: 'nuke' }) });
    assert.equal(res.status, 400);
  });

  await test('B4: malformed JSON body returns 400 (previously an unhandled 500)', async () => {
    const res = await request('POST', `/api/imports/${skipImportId}/execute`, { who: 'admin', body: '{broken', contentType: 'application/json' });
    assert.equal(res.status, 400);
  });

  await test('B5: execute skip imports all valid rows through executeImport()', async () => {
    const res = await request('POST', `/api/imports/${skipImportId}/execute`, {
      who: 'admin',
      body: JSON.stringify({ includeWarnings: true, duplicateStrategy: 'skip', actor: 'contract-test' }),
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const d = res.json?.data;
    assert.equal(d.importId, skipImportId);
    assert.equal(d.imported, 3);
    assert.equal(d.skippedExisting, 0);
  });

  await test('B6: re-execute with skip is idempotent - no duplicate materials', async () => {
    const res = await request('POST', `/api/imports/${skipImportId}/execute`, { who: 'admin', body: JSON.stringify({ duplicateStrategy: 'skip' }) });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.imported, 0);
    assert.equal(res.json.data.skippedExisting, 3);
  });

  await test('B7: execute update strategy - same codes update instead of skip', async () => {
    const first = await request('POST', `/api/imports/${updateImportId}/execute`, { who: 'admin', body: JSON.stringify({ duplicateStrategy: 'update' }) });
    assert.equal(first.status, 200);
    const again = await request('POST', `/api/imports/${updateImportId}/execute`, { who: 'admin', body: JSON.stringify({ duplicateStrategy: 'update' }) });
    assert.equal(again.status, 200);
    assert.equal(again.json.data.updated, 3, `expected 3 updated, got ${JSON.stringify(again.json?.data)}`);
  });

  await test('B8: execute cancel strategy - import cancelled, nothing imported', async () => {
    const res = await request('POST', `/api/imports/${cancelImportId}/execute`, { who: 'admin', body: JSON.stringify({ duplicateStrategy: 'cancel' }) });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.imported, 0);
  });

  await test('B9: CPSE manager cannot execute another CPSE import (403)', async () => {
    const res = await request('POST', `/api/imports/${ntpcImportId}/execute`, { who: 'cpclManager', body: JSON.stringify({ duplicateStrategy: 'skip' }) });
    assert.equal(res.status, 403);
    assert.equal(res.json?.error?.code, 'forbidden');
  });

  await test('B10: NTPC manager CAN execute their own import (positive scoping control)', async () => {
    const res = await request('POST', `/api/imports/${ntpcImportId}/execute`, { who: 'ntpcManager', body: JSON.stringify({ duplicateStrategy: 'skip' }) });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.imported, 3);
  });

  /* ---------------------------- C. legacy ---------------------------------- */

  await test('C1: legacy POST /api/imports still works unchanged', async () => {
    const form = csvForm('CPCL', [['TEST-LEG-0001', 'LEGACY ENDPOINT IMPORT BEARING', 'Bearings', 'SKF', 'PN-L1', 'NOS']]);
    const res = await request('POST', '/api/imports', { who: 'admin', body: form });
    assert.ok([200, 201].includes(res.status), `expected 200/201, got ${res.status}: ${res.text.slice(0, 300)}`);
    assert.equal(res.json?.data?.summary?.successfulRows, 1, res.text.slice(0, 300));
  });

  await test('C2: legacy endpoint missing file returns 400 (unchanged)', async () => {
    const form = new FormData();
    form.append('organizationCode', 'CPCL');
    const res = await request('POST', '/api/imports', { who: 'admin', body: form });
    assert.equal(res.status, 400);
  });

  /* ------------------- D. wizard's actual execute path ---------------------- */

  await test('D1: wizard execute path - POST /api/import-jobs starts a chunked job that completes', async () => {
    const analyzed = await request('POST', '/api/imports/analyze', { who: 'admin', body: xlsxForm('BHEL', MATERIAL_ROWS, 'contract-job.xlsx') });
    assert.equal(analyzed.status, 200);
    const importId = analyzed.json.data.importId;
    const started = await request('POST', '/api/import-jobs', { who: 'admin', body: JSON.stringify({ importId }) });
    assert.ok(started.status === 200 || started.status === 202, `job start -> ${started.status}: ${started.text.slice(0, 200)}`);
    const jobId = started.json?.data?.jobId ?? started.json?.data?.id;
    assert.ok(jobId, `no job id in ${started.text.slice(0, 200)}`);
    let job = started.json?.data;
    for (let i = 0; i < 60 && job?.status !== 'COMPLETED' && job?.status !== 'FAILED'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const poll = await request('GET', `/api/import-jobs/${jobId}`, { who: 'admin' });
      job = poll.json?.data;
    }
    assert.equal(job?.status, 'COMPLETED', `job did not complete: ${JSON.stringify(job)}`);
  });

  /* --------------------- E. import history bounded -------------------------- */

  await test('E1: import history API lists the contract imports, paginated and bounded', async () => {
    const res = await request('GET', '/api/imports?page=1&pageSize=5', { who: 'admin' });
    assert.equal(res.status, 200);
    const d = res.json?.data;
    const items = d.items ?? d.imports ?? d;
    assert.ok(Array.isArray(items), 'history must be a list');
    assert.ok(items.length <= 5, 'page size must be honored');
  });

  /* ------------------------------ summary ----------------------------------- */

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(`\nServer log tail:\n${childLogs.join('').slice(-3000)}`);
    cleanup();
    process.exit(1);
  }
  cleanup();
  process.exit(0);
}

void main();
