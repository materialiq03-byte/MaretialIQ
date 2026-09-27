import Link from 'next/link';
import { requirePermission } from '@/lib/auth/guard';
import { roleHasPermission } from '@/lib/auth/permissions';
import {
  getUomRuleRegistry,
  getUomDataQuality,
  listGovernedUomRules,
  listCmiProcurementOverviews,
  getUomRemediationBoard,
  getUomRuleHistory,
  getUomAffectedRecords,
  getUomRuleVersions,
  getUomRuleAgreement,
} from '@/lib/services/procurement-service';
import { UomGovernanceActions, UomRuleTransitionActions, AmendDecisionActions, UomRuleAmendForm } from './uom-governance-actions';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'UOM Conversion Rules — MaterialIQ' };
export const dynamic = 'force-dynamic';

/**
 * Step 17 (section 24) + Step 18: UOM rule registry, governance and quality
 * remediation. SYSTEM rules (Step 17) remain read-only master data; the
 * governed MATERIAL-SPECIFIC rules support the human lifecycle
 * PENDING -> APPROVED/REJECTED, APPROVED -> DISABLED -> re-enabled. Reads
 * create no audit rows; only governance actions do (section 9).
 */
export default async function UomRulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('VIEW_MAPPINGS');
  const canManage = roleHasPermission(user.role, 'MANAGE_UOM_RULES');
  const rules = getUomRuleRegistry();
  const domainRules = listGovernedUomRules();
  const quality = getUomDataQuality();
  const cmis = listCmiProcurementOverviews();
  const remediation = cmis.length > 0 ? getUomRemediationBoard(cmis[0].cmiId) : null;

  // Step 19 (section 6): rule detail with append-only history, deep-linked
  // from the steward dashboard via ?rule=<id>. Invalid ids fail closed to
  // "not selected" - the page never guesses.
  const sp = await searchParams;
  const rawRule = Array.isArray(sp.rule) ? sp.rule[0] : sp.rule;
  const parsedRule = rawRule === undefined ? NaN : Number(rawRule);
  const selectedRule =
    rawRule !== undefined && Number.isInteger(parsedRule) && parsedRule > 0
      ? domainRules.find((d) => d.id === parsedRule) ?? null
      : null;
  const selectedHistory = selectedRule ? getUomRuleHistory(selectedRule.id) : [];
  const selectedAffected = selectedRule ? getUomAffectedRecords(selectedRule.cmiId, selectedRule.fromUom, 10) : [];
  // Step 20 (section 16): current vs historical versions + audit/history
  // agreement timeline on the rule detail view.
  const selectedVersions = selectedRule ? getUomRuleVersions(selectedRule.id) : [];
  const selectedAgreement = selectedRule ? getUomRuleAgreement(selectedRule.id) : [];

  return (
    <main>
      <h1>UOM Conversion Rules</h1>
      <p className="subtitle">
        Controlled, directional conversion registry. A comparable quantity is produced only where an
        explicit rule exists — system aliases map count units 1:1, scale rules apply exact integer factors,
        and material-specific rules apply only inside their approved scope. Original quantity and UOM are
        never modified. Unknown units remain unconverted; unconverted does not mean incorrect.
      </p>

      <div className="hq-kpis">
        <div className="hq-kpi">
          <div className="hq-kpi-value">{quality.counts.VALID_CANONICAL ?? 0}</div>
          <div className="hq-kpi-label">Valid canonical</div>
          <div className="hq-kpi-context">Records already in a canonical UOM</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{(quality.counts.VALID_ALIAS ?? 0) + (quality.counts.VALID_CONVERTED ?? 0)}</div>
          <div className="hq-kpi-label">Normalized via rule</div>
          <div className="hq-kpi-context">Alias, scale, or approved material-specific conversion</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{quality.counts.UNCONVERTED ?? 0}</div>
          <div className="hq-kpi-label">Unconverted</div>
          <div className="hq-kpi-context">No approved rule — no approved conversion rule exists</div>
        </div>
        <div className="hq-kpi">
          <div className="hq-kpi-value">{quality.counts.UNKNOWN ?? 0}</div>
          <div className="hq-kpi-label">Unknown UOM</div>
          <div className="hq-kpi-context">Not in the controlled vocabulary</div>
        </div>
      </div>

      {remediation && (
        <div className="detail-card">
          <h2>Quality remediation — {remediation.cmiCode}</h2>
          <p className="subtitle">
            Affected UOMs inside this CMI&apos;s scope. Investigate the records, then propose a scoped rule if an
            authoritative source exists. No rule is created automatically.
          </p>
          <table className="data-table">
            <thead>
              <tr><th>UOM (normalized)</th><th>Category</th><th>Records</th><th>Affected records</th></tr>
            </thead>
            <tbody>
              {remediation.buckets.map((b) => (
                <tr key={b.uom}>
                  <td className="mono">{b.uom}</td>
                  <td>{b.category}</td>
                  <td className="num">{b.count}</td>
                  <td>
                    <a href={`/procurement?cmi=${remediation.cmiId}&uom=${encodeURIComponent(b.uom)}`}>
                      View affected records
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {remediation.rules.length > 0 && (
            <p className="note">
              Governing rules for this CMI:{' '}
              {remediation.rules
                .map((r) => `#${r.id} ${r.fromUom}→${r.toUom} ×${r.factor} (${r.status})`)
                .join(' · ')}
            </p>
          )}
        </div>
      )}

      {quality.unknownUoms.length > 0 && (
        <div className="detail-card">
          <h2>Unknown UOMs observed</h2>
          <p className="note">No approved conversion rule exists for these tokens; the records remain unconverted.</p>
          <table className="data-table">
            <thead>
              <tr><th>UOM (normalized)</th><th>Records</th></tr>
            </thead>
            <tbody>
              {quality.unknownUoms.map((u) => (
                <tr key={u.uom}><td>{u.uom}</td><td>{u.count}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}      <UomGovernanceActions
        cmiOptions={cmis.map((c) => ({ id: c.cmiId, code: c.cmiCode, name: c.cmiName }))}
        canManage={canManage}
      />

      {rawRule !== undefined && !selectedRule && (
        <div className="detail-card">
          <h2>Rule detail</h2>
          <p className="note">No governed rule matches that id — nothing to show.</p>
        </div>
      )}

      {selectedRule && (
        <div className="detail-card">
          <h2>
            Rule detail — #{selectedRule.id}{' '}
            <span className={selectedRule.status === 'APPROVED' ? 'badge approved' : selectedRule.status === 'PENDING' ? 'badge pending' : selectedRule.status === 'REJECTED' ? 'badge rejected' : 'badge neutral'}>
              {selectedRule.status}
            </span>
          </h2>
          <table className="data-table">
            <tbody>
              <tr><th>Scope</th><td className="mono">{selectedRule.cmiCode} — {selectedRule.cmiName} (CMI #{selectedRule.cmiId})</td></tr>
              <tr><th>Conversion</th><td>{selectedRule.fromUom} → {selectedRule.toUom} ×{selectedRule.factor}</td></tr>
              <tr><th>Type / source</th><td>DOMAIN_SPECIFIC / {selectedRule.source}</td></tr>
              <tr><th>Evidence / reason</th><td>{selectedRule.reason}</td></tr>
              <tr><th>Created by / at</th><td>{selectedRule.createdBy} · {selectedRule.createdAt}</td></tr>
              <tr><th>Approved by / decided</th><td>{selectedRule.approvedBy ?? '—'} · {selectedRule.decidedAt ?? '—'}</td></tr>
              <tr>
                <th>Affected records</th>
                <td>
                  <Link href={`/procurement?cmi=${selectedRule.cmiId}&uom=${encodeURIComponent(selectedRule.fromUom)}`}>
                    View affected records ({selectedRule.fromUom} in scope)
                  </Link>
                  {selectedAffected.length > 0 && (
                    <span className="note"> — {selectedAffected.length} most recent shown there; original quantity and UOM are always preserved.</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          {canManage && (
            <div className="decision-row">
              <UomRuleTransitionActions id={selectedRule.id} status={selectedRule.status} canManage={canManage} />
            </div>
          )}
          <h3>Versions (immutable content)</h3>
          <p className="note">
            Current version {selectedRule.effectiveVersionId !== null && `v${selectedVersions.find((v) => v.id === selectedRule.effectiveVersionId)?.versionNumber ?? '—'}`}{' '}
            — only the effective version participates in conversion. Historical versions remain available forever and
            are never presented as active.
          </p>
          <table className="data-table">
            <thead>
              <tr><th>Version</th><th>Conversion</th><th>Evidence / amendment reason</th><th>Proposed by</th><th>Supersedes</th><th>State</th></tr>
            </thead>
            <tbody>
              {selectedVersions.length === 0 && (
                <tr><td colSpan={6}>No versions recorded (pre-Step-20 rule).</td></tr>
              )}
              {selectedVersions.map((v) => {
                const isEffective = v.id === selectedRule.effectiveVersionId;
                const isPending = v.id === selectedRule.pendingVersionId;
                return (
                  <tr key={v.id}>
                    <td className="num">v{v.versionNumber}</td>
                    <td>
                      {v.fromUom} → {v.toUom} ×{v.factor}
                    </td>
                    <td>{v.amendmentReason ?? '—'}</td>
                    <td>{v.createdBy}</td>
                    <td>
                      {v.supersedesVersionId !== null
                        ? `v${selectedVersions.find((x) => x.id === v.supersedesVersionId)?.versionNumber ?? '?'}`
                        : '—'}
                    </td>
                    <td>
                      <span
                        className={
                          isEffective ? 'badge approved'
                          : isPending ? 'badge pending'
                          : 'badge neutral'
                        }
                      >
                        {isEffective ? 'EFFECTIVE' : isPending ? 'PENDING' : 'SUPERSEDED'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {canManage && selectedRule.pendingVersionId !== null && selectedRule.effectiveVersionId !== null && (
            <AmendDecisionActions ruleId={selectedRule.id} />
          )}
          {canManage && selectedRule.pendingVersionId === null && selectedRule.effectiveVersionId !== null && (
            <UomRuleAmendForm ruleId={selectedRule.id} canManage={canManage} />
          )}
          <h3>History (append-only)</h3>
          <table className="data-table">
            <thead>
              <tr><th>#</th><th>Action</th><th>Previous → New</th><th>Actor</th><th>When</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {selectedHistory.length === 0 && (
                <tr><td colSpan={6}>No history recorded (pre-Step-19 rule).</td></tr>
              )}
              {selectedHistory.map((h) => (
                <tr key={h.id}>
                  <td className="num">{h.id}</td>
                  <td>{h.action}</td>
                  <td>{h.previousStatus ?? '—'} → {h.newStatus}</td>
                  <td>{h.actor}</td>
                  <td>{h.createdAt}</td>
                  <td>{h.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">
            History is append-only: entries are never rewritten or deleted. It answers “what happened to this rule over
            time?” while the audit trail records the governance events themselves.
          </p>
          <h3>Audit ↔ History agreement</h3>
          <p className="note">
            HISTORY is the rule-state chronology; AUDIT is the security/governance event record. They are separate
            append-only ledgers, correlated here by rule, action, actor and time — never merged.
          </p>
          <table className="data-table">
            <thead>
              <tr><th>When</th><th>Actor</th><th>Action</th><th>Version</th><th>Prev. version</th><th>Prev → New</th><th>Content</th><th>Reason</th><th>Audit event</th><th>Evidence</th></tr>
            </thead>
            <tbody>
              {selectedAgreement.map((a) => (
                <tr key={a.historyId}>
                  <td>{a.createdAt.slice(0, 19).replace('T', ' ')}</td>
                  <td>{a.actor}</td>
                  <td>{a.action}</td>
                  <td>{a.versionNumber !== null ? `v${a.versionNumber}` : '—'}</td>
                  <td>{a.previousVersionNumber !== null ? `v${a.previousVersionNumber}` : '—'}</td>
                  <td>{a.previousStatus ?? '—'} → {a.newStatus}</td>
                  <td>
                    {a.fromUom} → {a.toUom} ×{a.factor}
                  </td>
                  <td>{a.reason ?? '—'}</td>
                  <td>
                    {a.auditId !== null ? (
                      <Link href={`/audit?entityType=uom_domain_rule&entityId=${selectedRule.id}`}>#{a.auditId} {a.auditAction}</Link>
                    ) : (
                      <span className="badge rejected">MISSING</span>
                    )}
                  </td>
                  <td>
                    {a.auditId === null ? '—' : a.auditDetailsMatch ? 'match' : <span className="badge rejected">MISMATCH</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="detail-card">
        <h2>SYSTEM RULES</h2>
        <p className="note">Directional, integer-factor master data (migration-defined). Not editable in this step.</p>
        <table className="data-table">
          <thead>
            <tr><th>FROM</th><th>TO</th><th>FACTOR</th><th>TYPE</th><th>SOURCE</th><th>STATUS</th><th>Description</th></tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.fromUom}</td>
                <td>{r.toUom}</td>
                <td className="num">{r.factor}</td>
                <td>{r.ruleType}</td>
                <td>{r.source}</td>
                <td><span className={r.isActive ? 'badge-open' : ''}>{r.isActive ? 'ACTIVE' : 'INACTIVE'}</span></td>
                <td>{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="detail-card">
        <h2>MATERIAL-SPECIFIC RULES</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Scope</th><th>Material/CMI</th><th>From</th><th>To</th><th>Factor</th>
              <th>Status</th><th>Evidence / reason</th><th>Created by</th><th>Approved by</th><th>Detail</th>{canManage && <th>Action</th>}
            </tr>
          </thead>
          <tbody>
            {domainRules.length === 0 && (
              <tr><td colSpan={canManage ? 11 : 10}>No material-specific rules proposed.</td></tr>
            )}
            {domainRules.map((d) => (
              <tr key={d.id}>
                <td className="mono">
                  <Link href={`/procurement/uom-rules?rule=${d.id}`}>CMI #{d.cmiId}</Link>
                </td>
                <td>{d.cmiCode} — {d.cmiName}</td>
                <td>{d.fromUom}</td>
                <td>{d.toUom}</td>
                <td className="num">{d.factor}</td>
                <td>
                  <span
                    className={
                      d.status === 'APPROVED' ? 'badge approved'
                      : d.status === 'PENDING' ? 'badge pending'
                      : d.status === 'REJECTED' ? 'badge rejected'
                      : 'badge neutral'
                    }
                  >
                    {d.status}
                  </span>
                </td>
                <td>{d.reason}</td>
                <td>{d.createdBy}</td>
                <td>{d.approvedBy ?? '—'}</td>
                <td>
                  <Link href={`/procurement/uom-rules?rule=${d.id}`}>history</Link>
                </td>
                {canManage && (
                  <td>
                    <UomRuleTransitionActions id={d.id} status={d.status} canManage={canManage} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          Lifecycle: PENDING (visible, no effect) → APPROVED / REJECTED; APPROVED → DISABLED → re-enabled.
          Only APPROVED rules affect comparable quantities, and only for records of the scoped CMI&apos;s mapped
          materials — they never become global conversions.
        </p>
      </div>

      <p className="note">
        Demonstration environment — procurement records are representative synthetic data. Comparable quantities
        are shown only where an explicit UOM rule is available. Governance actions are audited in the Audit Trail.
      </p>
    </main>
  );
}
