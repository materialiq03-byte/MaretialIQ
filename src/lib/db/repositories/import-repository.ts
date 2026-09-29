import { getDb } from '../client';
import { errors } from '../../errors';
import { nowIso } from '../util';
import type { ImportStatus } from '../../types/domain';

export interface DataImportRow {
  id: number;
  organization_id: number;
  org_code: string;
  file_name: string;
  file_type: string;
  total_rows: number;
  successful_rows: number;
  failed_rows: number;
  new_rows: number;
  duplicate_rows: number;
  warning_rows: number;
  missing_description_rows: number;
  workflow_status: 'uploaded' | 'validating' | 'ready' | 'importing' | 'completed' | 'completed_with_warnings' | 'failed';
  valid_rows: number;
  error_rows: number;
  empty_rows: number;
  imported_rows: number;
  skipped_existing_rows: number;
  updated_rows: number;
  column_mapping: string | null;
  row_report: string | null;
  duplicate_strategy: 'skip' | 'update' | null;
  validated_at: string | null;
  imported_at: string | null;
  status: ImportStatus;
  error_info: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `
  SELECT d.*, o.code AS org_code
    FROM data_imports d JOIN organizations o ON o.id = d.organization_id`;

export function listImports(opts: { organizationId?: number; status?: ImportStatus; page: number; pageSize: number }) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.organizationId !== undefined) {
    clauses.push('d.organization_id = ?');
    params.push(opts.organizationId);
  }
  if (opts.status) {
    clauses.push('d.status = ?');
    params.push(opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const offset = (opts.page - 1) * opts.pageSize;
  const items = getDb()
    .prepare(`${SELECT} ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.pageSize, offset) as unknown as DataImportRow[];
  const total = (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM data_imports d ${where}`)
      .get(...params) as unknown as { n: number }
  ).n;
  return { items, total };
}

export function getImport(id: number): DataImportRow | undefined {
  return getDb().prepare(`${SELECT} WHERE d.id = ?`).get(id) as unknown as DataImportRow | undefined;
}

export function getImportRequired(id: number): DataImportRow {
  const row = getImport(id);
  if (!row) throw errors.notFound('Import');
  return row;
}

export function createImport(input: {
  organizationId: number;
  fileName: string;
  fileType: 'csv' | 'xlsx';
  totalRows: number;
}): DataImportRow {
  const res = getDb()
    .prepare(
      `INSERT INTO data_imports (organization_id, file_name, file_type, total_rows, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
    .run(input.organizationId, input.fileName, input.fileType, input.totalRows);
  return getImportRequired(Number(res.lastInsertRowid));
}

export interface BlockedCodeCollision {
  importId: number;
  fileName: string;
  orgName: string;
  code: string;
  fileDescription: string;
  existingMaterialId: number;
  existingCode: string;
  existingDescription: string;
}

/**
 * Rows that import validation BLOCKED because their material code already
 * exists in the CPSE while the offered item identity (description) differs
 * from the stored record — a same-code/different-item collision. The row was
 * never imported; this reads the stored validation reports so the Material
 * Master can warn reviewers without inventing or merging any record.
 */
export function listBlockedCodeCollisions(): BlockedCodeCollision[] {
  const imports = getDb()
    .prepare(
      `SELECT id, file_name, row_report FROM data_imports
        WHERE workflow_status = 'completed' AND row_report IS NOT NULL
        ORDER BY id DESC LIMIT 25`
    )
    .all() as Array<{ id: number; file_name: string; row_report: string }>;

  interface ReportRow {
    values?: Record<string, string>;
    problems?: Array<{ rule: string }>;
    duplicateOf?: { materialId: number; originalCode: string };
  }
  // PERF: referenced material records used to be looked up one query per
  // collision row (N+1 over up to 25 parsed import reports). References are
  // collected first — same seen-set dedupe, same encounter order — then
  // resolved with ONE batched IN (...) lookup before finalizing.
  interface PendingCollision {
    importId: number;
    fileName: string;
    /** cpse_name from the import row, when present (falls back to the CPSE name of the stored record). */
    orgNameFromFile: string | null;
    code: string;
    fileDescription: string;
    existingMaterialId: number;
  }
  const pending: PendingCollision[] = [];
  const seen = new Set<string>();
  for (const imp of imports) {
    let report: { rows?: ReportRow[] } | null = null;
    try {
      report = JSON.parse(imp.row_report) as { rows?: ReportRow[] };
    } catch {
      continue;
    }
    for (const row of report?.rows ?? []) {
      const dup = (row.problems ?? []).find((p) => p.rule === 'duplicate_in_database');
      if (!dup || !row.duplicateOf || !row.values) continue;
      const fileDescription = (row.values['material_description'] ?? '').trim();
      const code = row.values['material_code'] ?? row.duplicateOf.originalCode;
      const key = `${code}:${row.duplicateOf.materialId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pending.push({
        importId: imp.id,
        fileName: imp.file_name,
        orgNameFromFile: row.values['cpse_name'] ?? null,
        code,
        fileDescription,
        existingMaterialId: row.duplicateOf.materialId,
      });
    }
  }
  if (pending.length === 0) return [];

  const ids = [...new Set(pending.map((p) => p.existingMaterialId))];
  const existingRows = getDb()
    .prepare(
      `SELECT mr.id, mr.original_code, mr.original_description, COALESCE(o.name, o.code, '') AS org_name
         FROM material_records mr LEFT JOIN organizations o ON o.id = mr.organization_id
        WHERE mr.id IN (${ids.map(() => '?').join(', ')})`
    )
    .all(...ids) as Array<{
    id: number; original_code: string; original_description: string | null; org_name: string;
  }>;
  const byId = new Map(existingRows.map((r) => [Number(r.id), r]));

  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  const out: BlockedCodeCollision[] = [];
  for (const p of pending) {
    const existing = byId.get(p.existingMaterialId);
    if (!existing) continue;
    if (p.fileDescription && norm(p.fileDescription) !== norm(existing.original_description)) {
      out.push({
        importId: p.importId,
        fileName: p.fileName,
        orgName: p.orgNameFromFile ?? existing.org_name,
        code: p.code,
        fileDescription: p.fileDescription,
        existingMaterialId: p.existingMaterialId,
        existingCode: existing.original_code,
        existingDescription: existing.original_description ?? '',
      });
    }
  }
  return out;
}

export function updateImportStatus(
  id: number,
  input: {
    status: ImportStatus;
    successfulRows?: number;
    failedRows?: number;
    newRows?: number;
    duplicateRows?: number;
    warningRows?: number;
    missingDescriptionRows?: number;
    errorInfo?: string;
  }
): DataImportRow {
  getImportRequired(id);
  getDb()
    .prepare(
      `UPDATE data_imports
          SET status = ?,
              successful_rows = COALESCE(?, successful_rows),
              failed_rows = COALESCE(?, failed_rows),
              new_rows = COALESCE(?, new_rows),
              duplicate_rows = COALESCE(?, duplicate_rows),
              warning_rows = COALESCE(?, warning_rows),
              missing_description_rows = COALESCE(?, missing_description_rows),
              error_info = COALESCE(?, error_info),
              updated_at = ?
        WHERE id = ?`
    )
    .run(
      input.status,
      input.successfulRows ?? null,
      input.failedRows ?? null,
      input.newRows ?? null,
      input.duplicateRows ?? null,
      input.warningRows ?? null,
      input.missingDescriptionRows ?? null,
      input.errorInfo ?? null,
      nowIso(),
      id
    );
  return getImportRequired(id);
}
