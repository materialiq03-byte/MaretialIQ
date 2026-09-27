import { ok } from '@/lib/api-helpers';

/**
 * Step 25 — LIVENESS probe: is the process up? Deliberately does NOT touch
 * the database (a wedged DB must not crash-loop the orchestrator's liveness
 * signal). Exposes no internal details.
 */
export async function GET() {
  return ok({ status: 'live', time: new Date().toISOString() });
}
