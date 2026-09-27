/**
 * Step-5 import job execution model.
 *
 * The frozen import semantics live in import-center-service; this service
 * re-uses that code (the same analyzeImport for validation, the same
 * row-inclusion filter, the same pipeline/material writes) and changes ONLY
 * how execution is orchestrated:
 *
 *   BEFORE: executeImport() = one synchronous transaction over the whole
 *           import inside the HTTP request.
 *   AFTER:  the same persistence code runs in bounded chunks (default 500
 *           rows), each committed independently, with durable progress and
 *           a DB-authoritative single-active-import guard.
 *
 * This is an in-process prototype runner, not a distributed production
 * worker — no Redis/BullMQ/external queue is involved.
 */
import { withTransaction, getDb } from '../db/client';
import { batchInsertReturning, batchUpsert, batchUpdateColumn, maxBatchRows } from '../db/batch-writer';
import { getImportRequired, createImport } from '../db/repositories/import-repository';
import { getOrganizationRequired } from '../db/repositories/organization-queries';
import { recordAudit } from '../db/repositories/audit-repository';
import { analyzeImport, getDbNow, loadValidatedRows, loadExistingCodes, loadAllExistingCodes, type AnalyzeInput } from './import-center-service';
import { CsvRecordIterator, splitCsvLine, canonicalHeader, buildRow } from './file-parse-service';
import { suggestMapping, mappingIsUsable, RowValidator, type ImportColumnMapping, type RawRow } from './import-validation';
import { executeProcurementChunk } from './procurement-import-service';
import { config } from '../config';
import { storeUpload } from './upload-store';
import { errors } from '../errors';

/* --------------------------------- config --------------------------------- */

const CHUNK_DEFAULT = 500;
function chunkFromEnv(): number {
  const raw = Number.parseInt(process.env.IMPORT_CHUNK_SIZE ?? '', 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 5000) : CHUNK_DEFAULT;
}
function heartbeatFromEnv(): number {
  const raw = Number.parseInt(process.env.IMPORT_HEARTBEAT_TIMEOUT_SEC ?? '', 10);
  return Number.isFinite(raw) && raw >= 10 ? Math.min(raw, 3600) : 120;
}

/* ------------------------------- row types -------------------------------- */

/** Rows eligible for execution (severity + inclusions resolved at analyze time). */
export interface ImportJobRow {
  rowNumber: number;
  code: string;
  description: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  partNumber: string | null;
  uom: string;
  severity: 'VALID' | 'WARNING' | 'ERROR';
}

export interface ImportJobSummary {
  jobId: string;
  dataImportId: number;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  filename: string;
  fileType: string;
  totalRows: number;
  processedRows: number;
  successfulRows: number;
  failedRows: number;
  chunkSize: number;
  progressPct: number;
  currentChunk: number;
  totalChunks: number;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
  error: string | null;
}

interface ImportRunDbRow {
  id: string;
  data_import_id: number;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  filename: string;
  file_type: string;
  total_rows: number;
  processed_rows: number;
  successful_rows: number;
  failed_rows: number;
  chunk_size: number;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function toSummary(row: ImportRunDbRow): ImportJobSummary {
  const pct = row.total_rows > 0 ? (row.processed_rows / row.total_rows) * 100 : 0;
  return {
    jobId: row.id,
    dataImportId: row.data_import_id,
    status: row.status,
    filename: row.filename,
    fileType: row.file_type,
    totalRows: row.total_rows,
    processedRows: row.processed_rows,
    successfulRows: row.successful_rows,
    failedRows: row.failed_rows,
    chunkSize: row.chunk_size,
    progressPct: Math.round(pct * 10) / 10,
    currentChunk: row.chunk_size > 0 ? Math.floor(row.processed_rows / row.chunk_size) : 0,
    totalChunks: row.chunk_size > 0 ? Math.ceil(row.total_rows / row.chunk_size) : 0,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    heartbeatAt: row.heartbeat_at,
    error: row.error_message,
  };
}

function getRunRow(jobId: string): ImportRunDbRow {
  const row = getDb().prepare(`SELECT * FROM import_runs WHERE id = ?`).get(jobId) as
    | ImportRunDbRow
    | undefined;
  if (!row) throw errors.notFound('Import job');
  return row;
}

/** Fetch one job as an API-shaped summary. */
export function getImportJob(jobId: string): ImportJobSummary {
  return toSummary(getRunRow(jobId));
}

/** Newest jobs first — small observability helper (bounded). */
export function listImportJobs(limit = 10): ImportJobSummary[] {
  const rows = getDb()
    .prepare(`SELECT * FROM import_runs ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(Math.max(1, Math.min(limit, 100))) as unknown as ImportRunDbRow[];
  return rows.map(toSummary);
}

/* ---------------------------- bounded analyze ------------------------------ */

export interface BoundedAnalyzeOutput {
  importId: number;
  headers: string[];
  mapping: Record<string, string | null>;
  mappingUsable: boolean;
  suggestions: Array<{ header: string; target: string | null; confident: boolean }>;
  parseWarnings: string[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  /**
   * UI-9 fix (presentation semantics only): rows whose ERROR problems are ALL
   * `duplicate_in_database` (or `duplicate_in_file`) — exactly the rows the
   * execution layer already includes under the chosen duplicate strategy
   * (skip → zero new materials; update → optional-field refresh, originals
   * never overwritten). Derived from actual per-row rules, never inferred
   * from the duplicateRows count (which can overlap genuine errors).
   */
  duplicateOnlyRows: number;
  /** ERROR rows with at least one non-duplicate ERROR rule (true source errors). */
  genuineInvalidRows: number;
  previewRows: Array<{
    rowNumber: number;
    values: Record<string, string>;
    severity: 'VALID' | 'WARNING' | 'ERROR';
    problems: Array<{ rule: string; severity: string; message: string }>;
  }>;
  validationErrors: Array<{ rowNumber: number; field: string | null; rule: string; message: string }>;
  canExecute: boolean;
}

/** Bound enforced server-side; never trust a client page size. */
export const PREVIEW_MAX_ROWS = 100;
const MAX_DIAGNOSTICS = 500;

/**
 * UI-9 fix: true when every ERROR problem on the row is a duplicate rule —
 * i.e. the row is structurally valid and skippable/updatable per the chosen
 * duplicate strategy (identical to the execution layer's inclusion test in
 * claimAndStageJob/executeImport). Genuine errors (unknown_category,
 * unknown_uom, missing code/description, field_too_long, …) make it false.
 * duplicate_in_file counts too: execution re-checks codes per batch and skips
 * repeats at their first occurrence, so a same-file repeat of an existing code
 * is equally skippable — originals are never overwritten.
 */
export function isDuplicateOnlyErrorRow(row: {
  severity: string;
  problems: Array<{ rule: string; severity: string }>;
}): boolean {
  if (row.severity !== 'ERROR') return false;
  const errorRules = row.problems.filter((p) => p.severity === 'ERROR').map((p) => p.rule);
  return (
    errorRules.length > 0 &&
    errorRules.every((rule) => rule === 'duplicate_in_database' || rule === 'duplicate_in_file')
  );
}

/**
 * Bounded analyze: identical parse/map/validate semantics to analyzeImport,
 * but the HTTP response carries ONLY a summary, a bounded preview and bounded
 * diagnostics — never the full row set. The row report persisted on the
 * data_imports record keeps the exact same bounded shape as before (full rows
 * remain available server-side for pagination and the CSV error download).
 */
export function analyzeImportBounded(input: AnalyzeInput): BoundedAnalyzeOutput {
  const full = analyzeImport(input);
  const rows = full.validation.rows;
  const summary = full.validation.summary;

  const problems = rows.filter((r) => r.problems.length > 0);
  const previewRows = rows.filter((r) => !r.empty).slice(0, PREVIEW_MAX_ROWS).map((r) => ({
    rowNumber: r.rowNumber,
    values: r.values,
    severity: r.severity,
    problems: r.problems.map((p) => ({ rule: p.rule, severity: p.severity, message: p.message })),
  }));
  const validationErrors = problems
    .flatMap((r) =>
      r.problems.map((p) => ({
        rowNumber: r.rowNumber,
        field: null as string | null,
        rule: `${p.severity}:${p.rule}`,
        message: p.message,
      })),
    )
    .slice(0, MAX_DIAGNOSTICS);

  const duplicateRows = summary.duplicateInFile + summary.duplicateInDatabase;
  // UI-9 fix: classify ERROR rows by their ACTUAL rules (never by counts).
  const dupOnlyRows = rows.filter(isDuplicateOnlyErrorRow).length;
  const genuineInvalid = summary.errors - dupOnlyRows;
  return {
    importId: full.importId,
    headers: full.headers,
    mapping: full.mapping as unknown as Record<string, string | null>,
    mappingUsable: full.mappingUsable,
    suggestions: full.suggestions,
    parseWarnings: full.parseWarnings,
    totalRows: summary.totalRows,
    validRows: summary.valid,
    invalidRows: summary.errors,
    duplicateRows,
    duplicateOnlyRows: dupOnlyRows,
    genuineInvalidRows: genuineInvalid,
    previewRows,
    validationErrors,
    canExecute: full.mappingUsable && (summary.valid + summary.warnings + dupOnlyRows > 0),
  };
}

/* --------------------- Step 12: streaming CSV analyze ---------------------- */

export interface StreamingAnalyzeOutput {
  importId: number;
  headers: string[];
  mapping: Record<string, string | null>;
  mappingUsable: boolean;
  /** Header→target suggestions for the wizard's Map step (same as batch). */
  suggestions: Array<{ header: string; target: string | null; confident: boolean }>;
  parseWarnings: string[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  /** UI-9 fix: duplicate-only ERROR rows (see BoundedAnalyzeOutput). */
  duplicateOnlyRows: number;
  /** UI-9 fix: ERROR rows with genuine (non-duplicate) errors. */
  genuineInvalidRows: number;
  previewRows: Array<{ rowNumber: number; values: Record<string, string>; severity: string; problems: Array<{ rule: string; severity: string; message: string }> }>;
  validationErrors: Array<{ rowNumber: number; field: string | null; rule: string; message: string }>;
  canExecute: boolean;
}

/**
 * Step 12 — streaming/bounded CSV analyze. Parses the upload byte buffer
 * record-by-record (O(1) row memory via CsvRecordIterator), validates each
 * row through the SAME RowValidator rule engine as batch mode, and persists
 * the identical bounded row_report shape as analyzeImportBounded. Only the
 * header is materialized plus one row at a time; disk stores the raw upload
 * for later re-validation by the import job (identical to batch analyze).
 *
 * XLSX files intentionally use the batch path (workbook parsing is
 * memory-bound; the XLSX safety limit still applies).
 */
export function analyzeCsvStreaming(buffer: Buffer, fileName: string, fileType: 'csv' | 'xlsx', organizationId: number, mappingOverride?: Record<string, string | null> | null): StreamingAnalyzeOutput {
  getOrganizationRequired(organizationId);

  const it = new CsvRecordIterator(buffer);
  const headerRecord = it.next();
  if (headerRecord == null || headerRecord.trim() === '') {
    throw errors.badRequest('The file contains no data rows (only a header or nothing at all).');
  }
  const headersRaw = splitCsvLine(headerRecord);
  const canonicalFor = headersRaw.map(canonicalHeader);

  const suggested = suggestMapping(headersRaw);
  const mapping: ImportColumnMapping = { ...suggested.mapping, ...(mappingOverride ?? {}) } as ImportColumnMapping;
  const mappingUsable = mappingIsUsable(mapping);

  // With a per-row cpse_name column, duplicate-ness is judged against every
  // organization (same rule as batch analyzeImport).
  const existingCodes = mapping.orgCode ? loadAllExistingCodes() : loadExistingCodes(organizationId);
  const validator = new RowValidator(mapping, existingCodes);

  const problems: import('./import-validation').RowReport[] = [];
  const previewRows: StreamingAnalyzeOutput['previewRows'] = [];
  let firstDataRowNumber = 2; // header occupies line 1

  for (;;) {
    const record = it.next();
    if (record == null) break;
    if (record.trim() === '') continue; // blank physical line (batch parser filters these)
    const cells = splitCsvLine(record);
    const row: RawRow = buildRow(firstDataRowNumber, headersRaw, canonicalFor, cells);
    firstDataRowNumber++;
    const report = validator.next(row);
    if (report.problems.length > 0) problems.push(report);
    if (previewRows.length < PREVIEW_MAX_ROWS && !report.empty) {
      previewRows.push({
        rowNumber: report.rowNumber,
        values: report.values,
        severity: report.severity,
        problems: report.problems.map((p) => ({ rule: p.rule, severity: p.severity, message: p.message })),
      });
    }
  }

  const summary = validator.summary;
  if (summary.totalRows === 0) {
    throw errors.badRequest('The file contains no data rows (only a header or nothing at all).');
  }

  const importRow = createImport({
    organizationId,
    fileName,
    fileType,
    totalRows: summary.totalRows,
  });

  let uploadStored = false;
  try {
    storeUpload(importRow.id, fileName, buffer);
    uploadStored = true;
  } catch {
    uploadStored = false;
  }

  // Identical bounded row_report shape to batch analyze (summary + problem
  // diagnostics; valid rows re-derivable from the stored file + mapping).
  const rowReport = JSON.stringify({
    headers: headersRaw,
    mapping,
    suggestions: suggested.suggestions,
    uploadStored,
    summary,
    problems,
    rows: undefined, // streaming never embeds rows — disk IS the row store
    parseWarnings: [],
    streaming: true,
  });

  getDbNow().prepare(
    `UPDATE data_imports SET workflow_status = 'validating', valid_rows = ?, error_rows = ?, column_mapping = ?, row_report = ?
      WHERE id = ?`
  ).run(summary.valid, summary.errors, JSON.stringify(mapping), rowReport, importRow.id);

  const duplicateRows = summary.duplicateInFile + summary.duplicateInDatabase;
  const dupOnlyRows = problems.filter(isDuplicateOnlyErrorRow).length;
  const validationErrors = problems
    .flatMap((r) =>
      r.problems.map((p) => ({
        rowNumber: r.rowNumber,
        field: null as string | null,
        rule: `${p.severity}:${p.rule}`,
        message: p.message,
      })),
    )
    .slice(0, MAX_DIAGNOSTICS);

  return {
    importId: importRow.id,
    headers: headersRaw,
    mapping: mapping as unknown as Record<string, string | null>,
    mappingUsable,
    suggestions: suggested.suggestions,
    parseWarnings: [],
    totalRows: summary.totalRows,
    validRows: summary.valid,
    invalidRows: summary.errors,
    duplicateRows,
    duplicateOnlyRows: dupOnlyRows,
    genuineInvalidRows: summary.errors - dupOnlyRows,
    previewRows,
    validationErrors,
    canExecute: mappingUsable && (summary.valid + summary.warnings + dupOnlyRows > 0),
  };
}

/* ------------------------- server-side preview API ------------------------- */

/**
 * Server-side paginated preview over the validated rows of an import.
 * Only one page (plus counts) ever crosses the service boundary.
 */
export function getImportPreviewPage(
  importId: number,
  opts: { page?: number; pageSize?: number; severity?: 'ALL' | 'VALID' | 'WARNING' | 'ERROR'; q?: string } = {},
): {
  importId: number;
  page: number;
  pageSize: number;
  totalRows: number;
  filteredTotal: number;
  rows: Array<{
    rowNumber: number;
    values: Record<string, string>;
    severity: 'VALID' | 'WARNING' | 'ERROR';
    problems: Array<{ rule: string; severity: string; message: string }>;
  }>;
} {
  const imp = getImportRequired(importId);
  if (!imp.row_report) throw errors.conflict('This import has not been validated yet.');
  // Step-5: bounded reports re-validate the stored upload; legacy reports
  // keep embedded rows. Pagination operates on the full validated row set.
  let rows = loadValidatedRows(imp).filter((r) => !r.empty);
  if (opts.severity && opts.severity !== 'ALL') rows = rows.filter((r) => r.severity === opts.severity);
  const q = (opts.q ?? '').trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (r) => String(r.rowNumber).includes(q) || Object.values(r.values).some((v) => v.toLowerCase().includes(q)),
    );
  }
  const filteredTotal = rows.length;

  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 50), 100); // hard ceiling 100
  const page = Math.max(1, opts.page ?? 1);
  const start = (page - 1) * pageSize;
  return {
    importId,
    page,
    pageSize,
    totalRows: rows.length + (imp.row_report ? 0 : 0), // totalRows = validated rows incl. empty
    // (kept simple: filteredTotal covers the UI)
    filteredTotal,
    rows: rows.slice(start, start + pageSize),
  };
}

/* ------------------------------ job creation ------------------------------- */

/**
 * Create an import job for a validated import. The DB is the authority for
 * the single-active-import policy via uq_import_runs_active. Job identity is
 * a UUID — never a bare timestamp.
 */
export function createImportJob(dataImportId: number, actor: string, kind: 'materials' | 'procurement' = 'materials'): ImportJobSummary {
  const imp = getImportRequired(dataImportId);
  if (!imp.row_report) throw errors.conflict('This import has not been validated yet — run validation first.');
  const jobId = kind === 'procurement' ? `prc_${crypto.randomUUID()}` : `imp_${crypto.randomUUID()}`;
  try {
    withTransaction(() => {
      getDb()
        .prepare(
          `INSERT INTO import_runs (id, data_import_id, status, filename, file_type, chunk_size, kind)
           VALUES (?, ?, 'QUEUED', ?, ?, ?, ?)`,
        )
        .run(jobId, dataImportId, imp.file_name, imp.file_type, chunkFromEnv(), kind);
      recordAudit({
        action: 'import_created',
        entityType: 'import_job',
        entityId: dataImportId,
        actor,
        details: { jobId, fileName: imp.file_name, kind },
      });
      if (kind === 'procurement') {
        // Step 13 §20: procurement lifecycle audit with the REAL actor
        // (covers both the direct service path and the HTTP job route).
        recordAudit({
          action: 'procurement_import_started',
          entityType: 'import_job',
          entityId: dataImportId,
          actor,
          details: { jobId, kind: 'procurement', fileName: imp.file_name },
        });
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('uq_import_runs_active')) {
      throw errors.conflict('An import is already queued or running. Wait for it to finish before starting another.');
    }
    throw err;
  }
  return getImportJob(jobId);
}

/* ------------------------------ job execution ------------------------------ */

/**
 * Claim + stage a job in ONE transaction (Step 3 split). Fast and synchronous:
 * the HTTP 202 can be sent as soon as this returns. Semantics are EXACTLY the
 * frozen ones: guard rules (RUNNING-with-fresh-heartbeat conflicts, COMPLETED
 * conflicts), staging inclusion, counter reset, chunk plan, audits.
 *
 * Returns the staged row set + chunk plan for the execution phase, plus the
 * job's data_import_id for the failure path.
 */
interface ClaimedJob {
  rows: ImportJobRow[];
  chunkSize: number;
  dataImportId: number;
  /** Step 13: set when the job runs the procurement executor. */
  kind: 'materials' | 'procurement';
  /** Procurement staged rows (rowNumber + severity) when kind='procurement'. */
  procRows: Array<{ rowNumber: number; severity: string }>;
}

/** Visible for testing (tests/import-job-test-hooks). */
export function claimAndStageJob(jobId: string): ClaimedJob {
  const now = () => new Date().toISOString();
  let jobDataImportId = 0; // captured for the failure audit path

  let rows: ImportJobRow[] = [];
  let procRows: Array<{ rowNumber: number; severity: string }> = [];
  let kind: 'materials' | 'procurement' = 'materials';
  let chunkSizeForRun = chunkFromEnv();

  // ---- claim + stage (single transaction) --------------------------------
  withTransaction(() => {
    const job = getRunRow(jobId);
    if (job.status === 'RUNNING') {
      const staleSec = job.heartbeat_at ? (Date.now() - new Date(job.heartbeat_at).getTime()) / 1000 : Infinity;
      if (staleSec <= heartbeatFromEnv()) {
        throw errors.conflict('Import job is already running.');
      }
    } else if (job.status === 'COMPLETED') {
      throw errors.conflict('Import job already completed.');
    }

    chunkSizeForRun = job.chunk_size;
    jobDataImportId = job.data_import_id;

    const impRow = getImportRequired(job.data_import_id);
    const report = JSON.parse(impRow.row_report ?? '{}') as {
      mapping?: Record<string, string | null>;
      kind?: string;
      staged?: unknown[];
    };
    // Step 13: procurement jobs stage a typed row set (row_number + severity
    // only — the executable inputs live in the import's row_report, exactly
    // like the material path's disk-stored upload). Same transaction, same
    // counters, same chunk ledger.
    if (report.kind === 'procurement') {
      const staged = (report.staged ?? []) as Array<{ rowNumber: number; severity: string }>;
      if (job.status !== 'RUNNING') {
        getDb().prepare(`DELETE FROM procurement_import_rows WHERE job_id = ?`).run(jobId);
        const stagingRows: unknown[][] = [];
        for (const r of staged) {
          if (r.severity === 'VALID' || r.severity === 'WARNING') {
            stagingRows.push([jobId, r.rowNumber, r.severity]);
          }
        }
        batchInsertReturning({
          insertSql: `INSERT INTO procurement_import_rows (job_id, row_number, severity)`,
          columnCount: 3,
          rows: stagingRows,
          returning: 'row_number',
        });
      }
      const stagedRows = (
        getDb()
          .prepare(`SELECT row_number, severity FROM procurement_import_rows WHERE job_id = ? ORDER BY row_number`)
          .all(jobId) as Array<{ row_number: number; severity: string }>
      ).map((r) => ({ rowNumber: r.row_number, severity: r.severity }));

      if (job.status !== 'RUNNING') {
        getDb()
          .prepare(
            `UPDATE import_runs
                SET status = 'RUNNING', started_at = COALESCE(started_at, ?), completed_at = NULL,
                    heartbeat_at = ?, error_message = NULL,
                    total_rows = ?, processed_rows = 0, successful_rows = 0, failed_rows = 0
              WHERE id = ?`,
          )
          .run(now(), now(), stagedRows.length, jobId);
        getDb().prepare(`DELETE FROM import_run_chunks WHERE run_id = ?`).run(jobId);
        recordAudit({
          action: 'import_started',
          entityType: 'import_job',
          entityId: job.data_import_id,
          actor: 'system',
          details: { jobId, kind: 'procurement', totalRows: stagedRows.length, chunkSize: chunkSizeForRun },
        });
      } else {
        getDb().prepare(`UPDATE import_runs SET heartbeat_at = ? WHERE id = ?`).run(now(), jobId);
      }

      const insertChunk = getDb().prepare(
        `INSERT OR IGNORE INTO import_run_chunks (run_id, chunk_index, first_row, row_count, status)
         VALUES (?, ?, ?, ?, 'PENDING')`,
      );
      for (let start = 0; start < stagedRows.length; start += chunkSizeForRun) {
        insertChunk.run(jobId, start / chunkSizeForRun, start, Math.min(chunkSizeForRun, stagedRows.length - start));
      }
      if (stagedRows.length === 0) {
        getDb()
          .prepare(`UPDATE import_runs SET status = 'COMPLETED', completed_at = ?, heartbeat_at = ? WHERE id = ?`)
          .run(now(), now(), jobId);
      }
      kind = 'procurement';
      procRows = stagedRows;
    } else {
    const mapping = report.mapping ?? {};
    // Step-5: bounded reports re-validate the disk-stored upload; legacy
    // reports keep embedded rows. Staging consumes the SAME full row set the
    // frozen executeImport() would — identical inclusion semantics.
    const allRows = loadValidatedRows(impRow);

    // Stage: persist the job's row set with its inclusion decision so the
    // analysis snapshot can never drift from what executes. Analysis (from
    // analyze time) is thereby separated from execution.
    if (job.status !== 'RUNNING') {
      getDb()
        .prepare(`DELETE FROM import_rows WHERE job_id = ?`)
        .run(jobId);
      const include = (r: (typeof allRows)[number]): boolean => {
        if (r.empty) return false;
        if (r.severity === 'VALID') return true;
        if (r.severity === 'WARNING') return true; // includeWarnings=true is the wizard default & job default
        const errorRules = r.problems.filter((p) => p.severity === 'ERROR').map((p) => p.rule);
        return errorRules.length > 0 && errorRules.every((rule) => rule === 'duplicate_in_database');
      };
      // Bounded multi-row staging: one INSERT per IMPORT_BATCH_ROWS slice
      // instead of one statement per row (Step 2). import_rows has no id
      // column — row_number is the app-assigned ordinal, so no RETURNING is
      // needed; it exists only so .all() is valid on both dialects.
      const stagingRows: unknown[][] = [];
      for (const r of allRows) {
        if (!include(r)) continue;
        stagingRows.push([
          jobId,
          r.rowNumber,
          r.severity,
          mapping.originalCode ? (r.values[mapping.originalCode] ?? '').trim() : '',
          mapping.originalDescription ? (r.values[mapping.originalDescription] ?? '').trim() : '',
          mapping.category ? r.values[mapping.category] || null : null,
          mapping.manufacturer ? r.values[mapping.manufacturer] || null : null,
          mapping.model ? r.values[mapping.model] || null : null,
          mapping.partNumber ? r.values[mapping.partNumber] || null : null,
          (mapping.uom ? r.values[mapping.uom] || '' : '') || 'NOS',
        ]);
      }
      batchInsertReturning({
        insertSql: `INSERT INTO import_rows (job_id, row_number, severity, code, description, category, manufacturer, model, part_number, uom)`,
        columnCount: 10,
        rows: stagingRows,
        returning: 'row_number',
      });
    }

    rows = (
      getDb()
        .prepare(`SELECT row_number, code, description, category, manufacturer, model, part_number, uom, severity FROM import_rows WHERE job_id = ? ORDER BY row_number`)
        .all(jobId) as unknown as Array<{
        row_number: number; code: string; description: string; category: string | null;
        manufacturer: string | null; model: string | null; part_number: string | null; uom: string; severity: string;
      }>
    ).map((r) => ({
      rowNumber: r.row_number,
      code: r.code,
      description: r.description,
      category: r.category,
      manufacturer: r.manufacturer,
      model: r.model,
      partNumber: r.part_number,
      uom: r.uom,
      severity: r.severity as ImportJobRow['severity'],
    }));

    // Fresh (or retry) run: reset the phase; idempotent persistence keeps
    // re-execution safe. Stale-RUNNING resume keeps counters (committed
    // chunks are skipped below) and refreshes the heartbeat only.
    if (job.status !== 'RUNNING') {
      getDb()
        .prepare(
          `UPDATE import_runs
              SET status = 'RUNNING', started_at = COALESCE(started_at, ?), completed_at = NULL,
                  heartbeat_at = ?, error_message = NULL,
                  total_rows = ?, processed_rows = 0, successful_rows = 0, failed_rows = 0
            WHERE id = ?`,
        )
        .run(now(), now(), rows.length, jobId);
      getDb().prepare(`DELETE FROM import_run_chunks WHERE run_id = ?`).run(jobId);
      recordAudit({
        action: 'import_started',
        entityType: 'import_job',
        entityId: job.data_import_id,
        actor: 'system',
        details: { jobId, totalRows: rows.length, chunkSize: chunkSizeForRun },
      });
    } else {
      getDb().prepare(`UPDATE import_runs SET heartbeat_at = ? WHERE id = ?`).run(now(), jobId);
    }

    // Persist the chunk plan (PENDING) so progress is observable per chunk.
    const insertChunk = getDb().prepare(
      `INSERT OR IGNORE INTO import_run_chunks (run_id, chunk_index, first_row, row_count, status)
       VALUES (?, ?, ?, ?, 'PENDING')`,
    );
    for (let start = 0; start < rows.length; start += chunkSizeForRun) {
      insertChunk.run(jobId, start / chunkSizeForRun, start, Math.min(chunkSizeForRun, rows.length - start));
    }
    if (rows.length === 0) {
      getDb()
        .prepare(`UPDATE import_runs SET status = 'COMPLETED', completed_at = ?, heartbeat_at = ? WHERE id = ?`)
        .run(now(), now(), jobId);
    }
    kind = 'materials';
    }
  });

  return { rows, procRows, kind, chunkSize: chunkSizeForRun, dataImportId: jobDataImportId };
}

/**
 * Execute a QUEUED job (or resume a stale/failed one) SYNCHRONOUSLY to
 * completion. Frozen entrypoint used by tests and the legacy execute path;
 * the API layer uses startQueuedImportAsync (Step 3), which splits claim from
 * execution so the HTTP 202 is never delayed by job work.
 */
export function runImportJob(jobId: string): ImportJobSummary {
  const claim = claimAndStageJob(jobId);
  // Sync driver: fully synchronous chunk loop (frozen test/legacy entrypoint).
  const now = () => new Date().toISOString();
  const { rows, chunkSize: chunkSizeForRun, dataImportId: jobDataImportId } = claim;

  const isProcurement = claim.kind === 'procurement';
  const work: Array<{ chunkIndex: number; materialRows: ImportJobRow[]; procSlice: Array<{ rowNumber: number; severity: string }> }> = [];
  if (isProcurement) {
    for (let start = 0; start < claim.procRows.length; start += chunkSizeForRun) {
      work.push({ chunkIndex: start / chunkSizeForRun, materialRows: [], procSlice: claim.procRows.slice(start, start + chunkSizeForRun) });
    }
  } else {
    for (let start = 0; start < rows.length; start += chunkSizeForRun) {
      work.push({ chunkIndex: start / chunkSizeForRun, materialRows: rows.slice(start, start + chunkSizeForRun), procSlice: [] });
    }
  }
  for (const w of work) {
    const prior = getDb()
      .prepare(`SELECT status FROM import_run_chunks WHERE run_id = ? AND chunk_index = ?`)
      .get(jobId, w.chunkIndex) as { status: string } | undefined;
    if (prior?.status === 'COMMITTED') continue; // idempotent resume
    try {
      if (isProcurement) executeProcurementChunk(jobId, w.chunkIndex);
      else executeImportChunk(jobDataImportId, w.materialRows, jobId, w.chunkIndex);
    } catch (err) {
      persistChunkFailure(jobId, w.chunkIndex, jobDataImportId, err, now);
      return getImportJob(jobId); // stop at first failed chunk; retryable
    }
  }
  if (claim.procRows.length > 0 || rows.length > 0) {
    completeJob(jobId, jobDataImportId, isProcurement ? claim.procRows.length : rows.length, now);
  }
  return getImportJob(jobId);
}

/** Persist a chunk failure: FAILED chunk + FAILED job + audit (frozen shape). */
function persistChunkFailure(
  jobId: string,
  chunkIndex: number,
  dataImportId: number,
  err: unknown,
  now: () => string,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  withTransaction(() => {
    getDb()
      .prepare(`UPDATE import_run_chunks SET status = 'FAILED', error_message = ? WHERE run_id = ? AND chunk_index = ?`)
      .run(msg, jobId, chunkIndex);
    getDb()
      .prepare(`UPDATE import_runs SET status = 'FAILED', completed_at = ?, heartbeat_at = ?, error_message = ? WHERE id = ?`)
      .run(now(), now(), msg, jobId);
  });
  try {
    const runKind = (
      getDb().prepare(`SELECT kind FROM import_runs WHERE id = ?`).get(jobId) as
        { kind: string } | undefined
    )?.kind;
    recordAudit({
      action: runKind === 'procurement' ? 'procurement_import_failed' : 'import_failed',
      entityType: 'import_job',
      entityId: dataImportId,
      actor: 'system',
      details: { jobId, chunkIndex, error: msg, kind: runKind ?? 'materials' },
    });
  } catch {
    /* audit failure must not mask the job failure */
  }
}

/** Mark a job COMPLETED + audit (frozen shape). Visible for testing. */
export function completeJob(jobId: string, dataImportId: number, totalRows: number, now: () => string): void {
  withTransaction(() => {
    getDb()
      .prepare(`UPDATE import_runs SET status = 'COMPLETED', completed_at = ?, heartbeat_at = ? WHERE id = ?`)
      .run(now(), now(), jobId);
    recordAudit({
      action: 'import_performed',
      entityType: 'import_job',
      entityId: dataImportId,
      actor: 'system',
      details: {
        jobId,
        event: 'job_completed',
        totalRows,
        successfulRows: getImportJob(jobId).successfulRows,
      },
    });
  });
}

/**
 * ASYNC driver (Step 3): run the claimed job's chunks on macrotask ticks so
 * the event loop services HTTP traffic (the 202, progress polls) BETWEEN
 * chunk transactions. Chunk transactions themselves stay synchronous — each
 * is one atomic unit on the same connection/worker as before. Failure and
 * completion semantics are the frozen ones (shared helpers above).
 */
async function runClaimedChunksAsync(jobId: string, claim: ClaimedJob): Promise<ImportJobSummary> {
  const now = () => new Date().toISOString();
  const { rows, chunkSize: chunkSizeForRun, dataImportId: jobDataImportId } = claim;

  const isProcurement = claim.kind === 'procurement';
  const work: Array<{ chunkIndex: number; materialRows: ImportJobRow[]; procSlice: Array<{ rowNumber: number; severity: string }> }> = [];
  if (isProcurement) {
    for (let start = 0; start < claim.procRows.length; start += chunkSizeForRun) {
      work.push({ chunkIndex: start / chunkSizeForRun, materialRows: [], procSlice: claim.procRows.slice(start, start + chunkSizeForRun) });
    }
  } else {
    for (let start = 0; start < rows.length; start += chunkSizeForRun) {
      work.push({ chunkIndex: start / chunkSizeForRun, materialRows: rows.slice(start, start + chunkSizeForRun), procSlice: [] });
    }
  }
  for (const w of work) {
    // Yield BEFORE each chunk: the claim phase ran synchronously, so the
    // first yield is what lets the HTTP 202 flush while the job runs.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const prior = getDb()
      .prepare(`SELECT status FROM import_run_chunks WHERE run_id = ? AND chunk_index = ?`)
      .get(jobId, w.chunkIndex) as { status: string } | undefined;
    if (prior?.status === 'COMMITTED') continue; // idempotent resume
    try {
      if (isProcurement) executeProcurementChunk(jobId, w.chunkIndex);
      else executeImportChunk(jobDataImportId, w.materialRows, jobId, w.chunkIndex);
    } catch (err) {
      persistChunkFailure(jobId, w.chunkIndex, jobDataImportId, err, now);
      return getImportJob(jobId); // stop at first failed chunk; retryable
    }
  }
  // Empty-row jobs are marked COMPLETED by the claim phase itself.
  if (work.length > 0) completeJob(jobId, jobDataImportId, isProcurement ? claim.procRows.length : rows.length, now);
  return getImportJob(jobId);
}

/**
 * Persist ONE bounded chunk of rows. Runs inside its own transaction so a
 * failure rolls back only this chunk. Re-uses the frozen material-service
 * pipeline semantics (insert / duplicate-skip) — identical behavior to the
 * legacy single-transaction executeImport().
 */
export function executeImportChunk(
  dataImportId: number,
  chunk: ImportJobRow[],
  jobId: string,
  chunkIndex: number,
): void {
  withTransaction(() => {
    const db = getDb();
    const imp = getImportRequired(dataImportId);
    const org = getOrganizationRequired(imp.organization_id);
    const { runPipeline } = require('../pipeline/index') as typeof import('../pipeline/index');

    // Chunk marker first so a mid-chunk crash leaves RUNNING (recoverable).
    db.prepare(`UPDATE import_run_chunks SET status = 'RUNNING' WHERE run_id = ? AND chunk_index = ?`).run(jobId, chunkIndex);

    let imported = 0;
    let skipped = 0;
    // Bounded-batch persistence (Step 2): the sequential per-row flow (dup
    // lookup + INSERT + source_row UPDATE + N attribute upserts = ~11 round
    // trips per row) becomes, per IMPORT_BATCH_ROWS-row batch:
    //   1 dup lookup (IN list) + 1 multi-row INSERT...RETURNING +
    //   1 source_row UPDATE + 1 multi-row attribute upsert  = ~4 statements.
    // Behavior is preserved exactly:
    //   - codes are uppercased (existing normalization invariant) and matched
    //     on (organization_id, original_code, is_active) via
    //     idx_material_org_code — same index the per-row lookup used;
    //   - DB-existing codes, intra-batch repeats and blank codes are skipped
    //     with identical accounting ('skip' strategy: originals never change);
    //   - rows inserted in one batch see the previous batch's inserts in the
    //     dup lookup (same transaction), so cross-batch duplicates behave
    //     exactly like the sequential loop;
    //   - pipeline classification/attributes are computed per row, unchanged.
    const batchCap = maxBatchRows();
    for (let batchStart = 0; batchStart < chunk.length; batchStart += batchCap) {
      const batch = chunk.slice(batchStart, batchStart + batchCap);

      // 1) Duplicates: existing codes via one bounded query + intra-batch repeats.
      const firstOccurrence = new Map<string, number>(); // uppercased code -> first batch index
      for (let i = 0; i < batch.length; i++) {
        const row = batch[i];
        if (!row.code) continue; // staged rows are pre-validated; a blank code never executes
        const code = row.code.toUpperCase();
        if (!firstOccurrence.has(code)) firstOccurrence.set(code, i);
      }
      const existingCodes = new Set<string>();
      if (firstOccurrence.size > 0) {
        const codes = [...firstOccurrence.keys()];
        const placeholders = codes.map(() => '?').join(', ');
        const existing = db
          .prepare(
            `SELECT original_code FROM material_records
              WHERE organization_id = ? AND is_active = 1 AND original_code IN (${placeholders})`,
          )
          .all(...([imp.organization_id, ...codes] as never[])) as Array<{ original_code: string }>;
        for (const r of existing) existingCodes.add(r.original_code.toUpperCase());
      }
      const insertables = batch
        .map((row, i) => ({ row, i }))
        .filter(({ row, i }) => {
          if (!row.code) return false;
          const code = row.code.toUpperCase();
          // duplicate strategy 'skip' — original code is never overwritten;
          // intra-batch repeats only insert at their FIRST occurrence.
          return firstOccurrence.get(code) === i && !existingCodes.has(code);
        });

      // 2) Pipeline for every insertable row (CPU only, no I/O) — unchanged
      // per-row classification/quality semantics.
      const processed = insertables.map(({ row }) => ({
        row,
        out: runPipeline({ originalDescription: row.description, categoryOverride: row.category ?? undefined }),
      }));

      if (processed.length > 0) {
        // 3) One bounded multi-row INSERT ... RETURNING (id, original_code):
        // generated ids arrive in input order on BOTH dialects (SQLite >= 3.35
        // and PostgreSQL 15), so attribute/source-row mapping is deterministic.
        const inserted = batchInsertReturning<{ id: number | string; original_code: string }>({
          insertSql: `INSERT INTO material_records
             (organization_id, original_code, original_description, normalized_description,
              category, subcategory, manufacturer, model, part_number, material_type, uom, import_id,
              processing_status, classification_confidence, classification_source, quality_status, quality_checks)`,
          columnCount: 17,
          rows: processed.map(({ row, out }) => [
            imp.organization_id,
            row.code,
            row.description,
            out.normalizedDescription ?? null,
            out.classification.category ?? row.category ?? 'Uncategorised',
            out.classification.subcategory ?? null,
            row.manufacturer,
            row.model,
            row.partNumber,
            null, // material_type: legacy insertMaterial left it unset
            row.uom,
            imp.id,
            out.processingStatus ?? 'imported',
            out.classification.confidence ?? null,
            out.classification.source ?? null,
            out.quality.status,
            JSON.stringify(out.quality.checks),
          ]),
          returning: 'id, original_code',
        });
        if (inserted.length !== processed.length) {
          throw new Error(
            `import batch insert mismatch: expected ${processed.length} RETURNING rows, got ${inserted.length}`,
          );
        }
        const idByCode = new Map<string, number>();
        for (const r of inserted) idByCode.set(r.original_code.toUpperCase(), Number(r.id));

        // 4) source_row for every inserted material — one searched UPDATE.
        batchUpdateColumn(
          'material_records',
          'source_row',
          processed.map(({ row }) => ({ id: idByCode.get(row.code.toUpperCase()) as number, value: row.rowNumber })),
        );

        // 5) Attributes: one bounded multi-row upsert, deduped by
        // (material_id, attribute_name) — PostgreSQL rejects a repeated
        // conflict key inside one ON CONFLICT DO UPDATE statement (SQLite
        // tolerates it; dedupe keeps semantics identical on both).
        const attrRows: unknown[][] = [];
        const attrSeen = new Set<string>();
        for (const { row, out } of processed) {
          const materialId = idByCode.get(row.code.toUpperCase()) as number;
          for (const a of out.attributes) {
            const key = `${materialId}\u0000${a.attributeName}`;
            if (attrSeen.has(key)) continue;
            attrSeen.add(key);
            attrRows.push([
              materialId,
              a.attributeName,
              a.value,
              a.normalizedValue ?? null,
              a.unit ?? null,
              a.isCritical ? 1 : 0,
              'rule',
              a.confidence ?? null,
            ]);
          }
        }
        if (attrRows.length > 0) {
          batchUpsert({
            insertSql: `INSERT INTO material_attributes
               (material_id, attribute_name, value, normalized_value, unit, is_critical, extraction_method, confidence)`,
            columnCount: 8,
            rows: attrRows,
            conflictTarget: 'material_id, attribute_name',
            updateSet:
              'value = excluded.value, normalized_value = excluded.normalized_value, ' +
              'unit = excluded.unit, is_critical = excluded.is_critical, ' +
              'extraction_method = excluded.extraction_method, confidence = excluded.confidence, ' +
              'updated_at = excluded.updated_at',
          });
        }
      }

      imported += processed.length;
      skipped += batch.length - processed.length;
    }

    // Chunk committed: advance the ledger + job counters from committed work.
    db.prepare(`UPDATE import_run_chunks SET status = 'COMMITTED' WHERE run_id = ? AND chunk_index = ?`).run(jobId, chunkIndex);
    db.prepare(
      `UPDATE import_runs
          SET processed_rows = processed_rows + ?, successful_rows = successful_rows + ?, heartbeat_at = ?
        WHERE id = ?`,
    ).run(chunk.length, imported, new Date().toISOString(), jobId);

    // Durable import summary on data_imports (bounded; no row payload).
    db.prepare(
      `UPDATE data_imports
          SET successful_rows = successful_rows + ?, duplicate_rows = duplicate_rows + ?, failed_rows = failed_rows + ?
        WHERE id = ?`,
    ).run(imported, skipped, 0, dataImportId);

    void org;
  });
}

/* --------------------------- detached execution ---------------------------- */

/**
 * Concurrency guard (Step 3): the prototype runs at most ONE import job per
 * server process. Justification: import_runs enforces a DATABASE-WIDE
 * single-active-import policy (uq_import_runs_active), so a second worker
 * could never legitimately run concurrently; a single slot keeps SQLite's
 * writer lock and the PG worker-bridge (one statement in flight) serial and
 * predictable, and bounds memory. The DB constraint remains the real
 * authority — this in-process semaphore only prevents redundant scheduling.
 */
let activeAsyncRuns = 0;

/**
 * Request-path entrypoint (Step 3): claim fast, execute in the BACKGROUND.
 *
 * `claimAndStageJob` runs synchronously so claim conflicts (409) surface to
 * the caller BEFORE this function returns; everything afterwards happens on
 * macrotask ticks so pending I/O — including the HTTP 202 response the route
 * is about to write — is never starved. The old implementation parked the
 * whole synchronous job on one microtask, which ran to completion before the
 * response could flush (Step 1 measurement: the 202 arrived only after the
 * entire import).
 *
 * NOT durable enterprise processing: in-process fire-and-forget on the
 * Next.js server. Documented limitations (report §10): process restart,
 * deployment restart, crash, and multiple server instances are NOT covered —
 * a restarted process finds a RUNNING job whose heartbeat has gone stale and
 * may resume it via the existing stale-heartbeat rule (POST { jobId }), but
 * nothing automatic respawns execution. The DATABASE row remains the single
 * source of truth in every case.
 */
export function startQueuedImportAsync(jobId: string): void {
  // Reject over-subscription BEFORE claiming anything.
  if (activeAsyncRuns >= 1) {
    throw errors.conflict('An import job is already executing on this server instance. Wait for it to finish.');
  }

  let claim: ClaimedJob;
  claim = claimAndStageJob(jobId); // synchronous; 409s (conflicts) propagate to the route

  activeAsyncRuns++;
  void runClaimedChunksAsync(jobId, claim)
    .catch((err) => {
      // Last-resort containment: runClaimedChunks already persists FAILED for
      // chunk errors; this catches crashes in the driver itself (e.g. claim
      // bookkeeping bugs, OOM-adjacent failures). Persist the failure so the
      // job is never left RUNNING, and log for server-side diagnosis.
      console.error(`[import-job] background run ${jobId} crashed:`, err);
      try {
        const msg = err instanceof Error ? err.message : String(err);
        withTransaction(() => {
          getDb()
            .prepare(`UPDATE import_runs SET status = 'FAILED', completed_at = ?, heartbeat_at = ?, error_message = ? WHERE id = ?`)
            .run(new Date().toISOString(), new Date().toISOString(), `background crash: ${msg}`, jobId);
        });
      } catch (persistErr) {
        console.error(`[import-job] could not persist FAILED for ${jobId}:`, persistErr);
      }
    })
    .finally(() => {
      activeAsyncRuns--;
    });
}

/** Create + start in one call for the API layer (Step 13: kind-aware). */
export function createAndStartImportJob(dataImportId: number, actor: string, kind: 'materials' | 'procurement' = 'materials'): ImportJobSummary {
  const job = createImportJob(dataImportId, actor, kind);
  startQueuedImportAsync(job.jobId);
  return job;
}
