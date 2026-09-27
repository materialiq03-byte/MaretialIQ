import { NextRequest } from 'next/server';
import { fail, ok } from '@/lib/api-helpers';
import { requireApiPermission, assertOrganizationWrite } from '@/lib/auth/guard';
import { getImportRequired } from '@/lib/db/repositories/import-repository';

export const dynamic = 'force-dynamic';

function csvEscape(v: string): string {
  // Step 25 §13 — CSV formula-injection defense: a cell beginning with =, +,
  // - or @ (or tab/CR) is interpreted as a formula by spreadsheet apps.
  // Imported text can reach these cells via validation messages, so prefix a
  // single quote at the ENCODING layer only — the authoritative row_report
  // and any stored data are never mutated. Checked BEFORE quoting: a quoted
  // cell like "+1,2" would otherwise still parse back to a formula.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * GET /api/imports/:id/errors — downloadable CSV error report for an import
 * (row number, severity, rules, messages) for the full audit trail.
 */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireApiPermission('IMPORT_MATERIALS');
    const { id } = await ctx.params;
    const importId = Number(id);
    if (!Number.isInteger(importId) || importId <= 0) {
      throw (await import('@/lib/errors')).errors.badRequest('Invalid import id');
    }
    const imp = getImportRequired(importId);
    assertOrganizationWrite(user, imp.organization_id);

    const lines: string[] = ['row_number,severity,rules,message'];
    if (imp.row_report) {
      try {
        const report = JSON.parse(imp.row_report) as {
          rows?: Array<{
            rowNumber: number;
            severity: string;
            problems?: Array<{ rule: string; severity: string; message: string }>;
          }>;
          problems?: Array<{
            rowNumber: number;
            severity: string;
            problems?: Array<{ rule: string; severity: string; message: string }>;
          }>;
        };
        // Bounded reports carry problem rows under `problems`; legacy full
        // reports embed every row under `rows`.
        const reportRows = report.rows ?? report.problems ?? [];
        for (const row of reportRows) {
          if (!row.problems || row.problems.length === 0) continue;
          const rules = row.problems.map((p) => p.rule).join('; ');
          const messages = row.problems.map((p) => `[${p.severity}] ${p.message}`).join(' | ');
          lines.push([String(row.rowNumber), row.severity, csvEscape(rules), csvEscape(messages)].join(','));
        }
      } catch {
        // Corrupt report → emit header-only CSV; the JSON report on the
        // import detail page remains the source of truth.
      }
    }
    const csv = lines.join('\r\n') + '\r\n';
    return new Response(csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="import-${importId}-errors.csv"`,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err) {
    return fail(err);
  }
}
