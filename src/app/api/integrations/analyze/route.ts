import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { errors } from '@/lib/errors';
import { requireApiPermission } from '@/lib/auth/guard';
import { maxUploadMbFor } from '@/lib/config';
import { getAdapterRequired } from '@/lib/integrations/registry';
import { analyzeIntegration } from '@/lib/integrations/integration-service';
import { getOrganizationByCode } from '@/lib/db/repositories/organization-repository';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/analyze — read-only canonical preview (§13/§28).
 * Parses + validates the uploaded source feed through the resolved adapter
 * and returns preview + quality report computed from the ACTUAL data.
 * Creates NO import record and mutates NOTHING — idempotent and audit-silent.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireApiPermission('IMPORT_MATERIALS');

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw errors.badRequest('Expected a multipart/form-data request with "file" and "sourceSystem" fields');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw errors.badRequest('Multipart field "file" is required');
    const sourceSystem = String(form.get('sourceSystem') ?? '').trim();
    if (!sourceSystem) throw errors.badRequest('sourceSystem is required');

    // Resolve the adapter (fail-closed) and enforce org scoping server-side —
    // the client-provided CPSE is never trusted (§19).
    const adapter = getAdapterRequired(sourceSystem);
    if (user.organizationId) {
      const org = getOrganizationByCode(adapter.cpse);
      if (org && user.organizationId !== org.id) {
        throw errors.forbidden(`This source profile belongs to CPSE ${adapter.cpse}`);
      }
    }

    const fileName = file.name;
    const lower = fileName.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
      throw errors.badRequest('Unsupported source format: only .csv and .xlsx feeds are accepted', {
        code: 'UNSUPPORTED_FORMAT',
      });
    }
    // Step 25 §11 — same bounded upload limits as the Import Center.
    const limitMb = maxUploadMbFor(fileName);
    if (file.size > limitMb * 1024 * 1024) {
      throw errors.badRequest(`Source feed exceeds the configured ${limitMb} MB upload limit.`);
    }
    const payload = await file.arrayBuffer();

    const analysis = analyzeIntegration({ adapterId: adapter.id, fileName, payload });
    return ok(analysis);
  } catch (err) {
    return fail(err);
  }
}
