import { requirePermission, visibleOrganizationIds } from '@/lib/auth/guard';
import { listMaterials, listCategories, listDuplicateCodeGroups, type MaterialSortField } from '@/lib/db/repositories/material-repository';
import { listBlockedCodeCollisions, type BlockedCodeCollision } from '@/lib/db/repositories/import-repository';
import { listOrganizations, getOrganization } from '@/lib/db/repositories/organization-repository';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

const SORTS: Array<{ value: string; label: string }> = [
  { value: 'code', label: 'Code' },
  { value: 'category', label: 'Category' },
  { value: 'org', label: 'CPSE' },
  { value: 'description', label: 'Description' },
  { value: 'updated', label: 'Last updated' },
];

/** Org code for a read scope, or undefined for platform-wide. */
function orgCodeOf(scope: number[] | null): string | undefined {
  if (scope === null) return undefined;
  const org = getOrganization(scope[0]);
  return org?.code;
}

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('VIEW_MATERIALS');
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const search = get('q')?.trim() || undefined;
  const cpse = get('cpse')?.trim() || undefined;
  const category = get('category')?.trim() || undefined;
  const sort = (get('sort') as MaterialSortField | undefined) ?? 'code';
  const dir = get('dir') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, parseInt(get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(config.pageSize.max, Math.max(1, parseInt(get('pageSize') ?? '10', 10) || 10));

  let result: ReturnType<typeof listMaterials>;
  let categories: ReturnType<typeof listCategories>;
  let orgs: ReturnType<typeof listOrganizations>;
  let duplicateCodes: ReturnType<typeof listDuplicateCodeGroups> = [];
  let codeCollisions: BlockedCodeCollision[] = [];
  let loadError: string | null = null;
  // Server-side org scoping: CPSE users can never widen their view via URL params.
  const scope = visibleOrganizationIds(user);
  const scopedCpse = scope === null ? cpse : (orgCodeOf(scope) ?? 'none');
  try {
    result = listMaterials({ search, organizationCode: scopedCpse, category, page, pageSize, sort, direction: dir });
    categories = listCategories();
    orgs = listOrganizations();
    // Data-governance banner: same CPSE + same code but conflicting item
    // identities. Both records stay listed; the system never auto-merges.
    duplicateCodes = listDuplicateCodeGroups().filter((d) => scope !== null ? d.organization_id === scope[0] : true);
    const collisions = listBlockedCodeCollisions();
    codeCollisions = scope === null ? collisions : collisions.filter((c) => scope.some((id) => getOrganization(id)?.name === c.orgName));
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    result = { items: [], total: 0 };
    categories = [];
    orgs = [];
  }

  if (loadError) {
    return (
      <main>
        <h1>Material Master</h1>
        <div className="error-box">Failed to load materials: {loadError}</div>
      </main>
    );
  }

  const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
  const pageLink = (p: number, label: string) => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (cpse) params.set('cpse', cpse);
    if (scope !== null && user.organizationCode) params.set('cpse', user.organizationCode);
    if (category) params.set('category', category);
    params.set('sort', sort);
    params.set('dir', dir);
    params.set('page', String(p));
    return <a href={`/materials?${params.toString()}`}>{label}</a>;
  };

  return (
    <main>
      <h1>Material Master</h1>
      <p className="subtitle">
        Cross-CPSE material records and technical attributes — {result.total} record{result.total === 1 ? '' : 's'}
        {scope === null ? ` across ${orgs.length} CPSEs` : ` for ${user.organizationCode}`}. Click a code for the
        full engineering record, technical attributes and match history.
      </p>

      <form className="filterbar" method="get">
        <label className="fld">
          Search
          <input type="text" name="q" defaultValue={search ?? ''} placeholder="code, description, maker…" />
        </label>
        <label className="fld">
          CPSE
          <select name="cpse" defaultValue={scopedCpse ?? ''} disabled={scope !== null}>
            {scope !== null ? (
              <option value={scopedCpse ?? ''}>{user.organizationCode}</option>
            ) : (
              <>
                <option value="">All CPSEs</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.code}>
                    {o.code} — {o.name.replace(' (synthetic demo)', '')}
                  </option>
                ))}
              </>
            )}
          </select>
        </label>
        <label className="fld">
          Category
          <select name="category" defaultValue={category ?? ''}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.category} value={c.category}>
                {c.category} ({c.count})
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          Sort by
          <select name="sort" defaultValue={sort}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          Direction
          <select name="dir" defaultValue={dir}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
        <button type="submit">Apply</button>
        <a href="/materials">Clear</a>
      </form>

      {duplicateCodes.length > 0 ? (
        <div className="error-box" role="alert">
          <strong>⚠ Data governance issue — duplicate material code within a CPSE</strong>
          {duplicateCodes.map((d) => (
            <div key={`${d.org_code}-${d.original_code}`}>
              <span className="mono">{d.org_code} · {d.original_code}</span> — {d.n} records with conflicting identities:{' '}
              {d.descriptions.split(' | ').map((desc, i) => (
                <span key={i}>
                  {i > 0 ? ' vs ' : '“'}{desc}{i < d.descriptions.split(' | ').length - 1 ? '' : '”'}
                </span>
              ))}
              . Both records are kept separate — the system never merges rows on code equality alone.
            </div>
          ))}
        </div>
      ) : null}

      {codeCollisions.length > 0 ? (
        <div className="error-box" role="alert">
          <strong>⚠ Data governance issue — same code offered for a different item (import blocked, no records merged)</strong>
          {codeCollisions.map((c, i) => (
            <div key={`${c.code}-${c.existingMaterialId}-${i}`}>
              <span className="mono">{c.orgName} · {c.code}</span> — file offers “{c.fileDescription}” but the CPSE already holds{' '}
              <a href={`/materials/${c.existingMaterialId}`}>record #{c.existingMaterialId}</a> “{c.existingDescription}”. The import row was{' '}
              <a href={`/imports/${c.importId}`}>blocked</a> — resolve manually; the system never merges rows on code equality alone.
            </div>
          ))}
        </div>
      ) : null}

      {result.items.length === 0 ? (
        <div className="empty-state">
          No material records match these filters. <a href="/materials">Clear filters</a> or run the demo seed.
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="ent-table">
            <thead>
              <tr>
                <th>Material Code</th>
                <th>CPSE</th>
                <th>Description</th>
                <th>Category</th>
                <th>Manufacturer</th>
                <th>Part Number</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((m) => (
                <tr key={m.id}>
                  <td>
                    <a className="ent-code" href={`/materials/${m.id}`}>
                      {m.original_code}
                    </a>
                  </td>
                  <td className="mono">{m.org_code}</td>
                  <td className="ent-desc">{m.original_description}</td>
                  <td>{m.category}</td>
                  <td>{m.manufacturer ?? '—'}</td>
                  <td className="mono">{m.model ?? m.part_number ?? '—'}</td>
                  <td>
                    <span className={`badge ${m.processing_status === 'warning' ? 'pending' : 'approved'}`}>
                      {m.processing_status === 'warning' ? 'Warning' : 'Active'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="pagination">
            Page {page} of {totalPages} · {result.total} records
            {page > 1 ? <span> · {pageLink(page - 1, '← Previous')}</span> : null}
            {page < totalPages ? <span> · {pageLink(page + 1, 'Next →')}</span> : null}
          </div>
        </>
      )}
    </main>
  );
}
