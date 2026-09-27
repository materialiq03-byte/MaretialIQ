import { getDb } from '../client';
import { errors } from '../../errors';
import type { OrgCreate, OrgUpdate } from '../../validation/schemas';
import type { OrgStatus } from '../../types/domain';

export interface OrganizationRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  status: OrgStatus;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT * FROM organizations`;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}

export function listOrganizations(status?: OrgStatus): OrganizationRow[] {
  const rows = status
    ? getDb().prepare(`${SELECT} WHERE status = ? ORDER BY code`).all(status)
    : getDb().prepare(`${SELECT} ORDER BY code`).all();
  return rows as unknown as OrganizationRow[];
}

export function getOrganization(id: number): OrganizationRow | undefined {
  return getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as OrganizationRow | undefined;
}

export function getOrganizationByCode(code: string): OrganizationRow | undefined {
  return getDb().prepare(`${SELECT} WHERE code = ?`).get(code) as unknown as OrganizationRow | undefined;
}

export function createOrganization(input: OrgCreate): OrganizationRow {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO organizations (code, name, description) VALUES (?, ?, ?)`
      )
      .run(input.code, input.name, input.description ?? null);
    return getOrganization(Number(res.lastInsertRowid))!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw errors.conflict(`Organization code "${input.code}" already exists`);
    }
    throw err;
  }
}

export function updateOrganization(id: number, input: OrgUpdate): OrganizationRow {
  const existing = getOrganization(id);
  if (!existing) throw errors.notFound('Organization');
  const next = { ...existing, ...input };
  try {
    getDb()
      .prepare(`UPDATE organizations SET code = ?, name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(next.code, next.name, next.description ?? null, next.status, new Date().toISOString(), id);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw errors.conflict(`Organization code "${next.code}" already exists`);
    }
    throw err;
  }
  return getOrganization(id)!;
}

export function countOrganizations(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number }).n;
}
