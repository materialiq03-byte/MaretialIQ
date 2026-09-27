import { NextRequest, NextResponse } from 'next/server';
import { logout } from '@/lib/auth/service';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * POST /logout — invalidate the session and clear the cookie. In SIH
 * prototype mode the operator stays signed in (back to the dashboard); with
 * REQUIRE_AUTH=true it returns to /login.
 */
export async function POST(_request: NextRequest) {
  await logout();
  const destination = config.prototypeMode ? '/' : '/login';
  return NextResponse.redirect(new URL(destination, _request.url), { status: 303 });
}
