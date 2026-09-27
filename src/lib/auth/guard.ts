/**
 * Central authorization guards — the ONLY place pages and routes obtain the
 * current user. Server components use requireUser/requirePermission (which
 * redirect or render 403); route handlers use requireApiUser/requireApiPermission
 * (which throw typed errors mapped to 401/403 JSON).
 */
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from './constants';
import { getSessionUser } from './session';
import { roleHasPermission, type Permission } from './permissions';
import { errors } from '../errors';
import { config } from '../config';
import type { SessionUser } from './types';

/**
 * SIH prototype identity, used when no session cookie is present and
 * prototype mode is on. Full-permission (platform_admin-equivalent) with no
 * organization scope, so every page and API is reachable and all five demo
 * CPSEs are visible. Nothing is persisted to the sessions table.
 */
const PROTOTYPE_USER: SessionUser = {
  id: 0,
  name: 'SIH Demo Operator',
  email: 'prototype@materialiq.demo',
  role: 'platform_admin',
  organizationId: null,
  organizationCode: null,
  organizationName: null,
  demoSwitched: false,
};

/** Resolve the authenticated user from the request cookie, or null. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  const user = getSessionUser(sessionId);
  if (user) return user;
  // SIH prototype mode: no session → full-permission prototype identity.
  // Downstream permission and scoping helpers treat it like a real
  // platform_admin. Nothing is persisted to the sessions table.
  if (config.prototypeMode) return PROTOTYPE_USER;
  return null;
}

/** For server components: redirect anonymous users to /login. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * For server components: require an authenticated user with the given
 * permission. Missing permission renders the 403 page via redirect.
 */
export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await requireUser();
  if (!roleHasPermission(user.role, permission)) redirect('/403');
  return user;
}

/** For route handlers: throws 401 AppError when unauthenticated. */
export async function requireApiUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw errors.unauthorized();
  return user;
}

/** For route handlers: throws 401/403 AppError as appropriate. */
export async function requireApiPermission(permission: Permission): Promise<SessionUser> {
  const user = await requireApiUser();
  if (!roleHasPermission(user.role, permission)) throw errors.forbidden();
  return user;
}

/**
 * Organization scoping for a mutation on a material owned by `orgId`.
 * CPSE roles may only touch their own organization; authority has no write
 * access here at all; platform_admin passes everywhere.
 */
export function assertOrganizationWrite(user: SessionUser, orgId: number): void {
  if (user.role === 'platform_admin') return;
  if (user.role === 'authority') {
    throw errors.forbidden('Authority users have read-only oversight access');
  }
  if (user.organizationId !== orgId) {
    throw errors.forbidden('This record belongs to a different CPSE organization');
  }
}

/** Read-scoping: which organization ids may this user see? null = all. */
export function visibleOrganizationIds(user: SessionUser): number[] | null {
  if (user.role === 'platform_admin' || user.role === 'authority') return null;
  return user.organizationId ? [user.organizationId] : [];
}
