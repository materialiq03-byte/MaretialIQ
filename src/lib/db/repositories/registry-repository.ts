import { getDb } from '../client';
import { errors } from '../../errors';
import { nowIso } from '../util';

export interface CommonMaterialRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  category: string;
  source_match_id: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CmiWithMembers extends CommonMaterialRow {
  members: Array<{
    mapping_id: number;
    material_id: number;
    org_code: string;
    original_code: string;
    original_description: string;
  }>;
}

const SELECT = `SELECT * FROM common_materials`;

export function listCommonMaterials(): CommonMaterialRow[] {
  return getDb().prepare(`${SELECT} ORDER BY code`).all() as unknown as CommonMaterialRow[];
}

export function getCommonMaterial(id: number): CommonMaterialRow | undefined {
  return getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as CommonMaterialRow | undefined;
}

export function getCommonMaterialRequired(id: number): CommonMaterialRow {
  const row = getCommonMaterial(id);
  if (!row) throw errors.notFound('Common material identity');
  return row;
}

/** Read-only lookup: does an active CMI trace back to this approved match? */
export function getCommonMaterialByMatchId(matchId: number): CommonMaterialRow | undefined {
  return getDb()
    .prepare(`${SELECT} WHERE source_match_id = ? AND is_active = 1 LIMIT 1`)
    .get(matchId) as unknown as CommonMaterialRow | undefined;
}

export function createCommonMaterial(input: {
  code: string;
  name: string;
  description?: string;
  category: string;
  sourceMatchId?: number | null;
}): CommonMaterialRow {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO common_materials (code, name, description, category, source_match_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(input.code, input.name, input.description ?? null, input.category, input.sourceMatchId ?? null);
    return getCommonMaterialRequired(Number(res.lastInsertRowid));
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      throw errors.conflict(`Common material code "${input.code}" already exists`);
    }
    throw err;
  }
}

export function listMappings(opts: { cmiId?: number; organizationCode?: string; page: number; pageSize: number }) {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.cmiId) {
    clauses.push('mm.cmi_id = ?');
    params.push(opts.cmiId);
  }
  if (opts.organizationCode) {
    clauses.push('o.code = ?');
    params.push(opts.organizationCode);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const items = getDb()
    .prepare(
      `SELECT mm.*, o.code AS org_code, m.original_code, m.original_description,
              cm.code AS cmi_code, cm.name AS cmi_name
         FROM material_mappings mm
         JOIN organizations o ON o.id = mm.organization_id
         JOIN material_records m ON m.id = mm.material_id
         JOIN common_materials cm ON cm.id = mm.cmi_id
         ${where} ORDER BY cm.code, o.code LIMIT ? OFFSET ?`
    )
    .all(...params, opts.pageSize, (opts.page - 1) * opts.pageSize) as Array<
    Record<string, unknown> & { id: number }
  >;
  const total = (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM material_mappings mm
           JOIN organizations o ON o.id = mm.organization_id
           JOIN common_materials cm ON cm.id = mm.cmi_id ${where}`
      )
      .get(...params) as { n: number }
  ).n;
  return { items, total };
}

export function listMappingsForMaterial(materialId: number) {
  return getDb()
    .prepare(
      `SELECT mm.*, cm.code AS cmi_code, cm.name AS cmi_name
         FROM material_mappings mm JOIN common_materials cm ON cm.id = mm.cmi_id
        WHERE mm.material_id = ?`
    )
    .all(materialId) as Array<Record<string, unknown> & { id: number }>;
}

export function insertMapping(input: { cmiId: number; materialId: number; organizationId: number }): number {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO material_mappings (cmi_id, material_id, organization_id) VALUES (?, ?, ?)`
      )
      .run(input.cmiId, input.materialId, input.organizationId);
    return Number(res.lastInsertRowid);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('UNIQUE constraint failed: material_mappings.material_id')) {
        throw errors.conflict('This material is already mapped to a common material identity');
      }
      if (err.message.includes('FOREIGN KEY constraint failed')) {
        throw errors.badRequest('Common material identity or material does not exist');
      }
    }
    throw err;
  }
}
