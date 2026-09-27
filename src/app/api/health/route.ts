import { ok, fail } from '@/lib/api-helpers';
import { getDb } from '@/lib/db/client';

export async function GET() {
  try {
    const db = getDb();
    const orgs = (db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number }).n;
    const materials = (db.prepare('SELECT COUNT(*) AS n FROM material_records').get() as { n: number }).n;
    return ok({ status: 'ok', organizations: orgs, materials });
  } catch (err) {
    return fail(err);
  }
}
