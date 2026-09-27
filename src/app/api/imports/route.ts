import { readBoundedJson } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail, parsePagination } from '@/lib/api-helpers';
import { errors } from '@/lib/errors';
import { requireApiPermission, visibleOrganizationIds, assertOrganizationWrite } from '@/lib/auth/guard';
import { maxUploadMbFor } from '@/lib/config';
import { parseOrThrow, idSchema } from '@/lib/validation/schemas';
import { parseImportFile } from '@/lib/services/file-parse-service';
import { performImport } from '@/lib/services/material-service';
import { listImports } from '@/lib/db/repositories/import-repository';
import { getOrganization, getOrganizationByCode } from '@/lib/db/repositories/organization-repository';

export const dynamic = 'force-dynamic';

/** Resolve an org from a numeric id or a CPSE code string. */
function resolveOrganization(value: string): number {
  if (!value) throw errors.badRequest('organizationCode or organizationId is required');
  if (/^\d+$/.test(value)) return parseOrThrow(idSchema, value);
  const org = getOrganizationByCode(value);
  if (!org) throw errors.notFound(`CPSE organization "${value}"`);
  return org.id;
}

/**
 * POST /api/imports — legacy one-shot programmatic import (Import Center uses
 * analyze/execute). The caller may only import into their own organization.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireApiPermission('IMPORT_MATERIALS');
    let organizationId: number;
    let fileName: string;
    let fileType: 'csv' | 'xlsx';
    let payload: ArrayBuffer | string;
    let actor = user.email;

    const contentType = request.headers.get('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) throw errors.badRequest('Multipart field "file" is required');
      fileName = file.name;
      {
        const limitMb = maxUploadMbFor(fileName);
        if (file.size > limitMb * 1024 * 1024) {
          const isCsv = fileName.toLowerCase().endsWith('.csv');
          throw errors.badRequest(
            isCsv
              ? `CSV file exceeds the configured ${limitMb} MB upload limit. For larger enterprise ingestion, use the supported enterprise ingestion pipeline.`
              : `XLSX file exceeds the ${limitMb} MB safety limit. XLSX parsing is memory-sensitive — export the material master as CSV for large datasets.`
          );
        }
      }
      const lower = fileName.toLowerCase();
      if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
        throw errors.badRequest('Only .csv and .xlsx files are supported');
      }
      fileType = lower.endsWith('.csv') ? 'csv' : 'xlsx';
      payload = await file.arrayBuffer();
      organizationId = resolveOrganization(
        String(form.get('organizationCode') ?? form.get('organizationId') ?? '')
      );
      const actorField = form.get('actor');
      if (typeof actorField === 'string' && actorField.trim()) actor = actorField.trim().slice(0, 120);
    } else {
      const body = (await readBoundedJson<unknown>(request).catch(() => null)) as
        | { organizationCode?: string; organizationId?: number; fileName?: string; csv?: string }
        | null;
      if (!body) throw errors.badRequest('JSON body required');
      fileName = (body.fileName ?? 'upload.csv').trim();
      fileType = fileName.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
      payload = body.csv ?? '';
      if (!payload.trim()) throw errors.badRequest('csv content is required for JSON import');
      organizationId = resolveOrganization(
        body.organizationCode ?? (body.organizationId !== undefined ? String(body.organizationId) : '')
      );
    }

    assertOrganizationWrite(user, organizationId);

    const parsed = parseImportFile(fileName, payload);
    if (parsed.rows.length === 0) {
      throw errors.badRequest('No data rows found in file', parsed.errors);
    }

    const rows = parsed.rows.map((r) => ({
      organizationId,
      originalCode: r.canonical.originalCode ?? '',
      originalDescription: r.canonical.originalDescription ?? '',
      category: r.canonical.category || 'Uncategorised',
      subcategory: r.canonical.subcategory || undefined,
      manufacturer: r.canonical.manufacturer || undefined,
      model: r.canonical.model || undefined,
      partNumber: r.canonical.partNumber || undefined,
      uom: r.canonical.uom || 'NOS',
    }));

    const result = performImport({ organizationId, fileName, fileType, rows, actor });

    return ok(
      {
        importId: result.importId,
        summary: {
          totalRows: result.totalRows,
          successfulRows: result.successfulRows,
          failedRows: result.failedRows,
          newMaterials: result.newMaterials,
          duplicateCodes: result.duplicateCodes,
          warnings: result.warnings,
          missingDescriptions: result.missingDescriptions,
        },
        errors: result.errors,
      },
      201
    );
  } catch (err) {
    return fail(err);
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiPermission('IMPORT_MATERIALS');
    const params = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(params);
    const status = params.get('status') ?? undefined;
    const organizationId = params.get('organizationId');
    // Org scoping: CPSE users see only their own import history.
    const scope = visibleOrganizationIds(user);
    const scopedOrgId =
      scope === null
        ? organizationId
          ? parseOrThrow(idSchema, organizationId)
          : undefined
        : scope[0];
    const result = listImports({
      organizationId: scopedOrgId,
      status: status as never,
      page,
      pageSize,
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
