import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { describeAdapter, listAdapters } from '@/lib/integrations/registry';
import { listIntegrationRuns } from '@/lib/integrations/integration-service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/integrations — source registry (§29) + recent integration runs.
 * Read-only and audit-silent. Exposes only declared adapter metadata — no
 * secrets, no infrastructure configuration.
 */
export async function GET(_request: NextRequest) {
  try {
    await requireApiPermission('IMPORT_MATERIALS');
    const sources = listAdapters().map(describeAdapter);
    let runs: ReturnType<typeof listIntegrationRuns> = [];
    try {
      runs = listIntegrationRuns(20);
    } catch {
      runs = []; // history listing must never break registry reads
    }
    return ok({ sources, runs });
  } catch (err) {
    return fail(err);
  }
}
