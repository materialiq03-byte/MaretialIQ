/**
 * Step 25 — bounded in-memory rate limiter (edge-safe, no dependencies).
 *
 * Fixed-window counter per key. Deliberately simple: this prototype deploys
 * as a SINGLE Next.js instance, where one in-process map is correct and adds
 * no infrastructure dependency (no Redis, per Step 25 scope). LIMITATION
 * (documented in docs/SECURITY.md): counters are per-instance and in-memory —
 * multi-instance deployments would need a shared store. This is an accepted,
 * documented prototype limitation, not a hidden weakness.
 *
 * Design rules:
 *  - deny with 429 + Retry-After, never throw
 *  - failures never block traffic (fail-open on internal error)
 *  - configurable via MATERIALIQ_RATE_LIMIT_* environment variables
 */

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
}

interface Window {
  start: number;
  count: number;
}

/**Cap map size so abusive unique keys cannot grow memory unbounded. */
const MAX_TRACKED_KEYS = 5000;

export interface RateLimitPolicy {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

/** Read a positive int from env, falling back when absent/invalid. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Policies (defaults overridable per environment):
 *  - mutations: state-changing API calls (POST/PATCH/PUT/DELETE under /api/)
 *  - auth: authentication endpoints (login/demo-switch) — strictest
 *  - reads: generous ceiling on GET APIs so the UI stays fully usable
 */
export function policies(): { mutations: RateLimitPolicy; auth: RateLimitPolicy; reads: RateLimitPolicy } {
  return {
    mutations: { limit: intEnv('MATERIALIQ_RATE_LIMIT_MUTATIONS', 60), windowSec: intEnv('MATERIALIQ_RATE_LIMIT_WINDOW_SEC', 60) },
    auth: { limit: intEnv('MATERIALIQ_RATE_LIMIT_AUTH', 10), windowSec: intEnv('MATERIALIQ_RATE_LIMIT_WINDOW_SEC', 60) },
    reads: { limit: intEnv('MATERIALIQ_RATE_LIMIT_READS', 600), windowSec: intEnv('MATERIALIQ_RATE_LIMIT_WINDOW_SEC', 60) },
  };
}

const buckets = new Map<string, Window>();

/** Consume one token for `key` under `policy`. Never throws. */
export function checkRateLimit(key: string, policy: RateLimitPolicy): RateLimitResult {
  try {
    const now = Date.now();
    const windowMs = policy.windowSec * 1000;
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.start >= windowMs) {
      if (buckets.size >= MAX_TRACKED_KEYS) {
        // Simple aging sweep: drop expired windows before refusing new keys.
        for (const [k, w] of buckets) {
          if (now - w.start >= windowMs) buckets.delete(k);
        }
        if (buckets.size >= MAX_TRACKED_KEYS && !buckets.has(key)) {
          // Pathological key churn; fail-open rather than break the app.
          return { allowed: true, limit: policy.limit, remaining: policy.limit - 1, retryAfterSec: 0 };
        }
      }
      buckets.set(key, { start: now, count: 1 });
      return { allowed: true, limit: policy.limit, remaining: policy.limit - 1, retryAfterSec: 0 };
    }

    if (bucket.count >= policy.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.start + windowMs - now) / 1000));
      return { allowed: false, limit: policy.limit, remaining: 0, retryAfterSec };
    }
    bucket.count += 1;
    return { allowed: true, limit: policy.limit, remaining: policy.limit - bucket.count, retryAfterSec: 0 };
  } catch {
    // Fail-open: rate limiting must never take the application down.
    return { allowed: true, limit: policy.limit, remaining: policy.limit, retryAfterSec: 0 };
  }
}

/** Test helper: clear all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** Test helper: current tracked key count. */
export function trackedKeyCount(): number {
  return buckets.size;
}

/**
 * Cross-Site Request Forgery defense (defense in depth on top of
 * SameSite=Lax session cookies): browsers send an Origin header on
 * cross-origin state-changing requests. If Origin is present and its host
 * differs from the request host, reject with 403 before any handler runs.
 * Non-browser clients (curl, server-to-server) send no Origin and pass.
 *
 * Loopback aliases (127.0.0.1 / ::1 / localhost) are normalized to one name
 * on BOTH sides: Next.js's NextURL canonicalizes local hostnames to
 * `localhost`, so a browser request to http://127.0.0.1:PORT would otherwise
 * carry Origin host `127.0.0.1:PORT` against request host `localhost:PORT`
 * and every legitimate same-origin local request would be rejected.
 */
function normalizedHost(hostWithPort: string): string {
  let hostname = hostWithPort.toLowerCase().trim();
  let port = '';
  const ipv6 = hostname.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (ipv6) {
    hostname = ipv6[1];
    port = ipv6[2] ?? '';
  } else {
    const idx = hostname.indexOf(':');
    if (idx >= 0) {
      port = hostname.slice(idx + 1);
      hostname = hostname.slice(0, idx);
    }
  }
  if (hostname === '127.0.0.1' || hostname === '::1' || hostname === '::ffff:127.0.0.1') hostname = 'localhost';
  return port ? `${hostname}:${port}` : hostname;
}

export function isSameOrigin(originHeader: string | null, requestHost: string): boolean {
  if (!originHeader) return true; // non-browser or same-origin clients without Origin
  let originHost: string;
  try {
    originHost = normalizedHost(new URL(originHeader).host);
  } catch {
    return false;
  }
  if (originHost === normalizedHost(requestHost)) return true;
  // Reverse proxy / tunnel deployments (e.g. trycloudflare in front of the
  // local demo server): the browser's Origin is the public HTTPS host while
  // the Next.js server sees its own localhost host. Only ONE operator-
  // configured origin is accepted, matched exactly on normalized host from a
  // server-only env var — never from a request header, never a wildcard.
  // With the variable unset the check is byte-identical to the previous
  // behavior, so CSRF stays fully enabled for every other origin.
  const trusted = (process.env.MATERIALIQ_TRUSTED_ORIGIN ?? '').trim();
  if (trusted) {
    try {
      if (originHost === normalizedHost(new URL(trusted).host)) return true;
    } catch {
      // malformed configured value -> ignore it and keep the strict check
    }
  }
  return false;
}
