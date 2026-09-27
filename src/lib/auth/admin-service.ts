/**
 * Platform-administration service for user management. Every mutation is
 * audit-logged. Only PLATFORM_ADMIN (MANAGE_USERS) may call these — enforced
 * at the route layer.
 */
import { withTransaction } from '../db/client';
import { hashPassword } from './password';
import { insertUser, listUsers, findUserByEmail } from './user-repository';
import { getOrganizationRequired } from '../db/repositories/organization-queries';
import { recordAudit } from '../db/repositories/audit-repository';
import { errors } from '../errors';
import { getDb } from '../db/client';
import type { Role } from './types';

export interface AdminUserView {
  id: number;
  name: string;
  email: string;
  role: Role;
  organizationId: number | null;
  organizationCode: string | null;
  organizationName: string | null;
  status: string;
  last_login_at: string | null;
  created_at: string;
}

export { listUsers };

const CPSE_ROLES: Role[] = ['cpse_material_manager', 'cpse_technical_reviewer'];

/** Create a user (password hashed with scrypt) and audit the creation. */
export async function createUserAsync(
  input: {
    name: string;
    email: string;
    password: string;
    role: Role;
    organizationId?: number | null;
  },
  actor: string
): Promise<AdminUserView> {
  if (input.password.length < 8) {
    throw errors.badRequest('Password must be at least 8 characters.');
  }
  let organizationId = input.organizationId ?? null;
  if (CPSE_ROLES.includes(input.role)) {
    if (!organizationId) throw errors.badRequest('CPSE roles require an organization.');
    getOrganizationRequired(organizationId);
  } else {
    organizationId = null;
  }
  if (findUserByEmail(input.email)) {
    throw errors.conflict(`A user with email ${input.email} already exists`);
  }
  const passwordHash = await hashPassword(input.password);
  const id = withTransaction(() =>
    insertUser({
      name: input.name,
      email: input.email,
      passwordHash,
      role: input.role,
      organizationId,
    })
  );
  recordAudit({
    action: 'user_created',
    entityType: 'user',
    entityId: id,
    actor,
    details: { email: input.email.toLowerCase(), role: input.role, organizationId },
  });
  return getUserView(id);
}

export function getUserView(id: number): AdminUserView {
  const row = getDb()
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.organization_id, u.status, u.last_login_at, u.created_at,
              o.code AS org_code, o.name AS org_name
         FROM users u LEFT JOIN organizations o ON o.id = u.organization_id WHERE u.id = ?`
    )
    .get(id) as
    | (Omit<AdminUserView, 'organizationId' | 'organizationCode' | 'organizationName'> & {
        organization_id: number | null;
        org_code: string | null;
        org_name: string | null;
      })
    | undefined;
  if (!row) throw errors.notFound('User');
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    organizationId: row.organization_id,
    organizationCode: row.org_code,
    organizationName: row.org_name,
    status: row.status,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
  };
}

/** Change role and/or organization; CPSE roles must keep an organization. */
export function updateUserRole(
  userId: number,
  input: { role?: Role; organizationId?: number | null; status?: 'active' | 'inactive' },
  actor: string
): AdminUserView {
  return withTransaction(() => {
    const current = getUserView(userId);
    const role = input.role ?? current.role;
    let organizationId = input.organizationId !== undefined ? input.organizationId : current.organizationId;
    if (CPSE_ROLES.includes(role)) {
      if (!organizationId) throw errors.badRequest('CPSE roles require an organization.');
      getOrganizationRequired(organizationId);
    }
    if (userId === actorId(actor) && input.role && input.role !== 'platform_admin') {
      throw errors.badRequest('Administrators cannot demote their own account via role switching.');
    }
    getDb()
      .prepare(`UPDATE users SET role = ?, organization_id = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(role, organizationId, input.status ?? current.status, new Date().toISOString(), userId);
    recordAudit({
      action: 'user_role_changed',
      entityType: 'user',
      entityId: userId,
      actor,
      details: { from: { role: current.role, org: current.organizationId }, to: { role, organizationId } },
    });
    return getUserView(userId);
  });
}

/** Resolve the acting admin's user id from their email (audit context). */
function actorId(email: string): number {
  const row = getDb().prepare(`SELECT id FROM users WHERE lower(email) = lower(?)`).get(email) as
    | { id: number }
    | undefined;
  return row?.id ?? -1;
}
