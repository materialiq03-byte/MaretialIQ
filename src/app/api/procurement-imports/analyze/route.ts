import { NextRequest } from 'next/server';
import { ok, fail } from '@/lib/api-helpers';
import { errors } from '@/lib/errors';
import { requireApiPermission, assertOrganizationWrite } from '@/lib/auth/guard';
import { config, maxUploadMbFor } from '@/lib/config';
import { analyzeProcurementCsv } from '@/lib/services/procurement-import-service';
import { getOrganizationByCode } from '@/lib/db/repositories/organization-repository';

export const dynamic = 'force-dynamic';

const MAPPING_KEYS = [
  'organization', 'materialCode', 'supplier', 'purchaseDate', 'quantity', 'uom',
  'poReference', 'deliveryDate', 'unitPrice', 'currency', 'status', 'plantLocation', 'cmiCode',
] as const;

/**
 * POST /api/procurement-imports/analyze — bounded analysis (read-only with
 * respect to business procurement data). Parses + maps + validates WITHOUT
 * inserting procurement rows; the response carries only the summary, a
 * bounded preview and bounded diagnostics. Persists an import record +
 * row_report for the execution phase (same lifecycle as material analyze).
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireApiPermission('IMPORT_MATERIALS');
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
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
          ? `CSV file exceeds the configured ${limitMb} MB upload limit. Split large procurement histories or use the supported ingestion pipeline.`
          : `XLSX file exceeds the ${limitMb} MB safety limit. XLSX parsing is memory-sensitive — export procurement data as CSV for large datasets.`
      );
    }
    const lower = fileName.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
      throw errors.badRequest('Only .csv and .xlsx files are supported');
    }
    const orgField = String(form.get('organizationCode') ?? form.get('organizationId') ?? '').trim();
    if (!orgField) throw errors.badRequest('organizationCode is required (default CPSE for rows without a CPSE column)');

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

    const org = getOrganizationByCode(orgField.toUpperCase());
    const organizationId = org?.id ?? (Number.isInteger(Number(orgField)) ? Number(orgField) : NaN);
    if (!organizationId || Number.isNaN(organizationId)) {
      throw errors.notFound(`CPSE organization "${orgField}"`);
    }
    if (user.organizationId && user.organizationId !== organizationId && user.role !== 'platform_admin') {
      throw errors.forbidden('This import targets a different CPSE organization');
    }
    assertOrganizationWrite(user, organizationId);

    const payload = Buffer.from(await file.arrayBuffer());
    const fileType: 'csv' | 'xlsx' = lower.endsWith('.csv') ? 'csv' : 'xlsx';
    const result = analyzeProcurementCsv(payload, fileName, fileType, organizationId as number, mapping);
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/** Advertised bound. */
export async function GET() {
  return ok({ previewMaxRows: 100, limits: { csvMb: config.pipeline.maxCsvImportMb, xlsxMb: config.pipeline.maxXlsxImportMb } });
}
