/**
 * Step 22 — Integration service: the bridge between CPSE source adapters and
 * the EXISTING Import Center (§12: "do not build another Import Center").
 *
 * analyzeIntegration   → read-only: adapter parse/validate/transform over the
 *                        uploaded feed, canonical preview + quality report.
 *                        No DB mutation, no import record (idempotent).
 * executeIntegration   → maps canonical rows into the Import Center's column
 *                        mapping and runs the EXISTING analyzeImport +
 *                        createAndStartImportJob pipeline (chunked, durable,
 *                        audited). Integration metadata (adapter id/version,
 *                        source identity, quality summary) is stored on the
 *                        import's row_report — the existing "what did the
 *                        system understand" record — WITHOUT any schema
 *                        change.
 *
 * Matching/harmonization are deliberately untouched: imported materials only
 * become AVAILABLE to the existing matching pipeline (§31/§32).
 */
import type { CpseSourceAdapter } from './adapter-interface';
import type { CanonicalMaterialRow } from './canonical-contract';
import { getAdapterRequired } from './registry';
import { analyzeFeed, type FeedAnalysis } from './parse-and-validate';
import {
  analyzeImport,
  getDbNow,
  type AnalyzeInput,
} from '../services/import-center-service';
import {
  createAndStartImportJob,
  createImportJob,
  runImportJob,
  type ImportJobSummary,
} from '../services/import-job-service';
import { getImportRequired } from '../db/repositories/import-repository';
import { recordAudit } from '../db/repositories/audit-repository';
import { errors } from '../errors';

/** The mapping the Import Center consumes, derived 1:1 from canonical rows. */
const CANONICAL_TO_IMPORT_MAPPING = {
  originalCode: 'materialCode',
  originalDescription: 'description',
  category: 'category',
  subcategory: 'subcategory',
  manufacturer: 'manufacturer',
  model: null,
  partNumber: 'partNumber',
  uom: 'uom',
  orgCode: null, // CPSE is fixed by the adapter profile, not a per-row column
} as const;

export interface AnalyzeIntegrationInput {
  adapterId: string;
  fileName: string;
  /** CSV text or binary payload (XLSX). */
  payload: ArrayBuffer | string;
}

/**
 * Read-only integration analysis. Parses and validates the feed through the
 * resolved adapter; computes preview + quality report from the ACTUAL data.
 * Idempotent: safe to call repeatedly; mutates nothing anywhere.
 */
export function analyzeIntegration(input: AnalyzeIntegrationInput): FeedAnalysis {
  const adapter = getAdapterRequired(input.adapterId);
  return analyzeFeed(adapter, input.fileName, input.payload);
}

export interface ExecuteIntegrationInput {
  adapterId: string;
  fileName: string;
  payload: ArrayBuffer | string;
  /** Analyze result may be supplied by the caller to avoid re-parsing. */
  analysis?: FeedAnalysis;
  actor: string;
  /**
   * Run the import job SYNCHRONOUSLY to completion (frozen test/legacy
   * entrypoint). Default false: the EXISTING async driver executes the job in
   * the background and the caller polls /api/import-jobs/[id].
   */
  sync?: boolean;
}

export interface ExecuteIntegrationOutput {
  importId: number;
  jobId: string;
  adapterId: string;
  adapterVersion: string;
  cpse: string;
  sourceFileName: string;
  sourceRecordCount: number;
  canonicalRecordCount: number;
  validationSummary: {
    rowsReceived: number;
    rowsValid: number;
    rowsWithWarnings: number;
    rowsWithError: number;
    duplicatesInFeed: number;
    emptyRows: number;
  };
  job: ImportJobSummary;
}

/** Canonical CSV column order — the contract the Import Center will see. */
const CANONICAL_COLUMNS = [
  'materialCode',
  'description',
  'category',
  'subcategory',
  'manufacturer',
  'partNumber',
  'uom',
] as const;

function csvEscape(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialize canonical rows into the exact CSV the Import Center will map. */
export function canonicalRowsToCsv(rows: CanonicalMaterialRow[]): string {
  const lines = [CANONICAL_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.materialCode),
        csvEscape(r.description),
        csvEscape(r.category),
        csvEscape(r.subcategory),
        csvEscape(r.manufacturer),
        csvEscape(r.partNumber),
        csvEscape(r.uom),
      ].join(',')
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Execute an integration: analyze (read-only) → hand the canonical rows to
 * the EXISTING Import Center analyze → start the EXISTING chunked async job.
 * The integration never writes material rows itself.
 */
export function executeIntegration(input: ExecuteIntegrationInput): ExecuteIntegrationOutput {
  const adapter = getAdapterRequired(input.adapterId);

  // Re-analyze unless the caller passed the analysis (same pure function —
  // identical result; duplicates/errors are enforced again here, fail-closed).
  const analysis = input.analysis ?? analyzeIntegration({ adapterId: input.adapterId, fileName: input.fileName, payload: input.payload });
  if (!analysis.canExecute) {
    throw errors.validation(
      {
        code: 'VALIDATION_ERROR',
        summary: {
          rowsReceived: analysis.rowsReceived,
          rowsWithError: analysis.rowsWithError,
          duplicatesInFeed: analysis.duplicatesInFeed,
        },
        diagnostics: analysis.diagnostics.slice(0, 50),
      },
      'Source feed has validation errors — nothing was imported. Review the diagnostics and re-upload.'
    );
  }

  const canonicalRows = canonicalRowsOf(adapter, input.fileName, input.payload);
  if (canonicalRows.length === 0) {
    throw errors.badRequest('Source feed contains no importable canonical rows', { code: 'SOURCE_ERROR' });
  }

  // Step 1 — EXISTING analyzeImport: parse (single engine), map, validate
  // every canonical row through the frozen Import Center validator.
  const analyzeInput: AnalyzeInput = {
    organizationId: organizationIdForCpse(adapter),
    fileName: `cpse-${adapter.id.toLowerCase()}-integration-${Date.now()}-${input.fileName.replace(/[^\w.\- ]+/g, '_')}`,
    fileType: 'csv',
    payload: canonicalRowsToCsv(canonicalRows),
    mapping: { ...CANONICAL_TO_IMPORT_MAPPING },
  };
  const analyzeResult = analyzeImport(analyzeInput);

  // Integration metadata: appended to the import's existing row_report (the
  // bounded "what did the system understand" record). Additive JSON keys —
  // no schema change, every existing consumer keeps working.
  try {
    const importRow = getDbNow()
      .prepare(`SELECT row_report FROM data_imports WHERE id = ?`)
      .get(analyzeResult.importId) as unknown as { row_report: string | null } | undefined;
    const report = JSON.parse(importRow?.row_report ?? '{}') as Record<string, unknown>;
    report.integration = {
      cpse: adapter.cpse,
      sourceSystem: adapter.id,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      sourceFormat: analysis.sourceFormat,
      sourceFileName: input.fileName.replace(/[^\w.\- ]+/g, '_'),
      sourceRecordCount: analysis.rowsReceived,
      canonicalRecordCount: canonicalRows.length,
      validationSummary: {
        rowsReceived: analysis.rowsReceived,
        rowsValid: analysis.rowsValid,
        rowsWithWarnings: analysis.rowsWithWarnings,
        rowsWithError: analysis.rowsWithError,
        duplicatesInFeed: analysis.duplicatesInFeed,
        emptyRows: analysis.emptyRows,
      },
      fieldMapping: analysis.fieldMapping,
      fieldCoverage: analysis.fieldCoverage,
      sourceIdentityModel: 'CPSE+sourceSystem+sourceRecordId',
    };
    getDbNow()
      .prepare(`UPDATE data_imports SET row_report = ? WHERE id = ?`)
      .run(JSON.stringify(report), analyzeResult.importId);
  } catch {
    // Metadata enrichment must never break the authoritative import flow.
  }

  // Integration-level audit (mutation happened: an import record exists).
  // Reuses the existing import_created vocabulary with integration context —
  // no new audit action vocabulary, no per-field audit noise (§20).
  try {
    recordAudit({
      action: 'import_created',
      entityType: 'data_import',
      entityId: analyzeResult.importId,
      actor: input.actor,
      details: {
        integration: true,
        cpse: adapter.cpse,
        sourceSystem: adapter.id,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        sourceFormat: analysis.sourceFormat,
        sourceFileName: input.fileName.replace(/[^\w.\- ]+/g, '_'),
        canonicalRecordCount: canonicalRows.length,
        rowsValid: analysis.rowsValid,
        rowsWithWarnings: analysis.rowsWithWarnings,
        rowsWithError: analysis.rowsWithError,
      },
    });
  } catch {
    /* audit best-effort on the wrapper; the import path audits its own events */
  }

  // Step 2 — EXISTING import job (chunked, durable, DB-authoritative):
  // async background driver by default (API path), or the frozen synchronous
  // entrypoint when explicitly requested (tests / deterministic callers).
  let job: ImportJobSummary;
  if (input.sync) {
    job = createImportJob(analyzeResult.importId, input.actor, 'materials');
    job = runImportJob(job.jobId);
  } else {
    job = createAndStartImportJob(analyzeResult.importId, input.actor, 'materials');
  }

  return {
    importId: analyzeResult.importId,
    jobId: job.jobId,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    cpse: adapter.cpse,
    sourceFileName: input.fileName,
    sourceRecordCount: analysis.rowsReceived,
    canonicalRecordCount: canonicalRows.length,
    validationSummary: {
      rowsReceived: analysis.rowsReceived,
      rowsValid: analysis.rowsValid,
      rowsWithWarnings: analysis.rowsWithWarnings,
      rowsWithError: analysis.rowsWithError,
      duplicatesInFeed: analysis.duplicatesInFeed,
      emptyRows: analysis.emptyRows,
    },
    job,
  };
}

/** Integration history: imports carrying integration metadata (bounded). */
export interface IntegrationRunView {
  importId: number;
  cpse: string;
  adapterId: string;
  adapterVersion: string;
  sourceFileName: string;
  sourceFormat: string;
  sourceRecordCount: number | null;
  canonicalRecordCount: number | null;
  validationSummary: ExecuteIntegrationOutput['validationSummary'] | null;
  workflowStatus: string;
  status: string;
  totalRows: number;
  successfulRows: number;
  failedRows: number;
  createdAt: string;
  importedAt: string | null;
  importUrl: string;
}

/** Read one integration run's metadata from its import row_report. */
export function getIntegrationRun(importId: number): IntegrationRunView {
  const imp = getImportRequired(importId);
  let meta: Record<string, unknown> | null = null;
  try {
    const report = JSON.parse(imp.row_report ?? '{}') as Record<string, unknown>;
    if (report.integration && typeof report.integration === 'object') meta = report.integration as Record<string, unknown>;
  } catch {
    meta = null;
  }
  if (!meta) throw errors.notFound(`Integration run for import #${importId}`);
  const summary = (meta.validationSummary ?? null) as ExecuteIntegrationOutput['validationSummary'] | null;
  return {
    importId: imp.id,
    cpse: String(meta.cpse ?? ''),
    adapterId: String(meta.adapterId ?? ''),
    adapterVersion: String(meta.adapterVersion ?? ''),
    sourceFileName: String(meta.sourceFileName ?? imp.file_name),
    sourceFormat: String(meta.sourceFormat ?? imp.file_type.toUpperCase()),
    sourceRecordCount: (meta.sourceRecordCount as number | null) ?? imp.total_rows,
    canonicalRecordCount: (meta.canonicalRecordCount as number | null) ?? imp.total_rows,
    validationSummary: summary,
    workflowStatus: imp.workflow_status,
    status: imp.status,
    totalRows: imp.total_rows,
    successfulRows: imp.successful_rows,
    failedRows: imp.failed_rows,
    createdAt: imp.created_at,
    importedAt: imp.imported_at,
    importUrl: `/imports/${imp.id}`,
  };
}

/** List recent integration runs (bounded; integration metadata only). */
export function listIntegrationRuns(limit = 20): IntegrationRunView[] {
  const rows = getDbNow()
    .prepare(
      `SELECT id FROM data_imports WHERE row_report LIKE '%"integration"%' ORDER BY id DESC LIMIT ?`
    )
    .all(Math.max(1, Math.min(limit, 100))) as Array<{ id: number }>;
  const out: IntegrationRunView[] = [];
  for (const r of rows) {
    try {
      out.push(getIntegrationRun(r.id));
    } catch {
      /* row_report parse race — skip */
    }
  }
  return out;
}

/** Resolve the organization for an adapter's CPSE (fail-closed). */
function organizationIdForCpse(adapter: CpseSourceAdapter): number {
  const row = getDbNow()
    .prepare(`SELECT id FROM organizations WHERE UPPER(code) = ?`)
    .get(adapter.cpse.toUpperCase()) as unknown as { id: number } | undefined;
  if (!row) throw errors.notFound(`CPSE organization "${adapter.cpse}"`);
  return row.id;
}

/** Extract the accepted canonical rows from a feed (re-running the pure adapter). */
function canonicalRowsOf(
  adapter: CpseSourceAdapter,
  fileName: string,
  payload: ArrayBuffer | string,
): CanonicalMaterialRow[] {
  // Re-run the adapter over the stored payload: the analysis preview is
  // bounded, so the full accepted set is recomputed deterministically from
  // the SAME pure adapter (identical results, no hidden state).
  const { parseFeed } = require('./parse-and-validate') as typeof import('./parse-and-validate');
  const { rows } = parseFeed(fileName, payload);
  const seen = new Set<string>();
  const out: CanonicalMaterialRow[] = [];
  for (const row of rows) {
    const { canonical, diagnostics } = adapter.validateAndTransform(row.values, row.rowNumber);
    if (!canonical || diagnostics.some((d) => d.severity === 'ERROR')) continue;
    const key = canonical.sourceRecordId.toUpperCase();
    if (seen.has(key)) continue; // duplicates excluded (idempotent replay)
    seen.add(key);
    out.push(canonical);
  }
  return out;
}
