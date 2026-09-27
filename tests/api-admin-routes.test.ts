/**
 * Admin API route tests — `npx tsx tests/api-admin-routes.test.ts`.
 *
 * Step 26 gap-fix regression: /api/admin/users and /api/auth/demo-switch were
 * UI-referenced but never implemented (404). This suite covers both routes at
 * two levels:
 *
 *   A. SERVICE LEVEL (always runs): createUserAsync rules against a disposable
 *      temp SQLite DB (mirrors auth.test.ts conventions), plus the
 *      demoSwitch production-disabled gate (throws before any cookie use).
 *
 *   B. HTTP CONTRACT (skips gracefully without a production build, mirroring
 *      api-imports-contract.test.ts): boots `next start` on an ephemeral port
 *      with REQUIRE_AUTH=true and a temp DB, then exercises the real routes —
 *      401 unauthenticated, 403 forbidden-for-CPSE-role, 201 create, 409
 *      duplicate email, 404 unknown demo target, and demo-switch end-to-end
 *      (which needs real Set-Cookie, impossible outside HTTP).
 *
 * Isolation mirrors the existing contract suite: MATERIALIQ_* scrubbed from
 * the child env, SQLite pinned explicitly, temp DB deleted afterwards.
 * Production data/materialiq.db, the frozen demo DB, and Supabase are never
 * touched.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { hashPassword } from '../src/lib/auth/password';
import { createUserAsync } from '../src/lib/auth/admin-service';
import { demoSwitch, isDemoModeEnabled } from '../src/lib/auth/service';

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
      srv.on('error', reject);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Part A — service-level rules (temp DB, always runs)                */
/* ------------------------------------------------------------------ */
async function serviceLevel(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-admin-api-test-'));
  const db = new DatabaseSync(path.join(tmp, 'test.db'));
  db.exec('PRAGMA foreign_keys = ON');
  setDbForTests(db);
  migrate(db);
  const now = new Date().toISOString();
  const cpcl = Number(
    db.prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES ('CPCL','CPCL Test','active',?,?)`).run(now, now).lastInsertRowid
  );

  await test('createUserAsync creates a platform admin with scrypt hash + audit row', async () => {
    const view = await createUserAsync(
      { name: 'Admin One', email: 'admin.one@test.local', password: 'strong-password-1', role: 'platform_admin' },
      'actor@test.local'
    );
    assert.equal(view.role, 'platform_admin');
    assert.equal(view.organizationId, null);
    const row = db.prepare(`SELECT password_hash FROM users WHERE id = ?`).get(view.id) as { password_hash: string };
    assert.ok(row.password_hash.startsWith('scrypt'), 'password stored as scrypt hash');
    const audit = db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action='user_created' AND entity_id = ?`).get(view.id) as { n: number };
    assert.equal(audit.n, 1, 'user_created audit row written');
  });

  await test('createUserAsync rejects short password (400)', async () => {
    await assert.rejects(
      () => createUserAsync({ name: 'Shorty', email: 'short@test.local', password: 'short', role: 'authority' }, 'actor@test.local'),
      (err: { status: number }) => err.status === 400
    );
  });

  await test('createUserAsync rejects duplicate email (409)', async () => {
    await createUserAsync({ name: 'Dup', email: 'dup@test.local', password: 'strong-password-2', role: 'authority' }, 'actor@test.local');
    await assert.rejects(
      () => createUserAsync({ name: 'Dup Two', email: 'dup@test.local', password: 'strong-password-2', role: 'authority' }, 'actor@test.local'),
      (err: { status: number }) => err.status === 409
    );
  });

  await test('createUserAsync enforces organization for CPSE roles (400 without)', async () => {
    await assert.rejects(
      () =>
        createUserAsync(
          { name: 'No Org', email: 'noorg@test.local', password: 'strong-password-3', role: 'cpse_material_manager' },
          'actor@test.local'
        ),
      (err: { status: number }) => err.status === 400
    );
    const withOrg = await createUserAsync(
      { name: 'With Org', email: 'withorg@test.local', password: 'strong-password-4', role: 'cpse_material_manager', organizationId: cpcl },
      'actor@test.local'
    );
    assert.equal(withOrg.organizationId, cpcl);
  });

  await test('createUserAsync clears organization for non-CPSE roles even if supplied', async () => {
    const view = await createUserAsync(
      { name: 'Authority Org', email: 'auth.org@test.local', password: 'strong-password-5', role: 'authority', organizationId: cpcl },
      'actor@test.local'
    );
    assert.equal(view.organizationId, null, 'authority must not keep an organization');
  });

  await test('demo mode gate: enabled in dev process (config.env snapshot semantics)', async () => {
    // config.env is snapshotted at module load; this process runs as
    // development, so demo switching is enabled here. The PRODUCTION gate
    // (config.env === 'production' && no ALLOW_DEMO_SWITCH) is exercised in
    // an isolated child process below — runtime env toggles cannot flip the
    // snapshot.
    assert.equal(isDemoModeEnabled(), true);
  });

  await test('demoSwitch refuses when demo mode disabled (production gate, child process)', async () => {
    const gateDb = path.join(tmp, 'gate.db');
    {
      const g = new DatabaseSync(gateDb);
      migrate(g);
      const n = new Date().toISOString();
      g.prepare(`INSERT INTO organizations (code, name, status, created_at, updated_at) VALUES ('CPCL','CPCL','active',?,?)`).run(n, n);
      const pwd = await hashPassword('gate-test-password');
      g.prepare(`INSERT INTO users (name, email, password_hash, role, organization_id, status, created_at, updated_at) VALUES ('Gate Admin','gate@test.local',?, 'platform_admin', NULL, 'active', ?, ?)`).run(pwd, n, n);
      g.close();
    }
    const script = [
      `const { DatabaseSync } = require('node:sqlite');`,
      `const { setDbForTests } = require('${process.cwd().replace(/\\/g, '/')}/src/lib/db/client');`,
      `const { demoSwitch } = require('${process.cwd().replace(/\\/g, '/')}/src/lib/auth/service');`,
      `const db = new DatabaseSync('${gateDb.replace(/\\/g, '/')}');`,
      `setDbForTests(db);`,
      `demoSwitch(1, 'actor@test.local').then(`,
      `  () => { console.error('GATE_FAIL: switch was allowed'); process.exit(1); },`,
      `  (err) => { if (err && err.status === 403) { console.log('GATE_OK 403'); process.exit(0); } console.error('GATE_FAIL', err); process.exit(1); }`,
      `);`,
    ].join('\n');
    const scriptFile = path.join(tmp, 'gate.cjs');
    fs.writeFileSync(scriptFile, script);
    const r = spawnSync(process.execPath, ['--import', 'tsx', scriptFile], {
      env: { ...process.env, NODE_ENV: 'production' },
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.ok(r.stdout.includes('GATE_OK 403'), `production gate did not throw 403: ${r.stdout} ${r.stderr}`);
  });

  db.close();
  setDbForTests(null as unknown as DatabaseSync);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* Part B — HTTP contract (real next start; skips without a build)     */
/* ------------------------------------------------------------------ */
async function httpContract(): Promise<void> {
  if (!fs.existsSync(path.join(process.cwd(), '.next-dev', 'BUILD_ID'))) {
    console.log('SKIP: .next-dev/BUILD_ID missing — build once to enable the HTTP contract part.');
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-admin-contract-'));
  const dbFile = path.join(tmpDir, 'contract.db');
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;

  // Schema + seed in the PARENT (same file the child server opens).
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
    const demoTargets: number[] = [];
    const users: Record<string, { id: number }> = {
      admin: { id: addUser('admin@test.local', 'platform_admin', null) },
      cpclManager: { id: addUser('cpcl-mgr@test.local', 'cpse_material_manager', orgIds.CPCL) },
      targetCpcl: { id: addUser('target-cpcl@test.local', 'cpse_material_manager', orgIds.CPCL) },
      targetNtpc: { id: addUser('target-ntpc@test.local', 'cpse_material_manager', orgIds.NTPC) },
    };
    demoTargets.push(users.targetCpcl.id, users.targetNtpc.id);
    for (const [key, u] of Object.entries(users)) {
      const token = crypto.randomBytes(24).toString('hex');
      const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_via) VALUES (?, ?, ?, 'login')`).run(token, u.id, exp);
      tokens[key] = token;
    }
    db.close();
    process.env.ADMIN_CONTRACT_DEMO_TARGET = String(demoTargets[0]);
  }

  const cookie = (who: string): string => `materialiq_session=${tokens[who]}`;

  async function request(
    method: string,
    urlPath: string,
    opts: { who?: string | null; body?: unknown } = {}
  ): Promise<{ status: number; json: any; setCookie: string | null }> {
    const headers: Record<string, string> = {};
    if (opts.who) headers.cookie = cookie(opts.who);
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body, signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON (HTML error pages) */
    }
    return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
  }

  console.log(`spawning next start on :${port} (temp db: ${dbFile})`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith('MATERIALIQ_') || k === 'PORT') delete childEnv[k];
  }
  childEnv.MATERIALIQ_DB_DIALECT = 'sqlite';
  childEnv.MATERIALIQ_DATABASE_URL = '';
  childEnv.DB_PATH = dbFile;
  childEnv.REQUIRE_AUTH = 'true';
  // `next start` runs NODE_ENV=production, where demo switching is disabled
  // unless explicitly allowed — the exact escape hatch the service documents.
  childEnv.ALLOW_DEMO_SWITCH = 'true';
  // Serve the ISOLATED .next-dev build (this suite's routes only exist there);
  // the frozen production .next that the 63030 demo serves is never touched.
  childEnv.NEXT_DEV_DIST = '.next-dev';
  childEnv.PORT = String(port);
  const child = spawn('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childLogs: string[] = [];
  child.stdout.on('data', (d) => childLogs.push(String(d)));
  child.stderr.on('data', (d) => childLogs.push(String(d)));

  try {
    // Wait for readiness via a public health endpoint.
    const deadline = Date.now() + 60_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(up, 'child server became ready');

    /* ---------- /api/admin/users ---------- */
    await test('GET /api/admin/users -> 401 without a session', async () => {
      const r = await request('GET', '/api/admin/users', { who: null });
      assert.equal(r.status, 401);
    });

    await test('GET /api/admin/users -> 403 for a CPSE manager', async () => {
      const r = await request('GET', '/api/admin/users', { who: 'cpclManager' });
      assert.equal(r.status, 403);
      assert.equal(r.json?.error?.code, 'forbidden');
    });

    await test('GET /api/admin/users -> 200 user list for platform admin', async () => {
      const r = await request('GET', '/api/admin/users', { who: 'admin' });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.json?.data?.users));
      assert.ok(r.json.data.users.some((u: { email: string }) => u.email === 'admin@test.local'));
    });

    await test('POST /api/admin/users -> 401 without a session', async () => {
      const r = await request('POST', '/api/admin/users', {
        who: null,
        body: { name: 'X Y', email: 'x@test.local', password: 'strong-password', role: 'authority' },
      });
      assert.equal(r.status, 401);
    });

    await test('POST /api/admin/users -> 403 for a CPSE manager', async () => {
      const r = await request('POST', '/api/admin/users', {
        who: 'cpclManager',
        body: { name: 'X Y', email: 'x@test.local', password: 'strong-password', role: 'authority' },
      });
      assert.equal(r.status, 403);
    });

    await test('POST /api/admin/users -> 422/400 validation for bad payload (admin)', async () => {
      const r = await request('POST', '/api/admin/users', {
        who: 'admin',
        body: { name: 'X', email: 'not-an-email', password: 'short', role: 'wizards' },
      });
      assert.ok([400, 422].includes(r.status), `unexpected status ${r.status}`);
      assert.equal(r.json?.error?.code, 'validation_error');
    });

    await test('POST /api/admin/users -> 201 creates user (admin)', async () => {
      const r = await request('POST', '/api/admin/users', {
        who: 'admin',
        body: { name: 'Created User', email: 'created@test.local', password: 'strong-password-9', role: 'cpse_technical_reviewer', organizationId: 1 },
      });
      assert.equal(r.status, 201);
      assert.equal(r.json?.data?.user?.email, 'created@test.local');
      assert.ok(r.json.data.user.id > 0);
    });

    await test('POST /api/admin/users -> 409 duplicate email', async () => {
      const r = await request('POST', '/api/admin/users', {
        who: 'admin',
        body: { name: 'Created Again', email: 'created@test.local', password: 'strong-password-9', role: 'authority' },
      });
      assert.equal(r.status, 409);
    });

    /* ---------- /api/auth/demo-switch ---------- */
    await test('POST /api/auth/demo-switch -> 401 without a session', async () => {
      const r = await request('POST', '/api/auth/demo-switch', { who: null, body: { userId: 1 } });
      assert.equal(r.status, 401);
    });

    await test('POST /api/auth/demo-switch -> 403 for a CPSE manager', async () => {
      const r = await request('POST', '/api/auth/demo-switch', { who: 'cpclManager', body: { userId: 1 } });
      assert.equal(r.status, 403);
    });

    await test('POST /api/auth/demo-switch -> 404 for unknown target user', async () => {
      const r = await request('POST', '/api/auth/demo-switch', { who: 'admin', body: { userId: 999999 } });
      assert.equal(r.status, 404);
    });

    await test('POST /api/auth/demo-switch -> 200 switches session (admin)', async () => {
      const target = Number(process.env.ADMIN_CONTRACT_DEMO_TARGET);
      const r = await request('POST', '/api/auth/demo-switch', { who: 'admin', body: { userId: target } });
      assert.equal(r.status, 200);
      assert.ok(r.json?.data?.user?.id === target, 'response carries the switched identity');
      assert.ok(r.setCookie && r.setCookie.includes('materialiq_session='), 'new session cookie is set');
    });

    await test('POST /api/auth/demo-switch -> 400 for malformed body', async () => {
      const r = await request('POST', '/api/auth/demo-switch', { who: 'admin', body: { userId: 'abc' } });
      assert.ok([400, 422].includes(r.status));
    });
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failures.length > 0 && childLogs.length > 0) {
    console.error('--- child server logs (tail) ---');
    console.error(childLogs.join('').slice(-2000));
  }
}

async function main(): Promise<void> {
  console.log('Part A: service-level rules');
  await serviceLevel();
  console.log('Part B: HTTP contract');
  await httpContract();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
