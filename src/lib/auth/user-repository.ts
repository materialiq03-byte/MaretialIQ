import { getDb } from '../db/client';
import { errors } from '../errors';
import { nowIso } from '../db/util';
import type { SessionUser, Role } from './types';

export interface UserRow {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  organization_id: number | null;
  status: 'active' | 'inactive';
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface UserWithOrg extends Omit<UserRow, 'organization_id'> {
  organization_id: number | null;
  org_code: string | null;
  org_name: string | null;
}

const SELECT_WITH_ORG = `
  SELECT u.*, o.code AS org_code, o.name AS org_name
    FROM users u LEFT JOIN organizations o ON o.id = u.organization_id`;

export function findUserByEmail(email: string): UserRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM users WHERE lower(email) = lower(?)`)
    .get(email.trim()) as unknown as UserRow | undefined;
}

function toSessionUser(row: UserWithOrg): SessionUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    organizationId: row.organization_id,
    organizationCode: row.org_code,
    organizationName: row.org_name,
    demoSwitched: false,
  };
}

export function getUser(id: number): SessionUser | undefined {
  const row = getDb()
    .prepare(`${SELECT_WITH_ORG} WHERE u.id = ?`)
    .get(id) as UserWithOrg | undefined;
  if (!row || row.status !== 'active') return undefined;
  return toSessionUser(row);
}

export function getUserRequired(id: number): SessionUser {
  const user = getUser(id);
  if (!user) throw errors.notFound('User');
  return user;
}

export function listUsers(): Array<Omit<SessionUser, 'demoSwitched'> & { status: string; last_login_at: string | null; created_at: string }> {
  const rows = getDb()
    .prepare(`${SELECT_WITH_ORG} ORDER BY u.id`)
    .all() as unknown as UserWithOrg[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    organizationId: r.organization_id,
    organizationCode: r.org_code,
    organizationName: r.org_name,
    status: r.status,
    last_login_at: r.last_login_at,
    created_at: r.created_at,
  }));
}

export function countUsers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function insertUser(input: {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  organizationId: number | null;
}): number {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO users (name, email, password_hash, role, organization_id) VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.name, input.email.toLowerCase(), input.passwordHash, input.role, input.organizationId);
    return Number(res.lastInsertRowid);
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed: users.email')) {
      throw errors.conflict(`A user with email ${input.email} already exists`);
    }
    throw err;
  }
}

export function touchLastLogin(userId: number): void {
  getDb().prepare(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), userId);
}
