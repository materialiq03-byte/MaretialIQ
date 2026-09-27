/**
 * Server-side session management. Sessions are DB rows referenced by an
 * http-only cookie; the browser never carries role or identity claims —
 * every request resolves identity from this table.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../db/client';
import { nowIso } from '../db/util';
import { getUser, getUserRequired } from './user-repository';
import type { SessionUser } from './types';

const SESSION_TTL_HOURS = 12;

export function createSession(input: {
  userId: number;
  via: 'login' | 'demo_switch';
  demoOfUserId?: number | null;
}): { sessionId: string; expiresAt: string } {
  const sessionId = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_via, demo_of_user_id) VALUES (?, ?, ?, ?, ?)`
    )
    .run(sessionId, input.userId, expiresAt, input.via, input.demoOfUserId ?? null);
  return { sessionId, expiresAt };
}

export function getSessionUser(sessionId: string | undefined): SessionUser | null {
  if (!sessionId) return null;
  const row = getDb()
    .prepare(`SELECT user_id, expires_at, created_via, demo_of_user_id FROM sessions WHERE id = ?`)
    .get(sessionId) as
    | { user_id: number; expires_at: string; created_via: string; demo_of_user_id: number | null }
    | undefined;
  if (!row) return null;
  if (row.expires_at <= nowIso()) {
    deleteSession(sessionId);
    return null;
  }
  const user = getUser(row.user_id);
  if (!user) return null;
  return { ...user, demoSwitched: row.created_via === 'demo_switch' };
}

export function deleteSession(sessionId: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

/** Remove expired sessions (housekeeping, called on login). */
export function purgeExpiredSessions(): void {
  getDb().prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(nowIso());
}

export function countSessions(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
}

/** Test/dev helper: resolve a user straight from a user id. */
export function userById(id: number): SessionUser {
  return getUserRequired(id);
}
