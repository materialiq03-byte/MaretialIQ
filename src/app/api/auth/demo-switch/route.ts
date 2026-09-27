/**
 * Demo role switching API — Step 26 gap fix.
 *
 * The /admin Demo Role Switcher has POSTed here since it was built, but the
 * route itself was never implemented (404). The demoSwitch() service owns
 * every rule: it refuses unless demo mode is enabled (non-production or the
 * explicit ALLOW_DEMO_SWITCH=true escape hatch), creates a REAL session for
 * the target account (never elevating beyond that account's actual role),
 * records a demo_role_switched audit entry, and sets the session cookie.
 *
 * Caller must hold MANAGE_USERS — the same permission that gates the /admin
 * page hosting the switcher — so an ordinary session cannot mint a new
 * identity.
 */
import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { demoSwitch } from '@/lib/auth/service';
import { readBoundedJson } from '@/lib/security/request-limit';
import { demoSwitchSchema, parseOrThrow } from '@/lib/validation/schemas';

export async function POST(request: NextRequest) {
  try {
    const actor = await requireApiPermission('MANAGE_USERS');
    const body = await readBoundedJson<unknown>(request);
    const { userId } = parseOrThrow(demoSwitchSchema, body);
    const result = await demoSwitch(userId, actor.email);
    return ok({ user: result.user, expiresAt: result.expiresAt });
  } catch (err) {
    return fail(err);
  }
}
