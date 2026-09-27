import { readBoundedJson } from '@/lib/security/request-limit';
import { NextRequest } from 'next/server';
import { ok, fail, parsePagination } from '@/lib/api-helpers';
import { requireApiPermission } from '@/lib/auth/guard';
import { listProcurementRecords } from '@/lib/db/repositories/procurement-repository';
import { createProcurementRecord } from '@/lib/services/procurement-service';
import { procurementCreateSchema, parseOrThrow } from '@/lib/validation/schemas';
import type { ProcurementStatus } from '@/lib/types/domain';

/**
 * GET /api/procurement — paginated, filterable list (view permission required).
 * POST /api/procurement — create one record (create permission required);
 * CMI-consistency validation happens in the service layer.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireApiPermission('VIEW_MAPPINGS');
    void user;
    const params = request.nextUrl.searchParams;
    const { page, pageSize } = parsePagination(params);
    const orgParam = params.get('organizationId');
    const cmiParam = params.get('cmiId');
    const supParam = params.get('supplierId');
    const harmParam = params.get('harmonized');
    const result = listProcurementRecords(
      {
        organizationId: orgParam ? Number(orgParam) : undefined,
        cmiId: cmiParam ? Number(cmiParam) : undefined,
        supplierId: supParam ? Number(supParam) : undefined,
        dateFrom: params.get('dateFrom') || undefined,
        dateTo: params.get('dateTo') || undefined,
        status: (params.get('status') as ProcurementStatus) || undefined,
        harmonized: harmParam === 'true' ? true : harmParam === 'false' ? false : undefined,
      },
      page,
      pageSize
    );
    return ok({ records: result.items, total: result.total, page, pageSize });
  } catch (err) {
    return fail(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireApiPermission('EDIT_MATERIALS');
    const body = await readBoundedJson<unknown>(request);
    const input = parseOrThrow(procurementCreateSchema, body);
    const record = createProcurementRecord(
      {
        ...input,
        cmiId: input.cmiId ?? null,
        deliveryDate: input.deliveryDate ?? null,
        unitPrice: input.unitPrice ?? null,
        currency: input.currency ?? null,
        plantLocation: input.plantLocation ?? null,
        sourceSystem: input.sourceSystem ?? null,
      },
      user.email
    );
    return ok(record, 201);
  } catch (err) {
    return fail(err);
  }
}
