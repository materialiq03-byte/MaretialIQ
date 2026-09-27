import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, PUBLIC_PATHS, PUBLIC_PREFIXES } from '@/lib/auth/constants';
import { checkRateLimit, isSameOrigin, policies, type RateLimitPolicy } from '@/lib/security/rate-limit';

/**
 * Step 25 — route-protection gate + baseline security hardening.
 *
 * Layers (edge middleware can only see the cookie, not the DB):
 *  1. Security headers on every response (CSP, nosniff, frame deny, referrer,
 *     permissions, HSTS only when the deployment is HTTPS — see addSecurityHeaders).
 *  2. Rate limiting + same-origin CSRF defense for API requests (auth endpoints
 *     strictest; mutations bounded; generous read ceiling so the UI stays usable).
 *  3. Session-cookie gate. Full server-side validation (session row, expiry,
 *     user status, role, org scope) happens in every page and route handler via
 *     requireUser/requirePermission/requireApiPermission — middleware is a
 *     fast-path filter, never the authorization boundary.
 *
 * SIH PROTOTYPE MODE (default): authentication is intentionally bypassed —
 * every request passes through and page/API guards resolve a full-permission
 * prototype identity instead of redirecting. Set REQUIRE_AUTH=true to restore
 * the cookie gate below. PROTOTYPE-ONLY configuration, not production auth.
 */
const PROTOTYPE_MODE = process.env.REQUIRE_AUTH !== 'true';

/** Endpoints that establish sessions — strictest limiter bucket. */
const AUTH_PATHS = ['/api/auth/login', '/api/auth/demo-switch'];
/** POST /logout is a mutation but must never be brute-force constrained. */
const LOGOUT_PATH = '/logout';

type RateBucketName = 'mutations' | 'auth' | 'reads';

function rateLimitBucketFor(pathname: string, method: string): { name: RateBucketName; policy: RateLimitPolicy } | null {
  const limits = policies();
  if (AUTH_PATHS.includes(pathname)) return { name: 'auth', policy: limits.auth };
  if (pathname === LOGOUT_PATH && method === 'POST') return null; // always allow self-logout
  if (pathname.startsWith('/api/')) {
    if (method === 'GET' || method === 'HEAD') return { name: 'reads', policy: limits.reads };
    return { name: 'mutations', policy: limits.mutations };
  }
  return null;
}

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0].trim() : request.headers.get('x-real-ip') ?? '';
  return ip || 'local';
}

function addSecurityHeaders(response: NextResponse, request: NextRequest): NextResponse {
  const https = request.nextUrl.protocol === 'https:';
  const csp = [
    "default-src 'self'",
    // Next.js requires inline/eval for its runtime and hydration payloads.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // SAMEORIGIN (not 'none'): same-origin embedding stays possible for local
    // tooling; third-party framing is blocked. Also sent as X-Frame-Options.
    "frame-ancestors 'self'",
  ].join('; ');
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
  );
  if (https) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return response;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return addSecurityHeaders(NextResponse.next(), request);
  }

  // CSRF same-origin defense for state-changing API requests (defense in depth
  // on top of SameSite=Lax cookies). Non-browser clients send no Origin and pass.
  const method = request.method.toUpperCase();
  const mutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (mutating && pathname.startsWith('/api/')) {
    const origin = request.headers.get('origin');
    if (!isSameOrigin(origin, request.nextUrl.host)) {
      return addSecurityHeaders(
        NextResponse.json(
          { error: { code: 'csrf_rejected', message: 'Cross-origin request rejected' } },
          { status: 403 }
        ),
        request
      );
    }
  }

  // Rate limiting: auth endpoints strictest, mutations bounded, reads generous.
  const bucket = rateLimitBucketFor(pathname, method);
  if (bucket) {
    const result = checkRateLimit(`${bucket.name}:${clientKey(request)}`, bucket.policy);
    if (!result.allowed) {
      return addSecurityHeaders(
        NextResponse.json(
          {
            error: {
              code: 'rate_limited',
              message: 'Too many requests. Please retry shortly.',
            },
          },
          { status: 429, headers: { 'Retry-After': String(result.retryAfterSec) } }
        ),
        request
      );
    }
  }

  if (PROTOTYPE_MODE) return addSecurityHeaders(NextResponse.next(), request);

  // Next.js server assets (RSC payloads, route handlers registered below the
  // app tree) still reach their own server-side guards.
  const hasSession = request.cookies.get(SESSION_COOKIE)?.value;
  if (hasSession) return addSecurityHeaders(NextResponse.next(), request);

  // API requests get JSON 401; page navigations redirect to /login.
  if (pathname.startsWith('/api/')) {
    return addSecurityHeaders(
      NextResponse.json(
        { error: { code: 'unauthorized', message: 'Authentication required' } },
        { status: 401 }
      ),
      request
    );
  }
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', pathname);
  return addSecurityHeaders(NextResponse.redirect(loginUrl), request);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
