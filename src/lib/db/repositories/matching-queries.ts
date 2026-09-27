import { getDb } from '../client';
import type { MatchableMaterial } from '../../matching/types';

/**
 * Read model for the matching engine: every active material with its
 * structured attributes, in deterministic order.
 */
export function listAllMaterialsForMatching(): MatchableMaterial[] {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.organization_id, o.code AS org_code, m.original_code,
              m.original_description, m.normalized_description, m.category,
              m.manufacturer, m.model, m.part_number, m.uom
         FROM material_records m JOIN organizations o ON o.id = m.organization_id
        WHERE m.is_active = 1
        ORDER BY o.code, m.original_code`
    )
    .all() as Array<{
    id: number; organization_id: number; org_code: string; original_code: string;
    original_description: string; normalized_description: string | null; category: string;
    manufacturer: string | null; model: string | null; part_number: string | null; uom: string;
  }>;

  const grouped = listAttributesForMaterials(rows.map((r) => r.id));

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    orgCode: r.org_code,
    originalCode: r.original_code,
    originalDescription: r.original_description,
    normalizedDescription: r.normalized_description,
    category: r.category,
    manufacturer: r.manufacturer,
    model: r.model,
    partNumber: r.part_number,
    uom: r.uom,
    attributes: grouped.get(r.id) ?? [],
  }));
}

/**
 * Batched attribute hydration for the matching read model: one IN-clause
 * query per chunk of material ids (SQLite host-parameter ceiling), grouped
 * by material in memory. Replaces the previous per-material N+1 pattern
 * (1 attribute query per material). Per-material rows keep the exact
 * attribute_name ordering of listAttributesForMaterial, and the returned
 * shape is unchanged.
 */
function listAttributesForMaterials(materialIds: number[]): Map<number, MatchableMaterial['attributes']> {
  const grouped = new Map<number, MatchableMaterial['attributes']>();
  const CHUNK_SIZE = 900; // stay under SQLite's host-parameter limit
  for (let i = 0; i < materialIds.length; i += CHUNK_SIZE) {
    const chunk = materialIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = getDb()
      .prepare(
        `SELECT material_id, attribute_name, value, normalized_value, unit, is_critical
           FROM material_attributes
          WHERE material_id IN (${placeholders})
          ORDER BY material_id, attribute_name`
      )
      .all(...chunk) as Array<{
      material_id: number;
      attribute_name: string; value: string; normalized_value: string | null; unit: string | null; is_critical: number;
    }>;
    for (const r of rows) {
      let list = grouped.get(r.material_id);
      if (!list) {
        list = [];
        grouped.set(r.material_id, list);
      }
      list.push({
        attributeName: r.attribute_name,
        value: r.value,
        normalizedValue: r.normalized_value,
        unit: r.unit,
        isCritical: r.is_critical === 1,
      });
    }
  }
  return grouped;
}

export function listAttributesForMaterial(materialId: number): MatchableMaterial['attributes'] {
  const rows = getDb()
    .prepare(
      `SELECT attribute_name, value, normalized_value, unit, is_critical
         FROM material_attributes WHERE material_id = ? ORDER BY attribute_name`
    )
    .all(materialId) as Array<{
    attribute_name: string; value: string; normalized_value: string | null; unit: string | null; is_critical: number;
  }>;
  return rows.map((r) => ({
    attributeName: r.attribute_name,
    value: r.value,
    normalizedValue: r.normalized_value,
    unit: r.unit,
    isCritical: r.is_critical === 1,
  }));
}

/**
 * Workspace search: resolve a free-text query to a single material id so the
 * existing `materialId` pair filter can be reused. Resolution order: exact
 * original code → code prefix → description substring. Read-only; returns null
 * when nothing matches (the UI shows an honest "no material found" hint).
 */
export function findMaterialIdBySearch(query: string): number | null {
  const q = query.trim();
  if (!q) return null;
  const db = getDb();
  const exact = db
    .prepare(`SELECT id FROM material_records WHERE original_code = ? COLLATE NOCASE LIMIT 1`)
    .get(q) as { id: number } | undefined;
  if (exact) return exact.id;
  const byCode = db
    .prepare(
      `SELECT id FROM material_records WHERE original_code LIKE ? COLLATE NOCASE
        ORDER BY original_code LIMIT 1`
    )
    .get(`${q}%`) as { id: number } | undefined;
  if (byCode) return byCode.id;
  const byDesc = db
    .prepare(
      `SELECT id FROM material_records WHERE original_description LIKE ? COLLATE NOCASE
        ORDER BY original_code LIMIT 1`
    )
    .get(`%${q}%`) as { id: number } | undefined;
  return byDesc?.id ?? null;
}

/** Both records of a match pair, fully hydrated for the side-by-side comparison page. */
export function getMaterialsForComparison(idA: number, idB: number): MatchableMaterial[] {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.organization_id, o.code AS org_code, m.original_code,
              m.original_description, m.normalized_description, m.category,
              m.manufacturer, m.model, m.part_number, m.uom
         FROM material_records m JOIN organizations o ON o.id = m.organization_id
        WHERE m.id IN (?, ?)`
    )
    .all(idA, idB) as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({
      id: r.id as number,
      organizationId: r.organization_id as number,
      orgCode: r.org_code as string,
      originalCode: r.original_code as string,
      originalDescription: r.original_description as string,
      normalizedDescription: (r.normalized_description as string | null) ?? null,
      category: r.category as string,
      manufacturer: (r.manufacturer as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      partNumber: (r.part_number as string | null) ?? null,
      uom: r.uom as string,
      attributes: listAttributesForMaterial(r.id as number),
    }))
    .sort((a, b) => (a.id === idA ? -1 : b.id === idA ? 1 : 0));
}
