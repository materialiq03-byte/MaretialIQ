import { getOrganization, getOrganizationByCode } from './organization-repository';
import { errors } from '../../errors';

export { getOrganization, getOrganizationByCode };

export function getOrganizationRequired(id: number) {
  const row = getOrganization(id);
  if (!row) throw errors.notFound('Organization');
  return row;
}

export function getOrganizationByCodeRequired(code: string) {
  const row = getOrganizationByCode(code);
  if (!row) throw errors.notFound(`Organization "${code}"`);
  return row;
}

export function listOrganizationsWithCounts() {
  const { getDb } = require('../client') as typeof import('../client');
  return getDb()
    .prepare(
      `SELECT o.*, COUNT(m.id) AS material_count
         FROM organizations o LEFT JOIN material_records m ON m.organization_id = o.id AND m.is_active = 1
        GROUP BY o.id ORDER BY o.code`
    )
    .all() as Array<{ id: number; code: string; name: string; status: string; material_count: number; created_at: string; updated_at: string }>;
}
