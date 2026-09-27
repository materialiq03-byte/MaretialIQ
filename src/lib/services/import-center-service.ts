/**
 * Import Center service — orchestrates the enterprise import workflow on top
 * of the existing data_imports model and material-service pipeline helpers.
 *
 * Two-phase design:
 *   analyzeImport  → parse + map + validate, persist NOTHING except the
 *                    workflow record (status 'validating'); returns the full
 *                    row report. No material is touched.
 *   executeImport  → insert ONLY the rows the user confirmed (valid rows, or
 *                    valid+warning rows when the user chose to proceed with
 *                    warnings), applying the chosen duplicate strategy.
 *
 * Invalid rows never enter the material master. Original CPSE codes and
 * descriptions are never overwritten.
 */
import { withTransaction } from '../db/client';
import {
  createImport,
  updateImportStatus,
  getImportRequired,
} from '../db/repositories/import-repository';
import {
  insertMaterial,
  upsertAttribute,
  deleteAllAttributes,
  updateMaterialRow,
} from '../db/repositories/material-repository';
import { getOrganizationRequired } from '../db/repositories/organization-queries';
import { recordAudit } from '../db/repositories/audit-repository';
import { parseImportFile } from './file-parse-service';
import { storeUpload, readStoredUpload } from './upload-store';
import { errors } from '../errors';
import {
  suggestMapping,
  mappingIsUsable,
  validateRows,
  TECHNICAL_TARGETS,
  technicalAttributeFrom,
  type ImportColumnMapping,
  type ValidationResult,
} from './import-validation';

export { KNOWN_UOMS, KNOWN_CATEGORIES } from './import-validation';

export interface AnalyzeInput {
  organizationId: number;
  fileName: string;
  fileType: 'csv' | 'xlsx';
  payload: ArrayBuffer | string;
  mapping?: Partial<ImportColumnMapping> | null;
}

export interface AnalyzeOutput {
  importId: number;
  headers: string[];
  mapping: ImportColumnMapping;
  suggestions: Array<{ header: string; target: string | null; confident: boolean }>;
  mappingUsable: boolean;
  unmappedHeaders: string[];
  parseWarnings: string[];
  validation: ValidationResult;
}

export function loadExistingCodes(organizationId: number): Map<string, { materialId: number; originalCode: string; itemSummary?: string }> {
  const { getDb } = require('../db/client') as { getDb: () => import('node:sqlite').DatabaseSync };
  const rows = getDb()
    .prepare(
      `SELECT mr.id, mr.original_code, mr.original_description AS description, COALESCE(mr.category, '') AS category
       FROM material_records mr WHERE mr.organization_id = ? AND mr.is_active = 1`
    )
    .all(organizationId) as Array<{ id: number; original_code: string; description: string | null; category: string }>;
  return new Map(
    rows.map((r) => [
      r.original_code.toUpperCase(),
      {
        materialId: r.id,
        originalCode: r.original_code,
        itemSummary: [r.category, (r.description ?? '').slice(0, 80)].filter(Boolean).join(' · ') || undefined,
      },
    ])
  );
}

/**
 * Every active material code across ALL organizations. Used for duplicate
 * display when one file carries a cpse_name column (rows belong to different
 * orgs, so a single-org code map cannot decide duplicate-ness per row).
 */
export function loadAllExistingCodes(): Map<string, { materialId: number; originalCode: string; itemSummary?: string }> {
  const { getDb } = require('../db/client') as { getDb: () => import('node:sqlite').DatabaseSync };
  const rows = getDb()
    .prepare(
      `SELECT mr.id, mr.original_code, mr.original_description AS description, COALESCE(o.name, '') AS org_name, COALESCE(mr.category, '') AS category
       FROM material_records mr LEFT JOIN organizations o ON o.id = mr.organization_id
       WHERE mr.is_active = 1`
    )
    .all() as Array<{ id: number; original_code: string; description: string | null; org_name: string; category: string }>;
  return new Map(
    rows.map((r) => [
      r.original_code.toUpperCase(),
      {
        materialId: r.id,
        originalCode: r.original_code,
        itemSummary: [r.org_name, r.category, (r.description ?? '').slice(0, 80)].filter(Boolean).join(' · ') || undefined,
      },
    ])
  );
}

/** All organizations by uppercase code — used to resolve per-row cpse_name. */
function loadOrganizationIds(): Map<string, number> {
  const { getDb } = require('../db/client') as { getDb: () => import('node:sqlite').DatabaseSync };
  const rows = getDb()
    .prepare(`SELECT id, code FROM organizations`)
    .all() as Array<{ id: number; code: string }>;
  return new Map(rows.map((r) => [r.code.toUpperCase(), r.id]));
}

/**
 * Phase 1: parse the file, suggest/apply column mapping, validate every row.
 * Creates the import record in 'validating' state and stores the mapping +
 * row report so the user can close the browser and come back.
 */
export function analyzeImport(input: AnalyzeInput): AnalyzeOutput {
  const org = getOrganizationRequired(input.organizationId);
  const parsed = parseImportFile(input.fileName, input.payload);

  if (parsed.rows.length === 0) {
    throw errors.badRequest(
      parsed.errors.length > 0
        ? `File could not be read as a material list: ${parsed.errors[0].message}`
        : 'The file contains no data rows (only a header or nothing at all).'
    );
  }

  const suggested = suggestMapping(parsed.headers);
  const mapping: ImportColumnMapping = { ...suggested.mapping, ...(input.mapping ?? {}) };
  const mappingUsable = mappingIsUsable(mapping);

  // Without the two required columns mapped there is nothing to validate —
  // the caller gets mapping info so the UI can return the user to step 3.
  const validation = mappingUsable
    ? validateRows(
        parsed.rows,
        mapping,
        // With a per-row cpse_name column, duplicate-ness is judged against
        // every organization; otherwise only the file-level target org.
        mapping.orgCode ? loadAllExistingCodes() : loadExistingCodes(input.organizationId)
      )
    : {
        rows: [],
        summary: {
          totalRows: parsed.rows.length, valid: 0, warnings: 0, errors: parsed.rows.length,
          emptyRows: 0, duplicateInFile: 0, duplicateInDatabase: 0, missingDescription: 0,
          missingCode: 0, unknownUom: 0, unknownCategory: 0,
        },
      };

  const importRow = createImport({
    organizationId: input.organizationId,
    fileName: input.fileName,
    fileType: input.fileType,
    totalRows: parsed.rows.length,
  });

  // Step-5: the raw upload is persisted to disk so the full row set never
  // needs to live inside data_imports.row_report. If disk storage fails we
  // degrade gracefully to the legacy in-DB full report.
  let uploadStored = false;
  try {
    storeUpload(importRow.id, input.fileName, input.payload as ArrayBuffer);
    uploadStored = true;
  } catch {
    uploadStored = false;
  }

  // The row report is the audit trail of "what did the system understand".
  // Bounded shape: summary + problem-row diagnostics only (valid rows are
  // re-derivable from the stored file with the persisted mapping).
  const rowReport = JSON.stringify({
    headers: parsed.headers,
    mapping,
    suggestions: suggested.suggestions,
    uploadStored,
    summary: validation.summary,
    problems: validation.rows.filter((r) => r.problems.length > 0),
    rows: uploadStored ? undefined : validation.rows, // legacy fallback
    parseWarnings: parsed.errors,
  });

  getDbNow().prepare(
    `UPDATE data_imports SET workflow_status = 'validating', valid_rows = ?, error_rows = ?, column_mapping = ?, row_report = ?
      WHERE id = ?`
  ).run(
    validation.summary.valid,
    validation.summary.errors,
    JSON.stringify(mapping),
    rowReport,
    importRow.id
  );

  return {
    importId: importRow.id,
    headers: parsed.headers,
    mapping,
    suggestions: suggested.suggestions,
    mappingUsable,
    unmappedHeaders: suggested.unmappedHeaders,
    parseWarnings: parsed.errors.map((e) => e.message),
    validation,
  };
}

/**
 * Step-5: load the full validated row set for an import. Bounded reports
 * (uploadStored) re-validate the disk-stored file with the persisted mapping;
 * legacy reports keep their embedded rows. Exclusion semantics are identical
 * in both cases because validateRows is the same frozen function.
 */
export function loadValidatedRows(imp: { id: number; file_name: string; row_report: string | null; organization_id: number }): Array<ValidationResult['rows'][number]> {
  const report = JSON.parse(imp.row_report ?? '{}') as {
    mapping?: ImportColumnMapping;
    rows?: ValidationResult['rows'];
    problems?: ValidationResult['rows'];
  };
  if (report.rows && report.rows.length > 0) return report.rows; // legacy full report
  const problemRows = report.problems ?? [];
  const stored = readStoredUpload(imp.id, imp.file_name);
  if (!stored) return problemRows; // degrade gracefully: diagnostics only
  const payload =
    stored.byteOffset === 0 && stored.byteLength === stored.buffer.byteLength
      ? stored.buffer
      : stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength);
  const reParsed = parseImportFile(imp.file_name, payload as ArrayBuffer);
  const reValidation = validateRows(
    reParsed.rows,
    report.mapping as ImportColumnMapping,
    loadExistingCodes(imp.organization_id),
  );
  return reValidation.rows;
}

// Small indirection so the helper stays import-light (client lives in db/client).
export function getDbNow(): import('node:sqlite').DatabaseSync {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require('../db/client');
  return getDb();
}

/**
 * Resolve the organization a row belongs to. With a mapped cpse_name column
 * each row goes to the CPSE named in its own cell (unknown/blank → the
 * file-level default org). Without one, every row belongs to the file-level
 * organization — the pre-existing behavior.
 */
function resolveRowOrgId(
  mapping: ImportColumnMapping,
  values: Record<string, string>,
  defaultOrgId: number,
  orgIds: Map<string, number> | null
): number {
  if (!mapping.orgCode || !orgIds) return defaultOrgId;
  const cell = (values[mapping.orgCode] ?? '').trim().toUpperCase();
  return (cell && orgIds.get(cell)) || defaultOrgId;
}

/**
 * Persist technical enrichment columns as import-sourced material attributes.
 * These ADD facts the description extractor cannot see (supplier part number,
 * temperature window, grade, stated ratings); they never modify the original
 * record text, and a rule-extracted attribute of the same name is replaced
 * only by the explicit source value.
 */
function upsertTechnicalAttributes(
  materialId: number,
  mapping: ImportColumnMapping,
  values: Record<string, string>
): number {
  let count = 0;
  for (const target of TECHNICAL_TARGETS) {
    const header = mapping[target];
    if (!header) continue;
    const attr = technicalAttributeFrom(target, values[header]);
    if (!attr) continue;
    upsertAttribute({
      materialId,
      attributeName: attr.attributeName,
      value: attr.value,
      normalizedValue: attr.normalizedValue,
      unit: attr.unit,
      isCritical: attr.isCritical,
      extractionMethod: 'imported',
      confidence: null,
    });
    count++;
  }
  return count;
}

export interface ExecuteInput {
  importId: number;
  includeWarnings: boolean;
  duplicateStrategy: 'skip' | 'update' | 'cancel';
  actor: string;
}

export interface ExecuteOutput {
  importId: number;
  imported: number;
  updated: number;
  skippedExisting: number;
  excludedInvalid: number;
  excludedEmpty: number;
  excludedWarningRows: number;
  warningsInImported: number;
}

export function executeImport(input: ExecuteInput): ExecuteOutput {
  return withTransaction(() => {
    const imp = getImportRequired(input.importId);
    if (!imp.row_report) throw errors.conflict('This import has not been validated yet — run validation first.');
    if (imp.workflow_status === 'importing') throw errors.conflict('This import is already running.');
    if (input.duplicateStrategy === 'cancel') {
      updateImportStatus(input.importId, { status: 'failed', errorInfo: 'Cancelled by user before import.' });
      markWorkflow(input.importId, 'failed');
      return {
        importId: input.importId, imported: 0, updated: 0, skippedExisting: 0,
        excludedInvalid: 0, excludedEmpty: 0, excludedWarningRows: 0, warningsInImported: 0,
      };
    }

    const report = JSON.parse(imp.row_report) as {
      headers: string[]; mapping: ImportColumnMapping;
      rows?: Array<{
        rowNumber: number; values: Record<string, string>; severity: 'VALID' | 'WARNING' | 'ERROR';
        empty: boolean; problems: Array<{ rule: string; severity: string; message: string }>;
      }>;
    };
    // Step-5: bounded reports re-validate the disk-stored upload; legacy
    // reports keep their embedded rows. Inclusion semantics are unchanged —
    // validateRows is the same frozen function in both paths.
    const allRows = loadValidatedRows(imp);

    const mapping = report.mapping;
    const org = getOrganizationRequired(imp.organization_id);
    // Multi-CPSE file: rows may name their own organization via cpse_name.
    const orgIds = mapping.orgCode ? loadOrganizationIds() : null;
    // Per-organization code maps (memoized) so duplicate detection stays
 // exact per CPSE even when one file spans five.
    const existingByOrg = new Map<number, Map<string, { materialId: number; originalCode: string }>>();
    const codesFor = (orgId: number) => {
      let m = existingByOrg.get(orgId);
      if (!m) {
        m = loadExistingCodes(orgId);
        existingByOrg.set(orgId, m);
      }
      return m;
    };

    const importable = allRows.filter((r) => {
      if (r.empty) return false;
      if (r.severity === 'VALID') return true;
      if (r.severity === 'WARNING') return input.includeWarnings;
      // ERROR rows are excluded, EXCEPT duplicates-in-database, which the
      // chosen duplicate strategy explicitly handles (skip / update / cancel).
      if (r.severity === 'ERROR') {
        const errorRules = r.problems.filter((p) => p.severity === 'ERROR').map((p) => p.rule);
        return errorRules.length > 0 && errorRules.every((rule) => rule === 'duplicate_in_database');
      }
      return false;
    });

    const output: ExecuteOutput = {
      importId: imp.id, imported: 0, updated: 0, skippedExisting: 0,
      excludedInvalid: 0, excludedEmpty: 0, excludedWarningRows: 0, warningsInImported: 0,
    };

    // Re-read pipeline services each iteration; heavy work stays in services.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runPipeline } = require('../pipeline') as typeof import('../pipeline');

    for (const row of importable) {
      const code = mapping.originalCode ? (row.values[mapping.originalCode] ?? '').trim() : '';
      const description = mapping.originalDescription ? (row.values[mapping.originalDescription] ?? '').trim() : '';
      const category = mapping.category ? (row.values[mapping.category] || null) : null;
      const manufacturer = mapping.manufacturer ? (row.values[mapping.manufacturer] || null) : null;
      const model = mapping.model ? (row.values[mapping.model] || null) : null;
      const partNumber = mapping.partNumber ? (row.values[mapping.partNumber] || null) : null;
      const uom = (mapping.uom ? (row.values[mapping.uom] || '') : '') || 'NOS';
      const rowOrgId = resolveRowOrgId(mapping, row.values, imp.organization_id, orgIds);

      const dup = codesFor(rowOrgId).get(code.toUpperCase());
      if (dup) {
        if (input.duplicateStrategy === 'skip') {
          output.skippedExisting++;
          continue;
        }
        // 'update': refresh optional derived fields only — original code and
        // description are NEVER overwritten.
        const output_ = runPipeline({ originalDescription: description, categoryOverride: category });
        updateMaterialRow(dup.materialId, {
          subcategory: output_.classification.subcategory ?? undefined,
          manufacturer: manufacturer ?? undefined,
          model: model ?? undefined,
          partNumber: partNumber ?? undefined,
          uom,
          qualityStatus: output_.quality.status,
          qualityChecks: JSON.stringify(output_.quality.checks),
          classificationConfidence: output_.classification.confidence,
          classificationSource: output_.classification.source,
        });
        deleteAllAttributes(dup.materialId);
        for (const a of output_.attributes) {
          upsertAttribute({
            materialId: dup.materialId, attributeName: a.attributeName, value: a.value,
            normalizedValue: a.normalizedValue, unit: a.unit, isCritical: a.isCritical,
            extractionMethod: 'rule', confidence: a.confidence,
          });
        }
        upsertTechnicalAttributes(dup.materialId, mapping, row.values);
        output.updated++;
        continue;
      }

      const pipelineOut = runPipeline({ originalDescription: description, categoryOverride: category });
      const materialId = insertMaterial({
        organizationId: rowOrgId,
        originalCode: code,
        originalDescription: description,
        category: pipelineOut.classification.category ?? category ?? 'Uncategorised',
        normalizedDescription: pipelineOut.normalizedDescription,
        subcategory: pipelineOut.classification.subcategory ?? undefined,
        manufacturer: manufacturer ?? undefined,
        model: model ?? undefined,
        partNumber: partNumber ?? undefined,
        uom,
        importId: imp.id,
        processingStatus: pipelineOut.processingStatus,
        classificationConfidence: pipelineOut.classification.confidence,
        classificationSource: pipelineOut.classification.source,
        qualityStatus: pipelineOut.quality.status,
        qualityChecks: JSON.stringify(pipelineOut.quality.checks),
      });
      // Traceability: which spreadsheet row produced this material.
      getDbNow().prepare(
        `UPDATE material_records SET source_row = ? WHERE id = ?`
      ).run(row.rowNumber, materialId);

      for (const a of pipelineOut.attributes) {
        upsertAttribute({
          materialId, attributeName: a.attributeName, value: a.value,
          normalizedValue: a.normalizedValue, unit: a.unit, isCritical: a.isCritical,
          extractionMethod: 'rule', confidence: a.confidence,
        });
      }
      // Explicit technical columns from the file (part number, ratings, grade,
      // seal type…) — stored alongside, never instead of, the original text.
      upsertTechnicalAttributes(materialId, mapping, row.values);
      codesFor(rowOrgId).set(code.toUpperCase(), { materialId, originalCode: code });
      output.imported++;
      if (row.severity === 'WARNING') output.warningsInImported++;
    }

    // Excluded-warning count: warning rows NOT included by user choice.
    output.excludedWarningRows = allRows.filter(
      (r) => r.severity === 'WARNING' && !input.includeWarnings
    ).length;
    output.excludedEmpty = allRows.filter((r) => r.empty).length;
    // Errors exclude themselves except duplicate-in-database rows, which are
    // handled by the duplicate strategy above (skip counts, update refreshes).
    const dbDupRowNumbers = new Set(
      allRows.filter((r) => r.problems?.some?.((p: { rule: string }) => p.rule === 'duplicate_in_database')).map((r) => r.rowNumber)
    );
    output.excludedInvalid = allRows.filter(
      (r) => r.severity === 'ERROR' && !dbDupRowNumbers.has(r.rowNumber)
    ).length;

    const warningsImported = output.warningsInImported;
    const workflow: 'completed' | 'completed_with_warnings' =
      warningsImported > 0 ? 'completed_with_warnings' : 'completed';
    markWorkflow(imp.id, workflow, {
      imported: output.imported,
      updated: output.updated,
      skipped: output.skippedExisting,
    });
    updateImportStatus(imp.id, {
      status: 'completed',
      successfulRows: output.imported + output.updated,
      failedRows: output.excludedInvalid,
      newRows: output.imported,
      duplicateRows: output.skippedExisting,
      warningRows: warningsImported,
      missingDescriptionRows: allRows.filter((r) => r.problems?.some?.((p: { rule: string }) => p.rule === 'required_description')).length,
      errorInfo: output.excludedInvalid > 0 ? JSON.stringify({ excludedInvalidRows: output.excludedInvalid }) : undefined,
    });

    recordAudit({
      action: 'import_performed',
      entityType: 'data_import',
      entityId: imp.id,
      actor: input.actor,
      details: {
        fileName: imp.file_name, org: org.code, imported: output.imported, updated: output.updated,
        skippedExisting: output.skippedExisting, excludedInvalid: output.excludedInvalid,
        duplicateStrategy: input.duplicateStrategy, includeWarnings: input.includeWarnings,
      },
    });

    return output;
  });
}

export function markWorkflow(
  importId: number,
  workflow: 'completed' | 'completed_with_warnings' | 'failed',
  counts?: { imported: number; updated: number; skipped: number }
): void {
  getDbNow().prepare(
    `UPDATE data_imports SET workflow_status = ?, imported_rows = ?, skipped_existing_rows = ?, updated_rows = ?, imported_at = ?
      WHERE id = ?`
  ).run(
    workflow,
    counts?.imported ?? 0,
    counts?.skipped ?? 0,
    counts?.updated ?? 0,
    new Date().toISOString(),
    importId
  );
}
