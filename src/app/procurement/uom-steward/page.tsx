import Link from 'next/link';
import { requirePermission } from '@/lib/auth/guard';
import { roleHasPermission } from '@/lib/auth/permissions';
import { getUomStewardDashboard, listGovernedUomRules } from '@/lib/services/procurement-service';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'UOM Steward — MaterialIQ' };

/**
 * Step 19 — UOM steward governance dashboard (sections 5/6): operational
 * KPIs, the PENDING work queue, governance activity and quality remediation.
 * Read-only page (no governance actions here); mutations stay on
 * /procurement/uom-rules where the governed controls live. Reads are
 * audit-silent.
 */
export default async function UomStewardPage() {
  const user = await requirePermission('VIEW_MAPPINGS');
  const canGovern = roleHasPermission(user.role, 'MANAGE_UOM_RULES');
  const overview = getUomStewardDashboard();
  const allRules = listGovernedUomRules();

  return (
    <main className="hq-root">
      <section className="hq3-pagehead" aria-label="UOM stewardship">
        <div>
          <p className="hq3-kicker">UNIT OF MEASURE STEWARDSHIP</p>
          <h1>UOM Steward Dashboard</h1>
          <p className="hq3-sub">
            Governance maturity for material-specific UOM rules — every conversion has an approved rule, every action is
            attributable, every state change traceable. No automatic conversion.
          </p>
        </div>
        <div className="hq3-pagehead-actions">
          <Link className="btn" href="/procurement/uom-rules">
            UOM Rules &amp; Governance
          </Link>
          <Link className="btn" href="/procurement">
            Procurement
          </Link>
        </div>
      </section>

      {/* UOM governance flow — architecture motif, not a claim of live execution. */}
      <ol className="hq3-flowstrip" aria-label="UOM governance flow">
        <li>
          <span className="hq3-flow-n">01</span>
          <span className="hq3-flow-name">SOURCE UNIT</span>
          <span className="hq3-flow-note">Recorded verbatim on the procurement record</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">02</span>
          <span className="hq3-flow-name">NORMALIZATION RULE</span>
          <span className="hq3-flow-note">Material-specific, human-approved</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">03</span>
          <span className="hq3-flow-name">CANONICAL UNIT</span>
          <span className="hq3-flow-note">Comparable quantities only where a rule exists</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">04</span>
          <span className="hq3-flow-name">GOVERNANCE / AUDIT</span>
          <span className="hq3-flow-note">Versioned history + audit twin</span>
        </li>
      </ol>
      <p className="note hq7-boundary">
        <strong>SYSTEM NORMALIZATION</strong> applies only governed rule content; <strong>GOVERNED RULE CONTENT</strong>{' '}
        is created and changed exclusively by authorized human decisions below. Original quantities and UOMs are never
        modified.
      </p>

      <div className="detail-card">
        <h2 className="hq3-sec"><span className="hq6-secno">01</span> Rules</h2>
        <div className="hq-kpis">
          <div className="hq-kpi">
            <div className="hq-kpi-label">Total domain rules</div>
            <div className="hq-kpi-value">{overview.rules.total}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Pending</div>
            <div className="hq-kpi-value">{overview.rules.pending}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Approved</div>
            <div className="hq-kpi-value">{overview.rules.approved}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Rejected</div>
            <div className="hq-kpi-value">{overview.rules.rejected}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Disabled</div>
            <div className="hq-kpi-value">{overview.rules.disabled}</div>
          </div>
        </div>
      </div>

      <div className="detail-card">
        <h2 className="hq3-sec"><span className="hq6-secno">02</span> Work queue — pending rules requiring approval</h2>
        {overview.pendingQueue.length === 0 ? (
          <p className="note">No PENDING rules. Nothing awaits a human decision.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Conversion</th>
                  <th>Status</th>
                  <th>Created By</th>
                  <th>Created</th>
                  <th>CMI records</th>
                  <th>Affected records</th>
                  <th>History</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {overview.pendingQueue.map((q) => (
                  <tr key={q.rule.id}>
                    <td className="mono">{q.rule.cmiCode}</td>
                    <td>
                      {q.rule.fromUom} → {q.rule.toUom} ×{q.rule.factor}
                    </td>
                    <td>
                      <span className="badge">{q.rule.status}</span>
                    </td>
                    <td>{q.rule.createdBy}</td>
                    <td>{q.rule.createdAt.slice(0, 10)}</td>
                    <td className="num">{q.cmiRecordCount}</td>
                    <td className="num">{q.affectedRecords}</td>
                    <td className="num">{q.historyCount}</td>
                    <td>
                      <Link className="btn" href={`/procurement/uom-rules?rule=${q.rule.id}`}>
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
        <h2 className="hq3-sec"><span className="hq6-secno">03</span> Governance activity — last {overview.activity.horizonDays} days</h2>
        <div className="hq-kpis">
          <div className="hq-kpi">
            <div className="hq-kpi-label">Rules created</div>
            <div className="hq-kpi-value">{overview.activity.created}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Approved</div>
            <div className="hq-kpi-value">{overview.activity.approved}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Rejected</div>
            <div className="hq-kpi-value">{overview.activity.rejected}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Disabled</div>
            <div className="hq-kpi-value">{overview.activity.disabled}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Re-enabled</div>
            <div className="hq-kpi-value">{overview.activity.reEnabled}</div>
          </div>
        </div>
        {overview.recentActivity.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Rule</th>
                  <th>Scope</th>
                  <th>Conversion</th>
                  <th>Action</th>
                  <th>Previous → New</th>
                  <th>Actor</th>
                  <th>Rule now</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {overview.recentActivity.map((h) => (
                  <tr key={h.id}>
                    <td>{h.createdAt.slice(0, 16).replace('T', ' ')}</td>
                    <td>
                      <Link href={`/procurement/uom-rules?rule=${h.ruleId}`}>#{h.ruleId}</Link>
                    </td>
                    <td className="mono">{h.cmiCode}</td>
                    <td>
                      {h.fromUom} → {h.toUom} ×{h.factor}
                    </td>
                    <td>{h.action}</td>
                    <td>
                      {h.previousStatus ?? '—'} → {h.newStatus}
                    </td>
                    <td>{h.actor}</td>
                    <td>{h.ruleStatus ?? '—'}</td>
                    <td>
                      <Link className="btn" href={`/procurement/uom-rules?rule=${h.ruleId}`}>
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
        <h2 className="hq3-sec"><span className="hq6-secno">04</span> Amendment work queue — pending version changes</h2>
        {overview.amendmentQueue.length === 0 ? (
          <p className="note">No PENDING amendments. Every rule&apos;s current version is the latest decision.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Scope</th>
                  <th>Current version</th>
                  <th>Proposed version</th>
                  <th>Affected records</th>
                  <th>Proposed by</th>
                  <th>Reason</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {overview.amendmentQueue.map((q) => (
                  <tr key={q.rule.id}>
                    <td>#{q.rule.id}</td>
                    <td className="mono">{q.rule.cmiCode}</td>
                    <td>
                      {q.effectiveVersion
                        ? `v${q.effectiveVersion.versionNumber}: ${q.effectiveVersion.fromUom} → ${q.effectiveVersion.toUom} ×${q.effectiveVersion.factor}`
                        : '—'}
                    </td>
                    <td>
                      {q.proposedVersion
                        ? `v${q.proposedVersion.versionNumber}: ${q.proposedVersion.fromUom} → ${q.proposedVersion.toUom} ×${q.proposedVersion.factor}`
                        : '—'}
                    </td>
                    <td className="num">{q.affectedRecords}</td>
                    <td>{q.proposedVersion?.createdBy ?? '—'}</td>
                    <td>{q.proposedVersion?.amendmentReason ?? '—'}</td>
                    <td>
                      <Link className="btn" href={`/procurement/uom-rules?rule=${q.rule.id}`}>
                        Review
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>Version activity — last {overview.amendments.horizonDays} days</h3>
        <div className="hq-kpis">
          <div className="hq-kpi">
            <div className="hq-kpi-label">Total versions</div>
            <div className="hq-kpi-value">{overview.versions.total}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Superseded versions</div>
            <div className="hq-kpi-value">{overview.versions.superseded}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Amendments proposed</div>
            <div className="hq-kpi-value">{overview.amendments.proposed}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Amendment approvals</div>
            <div className="hq-kpi-value">{overview.amendments.approved}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Amendment rejections</div>
            <div className="hq-kpi-value">{overview.amendments.rejected}</div>
          </div>
        </div>
      </div>

      <div className="detail-card">
        <h2 className="hq3-sec"><span className="hq6-secno">05</span> Audit ↔ History reconciliation</h2>
        <p className="note">
          Every governance history event must have a matching audit event (same rule, actor, expected action, ±5s) and
          vice versa. Discrepancies are reported — never repaired automatically.
        </p>
        <div className="hq-kpis">
          <div className="hq-kpi">
            <div className="hq-kpi-label">History events checked</div>
            <div className="hq-kpi-value">{overview.reconciliation.historyEventsChecked}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Audit events checked</div>
            <div className="hq-kpi-value">{overview.reconciliation.auditEventsChecked}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Reconciled</div>
            <div className="hq-kpi-value">{overview.reconciliation.reconciledCount}</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">Discrepancies</div>
            <div className="hq-kpi-value">{overview.reconciliation.discrepancies.length}</div>
          </div>
        </div>
        <p className="note">
          Status:{' '}
          <span className={overview.reconciliation.status === 'RECONCILED' ? 'badge approved' : 'badge rejected'}>
            {overview.reconciliation.status}
          </span>
        </p>
        {overview.reconciliation.discrepancies.length > 0 && (
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
                {overview.reconciliation.discrepancies.map((d, i) => (
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

      <div className="detail-card">
        <h2 className="hq3-sec"><span className="hq6-secno">06</span> Quality — unknown UOMs requiring investigation</h2>
        <p className="note">
          For these tokens no approved conversion rule exists. Records keep their original quantity and UOM verbatim.
          Investigate affected records and propose a material-specific rule on the UOM Rules page (PENDING — it affects
          comparable quantities only after approval).
        </p>
        <div className="hq-kpis">
          <div className="hq-kpi">
            <div className="hq-kpi-label">Unconverted records</div>
            <div className="hq-kpi-value">{overview.quality.unconvertedRecords}</div>
            <div className="hq-kpi-context">UNCONVERTED + UNKNOWN</div>
          </div>
          <div className="hq-kpi">
            <div className="hq-kpi-label">CMIs requiring remediation</div>
            <div className="hq-kpi-value">{overview.quality.cmisRequiringRemediation}</div>
            <div className="hq-kpi-context">CMIs holding unknown-UOM records</div>
          </div>
          {overview.quality.unknownUoms.map((u) => (
            <div key={u.uom} className="hq-kpi">
              <div className="hq-kpi-label">{u.uom}</div>
              <div className="hq-kpi-value">{u.count}</div>
              <div className="hq-kpi-context">No approved conversion rule exists.</div>
            </div>
          ))}
        </div>
        <details>
          <summary>Quality distribution (all procurement records)</summary>
          <div className="hq-kpis">
            {Object.entries(overview.quality.counts).map(([bucket, n]) => (
              <div key={bucket} className="hq-kpi">
                <div className="hq-kpi-label">{bucket}</div>
                <div className="hq-kpi-value">{n}</div>
              </div>
            ))}
          </div>
        </details>
      </div>

      <div className="detail-card">
        <h2 className="hq3-sec"><span className="hq6-secno">07</span> Rule inventory</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Scope</th>
                <th>Conversion</th>
                <th>Status</th>
                <th>Created By</th>
                <th>Approved By</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {allRules.length === 0 && (
                <tr>
                  <td colSpan={7}>No material-specific rules yet.</td>
                </tr>
              )}
              {allRules.map((r) => (
                <tr key={r.id}>
                  <td>#{r.id}</td>
                  <td className="mono">{r.cmiCode}</td>
                  <td>
                    {r.fromUom} → {r.toUom} ×{r.factor}
                  </td>
                  <td>
                    <span className="badge">{r.status}</span>
                  </td>
                  <td>{r.createdBy}</td>
                  <td>{r.approvedBy ?? '—'}</td>
                  <td>
                    <Link className="btn" href={`/procurement/uom-rules?rule=${r.id}`}>
                      Review
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">
          {canGovern
            ? 'You hold MANAGE_UOM_RULES: approve, reject, disable and re-enable actions are available on the rule detail.'
            : 'Your role is read-only for governance: you can view rules and history, but cannot perform governance actions.'}
        </p>
      </div>
    </main>
  );
}
