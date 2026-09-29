import { requireUser } from '@/lib/auth/guard';
import { getMetricsForUser } from '@/lib/services/metrics-service';
import { RoleDashboard } from '@/lib/services/dashboard-service';
import { getControlCenterData } from '@/lib/services/control-center-service';
import { ControlCenterDashboard } from '@/app/control-center';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await requireUser();

  let metrics;
  try {
    metrics = await getMetricsForUser(user);
  } catch (err) {
    return (
      <main>
        <h1>Dashboard</h1>
        <div className="error-box">
          Failed to load metrics from the database: {err instanceof Error ? err.message : String(err)}
        </div>
        <p className="subtitle">Run <code>npm run db:migrate</code> and <code>npm run db:seed</code>, then reload.</p>
      </main>
    );
  }

  if (metrics.totalMaterials === 0 && user.role !== 'platform_admin' && user.role !== 'authority') {
    return (
      <main>
        <h1>Dashboard</h1>
        <div className="empty-state">
          No material records for your organization yet. Use the Import & Validation Center to upload a catalogue, or run{' '}
          <code>npm run db:seed</code> to load the demonstration dataset.
        </div>
      </main>
    );
  }

  // Platform-wide operator view (SIH demo): the control-center dashboard.
  // CPSE-scoped roles keep their existing role dashboards.
  if (user.role === 'platform_admin') {
    return <ControlCenterDashboard d={getControlCenterData(metrics)} />;
  }

  return <RoleDashboard user={user} metrics={metrics} />;
}
