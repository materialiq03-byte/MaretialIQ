import { withTransaction } from '../db/client';
import { getCommonMaterialRequired, listCommonMaterials, listMappings, listMappingsForMaterial, insertMapping } from '../db/repositories/registry-repository';
import { getMaterialRequired } from '../db/repositories/material-repository';
import { getOrganizationRequired } from '../db/repositories/organization-queries';
import { recordAudit } from '../db/repositories/audit-repository';
import type { MaterialCreate } from '../validation/schemas';

export interface CmiMember {
  mapping_id: number;
  material_id: number;
  org_code: string;
  original_code: string;
  original_description: string;
}

export function listCmiWithMembers(): Array<{
  cmi: ReturnType<typeof listCommonMaterials>[number];
  members: CmiMember[];
}> {
  const cmis = listCommonMaterials();
  return cmis.map((cmi) => {
    const { items } = listMappings({ cmiId: cmi.id, page: 1, pageSize: 100 });
    const members = (items as unknown as Array<Record<string, unknown>>).map((r) => ({
      mapping_id: Number(r.id),
      material_id: Number(r.material_id),
      org_code: String(r.org_code),
      original_code: String(r.original_code),
      original_description: String(r.original_description),
    }));
    return { cmi, members };
  });
}

export function getCmiDetail(id: number) {
  const cmi = getCommonMaterialRequired(id);
  const { items: members, total } = listMappings({ cmiId: id, page: 1, pageSize: 100 });
  return { cmi, members, total };
}

export function createMapping(input: { cmiId: number; materialId: number }, actor: string) {
  return withTransaction(() => {
    const cmi = getCommonMaterialRequired(input.cmiId);
    const material = getMaterialRequired(input.materialId);
    getOrganizationRequired(material.organization_id);
    const mappingId = insertMapping({
      cmiId: cmi.id,
      materialId: material.id,
      organizationId: material.organization_id,
    });
    recordAudit({
      action: 'mapping_created',
      entityType: 'common_material',
      entityId: cmi.id,
      actor,
      details: { materialId: material.id, originalCode: material.original_code },
    });
    return { mappingId, cmiCode: cmi.code, materialCode: material.original_code };
  });
}
