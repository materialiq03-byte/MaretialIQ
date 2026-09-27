import { requirePermission } from '@/lib/auth/guard';
import { listCmiWithMembers } from '@/lib/services/registry-service';
import {
  getCmiProcurementSummary,
  getCmiDemandByOrganization,
  getCmiSupplierSummary,
  type CmiDemandSummary,
  type CmiOrgDemandRow,
  type CmiSupplierRow,
  type CmiMonthlyDemandRow,
} from '@/lib/db/repositories/procurement-repository';
import { getCmiMonthlyDemand, getCmiComparableDemand } from '@/lib/services/procurement-service';
import { listOrganizations } from '@/lib/db/repositories/organization-repository';
import { getMatch } from '@/lib/db/repositories/matching-repository';
import type { Metadata } from 'next';
import { listOpportunities } from '@/lib/services/procurement-opportunity-service';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Common Material Identity console — MaterialIQ' };
export const dynamic = 'force-dynamic';

/**
 * Phase UI-6 — Common Material Identity / Governance console.
 * READ-ONLY presentation over the existing frozen contracts:
 * listCmiWithMembers (registry + preserved members), getMatch (approval
 * provenance), listOrganizations (CPSE filter) and the existing CMI
 * procurement demand summaries. A CMI is a governed identity layered ABOVE
 * preserved source records — original CPSE codes are never deleted, replaced
 * or overwritten. No new intelligence, no fabricated state.
 */
export default async function CrossReferencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission('VIEW_MAPPINGS');
  const sp = await searchParams;
  const cpse = typeof sp.cpse === 'string' ? sp.cpse : undefined;

  let cmis: ReturnType<typeof listCmiWithMembers> = [];
  let demand: Record<number, CmiDemandSummary> = {};
  let byOrg: Record<number, CmiOrgDemandRow[]> = {};
  let bySupplier: Record<number, CmiSupplierRow[]> = {};
  let byMonth: Record<number, CmiMonthlyDemandRow[]> = {};
  let comparable: Record<number, ReturnType<typeof getCmiComparableDemand>> = {};
  let orgs: ReturnType<typeof listOrganizations> = [];
  let loadError: string | null = null;
  let openOpps: ReturnType<typeof listOpportunities>['items'] = [];
  try {
    cmis = listCmiWithMembers().map((c) => ({
      cmi: { ...c.cmi },
      // plain-object clone: node:sqlite rows are null-prototype
      members: c.members.map((m) => ({ ...m })),
    }));
    orgs = listOrganizations().map((o) => ({ ...o }));
    for (const c of cmis) {
      const d = getCmiProcurementSummary(c.cmi.id);
      if (d && d.recordCount > 0) {
        demand[c.cmi.id] = d;
        byOrg[c.cmi.id] = getCmiDemandByOrganization(c.cmi.id) ?? [];
        bySupplier[c.cmi.id] = getCmiSupplierSummary(c.cmi.id);
        byMonth[c.cmi.id] = getCmiMonthlyDemand(c.cmi.id);
        comparable[c.cmi.id] = getCmiComparableDemand(c.cmi.id);
      }
    }
    openOpps = listOpportunities({ status: 'OPEN' }, 1, 500).items.map((o) => ({ ...o }));
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  if (loadError) {
    return (
      <main>
        <h1>Common Material Identity console</h1>
        <div className="error-box">Failed to load registry: {loadError}</div>
      </main>
    );
  }

  const filtered = cpse
    ? cmis
        .map((c) => ({ ...c, members: c.members.filter((m) => m.org_code === cpse) }))
        .filter((c) => c.members.length > 0)
    : cmis;

  const governedCount = cmis.filter((c) => c.cmi.is_active === 1).length;
  const cpsesRepresented = [
    ...new Set(cmis.flatMap((c) => c.members.map((m) => m.org_code))),
  ].sort();

  return (
    <main className="hq-root">
      {/* SCREEN 1 — command header (real persisted values only) */}
      <section className="hq6-pagehead" aria-label="Common Material Identity console">
        <p className="hq6-kicker">AUTOMATION PROPOSES · AUTHORIZED HUMANS GOVERN</p>
        <h1>Common Material Identity Console</h1>
        <p className="hq3-sub">
          Governed harmonization register: each identity below was created from a human-approved
          technical review and governs preserved source materials across CPSE boundaries. MaterialIQ
          is a governance layer above CPSE material masters — not a replacement for them.
        </p>
        <dl className="hq6-cmdmeta">
          <div>
            <dt>Governed identities</dt>
            <dd>{cmis.length}</dd>
          </div>
          <div>
            <dt>Active governance state</dt>
            <dd>{governedCount}</dd>
          </div>
          <div>
            <dt>CPSEs represented</dt>
            <dd>{cpsesRepresented.length}</dd>
          </div>
          <div>
            <dt>Preserved source identities</dt>
            <dd>{cmis.reduce((n, c) => n + c.members.length, 0)}</dd>
          </div>
        </dl>
      </section>

      {/* Governing principle — visually prominent */}
      <p className="hq6-principle">
        <strong>COMMON MATERIAL IDENTITY ≠ REPLACEMENT OF SOURCE IDENTITY.</strong> A CMI adds a
        governed identity above preserved source records; original CPSE material codes are never
        deleted, replaced or overwritten. Mappings only add identity.
      </p>

      {/* SCREEN 5 — system/evidence/governance/CMI responsibility flow */}
      <ol className="hq3-flowstrip" aria-label="Governance flow">
        <li>
          <span className="hq3-flow-n">01</span>
          <span className="hq3-flow-name">SYSTEM</span>
          <span className="hq3-flow-note">Material relationship detected</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">02</span>
          <span className="hq3-flow-name">EVIDENCE</span>
          <span className="hq3-flow-note">Technical comparison recorded</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">03</span>
          <span className="hq3-flow-name">GOVERNANCE</span>
          <span className="hq3-flow-note">Authorized decision required</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">04</span>
          <span className="hq3-flow-name">CMI</span>
          <span className="hq3-flow-note">Governed identity state</span>
        </li>
      </ol>

      <form className="filterbar hq6-filter" method="get">
        <label className="fld">
          CPSE
          <select name="cpse" defaultValue={cpse ?? ''}>
            <option value="">All CPSEs</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.code}>
                {o.code} — {o.name.replace(' (synthetic demo)', '')}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Apply</button>
        <a href="/cross-reference">Clear</a>
      </form>

      {filtered.length === 0 ? (
        <div className="empty-state">
          No approved common material identities {cpse ? `involving ${cpse}` : 'yet'}. Approve a match in the
          review queue, then create the identity from it — identities are never generated from AI
          scores alone.
        </div>
      ) : (
        filtered.map(({ cmi, members }) => {
          const approval = cmi.source_match_id ? getMatch(cmi.source_match_id) : undefined;
          const cpses = [...new Set(members.map((m) => m.org_code))];
          const active = cmi.is_active === 1;
          // Rail spans from the first member's center to the last member's center.
          const railWidth = members.length > 1 ? `calc(${((members.length - 1) * 100) / members.length}%)` : '0';
          const netLabel = `${cmi.code} governs ${members.length} preserved source identities: ${members
            .map((m) => `${m.org_code} ${m.original_code}`)
            .join(', ')}. Original CPSE codes are preserved, not replaced.`;

          return (
            <article className="hq6-card" key={cmi.id}>
              <header className="hq6-cardhead">
                <div>
                  <p className="hq6-card-kicker">
                    COMMON MATERIAL IDENTITY · {cmi.category.toUpperCase()}
                  </p>
                  <h2 className="hq6-card-code mono">{cmi.code}</h2>
                  <p className="hq6-card-name">{cmi.name}</p>
                </div>
                <dl className="hq6-cardmeta">
                  <div>
                    <dt>Source identities</dt>
                    <dd>{members.length}</dd>
                  </div>
                  <div>
                    <dt>CPSEs</dt>
                    <dd>{cpses.length}</dd>
                  </div>
                  <div>
                    <dt>Governance state</dt>
                    <dd>
                      <span className={active ? 'badge approved' : 'badge neutral'}>
                        {active ? 'ACTIVE · GOVERNED' : 'RETIRED'}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{cmi.created_at.slice(0, 10)}</dd>
                  </div>
                </dl>
              </header>

              {cmi.description ? <p className="hq6-card-desc">{cmi.description}</p> : null}

              {/* SCREENS 2 + 11 — cross-CPSE identity network (CSS only;
                  textual alternative: aria-label + registry table below) */}
              <figure className="hq6-net" role="img" aria-label={netLabel}>
                <figcaption className="hq6-net-title">CROSS-CPSE IDENTITY NETWORK</figcaption>
                <div className="hq6-net-root">
                  <span className="hq6-net-root-code mono">{cmi.code}</span>
                  <span className="hq6-net-root-label">COMMON MATERIAL IDENTITY</span>
                </div>
                <div className="hq6-net-stem" aria-hidden="true" />
                <div className="hq6-net-rail" aria-hidden="true" style={{ width: railWidth }} />
                <ul className="hq6-net-members">
                  {members.map((m) => (
                    <li key={m.mapping_id}>
                      <span className="hq6-net-org">{m.org_code}</span>
                      <Link href={`/materials/${m.material_id}`} className="hq6-net-code mono">
                        {m.original_code}
                      </Link>
                      <span className="hq6-net-desc">{m.original_description}</span>
                    </li>
                  ))}
                </ul>
              </figure>

              {/* Approval provenance — real persisted decision only */}
              {approval ? (
                <p className="hq6-prov">
                  <strong>APPROVAL PROVENANCE</strong> — governed identity created from human-approved{' '}
                  <Link href={`/matching/${approval.candidate.id}`}>candidate #{approval.candidate.id}</Link>{' '}
                  ({approval.source?.org_code} {approval.source?.original_code} ↔{' '}
                  {approval.candidateMat?.org_code} {approval.candidateMat?.original_code}), authorized by{' '}
                  {approval.decision
                    ? `${approval.decision.reviewer} on ${approval.decision.decided_at}`
                    : 'recorded decision'}
                  {approval.decision?.comment ? <> — “{approval.decision.comment}”</> : null}. Technical
                  evidence preserved on the linked candidate.
                </p>
              ) : (
                <p className="hq6-prov hq6-prov-none">
                  <strong>APPROVAL PROVENANCE</strong> — no linked approval decision recorded for this
                  identity.
                </p>
              )}

              {/* SCREEN 3 — source identity registry */}
              <div className="hq6-reg">
                <p className="hq6-net-title hq6-reg-title">
                  SOURCE IDENTITY REGISTRY — ORIGINAL CODES PRESERVED
                </p>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Source CPSE</th>
                        <th>Original material code</th>
                        <th>Original description</th>
                        <th>Governance mapping</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((m) => (
                        <tr key={m.mapping_id}>
                          <td className="mono">{m.org_code}</td>
                          <td className="mono">
                            <Link href={`/materials/${m.material_id}`}>{m.original_code}</Link>
                          </td>
                          <td>{m.original_description}</td>
                          <td>
                            <span className={active ? 'badge approved' : 'badge neutral'}>
                              Mapped under {cmi.code} · {active ? 'Active' : 'Retired'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Existing frozen procurement context (real data, honest labels) */}
              {demand[cmi.id] ? (
                <div className="hq6-demand">
                  <p className="hq6-net-title hq6-reg-title">LINKED PROCUREMENT CONTEXT</p>
                  <p className="evidence-detail">
                    <strong>Linked procurement (synthetic demonstration data):</strong>{' '}
                    {demand[cmi.id].recordCount} records across {demand[cmi.id].orgCount} CPSEs ·{' '}
                    {demand[cmi.id].supplierCount} suppliers ·{' '}
                    {Object.entries(demand[cmi.id].totalQuantityByUom)
                      .map(([uom, qty]) => `${qty} ${uom}`)
                      .join(' + ')}
                    {Object.entries(demand[cmi.id].spendByCurrency).length > 0 ? (
                      <>
                        {' '}· spend{' '}
                        {Object.entries(demand[cmi.id].spendByCurrency)
                          .map(([cur, amt]) => `${amt} ${cur}`)
                          .join(' + ')}
                      </>
                    ) : null}
                    {demand[cmi.id].unpricedRecords > 0 ? (
                      <> · {demand[cmi.id].unpricedRecords} unpriced record(s) excluded from spend</>
                    ) : null}
                    {' '}· {demand[cmi.id].firstPurchaseDate} → {demand[cmi.id].lastPurchaseDate}.
                    Quantities are aggregated per UOM only — no unit conversions; spend per currency —
                    no exchange rates.
                  </p>
                  {comparable[cmi.id] != null && (
                    <p className="evidence-detail">
                      <strong>Comparable demand (Step 17 UOM normalization):</strong>{' '}
                      {Object.entries(comparable[cmi.id]!.comparableQuantityByUom)
                        .map(([uom, qty]) => `${qty} ${uom}`)
                        .join(' + ') || '—'}
                      {' '}— computed only where an explicit active conversion rule exists; unconverted
                      units (e.g. SET) remain separate. Original quantities above are unchanged.
                    </p>
                  )}
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>CPSE</th>
                          <th className="num">Records</th>
                          <th>Demand (by UOM)</th>
                          <th>Spend (by currency)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(byOrg[cmi.id] ?? []).map((o) => (
                          <tr key={o.organizationId}>
                            <td className="mono">{o.orgCode}</td>
                            <td className="num">{o.recordCount}</td>
                            <td className="mono">
                              {Object.entries(o.quantityByUom)
                                .map(([uom, qty]) => `${qty} ${uom}`)
                                .join(' + ')}
                            </td>
                            <td className="mono">
                              {Object.entries(o.spendByCurrency)
                                .map(([cur, amt]) => `${amt} ${cur}`)
                                .join(' + ') || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(() => {
                    const signals = openOpps.filter((o) => o.cmi_id === cmi.id && o.status === 'OPEN');
                    if (signals.length === 0) return null;
                    return (
                      <p className="evidence-detail">
                        <strong>Open procurement signals:</strong>{' '}
                        {signals.map((o) => (
                          <Link key={o.id} href={'/procurement/opportunities/' + o.id} style={{ marginRight: 10 }}>
                            view signal
                          </Link>
                        ))}
                        ({signals.length} open — human review required)
                      </p>
                    );
                  })()}
                  <p className="evidence-detail">
                    <strong>Suppliers involved (descriptive, not a ranking):</strong>{' '}
                    {(bySupplier[cmi.id] ?? [])
                      .map((s) => `${s.supplierName} (${s.recordCount} record${s.recordCount === 1 ? '' : 's'})`)
                      .join('; ')}
                  </p>
                  {(byMonth[cmi.id] ?? []).length > 1 ? (
                    <p className="evidence-detail">
                      <strong>Monthly demand (historical, no forecast):</strong>{' '}
                      {(byMonth[cmi.id] ?? [])
                        .map((m) => {
                          const q = Object.entries(m.quantityByUom)
                            .map(([uom, qty]) => `${qty} ${uom}`)
                            .join(' + ');
                          return `${m.month}: ${m.recordCount} record(s)${q ? ` · ${q}` : ''}`;
                        })
                        .join(' | ')}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* SCREENS 4 + 12 — evidence connection; real actions only */}
              <div className="hq6-ctas">
                <p className="hq6-ctas-note">Supporting candidate evidence is available in Judge Mode.</p>
                {cmi.source_match_id ? (
                  <Link className="btn" href={`/matching/${cmi.source_match_id}/judge`}>
                    OPEN JUDGE MODE →
                  </Link>
                ) : (
                  <span className="hq6-ctas-none">No linked candidate recorded.</span>
                )}
                <Link className="btn hq6-ctas-ghost" href="/procurement/governance">
                  VIEW GOVERNANCE →
                </Link>
              </div>
            </article>
          );
        })
      )}

      <p className="hq6-foot">
        Prototype note: “{user ? 'Common Material Identity' : 'CMI'}” is a MaterialIQ prototype
        construct. It is not an official national material code and implies no CPSE endorsement of
        the demonstration records.
      </p>
    </main>
  );
}
