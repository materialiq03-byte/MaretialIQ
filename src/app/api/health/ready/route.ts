import { ok, fail } from '@/lib/api-helpers';
import { getDb } from '@/lib/db/client';

/**
 * Step 25 — READINESS probe: minimal bounded database connectivity check
 * (SELECT 1 — never a scan, never a count). A failure means the database is
 * unreachable; the response contains a safe status only — no connection
 * strings, no stack traces, no credentials. The generic 500 body from
 * `fail` cannot leak internals by construction.
 */
export async function GET() {
  try {
    getDb().prepare('SELECT 1 AS ok').get();
    return ok({ status: 'ready', database: 'reachable' });
  } catch (err) {
    // Log server-side (safe: error class only, never the message which could
    // contain connection details), return a generic failure.
    console.error('[health/ready] database check failed:', err instanceof Error ? err.name : 'unknown');
    return ok({ status: 'unavailable', database: 'unreachable' }, 503);
  }
}
