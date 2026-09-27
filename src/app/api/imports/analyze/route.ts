import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { errors } from '@/lib/errors';
import { requireApiPermission } from '@/lib/auth/guard';
import { config, maxUploadMbFor } from '@/lib/config';
import { analyzeImportBounded, analyzeCsvStreaming, PREVIEW_MAX_ROWS } from '@/lib/services/import-job-service';

export const dynamic = 'force-dynamic';

const MAPPING_KEYS = [
  'originalCode', 'originalDescription', 'category', 'subcategory', 'manufacturer', 'model', 'partNumber', 'uom',
  'orgCode', 'size', 'materialType', 'voltage', 'pressureRating', 'power', 'temperatureRating', 'sealType',
  'bearingType', 'grade',
] as const;

/**
 * POST /api/imports/analyze — bounded analysis. Parse + map + validate
 * WITHOUT touching the material master; the response carries ONLY the
 * summary, a bounded preview (≤100 rows) and bounded validation diagnostics —
 * never the full validated row set. The import record keeps the full row
 * report server-side for the paginated preview + CSV error download.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireApiPermission('IMPORT_MATERIALS');
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      // Malformed multipart body must surface as 400, not an unhandled 500.
      throw errors.badRequest('Expected a multipart/form-data request with a "file" field');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw errors.badRequest('Multipart field "file" is required');
    const fileName = file.name;
    const limitMb = maxUploadMbFor(fileName);
    if (file.size > limitMb * 1024 * 1024) {
      const isCsv = fileName.toLowerCase().endsWith('.csv');
      throw errors.badRequest(
        isCsv
          ? `CSV file exceeds the configured ${limitMb} MB upload limit. For larger enterprise ingestion, use the supported enterprise ingestion pipeline.`
          : `XLSX file exceeds the ${limitMb} MB safety limit. XLSX parsing is memory-sensitive — export the material master as CSV for large datasets.`
      );
    }
    const lower = fileName.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
      throw errors.badRequest('Only .csv and .xlsx files are supported');
    }
    const orgField = String(form.get('organizationCode') ?? form.get('organizationId') ?? '').trim();
    if (!orgField) throw errors.badRequest('organizationCode is required');

    let mapping: Record<string, string | null> | null = null;
    const rawMapping = form.get('mapping');
    if (typeof rawMapping === 'string' && rawMapping.trim()) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawMapping) as Record<string, unknown>;
      } catch {
        throw errors.badRequest('mapping must be valid JSON');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw errors.badRequest('mapping must be a JSON object');
      }
      mapping = {};
      for (const key of MAPPING_KEYS) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) mapping[key] = value.trim();
        else mapping[key] = null;
        if (value !== undefined && value !== null && typeof value !== 'string') {
          throw errors.badRequest(`Invalid mapping value for "${key}"`);
        }
      }
    }

    const payload = await file.arrayBuffer();
    // Org authorization is checked inside analyzeImport via getOrganizationRequired.
    const org = await import('@/lib/db/repositories/organization-repository').then((m) =>
      m.getOrganizationByCode(orgField.toUpperCase())
    );
    const organizationId = org?.id ?? (Number.isInteger(Number(orgField)) ? Number(orgField) : NaN);
    if (!organizationId || Number.isNaN(organizationId)) {
      throw errors.notFound(`CPSE organization "${orgField}"`);
    }
    const numericOrgId = organizationId as number;
    if (user.organizationId && user.organizationId !== numericOrgId && user.role !== 'platform_admin') {
      throw errors.forbidden('This import targets a different CPSE organization');
    }
    const fileType: 'csv' | 'xlsx' = lower.endsWith('.csv') ? 'csv' : 'xlsx';

    // Step 12: CSV takes the bounded streaming path (O(1) row memory);
    // XLSX stays on the batch path (workbook parsing is memory-bound and
    // covered by its own safety limit).
    if (fileType === 'csv') {
      const result = analyzeCsvStreaming(
        Buffer.from(payload),
        fileName,
        fileType,
        numericOrgId,
        mapping,
      );
      return ok(result);
    }

    const result = analyzeImportBounded({
      organizationId: numericOrgId,
      fileName,
      fileType,
      payload,
      mapping,
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/** Advertised bound, handy for clients/tests. */
export async function GET() {
  return ok({ previewMaxRows: PREVIEW_MAX_ROWS });
}
