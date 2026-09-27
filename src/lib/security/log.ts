/**
 * Step 25 — structured security/operational logging.
 *
 * One JSON line per event to stdout/stderr, with a short correlation id so
 * operators can tie a request's events together. REDACTION IS CENTRAL:
 * sensitive keys are dropped at the logging boundary so no call site can
 * accidentally leak a secret. Never log: passwords, session ids, tokens,
 * connection strings, full material payloads.
 */

/** Keys that must never appear in log output (case-insensitive match). */
const REDACTED_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'sessionid',
  'session_id',
  'cookie',
  'cookies',
  'authorization',
  'token',
  'secret',
  'databaseurl',
  'database_url',
  'connectionstring',
  'connection_string',
  'apikey',
  'api_key',
]);

export function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Short per-request correlation id (collision-safe enough for log grouping). */
export function correlationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export type SecurityEvent =
  | 'auth_login_success'
  | 'auth_login_failure'
  | 'auth_logout'
  | 'authz_denied'
  | 'rate_limited'
  | 'csrf_rejected'
  | 'request_too_large'
  | 'import_failed'
  | 'job_failed'
  | 'db_failure'
  | 'backup_verified'
  | 'recovery_executed';

/**
 * Emit one structured security event. Writes to stderr (operational stream),
 * one JSON line. Never throws — logging must not break request handling.
 */
export function logSecurityEvent(
  event: SecurityEvent,
  meta: Record<string, unknown> = {},
  correlation?: string
): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      correlationId: correlation ?? correlationId(),
      ...redact(meta),
    });
    process.stderr.write(`${line}\n`);
  } catch {
    // Swallow logging failures by design.
  }
}
