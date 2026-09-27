import { requirePermission } from '@/lib/auth/guard';
import { listUsers } from '@/lib/auth/admin-service';
import { listOrganizations } from '@/lib/db/repositories/organization-repository';
import { ROLE_LABELS } from '@/lib/auth/types';
import DemoSwitcher from './demo-switcher';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const user = await requirePermission('MANAGE_USERS');
  const users = listUsers();
  const orgs = listOrganizations();
  const switchable = users
    .filter((u) => u.id !== user.id && u.status === 'active')
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, organizationCode: u.organizationCode }));

  return (
    <main>
      <h1>Administration</h1>
      <p className="subtitle">
        Platform administration for users, organizations and system configuration.
      </p>

      <div className="quick-actions">
        <a className="btn" href="/admin/users">User Management</a>
        <a className="btn" href="/settings">System Settings</a>
      </div>

      <h2>Users ({users.length})</h2>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Organization</th>
            <th>Status</th>
            <th>Last login</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td className="mono">{u.email}</td>
              <td>{ROLE_LABELS[u.role]}</td>
              <td className="mono">{u.organizationCode ?? '—'}</td>
              <td>
                <span className={`badge ${u.status === 'active' ? 'approved' : 'deferred'}`}>{u.status}</span>
              </td>
              <td>{u.last_login_at?.slice(0, 19).replace('T', ' ') ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <h2>Organizations ({orgs.length})</h2>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {orgs.map((o) => (
            <tr key={o.id}>
              <td className="mono">{o.code}</td>
              <td>{o.name}</td>
              <td>{o.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <DemoSwitcher users={switchable} />
    </main>
  );
}
