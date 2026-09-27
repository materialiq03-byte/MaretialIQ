import { requirePermission } from '@/lib/auth/guard';
import { listAudit } from '@/lib/db/repositories/audit-repository';

export const dynamic = 'force-dynamic';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('VIEW_AUDIT');
  const sp = await searchParams;
  const action = typeof sp.action === 'string' ? sp.action.trim() : undefined;
  const page = Math.max(1, parseInt(typeof sp.page === 'string' ? sp.page : '1', 10) || 1);

  const { items, total } = listAudit({ page, pageSize: 25, action });
  const filtered = items;
  const totalPages = Math.max(1, Math.ceil(total / 25));

  return (
    <main>
      <h1>Audit Trail</h1>
      <p className="subtitle">
        Security-relevant and workflow events, newest first. Entries are append-only; {total} recorded.
      </p>

      <form className="filterbar" method="get">
        <label className="fld">
          Action
          <select name="action" defaultValue={action ?? ''}>
            <option value="">All actions</option>
            {['user_login', 'user_login_failed', 'user_logout', 'user_created', 'user_role_changed', 'demo_role_switched', 'material_created', 'material_updated', 'material_reprocessed', 'import_performed', 'match_generated', 'proposal_approved', 'proposal_rejected', 'proposal_deferred', 'mapping_created', 'common_material_created'].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Apply</button>
        <a href="/audit">Clear</a>
      </form>

      {filtered.length === 0 ? (
        <div className="empty-state">No audit entries match this filter.</div>
      ) : (
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Actor</th>
              <th>Details</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr key={a.id}>
                <td className="num">{a.id}</td>
                <td className="mono">{a.action}</td>
                <td>
                  {a.entity_type}
                  {a.entity_id ? ` #${a.entity_id}` : ''}
                </td>
                <td className="mono">{a.actor}</td>
                <td className="evidence-detail">
                  {a.details ? JSON.stringify(a.details).slice(0, 120) : '—'}
                </td>
                <td>{a.created_at.slice(0, 19).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div className="pagination">
        Page {page} of {totalPages}
        {page > 1 ? (
          <span>
            {' '}
            <a href={`/audit?page=${page - 1}${action ? `&action=${action}` : ''}`}>← Previous</a>
          </span>
        ) : null}
        {page < totalPages ? (
          <span>
            {' '}
            <a href={`/audit?page=${page + 1}${action ? `&action=${action}` : ''}`}>Next →</a>
          </span>
        ) : null}
      </div>
    </main>
  );
}
