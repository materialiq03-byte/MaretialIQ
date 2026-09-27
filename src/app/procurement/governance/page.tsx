import Link from 'next/link';
import { requirePermission } from '@/lib/auth/guard';
import { roleHasPermission } from '@/lib/auth/permissions';
import { getGovernanceCockpit } from '@/lib/services/procurement-service';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Governance Cockpit — MaterialIQ' };

/**
 * Step 21 — unified governance cockpit (sections 2–11). READ-ONLY
 * orchestration over existing engines: it surfaces what requires human
 * attention and routes users into the existing governed workflows. It never
 * mutates rules, audit, history or procurement data. All authorization
 * remains server-side; this page only decides which explanatory note to show.
 */
export default async function GovernanceCockpitPage() {
  const user = await requirePermission('VIEW_MAPPINGS');
  const canGovern = roleHasPermission(user.role, 'MANAGE_UOM_RULES');
  const cockpit = getGovernanceCockpit();

  const stateBadge = (state: string): string =>
    state === 'PASS' ? 'badge approved' : state === 'WARNING' ? 'badge pending' : 'badge rejected';

  const typeLabel: Record<string, string> = {
    MATCH_REVIEW: 'MATCH',
    UOM_RULE_APPROVAL: 'UOM RULE',
    UOM_RULE_AMENDMENT: 'AMENDMENT',
    UOM_REMEDIATION: 'UOM QUALITY',
    CMI_GOVERNANCE: 'CMI',
  };

  const summaryCards: Array<{ label: string; value: number; href: string }> = [
    { label: 'Open technical reviews', value: cockpit.summary.openReviews, href: '/proposals?status=NEEDS_REVIEW' },
    { label: 'Pending UOM rules', value: cockpit.summary.pendingUomRules, href: '/procurement/uom-steward' },
    { label: 'Active governed rules', value: cockpit.summary.activeGovernedRules, href: '/procurement/uom-rules' },
    { label: 'Pending amendments', value: cockpit.summary.pendingAmendments, href: '/procurement/uom-steward' },
    { label: 'Unconverted records', value: cockpit.summary.unconvertedRecords, href: '/procurement/uom-rules' },
    { label: 'CPSEs awaiting CMI', value: cockpit.summary.cmisAwaitingGovernance, href: '/cross-reference' },
    { label: 'Governance events (30d)', value: cockpit.summary.governanceEvents30d, href: '/procurement/governance' },
  ];

  return (
    <main className="hq-root">
      <section className="hq3-pagehead hq3-govhead hq6-pagehead" aria-label="Governance cockpit">
        <div>
          <p className="hq3-kicker">AUTOMATION PROPOSES · AUTHORIZED HUMANS GOVERN</p>
          <h1>Governance Cockpit</h1>
          <p className="hq3-sub">
            One operational view of what requires human attention, whether governance is healthy, and where work waits.
            Read-only: every action routes into the existing governed workflow. No automatic conversion, no automatic
            approval, no automatic repair. Governed identities live in the{' '}
            <Link href="/cross-reference">Common Material Identity console</Link>.
          </p>
        </div>
      </section>

      <div className="hq-kpis">
        {summaryCards.map((c) => (
          <Link key={c.label} href={c.href} className="hq-kpi">
            <div className="hq-kpi-value">{c.value}</div>
            <div className="hq-kpi-label">{c.label}</div>
          </Link>
        ))}
      </div>

      <div className="detail-card">
        <h2 className="hq3-sec">
          <span className="hq6-secno">01</span> Human work queue
        </h2>
        <p className="note">
          Existing work from every governed surface, oldest and highest priority first. Deep links open the existing
          review pages — this queue never performs mutations.
        </p>
        {cockpit.workQueue.length === 0 ? (
          <p className="note">Nothing requires human attention right now.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Item</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th>Reason / evidence</th>
                  <th>Required action</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {cockpit.workQueue.map((w, i) => (
                  <tr key={`${w.type}-${i}`}>
                    <td>{typeLabel[w.type] ?? w.type}</td>
                    <td>{w.ref}</td>
                    <td className="mono">{w.scope}</td>
                    <td>
                      <span className="badge">{w.status}</span>
                    </td>
                    <td>{w.reason}</td>
                    <td>{w.requiredAction}</td>
                    <td>
                      <Link className="btn" href={w.href}>
                        Review
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="detail-card">
        <h2 className="hq3-sec">
          <span className="hq6-secno">02</span> Governance health
        </h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Indicator</th>
              <th>State</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {cockpit.health.map((h) => (
              <tr key={h.id}>
                <td>{h.label}</td>
                <td>
                  <span className={stateBadge(h.state)}>{h.state}</span>
                </td>
                <td>{h.evidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          Indicators are threshold-based and fully explainable — there is no invented health score and no AI confidence
          number for governance.
        </p>
      </div>

      <div className="detail-card">
        <h2 className="hq3-sec">
          <span className="hq6-secno">03</span> UOM quality / remediation
        </h2>
        <div className="hq-kpis">
          {Object.entries(cockpit.quality.counts).map(([bucket, n]) => (
            <div key={bucket} className="hq-kpi">
              <div className="hq-kpi-value">{n}</div>
              <div className="hq-kpi-label">{bucket}</div>
            </div>
          ))}
          <div className="hq-kpi">
            <div className="hq-kpi-value">{cockpit.quality.cmisRequiringRemediation}</div>
            <div className="hq-kpi-label">CMIs requiring remediation</div>
          </div>
        </div>
        {cockpit.quality.unknownUoms.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Unknown UOM</th>
                  <th>Records</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {cockpit.quality.unknownUoms.map((u) => (
                  <tr key={u.uom}>
                    <td className="mono">{u.uom}</td>
                    <td className="num">{u.count}</td>
                    <td>No approved conversion rule exists.</td>
                    <td>
                      <Link href="/procurement/uom-rules">Investigate</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="detail-card">
        <h2 className="hq3-sec">
          <span className="hq6-secno">04</span> Rule &amp; amendment activity — recent governance events
        </h2>
        <p className="note">
          Merged read-only timeline. Source is preserved per row: UOM_RULE_HISTORY (rule chronology) vs AUDIT
          (security/governance record) — never merged physically.
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Source</th>
                <th>Event</th>
                <th>Actor</th>
                <th>Entity</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {cockpit.activity.map((a) => (
                <tr key={`${a.source}-${a.id}`}>
                  <td>{a.at.slice(0, 16).replace('T', ' ')}</td>
                  <td>{a.source === 'AUDIT' ? 'AUDIT' : 'HISTORY'}</td>
                  <td>{a.action}</td>
                  <td>{a.actor}</td>
                  <td>
                    {a.entityType}
                    {a.entityId !== null ? ` #${a.entityId}` : ''}
                  </td>
                  <td>{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="detail-card">
        <h2 className="hq3-sec">
          <span className="hq6-secno">05</span> Steward monthly summary
        </h2>
        <p className="note">Whole-month buckets from the append-only UOM rule history (last 12 months with events).</p>
        {cockpit.monthly.length === 0 ? (
          <p className="note">No governance history recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Rules created</th>
                  <th>Approved</th>
                  <th>Rejected</th>
                  <th>Disabled</th>
                  <th>Re-enabled</th>
                  <th>Amendments proposed</th>
                </tr>
              </thead>
              <tbody>
                {cockpit.monthly.map((m) => (
                  <tr key={m.month}>
                    <td className="mono">{m.month}</td>
                    <td className="num">{m.created}</td>
                    <td className="num">{m.approved}</td>
                    <td className="num">{m.rejected}</td>
                    <td className="num">{m.disabled}</td>
                    <td className="num">{m.reEnabled}</td>
                    <td className="num">{m.amendmentsProposed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="detail-card">
        <h2 className="hq3-sec">
          <span className="hq6-secno">06</span> Audit ↔ history reconciliation
        </h2>
        <p className="note">
          Status:{' '}
          <span className={cockpit.reconciliation.status === 'RECONCILED' ? 'badge approved' : 'badge rejected'}>
            {cockpit.reconciliation.status}
          </span>{' '}
          — {cockpit.reconciliation.reconciledCount}/{cockpit.reconciliation.historyEventsChecked} governance events
          paired with their audit twin ({cockpit.reconciliation.auditEventsChecked} audit events checked). Discrepancies
          are reported, never repaired.
        </p>
        {cockpit.reconciliation.discrepancies.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Rule</th>
                  <th>History event</th>
                  <th>Audit event</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {cockpit.reconciliation.discrepancies.map((d, i) => (
                  <tr key={i}>
                    <td>{d.kind}</td>
                    <td>#{d.ruleId}</td>
                    <td>{d.historyId !== null ? `#${d.historyId}` : '—'}</td>
                    <td>{d.auditId !== null ? `#${d.auditId}` : '—'}</td>
                    <td>{d.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="note">
        Demonstration environment with representative synthetic data — cockpit values describe this prototype dataset,
        not production CPSE operations.{' '}
        {canGovern
          ? 'You hold MANAGE_UOM_RULES: mutations are available through the governed UOM rule pages and APIs.'
          : 'Your role is read-only for governance: views and queues are visible, mutations are server-side denied.'}
      </p>
    </main>
  );
}
