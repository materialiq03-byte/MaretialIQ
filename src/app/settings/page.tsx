import { requireUser } from '@/lib/auth/guard';
import { permissionsForRole } from '@/lib/auth/permissions';
import { ROLE_LABELS } from '@/lib/auth/types';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requireUser();
  const permissions = permissionsForRole(user.role);
  const isAdmin = user.role === 'platform_admin';

  return (
    <main>
      <h1>Settings</h1>
      <p className="subtitle">Your account and the effective permissions granted to your role.</p>

      <h2>Profile</h2>
      <div className="record-box">
        <dl>
          <dt>Name</dt>
          <dd>{user.name}</dd>
          <dt>Email</dt>
          <dd className="mono">{user.email}</dd>
          <dt>Role</dt>
          <dd>{ROLE_LABELS[user.role]}</dd>
          <dt>Organization</dt>
          <dd className="mono">{user.organizationCode ?? 'All organizations'}</dd>
        </dl>
      </div>

      <h2>Effective permissions ({permissions.length})</h2>
      <div className="compare-grid">
        <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Permission</th>
            </tr>
          </thead>
          <tbody>
            {permissions.map((p) => (
              <tr key={p}>
                <td className="mono">{p}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {isAdmin ? (
        <>
          <h2>System configuration</h2>
          <div className="record-box">
            <dl>
              <dt>Environment</dt>
              <dd className="mono">{config.env}</dd>
              <dt>Matching fuzzy threshold</dt>
              <dd className="mono">{config.matching.fuzzyThreshold}</dd>
              <dt>Critical attributes</dt>
              <dd className="mono">{config.matching.criticalCategories.join(', ')}</dd>
              <dt>Upload caps</dt>
              <dd className="mono">CSV {config.pipeline.maxCsvImportMb} MB · XLSX {config.pipeline.maxXlsxImportMb} MB</dd>
              <dt>Demo role switching</dt>
              <dd className="mono">
                {config.env !== 'production' || process.env.ALLOW_DEMO_SWITCH === 'true' ? 'enabled' : 'disabled'}
              </dd>
            </dl>
          </div>
          <div className="info-box">
            Configuration values are read from environment variables at startup (see <code>.env.example</code>).
          </div>
        </>
      ) : null}
    </main>
  );
}
