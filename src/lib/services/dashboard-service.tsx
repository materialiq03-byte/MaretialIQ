import { ROLE_LABELS } from '../auth/types';
import { DECISION_STATE_LABELS, type DecisionState } from '../matching/decision';
import type { SessionUser } from '../auth/types';
import type { DashboardMetrics } from '../db/repositories/metrics-repository';
import { Stat, DashboardTable, EmptyHint, MiniBars } from '@/app/dashboard-parts';

/**
 * Role-based dashboard rendering on the ONE /dashboard route. The user's
 * role selects the variant; organization scoping was already applied when
 * the metrics were fetched. No fabricated numbers — every value comes from
 * the metrics repository.
 */
export function RoleDashboard({ user, metrics }: { user: SessionUser; metrics: DashboardMetrics }) {
  switch (user.role) {
    case 'cpse_material_manager':
      return <ManagerDashboard user={user} metrics={metrics} />;
    case 'cpse_technical_reviewer':
      return <ReviewerDashboard user={user} metrics={metrics} />;
    case 'authority':
      return <AuthorityDashboard metrics={metrics} />;
    case 'platform_admin':
      return <AdminDashboard metrics={metrics} />;
  }
}

/** Decision-state label for dashboard stats; unknown states fall back to the raw value. */
function decisionLabel(state: string): string {
  return DECISION_STATE_LABELS[state as DecisionState] ?? state;
}

/* ------------------------ CPSE Material Manager --------------------------- */

function ManagerDashboard({ user, metrics }: { user: SessionUser; metrics: DashboardMetrics }) {
  const orgTitle = `${user.organizationCode ?? 'CPSE'} Workspace`;
  return (
    <main>
      <h1>{orgTitle}</h1>
      <p className="subtitle">
        Signed in as {ROLE_LABELS[user.role]} for {user.organizationName ?? user.organizationCode}. Figures cover
        your organization; matching metrics include candidates that involve your CPSE.
      </p>

      <div className="stat-grid">
        <Stat value={metrics.totalMaterials} label="My Materials" />
        <Stat value={metrics.pendingReviews} label="Pending Reviews" />
        <Stat value={metrics.potentialDuplicates} label="Potential Duplicates" />
        <Stat value={metrics.functionalEquivalents} label="Potential Equivalents" />
        <Stat value={metrics.pendingImports} label="Pending Imports" />
        <Stat value={metrics.totalMappings} label="Active Mappings" />
      </div>

      <div className="quick-actions">
        <a className="btn" href="/imports">Import Materials</a>
        <a className="btn" href="/materials">Open Material Master</a>
        <a className="btn" href="/matching">AI Matching</a>
        <a className="btn" href="/proposals">Review Matches</a>
      </div>

      <h2>Recent imports</h2>
      {metrics.recentImports.length === 0 ? (
        <EmptyHint>No imports recorded for your organization yet. Use the Import & Validation Center to upload a catalogue.</EmptyHint>
      ) : (
        <DashboardTable headers={['File', 'Status', 'Rows', 'OK', 'Failed', 'When']}>
          {metrics.recentImports.map((i) => (
            <tr key={i.id}>
              <td className="mono"><a href={`/imports/${i.id}`}>{i.file_name}</a></td>
              <td>{i.status}</td>
              <td className="num">{i.total_rows}</td>
              <td className="num">{i.successful_rows}</td>
              <td className="num">{i.failed_rows}</td>
              <td>{i.created_at}</td>
            </tr>
          ))}
        </DashboardTable>
      )}

      <h2>Recent matching activity</h2>
      {metrics.recentDecisions.length === 0 ? (
        <EmptyHint>No match decisions recorded yet.</EmptyHint>
      ) : (
        <DashboardTable headers={['Pair', 'Decision', 'Reviewer', 'When']}>
          {metrics.recentDecisions.map((d) => (
            <tr key={d.id}>
              <td className="mono">{d.s_org} {d.s_code} ↔ {d.c_org} {d.c_code}</td>
              <td>{d.decision}</td>
              <td>{d.reviewer}</td>
              <td>{d.decided_at}</td>
            </tr>
          ))}
        </DashboardTable>
      )}

      <h2>Materials requiring attention</h2>
      {metrics.byQualityStatus.filter((q) => q.quality_status !== 'good').length === 0 ? (
        <EmptyHint>All your materials passed the data-quality checks.</EmptyHint>
      ) : (
        <DashboardTable headers={['Quality verdict', 'Records']}>
          {metrics.byQualityStatus
            .filter((q) => q.quality_status !== 'good')
            .map((q) => (
              <tr key={q.quality_status}>
                <td><a href={`/materials?category=&q=`}>{q.quality_status}</a></td>
                <td className="num">{q.n}</td>
              </tr>
            ))}
        </DashboardTable>
      )}
    </main>
  );
}

/* ----------------------- CPSE Technical Reviewer -------------------------- */

function ReviewerDashboard({ user, metrics }: { user: SessionUser; metrics: DashboardMetrics }) {
  return (
    <main>
      <h1>Technical Review Center</h1>
      <p className="subtitle">
        {ROLE_LABELS[user.role]} · {user.organizationCode}. The queue shows candidate pairs that involve your CPSE.
      </p>

      <div className="stat-grid">
        <Stat value={metrics.pendingReviews} label="Pending Reviews" />
        <Stat value={metrics.criticalConflicts} label="Critical Conflicts" />
        <Stat value={metrics.deferredCount} label="Deferred Reviews" />
        <Stat value={metrics.recentDecisions.length} label="Recent Decisions (shown)" />
      </div>

      <h2>Matching pipeline</h2>
      <div className="stat-grid">
        {metrics.matchOverview.map((m) => (
          <Stat key={m.decision} value={m.n} label={decisionLabel(m.decision)} />
        ))}
        {metrics.matchOverview.length === 0 ? <EmptyHint>No pending match candidates. Run the matcher to generate candidates.</EmptyHint> : null}
      </div>

      <h2>Review queue</h2>
      {metrics.pendingReviews === 0 ? (
        <EmptyHint>Your review queue is empty. Run the matcher from the review queue to generate candidates.</EmptyHint>
      ) : (
        <p className="subtitle">
          {metrics.pendingReviews} item{metrics.pendingReviews === 1 ? '' : 's'} awaiting technical review.{' '}
          <a className="btn" href="/proposals">Open review queue</a>
        </p>
      )}

      <h2>Recent decisions</h2>
      {metrics.recentDecisions.length === 0 ? (
        <EmptyHint>No decisions recorded yet.</EmptyHint>
      ) : (
        <DashboardTable headers={['Pair', 'Decision', 'Reviewer', 'When']}>
          {metrics.recentDecisions.map((d) => (
            <tr key={d.id}>
              <td className="mono">{d.s_org} {d.s_code} ↔ {d.c_org} {d.c_code}</td>
              <td>{d.decision}</td>
              <td>{d.reviewer}</td>
              <td>{d.decided_at}</td>
            </tr>
          ))}
        </DashboardTable>
      )}

      <h2>Queue by priority</h2>
      {metrics.openQueue.length === 0 ? (
        <EmptyHint>No open queue items.</EmptyHint>
      ) : (
        <DashboardTable headers={['Priority', 'Items']}>
          {metrics.openQueue.map((q) => (
            <tr key={q.priority}>
              <td>{q.priority}</td>
              <td className="num">{q.n}</td>
            </tr>
          ))}
        </DashboardTable>
      )}
    </main>
  );
}

/* ------------------------------- Authority -------------------------------- */
function AuthorityDashboard({ metrics }: { metrics: DashboardMetrics }) {
  return (
    <main>
      <h1>Cross-CPSE Oversight</h1>
      <p className="subtitle">
        Aggregated harmonization status across all participating organizations. Read-only oversight — figures are
        computed from the database.
      </p>

      <div className="stat-grid">
        <Stat value={metrics.organizations} label="CPSEs in Scope" />
        <Stat value={metrics.totalMaterials} label="Material Records" />
        <Stat value={metrics.potentialDuplicates} label="Potential Duplicates" />
        <Stat value={metrics.functionalEquivalents} label="Potential Functional Equivalents" />
        <Stat value={metrics.pendingReviews} label="Pending Technical Reviews" />
        <Stat value={metrics.criticalConflicts} label="Critical Conflicts" />
        <Stat value={metrics.highConfidenceCandidates} label="High-Confidence Candidates" />
        <Stat value={metrics.commonIdentities} label="Common Material Identities" />
        <Stat value={metrics.totalMappings} label="Active Mappings" />
      </div>

      <h2>Organization summary</h2>
      {metrics.perOrganization.length === 0 ? (
        <EmptyHint>No active organizations.</EmptyHint>
      ) : (
        <DashboardTable headers={['CPSE', 'Materials', 'Pending reviews', 'Critical conflicts', 'Mappings']}>
          {metrics.perOrganization.map((o) => (
            <tr key={o.id}>
              <td><a href={`/materials?cpse=${o.code}`}>{o.code}</a></td>
              <td className="num">{o.materials}</td>
              <td className="num">{o.pending_reviews}</td>
              <td className="num">{o.critical_conflicts}</td>
              <td className="num">{o.mappings}</td>
            </tr>
          ))}
        </DashboardTable>
      )}

      <h2>Portfolio views</h2>
      <div className="chart-grid">
        <MiniBars title="Materials by CPSE" rows={metrics.perOrganization.map((o) => ({ label: o.code, n: o.materials }))} />
        <MiniBars title="Materials by category" rows={metrics.byCategory.map((c) => ({ label: c.category, n: c.n }))} />
        <MiniBars
          title="Match decision distribution (pending)"
          rows={metrics.matchOverview.map((d) => ({ label: decisionLabel(d.decision), n: d.n }))}
        />
        <MiniBars title="Review queue status" rows={metrics.queueStatus.map((q) => ({ label: q.status, n: q.n }))} />
      </div>
    </main>
  );
}

/* ---------------------------- Platform Admin ------------------------------ */

function AdminDashboard({ metrics }: { metrics: DashboardMetrics }) {
  return (
    <main>
      <h1>Dashboard</h1>
      <p className="subtitle">Platform-wide status across all CPSEs. Administrative modules are linked below.</p>

      <div className="stat-grid">
        <Stat value={metrics.organizations} label="Organizations" />
        <Stat value={metrics.users} label="Users" />
        <Stat value={metrics.totalMaterials} label="Materials" />
        <Stat value={metrics.importsCompleted} label="Completed Imports" />
        <Stat value={metrics.pendingReviews} label="Pending Reviews" />
        <Stat value={metrics.commonIdentities} label="Common Identities" />
      </div>

      <div className="quick-actions">
        <a className="btn" href="/admin/users">User Management</a>
        <a className="btn" href="/admin/organizations">Organization Management</a>
        <a className="btn" href="/settings">System Settings</a>
        <a className="btn" href="/audit">Audit Logs</a>
      </div>

      <h2>System activity</h2>
      {metrics.recentActivity.length === 0 ? (
        <EmptyHint>No activity recorded yet.</EmptyHint>
      ) : (
        <DashboardTable headers={['Action', 'Entity', 'Actor', 'When']}>
          {metrics.recentActivity.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.action}</td>
              <td>{a.entity_type}{a.entity_id ? ` #${a.entity_id}` : ''}</td>
              <td>{a.actor}</td>
              <td>{a.created_at}</td>
            </tr>
          ))}
        </DashboardTable>
      )}

      <h2>Portfolio views</h2>
      <div className="chart-grid">
        <MiniBars title="Materials by CPSE" rows={metrics.perOrganization.map((o) => ({ label: o.code, n: o.materials }))} />
        <MiniBars title="Materials by category" rows={metrics.byCategory.map((c) => ({ label: c.category, n: c.n }))} />
        <MiniBars
          title="Match decision distribution (pending)"
          rows={metrics.matchOverview.map((d) => ({ label: decisionLabel(d.decision), n: d.n }))}
        />
        <MiniBars title="Review queue status" rows={metrics.queueStatus.map((q) => ({ label: q.status, n: q.n }))} />
      </div>
    </main>
  );
}
