/** Edge-safe constants (imported by middleware — no Node-only imports here). */

export const SESSION_COOKIE = 'materialiq_session';

/** Routes reachable without a session. Everything else is protected. */
export const PUBLIC_PATHS = [
  '/login',
  '/api/auth/login',
  '/api/auth/demo-switch',
  '/api/health',
  '/api/health/live',
  '/api/health/ready',
];

/** Prefixes treated as public (static assets, Next internals). */
export const PUBLIC_PREFIXES = ['/_next', '/favicon', '/samples/'];
