import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { errors } from '@/lib/errors';
import { requireApiPermission } from '@/lib/auth/guard';
import { maxUploadMbFor } from '@/lib/config';
import { executeIntegration } from '@/lib/integrations/integration-service';
import { getAdapterRequired } from '@/lib/integrations/registry';
import { getOrganizationByCode } from '@/lib/db/repositories/organization-repository';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/execute — start an integration import.
 *
 * Runs the adapter analysis, then hands the canonical rows to the EXISTING
 * Import Center (analyzeImport → chunked async import job). The integration
 * layer never writes material rows itself. Server-side authorization:
 * IMPORT_MATERIALS + organization scoping (the client-provided CPSE is never
 * trusted).
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

    const result = executeIntegration({
      adapterId: adapter.id,
      fileName,
      payload,
      actor: user.email,
    });
    return ok(result, 202);
  } catch (err) {
    return fail(err);
  }
}
