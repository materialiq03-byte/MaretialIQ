import { requirePermission } from '@/lib/auth/guard';
import { listOrganizations, createOrganization } from '@/lib/db/repositories/organization-repository';
import { listOrganizationsWithCounts } from '@/lib/db/repositories/organization-queries';
import { listUsers } from '@/lib/auth/admin-service';
import { countUsers } from '@/lib/auth/user-repository';
import OrgForm from './org-form';

export const dynamic = 'force-dynamic';

export default async function AdminOrganizationsPage() {
  await requirePermission('MANAGE_ORGANIZATIONS');
  const orgs = listOrganizationsWithCounts();
  const users = countUsers();
  const demoOrgs = listOrganizations().filter((o) => o.name.includes('synthetic demo'));

  return (
    <main>
      <h1>Organization Management</h1>
      <p className="subtitle">
        CPSE organizations available in this prototype. All organizations are synthetic demonstration identities.
      </p>

      <h2>Create organization</h2>
      <OrgForm />

      <h2>Existing organizations ({orgs.length})</h2>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Status</th>
            <th>Materials</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {orgs.map((o) => (
            <tr key={o.id}>
              <td className="mono">{o.code}</td>
              <td>{o.name}</td>
              <td>
                <span className={`badge ${o.status === 'active' ? 'approved' : 'deferred'}`}>{o.status}</span>
              </td>
              <td className="num">{o.material_count}</td>
              <td>{o.created_at.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <h2>Linked demo accounts</h2>
      <p className="subtitle">
        {users} users exist; {demoOrgs.length} organizations are labelled as synthetic demo identities.
      </p>
    </main>
  );
}
