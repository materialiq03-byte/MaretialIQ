import { requirePermission } from '@/lib/auth/guard';
import { listUsers } from '@/lib/auth/admin-service';
import { listOrganizations } from '@/lib/db/repositories/organization-repository';
import { ROLE_LABELS } from '@/lib/auth/types';
import UserForm from './user-form';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  await requirePermission('MANAGE_USERS');
  const users = listUsers();
  const orgs = listOrganizations().map((o) => ({ id: o.id, code: o.code, name: o.name }));

  return (
    <main>
      <h1>User Management</h1>
      <p className="subtitle">
        Create accounts and assign roles. Passwords are stored as scrypt hashes and never displayed. All changes are
        audit-logged.
      </p>

      <h2>Create user</h2>
      <UserForm organizations={orgs} />

      <h2>Existing users ({users.length})</h2>
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
    </main>
  );
}
