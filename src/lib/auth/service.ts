/**
 * Authentication service — login, logout, demo role switching.
 * All security-sensitive events are audit-logged; passwords are never logged.
 */
import { cookies } from 'next/headers';
import { verifyPassword } from './password';
import { findUserByEmail, touchLastLogin, getUserRequired } from './user-repository';
import { createSession, deleteSession, purgeExpiredSessions } from './session';
import { getSessionUser } from './session';
import { SESSION_COOKIE } from './constants';
import { recordAudit } from '../db/repositories/audit-repository';
import { errors } from '../errors';
import { config } from '../config';
import type { SessionUser } from './types';

export { getCurrentUser } from './guard';

export interface LoginResult {
  user: SessionUser;
  expiresAt: string;
}

const GENERIC_FAILURE = 'Invalid email or password.';

export async function login(email: string, password: string): Promise<LoginResult> {
  purgeExpiredSessions();
  const user = findUserByEmail(email);
  if (!user) {
    recordAudit({
      action: 'user_login_failed',
      entityType: 'user',
      actor: email.trim().slice(0, 120),
      details: { reason: 'unknown_email' },
    });
    throw errors.unauthorized(GENERIC_FAILURE);
  }
  if (user.status !== 'active') {
    recordAudit({
      action: 'user_login_failed',
      entityType: 'user',
      entityId: user.id,
      actor: user.email,
      details: { reason: 'account_inactive' },
    });
    throw errors.forbidden('This account is inactive. Contact a platform administrator.');
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    recordAudit({
      action: 'user_login_failed',
      entityType: 'user',
      entityId: user.id,
      actor: user.email,
      details: { reason: 'bad_password' },
    });
    throw errors.unauthorized(GENERIC_FAILURE);
  }

  const { sessionId, expiresAt } = createSession({ userId: user.id, via: 'login' });
  touchLastLogin(user.id);
  recordAudit({
    action: 'user_login',
    entityType: 'user',
    entityId: user.id,
    actor: user.email,
    details: { role: user.role, organizationId: user.organization_id },
  });
  await setSessionCookie(sessionId, expiresAt);
  return { user: getSessionUser(sessionId)!, expiresAt };
}

/** Invalidate the current session and clear the cookie. Await in routes. */
export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (sessionId) {
    const user = getSessionUser(sessionId);
    deleteSession(sessionId);
    if (user) {
      recordAudit({
        action: 'user_logout',
        entityType: 'user',
        entityId: user.id,
        actor: user.email,
      });
    }
  }
  await clearSessionCookie();
}

/** Demo role switcher: creates a REAL session for the target demo account. */
export async function demoSwitch(targetUserId: number, actorEmail: string): Promise<LoginResult> {
  if (!isDemoModeEnabled()) {
    throw errors.forbidden('Demo role switching is disabled in this environment');
  }
  const target = getUserRequired(targetUserId);
  const { sessionId, expiresAt } = createSession({
    userId: target.id,
    via: 'demo_switch',
    demoOfUserId: target.id,
  });
  recordAudit({
    action: 'demo_role_switched',
    entityType: 'user',
    entityId: target.id,
    actor: actorEmail,
    details: { switchedTo: target.email, role: target.role },
  });
  await setSessionCookie(sessionId, expiresAt);
  return { user: getSessionUser(sessionId)!, expiresAt };
}

export function isDemoModeEnabled(): boolean {
  return config.env !== 'production' || process.env.ALLOW_DEMO_SWITCH === 'true';
}

async function setSessionCookie(sessionId: string, expiresAt: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    path: '/',
    expires: new Date(expiresAt),
  });
}

async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}
