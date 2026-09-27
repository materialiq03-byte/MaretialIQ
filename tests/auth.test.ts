/**
 * Authentication & authorization tests — `npx tsx tests/auth.test.ts`.
 *
 * Covers: password hashing/verification, unknown user, sessions (create /
 * resolve / expiry / logout), permission matrix per role, organization write
 * isolation, demo-mode gating, audit logging of security events, and scoped
 * dashboard metrics. Login flow is tested at the service boundary that does
 * not require an HTTP request context (cookies() is Next.js-only).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setDbForTests } from '../src/lib/db/client';
import { migrate } from '../src/lib/db/migrate';
import { hashPassword, verifyPassword } from '../src/lib/auth/password';
import {
  findUserByEmail,
  insertUser,
  touchLastLogin,
  getUser,
} from '../src/lib/auth/user-repository';
import {
  createSession,
  getSessionUser,
  deleteSession,
  purgeExpiredSessions,
} from '../src/lib/auth/session';
import { roleHasPermission, navForRole } from '../src/lib/auth/permissions';
import { assertOrganizationWrite, visibleOrganizationIds } from '../src/lib/auth/guard';
import { isDemoModeEnabled } from '../src/lib/auth/service';
import { getDashboardMetrics } from '../src/lib/db/repositories/metrics-repository';
import { recordAudit, listAudit } from '../src/lib/db/repositories/audit-repository';
import { getDb } from '../src/lib/db/client';
import type { SessionUser, Role } from '../src/lib/auth/types';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  FAIL - ${name}`);
  }
}

/* --------------------------------- setup ---------------------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'materialiq-auth-test-'));
const db = new DatabaseSync(path.join(tmp, 'test.db'));
db.exec('PRAGMA foreign_keys = ON');
setDbForTests(db);
migrate(db);

// Organizations + one seeded demo user per role, mirroring the real seed.
const orgIds = new Map<string, number>();
for (const code of ['CPCL', 'NTPC']) {
  const res = db.prepare(`INSERT INTO organizations (code, name) VALUES (?, ?)`).run(code, `${code} Test Org`);
  orgIds.set(code, Number(res.lastInsertRowid));
}
async function seedUsers(): Promise<Map<string, SessionUser>> {
  const hash = await hashPassword('demo-password');
  const defs: Array<{ key: string; name: string; email: string; role: Role; org: string | null }> = [
    { key: 'manager', name: 'Raj Kumar', email: 'cpcl.manager@materialiq.demo', role: 'cpse_material_manager', org: 'CPCL' },
    { key: 'reviewer', name: 'Priya Menon', email: 'cpcl.reviewer@materialiq.demo', role: 'cpse_technical_reviewer', org: 'CPCL' },
    { key: 'authority', name: 'Deepa Iyer', email: 'authority@materialiq.demo', role: 'authority', org: null },
    { key: 'admin', name: 'Admin', email: 'admin@materialiq.demo', role: 'platform_admin', org: null },
  ];
  const out = new Map<string, SessionUser>();
  for (const d of defs) {
    insertUser({
      name: d.name,
      email: d.email,
      passwordHash: hash,
      role: d.role,
      organizationId: d.org ? orgIds.get(d.org)! : null,
    });
    const row = findUserByEmail(d.email)!;
    out.set(d.key, getUser(row.id)!);
  }
  return out;
}

// The seed is async; run it before tests via a top-level await-free wrapper.
const users: Map<string, SessionUser> = new Map();
async function main(): Promise<void> {
  for (const [k, v] of await seedUsers()) users.set(k, v);

  /* ------------------------------ 1-3. login ------------------------------ */

  test('valid credentials verify against the stored scrypt hash', async () => {
    const user = findUserByEmail('cpcl.manager@materialiq.demo');
    assert.ok(user, 'demo manager exists');
    assert.equal(await verifyPassword('demo-password', user.password_hash), true);
  });
  await (async () => {})();

  test('invalid password is rejected without disclosure', async () => {
    const user = findUserByEmail('cpcl.manager@materialiq.demo')!;
    assert.equal(await verifyPassword('wrong-password', user.password_hash), false);
  });

  test('unknown user lookup returns undefined', () => {
    assert.equal(findUserByEmail('nobody@materialiq.demo'), undefined);
  });

  test('password hashes are never reversible or plaintext', async () => {
    const user = findUserByEmail('cpcl.manager@materialiq.demo')!;
    assert.notEqual(user.password_hash, 'demo-password');
    assert.match(user.password_hash, /^scrypt\$/);
    assert.equal(await verifyPassword('demo-password', user.password_hash), true);
  });

  /* --------------------------- 4-5. sessions ------------------------------ */

  test('session create → resolve → logout lifecycle', () => {
    const manager = users.get('manager')!;
    const { sessionId } = createSession({ userId: manager.id, via: 'login' });
    const resolved = getSessionUser(sessionId);
    assert.ok(resolved);
    assert.equal(resolved!.role, 'cpse_material_manager');
    assert.equal(resolved!.organizationCode, 'CPCL');
    deleteSession(sessionId);
    assert.equal(getSessionUser(sessionId), null, 'deleted session no longer resolves');
  });

  test('protected surface without a session resolves to no user', () => {
    assert.equal(getSessionUser(undefined), null);
    assert.equal(getSessionUser('fabricated-session-id'), null);
  });

  test('expired sessions are rejected and purged', () => {
    const reviewer = users.get('reviewer')!;
    const { sessionId } = createSession({ userId: reviewer.id, via: 'login' });
    // Force expiry directly in the store (both columns keep the CHECK valid).
    getDb()
      .prepare(`UPDATE sessions SET created_at = '1999-12-31T00:00:00Z', expires_at = '2000-01-01T00:00:00Z' WHERE id = ?`)
      .run(sessionId);
    assert.equal(getSessionUser(sessionId), null, 'expired session does not resolve');
    purgeExpiredSessions();
    const n = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = ?`).get(sessionId) as { n: number }
    ).n;
    assert.equal(n, 0, 'purge removes the expired row');
  });

  test('touchLastLogin records a timestamp', () => {
    const manager = findUserByEmail('cpcl.manager@materialiq.demo')!;
    touchLastLogin(manager.id);
    const after = findUserByEmail('cpcl.manager@materialiq.demo')!;
    assert.ok(after.last_login_at, 'last_login_at set');
  });

  /* --------------------- 6-7. organization isolation ---------------------- */

  test('CPCL user can write CPCL records', () => {
    const manager = users.get('manager')!;
    assert.doesNotThrow(() => assertOrganizationWrite(manager, orgIds.get('CPCL')!));
  });

  test('CPCL user CANNOT modify NTPC records (server-enforced)', () => {
    const manager = users.get('manager')!;
    assert.throws(
      () => assertOrganizationWrite(manager, orgIds.get('NTPC')!),
      /different CPSE organization/
    );
  });

  test('authority users have no write access to any organization', () => {
    const authority = users.get('authority')!;
    assert.throws(() => assertOrganizationWrite(authority, orgIds.get('CPCL')!), /read-only/);
  });

  test('admin can write anywhere', () => {
    const admin = users.get('admin')!;
    assert.doesNotThrow(() => assertOrganizationWrite(admin, orgIds.get('NTPC')!));
  });

  test('read scope: CPSE user pinned to own org; authority/admin see all', () => {
    assert.deepEqual(visibleOrganizationIds(users.get('manager')!), [orgIds.get('CPCL')]);
    assert.equal(visibleOrganizationIds(users.get('authority')!), null);
    assert.equal(visibleOrganizationIds(users.get('admin')!), null);
  });

  /* ------------------------ 8-11. permission matrix ----------------------- */

  test('technical reviewer has review permissions', () => {
    const reviewer = users.get('reviewer')!;
    assert.equal(roleHasPermission(reviewer.role, 'REVIEW_MATCHES'), true);
    assert.equal(roleHasPermission(reviewer.role, 'APPROVE_MATCH'), true);
    assert.equal(roleHasPermission(reviewer.role, 'REJECT_MATCH'), true);
    assert.equal(roleHasPermission(reviewer.role, 'DEFER_MATCH'), true);
  });

  test('technical reviewer cannot manage users or organizations', () => {
    const reviewer = users.get('reviewer')!;
    assert.equal(roleHasPermission(reviewer.role, 'MANAGE_USERS'), false);
    assert.equal(roleHasPermission(reviewer.role, 'MANAGE_ORGANIZATIONS'), false);
    assert.equal(roleHasPermission(reviewer.role, 'MANAGE_SYSTEM_SETTINGS'), false);
  });

  test('authority is read-only oversight (no write permissions)', () => {
    const authority = users.get('authority')!;
    for (const p of ['VIEW_ANALYTICS', 'VIEW_AUDIT', 'VIEW_MAPPINGS', 'VIEW_MATCHES'] as const) {
      assert.equal(roleHasPermission(authority.role, p), true, `authority has ${p}`);
    }
    for (const p of ['EDIT_MATERIALS', 'IMPORT_MATERIALS', 'APPROVE_MATCH', 'MANAGE_USERS'] as const) {
      assert.equal(roleHasPermission(authority.role, p), false, `authority lacks ${p}`);
    }
  });

  test('material manager can import and edit but not administer', () => {
    const manager = users.get('manager')!;
    assert.equal(roleHasPermission(manager.role, 'IMPORT_MATERIALS'), true);
    assert.equal(roleHasPermission(manager.role, 'EDIT_MATERIALS'), true);
    assert.equal(roleHasPermission(manager.role, 'REVIEW_MATCHES'), false);
    assert.equal(roleHasPermission(manager.role, 'MANAGE_USERS'), false);
  });

  test('platform admin holds every permission', () => {
    const admin = users.get('admin')!;
    assert.equal(roleHasPermission(admin.role, 'MANAGE_USERS'), true);
    assert.equal(roleHasPermission(admin.role, 'MANAGE_ORGANIZATIONS'), true);
    assert.equal(roleHasPermission(admin.role, 'APPROVE_MATCH'), true);
    assert.equal(roleHasPermission(admin.role, 'VIEW_AUDIT'), true);
  });

  test('navigation is permission-derived and never contains broken links', () => {
    const managerNav = navForRole(users.get('manager')!.role).map((n) => n.href);
    assert.ok(managerNav.includes('/imports'));
    assert.ok(!managerNav.includes('/admin'));
    const reviewerNav = navForRole(users.get('reviewer')!.role).map((n) => n.href);
    assert.ok(reviewerNav.includes('/proposals'));
    const authorityNav = navForRole(users.get('authority')!.role).map((n) => n.href);
    assert.ok(!authorityNav.includes('/imports'), 'authority has no import surface');
    const adminNav = navForRole(users.get('admin')!.role).map((n) => n.href);
    assert.ok(adminNav.includes('/admin'));
  });

  /* ------------------------- 12-14. demo mode ----------------------------- */

  test('demo role switching is enabled in non-production environments', () => {
    assert.equal(typeof isDemoModeEnabled(), 'boolean');
    assert.equal(isDemoModeEnabled(), true, 'dev/test environments allow the demo switcher');
  });

  test('demo-switch sessions are distinguishable from login sessions', () => {
    const reviewer = users.get('reviewer')!;
    const { sessionId } = createSession({ userId: reviewer.id, via: 'demo_switch', demoOfUserId: reviewer.id });
    const resolved = getSessionUser(sessionId)!;
    assert.equal(resolved.demoSwitched, true);
    const { sessionId: normalId } = createSession({ userId: reviewer.id, via: 'login' });
    assert.equal(getSessionUser(normalId)!.demoSwitched, false);
    deleteSession(sessionId);
    deleteSession(normalId);
  });

  /* ------------------------- 15. audit logging ---------------------------- */

  test('security events are audit-logged and retrievable', () => {
    const manager = findUserByEmail('cpcl.manager@materialiq.demo')!;
    recordAudit({ action: 'user_login', entityType: 'user', entityId: manager.id, actor: manager.email, details: { role: manager.role } });
    recordAudit({ action: 'user_login_failed', entityType: 'user', actor: 'intruder@example.com', details: { reason: 'bad_password' } });
    recordAudit({ action: 'user_logout', entityType: 'user', entityId: manager.id, actor: manager.email });
    const { items } = listAudit({ entityType: 'user', page: 1, pageSize: 10 });
    const actions = items.map((i) => i.action);
    assert.ok(actions.includes('user_login'));
    assert.ok(actions.includes('user_login_failed'));
    assert.ok(actions.includes('user_logout'));
    // Passwords must never appear in audit details.
    const serialized = JSON.stringify(items);
    assert.ok(!serialized.includes('demo-password'), 'no secret material in audit log');
  });

  /* ----------------- 16. scoped dashboard metrics (CPSE) ------------------ */

  test('scoped metrics count only the scoped organization materials', () => {
    // Create 3 CPCL + 2 NTPC materials.
    const ins = db.prepare(
      `INSERT INTO material_records (organization_id, original_code, original_description, category, uom)
       VALUES (?, ?, ?, 'Bearings', 'EA')`
    );
    for (let i = 0; i < 3; i++) ins.run(orgIds.get('CPCL')!, `CP-A${i}`, `CPCL BEARING ${i}`);
    for (let i = 0; i < 2; i++) ins.run(orgIds.get('NTPC')!, `NT-A${i}`, `NTPC BEARING ${i}`);

    const cpcl = getDashboardMetrics(orgIds.get('CPCL')!);
    assert.equal(cpcl.totalMaterials, 3, 'CPCL scope sees only CPCL records');
    const all = getDashboardMetrics(null);
    assert.equal(all.totalMaterials, 5, 'platform scope sees every record');
    assert.equal(all.perOrganization.length, 2, 'per-org summary lists both CPSEs');
    const ntpcRow = all.perOrganization.find((o) => o.code === 'NTPC')!;
    assert.equal(ntpcRow.materials, 2);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

main();
