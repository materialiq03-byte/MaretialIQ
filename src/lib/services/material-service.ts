import { withTransaction } from '../db/client';
import {
  insertMaterial,
  updateMaterialRow,
  getMaterialRequired,
  listAttributes,
  upsertAttribute,
  deleteAllAttributes,
  findMaterialByCode,
} from '../db/repositories/material-repository';
import { getOrganizationRequired } from '../db/repositories/organization-queries';
import { recordAudit } from '../db/repositories/audit-repository';
import { createImport, updateImportStatus } from '../db/repositories/import-repository';
import { errors } from '../errors';
import { runPipeline } from '../pipeline';
import type { MaterialCreate, MaterialUpdate } from '../validation/schemas';
import type { MaterialProcessingStatus } from '../types/domain';

export { normalizeDescription } from '../pipeline';

export interface MaterialDetail {
  material: ReturnType<typeof getMaterialRequired>;
  attributes: ReturnType<typeof listAttributes>;
}

export function getMaterialDetail(id: number): MaterialDetail {
  const material = getMaterialRequired(id);
  const attributes = listAttributes(id);
  return { material, attributes };
}

/**
 * Run the deterministic pipeline (normalize → classify → extract → quality)
 * over a material record and persist every outcome. The original description
 * and original code are never modified. Attributes previously stored are
 * replaced by the new extraction; manual provenance is preserved on conflict.
 */
export function processMaterial(materialId: number, actor: string): MaterialDetail {
  return withTransaction(() => {
    const material = getMaterialRequired(materialId);
    const existing = listAttributes(materialId);
    const manual = new Map(
      existing.filter((a) => a.extraction_method === 'manual').map((a) => [a.attribute_name, a])
    );

    const output = runPipeline({
      originalDescription: material.original_description,
      // Explicit record category wins over keyword rules (reviewer override).
      categoryOverride: material.category,
    });

    updateMaterialRow(materialId, {
      normalizedDescription: output.normalizedDescription,
      category: output.classification.category ?? material.category,
      subcategory: output.classification.subcategory ?? material.subcategory ?? undefined,
      manufacturer:
        output.attributes.find((a) => a.attributeName === 'manufacturer')?.value ??
        material.manufacturer ?? undefined,
      processingStatus: output.processingStatus,
      classificationConfidence: output.classification.confidence,
      classificationSource: output.classification.source,
      qualityStatus: output.quality.status,
      qualityChecks: JSON.stringify(output.quality.checks),
    });

    // Replace rule-extracted attributes; keep manual ones untouched.
    deleteAllAttributes(materialId);
    for (const a of output.attributes) {
      upsertAttribute({
        materialId,
        attributeName: a.attributeName,
        value: a.value,
        normalizedValue: a.normalizedValue,
        unit: a.unit,
        isCritical: a.isCritical,
        extractionMethod: 'rule',
        confidence: a.confidence,
      });
    }
    for (const a of manual.values()) {
      upsertAttribute({
        materialId,
        attributeName: a.attribute_name,
        value: a.value,
        normalizedValue: a.normalized_value,
        unit: a.unit,
        isCritical: a.is_critical === 1,
        extractionMethod: 'manual',
        confidence: a.confidence,
      });
    }

    recordAudit({
      action: 'material_reprocessed',
      entityType: 'material_record',
      entityId: materialId,
      actor,
      details: {
        qualityStatus: output.quality.status,
        processingStatus: output.processingStatus,
        attributesExtracted: output.attributes.length,
      },
    });

    return { material: getMaterialRequired(materialId), attributes: listAttributes(materialId) };
  });
}

/** Create a material record and immediately run the pipeline over it. */
export function createMaterial(input: MaterialCreate, actor: string): { id: number } {
  return withTransaction(() => {
    getOrganizationRequired(input.organizationId); // 404 if missing
    const output = runPipeline({
      originalDescription: input.originalDescription,
      categoryOverride: input.category,
    });
    const id = insertMaterial({
      ...input,
      normalizedDescription: output.normalizedDescription,
      processingStatus: output.processingStatus,
      classificationConfidence: output.classification.confidence,
      classificationSource: output.classification.source,
      qualityStatus: output.quality.status,
      qualityChecks: JSON.stringify(output.quality.checks),
    });
    for (const a of output.attributes) {
      upsertAttribute({
        materialId: id,
        attributeName: a.attributeName,
        value: a.value,
        normalizedValue: a.normalizedValue,
        unit: a.unit,
        isCritical: a.isCritical,
        extractionMethod: 'rule',
        confidence: a.confidence,
      });
    }
    recordAudit({
      action: 'material_created',
      entityType: 'material_record',
      entityId: id,
      actor,
      details: { originalCode: input.originalCode, category: input.category },
    });
    return { id };
  });
}

/**
 * Update a material record. Fields are optional; when the description changes
 * the full pipeline re-runs so derived data stays consistent.
 */
export function updateMaterial(id: number, input: MaterialUpdate, actor: string): { id: number } {
  return withTransaction(() => {
    getMaterialRequired(id);
    updateMaterialRow(id, input);
    if (input.attributes) {
      for (const attr of input.attributes) {
        upsertAttribute({
          materialId: id,
          attributeName: attr.attributeName,
          value: attr.value,
          normalizedValue: attr.normalizedValue,
          unit: attr.unit,
          isCritical: attr.isCritical,
          extractionMethod: attr.extractionMethod ?? 'manual',
          confidence: attr.confidence,
        });
      }
    }
    if (input.originalDescription !== undefined) {
      // Description changed — derived data must be recomputed.
      processMaterialInPlace(id, actor);
    }
    recordAudit({
      action: 'material_updated',
      entityType: 'material_record',
      entityId: id,
      actor,
      details: { fields: Object.keys(input) },
    });
    return { id };
  });
}

/** Reprocess without nesting transactions (called from updateMaterial). */
function processMaterialInPlace(materialId: number, actor: string): void {
  const material = getMaterialRequired(materialId);
  const existing = listAttributes(materialId);
  const manual = new Map(
    existing.filter((a) => a.extraction_method === 'manual').map((a) => [a.attribute_name, a])
  );

  const output = runPipeline({
    originalDescription: material.original_description,
    categoryOverride: material.category,
  });

  updateMaterialRow(materialId, {
    normalizedDescription: output.normalizedDescription,
    category: output.classification.category ?? material.category,
    subcategory: output.classification.subcategory ?? material.subcategory ?? undefined,
    manufacturer:
      output.attributes.find((a) => a.attributeName === 'manufacturer')?.value ??
      material.manufacturer ?? undefined,
    processingStatus: output.processingStatus,
    classificationConfidence: output.classification.confidence,
    classificationSource: output.classification.source,
    qualityStatus: output.quality.status,
    qualityChecks: JSON.stringify(output.quality.checks),
  });

  deleteAllAttributes(materialId);
  for (const a of output.attributes) {
    upsertAttribute({
      materialId,
      attributeName: a.attributeName,
      value: a.value,
      normalizedValue: a.normalizedValue,
      unit: a.unit,
      isCritical: a.isCritical,
      extractionMethod: 'rule',
      confidence: a.confidence,
    });
  }
  for (const a of manual.values()) {
    upsertAttribute({
      materialId,
      attributeName: a.attribute_name,
      value: a.value,
      normalizedValue: a.normalized_value,
      unit: a.unit,
      isCritical: a.is_critical === 1,
      extractionMethod: 'manual',
      confidence: a.confidence,
    });
  }
  recordAudit({
    action: 'material_reprocessed',
    entityType: 'material_record',
    entityId: materialId,
    actor,
    details: { trigger: 'description_change', qualityStatus: output.quality.status },
  });
}

export interface ImportRowsInput {
  organizationId: number;
  fileName: string;
  fileType: 'csv' | 'xlsx';
  rows: Array<MaterialCreate & { attributes?: MaterialUpdate['attributes'] }>;
  actor: string;
}

export interface ImportRowError {
  row: number;
  code: string;
  message: string;
}

export interface ImportResult {
  importId: number;
  totalRows: number;
  successfulRows: number;
  failedRows: number;
  newMaterials: number;
  duplicateCodes: number;
  warnings: number;
  missingDescriptions: number;
  errors: ImportRowError[];
}

/**
 * File import: per-row pipeline (normalize → classify → extract → quality),
 * duplicate-code detection, full summary counters. Row failures never abort
 * the batch and are never silently discarded — they are returned and stored
 * on the import record.
 */
export function performImport(input: ImportRowsInput): ImportResult {
  return withTransaction(() => {
    getOrganizationRequired(input.organizationId);
    const importRow = createImport({
      organizationId: input.organizationId,
      fileName: input.fileName,
      fileType: input.fileType,
      totalRows: input.rows.length,
    });
    updateImportStatus(importRow.id, { status: 'processing' });

    const rowErrors: ImportRowError[] = [];
    let successful = 0;
    let newMaterials = 0;
    let duplicates = 0;
    let warnings = 0;
    let missingDescriptions = 0;

    for (let i = 0; i < input.rows.length; i++) {
      const row = input.rows[i];
      const rowNumber = i + 1;
      try {
        // Required-field validation before anything touches the pipeline.
        if (!row.originalCode || row.originalCode.trim().length < 2) {
          rowErrors.push({ row: rowNumber, code: 'invalid_material_code', message: 'Missing or too-short material code' });
          continue;
        }
        if (!row.originalDescription || row.originalDescription.trim().length < 3) {
          rowErrors.push({ row: rowNumber, code: 'missing_description', message: 'Missing or too-short description' });
          missingDescriptions++;
          continue;
        }

        const existing = findMaterialByCode(input.organizationId, row.originalCode);
        if (existing) {
          // Duplicate material code for this CPSE — counted, not inserted.
          duplicates++;
          rowErrors.push({
            row: rowNumber,
            code: 'duplicate_material_code',
            message: `Material code ${row.originalCode} already exists for this CPSE (record #${existing.id})`,
          });
          continue;
        }

        const output = runPipeline({
          originalDescription: row.originalDescription,
          categoryOverride: row.category,
        });
        if (output.quality.status === 'warning' || output.quality.status === 'incomplete') warnings++;

        const id = insertMaterial({
          ...row,
          normalizedDescription: output.normalizedDescription,
          importId: importRow.id,
          processingStatus: output.processingStatus,
          classificationConfidence: output.classification.confidence,
          classificationSource: output.classification.source,
          qualityStatus: output.quality.status,
          qualityChecks: JSON.stringify(output.quality.checks),
        });
        for (const a of output.attributes) {
          upsertAttribute({
            materialId: id,
            attributeName: a.attributeName,
            value: a.value,
            normalizedValue: a.normalizedValue,
            unit: a.unit,
            isCritical: a.isCritical,
            extractionMethod: 'rule',
            confidence: a.confidence,
          });
        }
        successful++;
        newMaterials++;
      } catch (err) {
        rowErrors.push({
          row: rowNumber,
          code: 'row_error',
          message: err instanceof Error ? err.message : 'Unknown row error',
        });
      }
    }

    updateImportStatus(importRow.id, {
      status: rowErrors.length === 0 ? 'completed' : 'completed',
      successfulRows: successful,
      failedRows: rowErrors.length,
      newRows: newMaterials,
      duplicateRows: duplicates,
      warningRows: warnings,
      missingDescriptionRows: missingDescriptions,
      errorInfo: rowErrors.length ? JSON.stringify(rowErrors) : undefined,
    });
    recordAudit({
      action: 'import_performed',
      entityType: 'data_import',
      entityId: importRow.id,
      actor: input.actor,
      details: {
        fileName: input.fileName,
        total: input.rows.length,
        successful,
        failed: rowErrors.length,
        duplicates,
        warnings,
      },
    });
    return {
      importId: importRow.id,
      totalRows: input.rows.length,
      successfulRows: successful,
      failedRows: rowErrors.length,
      newMaterials,
      duplicateCodes: duplicates,
      warnings,
      missingDescriptions,
      errors: rowErrors,
    };
  });
}

export { errors as materialServiceErrors };
export type { MaterialProcessingStatus };
