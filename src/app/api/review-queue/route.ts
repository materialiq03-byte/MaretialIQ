import { NextRequest } from 'next/server';
import { ok, fail, parsePagination } from '@/lib/api-helpers';
import { requireApiPermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { getDb } from '@/lib/db/client';
import { queueQuerySchema, parseOrThrow } from '@/lib/validation/schemas';
import { parseReviewSort } from '@/lib/db/repositories/matching-repository';
import { getReviewSummary, reviewSortSql } from '@/lib/services/match-review-service';
import type { QueueStatus, QueuePriority } from '@/lib/types/domain';

export async function GET(request: NextRequest) {
  try {
    const user = await requireApiPermission('VIEW_MATCHES');
    const params = request.nextUrl.searchParams;
    const query = parseOrThrow(queueQuerySchema, {
      status: params.get('status') || undefined,
      priority: params.get('priority') || undefined,
      category: params.get('category') || undefined,
      band: params.get('band') || undefined,
      conflict: params.get('conflict') || undefined,
      sort: params.get('sort') || undefined,
    });
    const { page, pageSize } = parsePagination(params);
    const sort = parseReviewSort(query.sort);
    const clauses: string[] = [];
    const dbParams: Array<string | number> = [];
    if (query.status) {
      clauses.push('rq.status = ?');
      dbParams.push(query.status as QueueStatus);
    }
    if (query.priority) {
      clauses.push('rq.priority = ?');
      dbParams.push(query.priority as QueuePriority);
    }
    if (query.category) {
      clauses.push('s.category = ?');
      dbParams.push(query.category);
    }
    if (query.band) {
      // Decision band lives in the persisted evidence document (existing
      // JSON1 extraction — same mechanism the matching filters use).
      clauses.push("json_extract(mc.evidence, '$.decision.band') = ?");
      dbParams.push(query.band);
    }
    if (query.conflict === '1') {
      clauses.push("json_array_length(mc.evidence, '$.criticalConflicts') > 0");
    }
    // Org scoping: CPSE users see queue items for matches involving their org.
    const scope = visibleOrganizationIds(user);
    if (scope !== null) {
      clauses.push(`(s.organization_id = ? OR c.organization_id = ?)`);
      dbParams.push(scope[0], scope[0]);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const items = getDb()
      .prepare(
        `SELECT rq.*, s.original_code AS s_code, so.code AS s_org,
                c.original_code AS c_code, co.code AS c_org,
                mc.final_score, mc.match_type, mc.critical_difference, mc.status AS match_status
           FROM review_queue rq
           JOIN match_candidates mc ON mc.id = rq.match_id
           JOIN material_records s ON s.id = mc.source_material_id
           JOIN organizations so ON so.id = s.organization_id
           JOIN material_records c ON c.id = mc.candidate_material_id
           JOIN organizations co ON co.id = c.organization_id
           ${where} ORDER BY ${reviewSortSql(sort)} LIMIT ? OFFSET ?`
      )
      .all(...dbParams, pageSize, (page - 1) * pageSize);
    const total = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM review_queue rq
             JOIN match_candidates mc ON mc.id = rq.match_id
             JOIN material_records s ON s.id = mc.source_material_id
             JOIN material_records c ON c.id = mc.candidate_material_id
             ${where}`
        )
        .get(...dbParams) as { n: number }
    ).n;
    // Compact review metrics (§19) ride along — real data, one extra scan.
    let summary: ReturnType<typeof getReviewSummary> | null = null;
    if (params.get('summary') === '1') {
      try {
        summary = getReviewSummary();
      } catch {
        summary = null; // never break the listing on summary failure
      }
    }
    return ok({ items, total, page, pageSize, sort, summary });
  } catch (err) {
    return fail(err);
  }
}
