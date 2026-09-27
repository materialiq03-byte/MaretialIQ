import { getDb } from '../client';
import { errors } from '../../errors';
import { nowIso } from '../util';
import type { MaterialCreate, MaterialUpdate } from '../../validation/schemas';
import type { MaterialProcessingStatus } from '../../types/domain';

export interface MaterialRow {
  id: number;
  organization_id: number;
  org_code: string;
  org_name: string;
  original_code: string;
  original_description: string;
  normalized_description: string | null;
  category: string;
  subcategory: string | null;
  manufacturer: string | null;
  model: string | null;
  part_number: string | null;
  material_type: string | null;
  uom: string;
  import_id: number | null;
  processing_status: MaterialProcessingStatus;
  classification_confidence: number | null;
  classification_source: string | null;
  quality_status: 'good' | 'warning' | 'incomplete' | 'invalid' | null;
  quality_checks: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface MaterialAttributeRow {
  id: number;
  material_id: number;
  attribute_name: string;
  value: string;
  normalized_value: string | null;
  unit: string | null;
  is_critical: number;
  extraction_method: 'rule' | 'manual' | 'imported';
  confidence: number | null;
  created_at: string;
  updated_at: string;
}

export interface MaterialWithOrg extends MaterialRow {
  org_code: string;
  org_name: string;
}

const BASE = `
  SELECT m.*, o.code AS org_code, o.name AS org_name
    FROM material_records m JOIN organizations o ON o.id = m.organization_id`;

const SORTABLE = {
  code: 'm.original_code',
  category: 'm.category',
  org: 'o.code',
  updated: 'm.updated_at',
  description: 'm.original_description',
} as const;

export type MaterialSortField = keyof typeof SORTABLE;

export function listMaterials(opts: {
  search?: string;
  organizationCode?: string;
  category?: string;
  page: number;
  pageSize: number;
  sort: MaterialSortField;
  direction: 'asc' | 'desc';
}) {
  const clauses: string[] = ['m.is_active = 1'];
  const params: Array<string | number> = [];
  if (opts.search) {
    clauses.push(
      `(m.original_code LIKE ? OR m.original_description LIKE ? OR m.normalized_description LIKE ? OR m.manufacturer LIKE ? OR m.part_number LIKE ?)`
    );
    const like = `%${opts.search}%`;
    params.push(like, like, like, like, like);
  }
  if (opts.organizationCode) {
    clauses.push('o.code = ?');
    params.push(opts.organizationCode);
  }
  if (opts.category) {
    clauses.push('m.category = ?');
    params.push(opts.category);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const orderBy = `${SORTABLE[opts.sort]} ${opts.direction === 'asc' ? 'ASC' : 'DESC'}, m.id ASC`;
  const items = getDb()
    .prepare(`${BASE} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, opts.pageSize, (opts.page - 1) * opts.pageSize) as unknown as MaterialWithOrg[];
  const total = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM material_records m JOIN organizations o ON o.id = m.organization_id ${where}`
      )
      .get(...params) as unknown as { n: number }
  ).n;
  return { items, total };
}

export function getMaterial(id: number): MaterialWithOrg | undefined {
  return getDb().prepare(`${BASE} WHERE m.id = ?`).get(id) as MaterialWithOrg | undefined;
}

export function getMaterialRequired(id: number): MaterialWithOrg {
  const row = getMaterial(id);
  if (!row) throw errors.notFound('Material record');
  return row;
}

export function findMaterialByCode(organizationId: number, originalCode: string): MaterialRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM material_records WHERE organization_id = ? AND original_code = ?`)
    .get(organizationId, originalCode) as MaterialRow | undefined;
}

export function insertMaterial(input: MaterialCreate & { normalizedDescription?: string }): number {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO material_records
           (organization_id, original_code, original_description, normalized_description,
            category, subcategory, manufacturer, model, part_number, material_type, uom, import_id,
            processing_status, classification_confidence, classification_source, quality_status, quality_checks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.organizationId,
        input.originalCode,
        input.originalDescription,
        input.normalizedDescription ?? null,
        input.category,
        input.subcategory ?? null,
        input.manufacturer ?? null,
        input.model ?? null,
        input.partNumber ?? null,
        input.materialType ?? null,
        input.uom,
        input.importId ?? null,
        input.processingStatus ?? 'imported',
        input.classificationConfidence ?? null,
        input.classificationSource ?? null,
        input.qualityStatus ?? null,
        input.qualityChecks ?? null
      );
    return Number(res.lastInsertRowid);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('UNIQUE constraint failed: material_records.organization_id')) {
        throw errors.conflict(
          `Material code "${input.originalCode}" already exists for this CPSE`
        );
      }
      if (err.message.includes('FOREIGN KEY constraint failed')) {
        throw errors.badRequest('Organization or import reference does not exist');
      }
    }
    throw err;
  }
}

export function updateMaterialRow(
  id: number,
  input: MaterialUpdate & { processingStatus?: MaterialProcessingStatus }
): void {
  const current = getMaterialRequired(id);
  getDb()
    .prepare(
      `UPDATE material_records SET
         original_code = ?, original_description = ?, normalized_description = ?,
         category = ?, subcategory = ?, manufacturer = ?, model = ?, part_number = ?,
         material_type = ?, uom = ?, processing_status = ?,
         classification_confidence = ?, classification_source = ?,
         quality_status = ?, quality_checks = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      input.originalCode ?? current.original_code,
      input.originalDescription ?? current.original_description,
      input.normalizedDescription ?? current.normalized_description,
      input.category ?? current.category,
      input.subcategory ?? current.subcategory,
      input.manufacturer ?? current.manufacturer,
      input.model ?? current.model,
      input.partNumber ?? current.part_number,
      input.materialType ?? current.material_type,
      input.uom ?? current.uom,
      input.processingStatus ?? current.processing_status,
      input.classificationConfidence ?? current.classification_confidence,
      input.classificationSource ?? current.classification_source,
      input.qualityStatus ?? current.quality_status,
      input.qualityChecks ?? current.quality_checks,
      nowIso(),
      id
    );
}

export function archiveMaterial(id: number): void {
  getDb()
    .prepare(`UPDATE material_records SET is_active = 0, updated_at = ? WHERE id = ?`)
    .run(nowIso(), id);
}

export interface DuplicateCodeGroup {
  original_code: string;
  organization_id: number;
  org_code: string;
  n: number;
  descriptions: string;
}

/**
 * Active records within one CPSE that share the same original code but carry
 * different item identities. A repeated code inside a CPSE is a data-
 * governance warning: the import pipeline never auto-merges rows on code
 * equality alone, and the Material Master surfaces both records separately
 * so a human can resolve the collision.
 */
export function listDuplicateCodeGroups(): DuplicateCodeGroup[] {
  return getDb()
    .prepare(
      `SELECT m.organization_id, o.code AS org_code, m.original_code,
              COUNT(*) AS n, GROUP_CONCAT(m.original_description, ' | ') AS descriptions
         FROM material_records m JOIN organizations o ON o.id = m.organization_id
        WHERE m.is_active = 1
        GROUP BY m.organization_id, o.code, m.original_code
       HAVING COUNT(DISTINCT m.original_description) > 1
        ORDER BY o.code, m.original_code`
    )
    .all() as unknown as DuplicateCodeGroup[];
}

export function listCategories(): Array<{ category: string; count: number }> {
  return getDb()
    .prepare(
      `SELECT category, COUNT(*) AS count FROM material_records WHERE is_active = 1 GROUP BY category ORDER BY category`
    )
    .all() as Array<{ category: string; count: number }>;
}

/* ------------------------------- attributes ------------------------------- */

export function listAttributes(materialId: number): MaterialAttributeRow[] {
  return getDb()
    .prepare(`SELECT * FROM material_attributes WHERE material_id = ? ORDER BY attribute_name`)
    .all(materialId) as unknown as MaterialAttributeRow[];
}

export function upsertAttribute(input: {
  materialId: number;
  attributeName: string;
  value: string;
  normalizedValue?: string | null;
  unit?: string | null;
  isCritical?: boolean;
  extractionMethod?: 'rule' | 'manual' | 'imported';
  confidence?: number | null;
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO material_attributes
         (material_id, attribute_name, value, normalized_value, unit, is_critical, extraction_method, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (material_id, attribute_name)
       DO UPDATE SET value = excluded.value, normalized_value = excluded.normalized_value,
                     unit = excluded.unit, is_critical = excluded.is_critical,
                     extraction_method = excluded.extraction_method, confidence = excluded.confidence,
                     updated_at = excluded.updated_at`
    )
    .run(
      input.materialId,
      input.attributeName,
      input.value,
      input.normalizedValue ?? null,
      input.unit ?? null,
      input.isCritical ? 1 : 0,
      input.extractionMethod ?? 'imported',
      input.confidence ?? null
    );
  return Number(res.lastInsertRowid);
}

/** Remove every attribute of a material (used before a pipeline re-run). */
export function deleteAllAttributes(materialId: number): void {
  getDb().prepare(`DELETE FROM material_attributes WHERE material_id = ?`).run(materialId);
}

/** Count materials per processing status (metrics). */
export function countByProcessingStatus(): Array<{ processing_status: string; n: number }> {
  return getDb()
    .prepare(
      `SELECT processing_status, COUNT(*) AS n FROM material_records WHERE is_active = 1 GROUP BY processing_status ORDER BY processing_status`
    )
    .all() as Array<{ processing_status: string; n: number }>;
}

/** Count materials per quality verdict (metrics). */
export function countByQualityStatus(): Array<{ quality_status: string; n: number }> {
  return getDb()
    .prepare(
      `SELECT COALESCE(quality_status, 'not_processed') AS quality_status, COUNT(*) AS n
         FROM material_records WHERE is_active = 1 GROUP BY quality_status ORDER BY n DESC, quality_status`
    )
    .all() as Array<{ quality_status: string; n: number }>;
}

export function deleteAttribute(materialId: number, attributeName: string): void {
  getDb()
    .prepare(`DELETE FROM material_attributes WHERE material_id = ? AND attribute_name = ?`)
    .run(materialId, attributeName);
}
