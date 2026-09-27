import Link from 'next/link';
import { requirePermission } from '@/lib/auth/guard';
import { describeAdapter, listAdapters } from '@/lib/integrations/registry';
import { listIntegrationRuns } from '@/lib/integrations/integration-service';
import type { Metadata } from 'next';
import IntegrationClient from './integration-client';

export const metadata: Metadata = { title: 'Integration Center — MaterialIQ' };

/**
 * Step 22 — Integration Center (§23/§24), Phase UI-3 presentation refresh:
 * an enterprise integration console over the FROZEN adapter registry and
 * EXISTING import pipeline. Read-only orchestration; all authorization stays
 * server-side. Labels stay honest: prototype adapters over clearly labelled
 * synthetic source formats — no live CPSE/ERP connection is claimed.
 */
export default async function IntegrationsPage() {
  await requirePermission('IMPORT_MATERIALS');

  let sources: ReturnType<typeof describeAdapter>[] = [];
  let runs: ReturnType<typeof listIntegrationRuns> = [];
  let loadError: string | null = null;
  try {
    sources = listAdapters().map(describeAdapter);
    runs = listIntegrationRuns(20);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const statusBadge = (workflowStatus: string): string =>
    workflowStatus.startsWith('completed') ? 'badge approved' : workflowStatus === 'failed' ? 'badge rejected' : 'badge pending';

  return (
    <main className="hq-root">
      <section className="hq3-pagehead" aria-label="Integration center">
        <div>
          <p className="hq3-kicker">CPSE INTEGRATION LAYER</p>
          <h1>CPSE Integration Layer</h1>
          <p className="hq3-sub">
            ERP-agnostic ingestion: governed source adapters translate each CPSE&apos;s material feed into one canonical
            contract, then the existing Import Center runs the import. <strong>Prototype integration layer</strong> over
            clearly labelled synthetic source formats — no live CPSE/ERP connection.
          </p>
        </div>
      </section>

      {/* Flow motif: CPSE → ingestion → validation → material intelligence → review/governance. */}
      <ol className="hq3-flowstrip" aria-label="Integration flow">
        <li>
          <span className="hq3-flow-n">01</span>
          <span className="hq3-flow-name">CPSE SOURCE</span>
          <span className="hq3-flow-note">Per-CPSE material feed format</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">02</span>
          <span className="hq3-flow-name">INGESTION</span>
          <span className="hq3-flow-note">Governed source adapter</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">03</span>
          <span className="hq3-flow-name">VALIDATION</span>
          <span className="hq3-flow-note">Canonical contract + row report</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">04</span>
          <span className="hq3-flow-name">MATERIAL INTELLIGENCE</span>
          <span className="hq3-flow-note">Normalization · matching</span>
        </li>
        <li aria-hidden="true" className="hq3-flow-arrow">→</li>
        <li>
          <span className="hq3-flow-n">05</span>
          <span className="hq3-flow-name">REVIEW / GOVERNANCE</span>
          <span className="hq3-flow-note">Human technical validation</span>
        </li>
      </ol>

      {loadError && <div className="error-box">{loadError}</div>}

      {/* Architecture motif: 5 real CPSEs fan into the integration layer → MaterialIQ.
          CSS only; the source-systems table below is the accessible alternative. */}
      <figure className="hq7-fanin" role="img" aria-label={`Architecture: ${sources.map((s) => s.cpse).join(', ')} feed through the prototype integration layer into MaterialIQ. Prototype integration layer — no live CPSE or ERP connection.`}>
        <figcaption className="hq6-net-title">INTEGRATION ARCHITECTURE — PROTOTYPE LAYER</figcaption>
        <div className="hq7-fanin-grid">
          <ul className="hq7-fanin-cpses">
            {sources.map((s) => (
              <li key={s.id}>
                <span className="hq7-fanin-cpse">{s.cpse}</span>
              </li>
            ))}
          </ul>
          <div className="hq7-fanin-links" aria-hidden="true">
            {sources.map((s) => (
              <span key={s.id} className="hq7-fanin-link" />
            ))}
          </div>
          <div className="hq7-fanin-core">
            <span className="hq7-fanin-core-title">INTEGRATION LAYER</span>
            <span className="hq7-fanin-core-sub">Governed adapters · canonical contract</span>
            <span className="hq7-fanin-arrow" aria-hidden="true">↓</span>
            <span className="hq7-fanin-miq">MATERIALIQ</span>
          </div>
        </div>
      </figure>

      <section className="detail-card" aria-label="Source systems">
        <h2 className="hq3-sec"><span className="hq6-secno">01</span> Source systems</h2>
        <p className="hq3-cardnote">
          Registered CPSE adapters — {sources.length} configured in this prototype environment.
        </p>
        <div className="table-wrap">
          <table className="data-table hq3-sources">
            <thead>
              <tr>
                <th>CPSE</th>
                <th>Adapter</th>
                <th>Version</th>
                <th>Format</th>
                <th>Status</th>
                <th>Profile</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="mw-org">{s.cpse}</span>
                  </td>
                  <td>{s.label ?? s.id}</td>
                  <td className="mono">{s.version}</td>
                  <td>{s.supportedFormats.join(', ')}</td>
                  <td>
                    <span className="badge approved">{s.status}</span>
                  </td>
                  <td className="note">{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <IntegrationClient
        sources={sources.map((s) => ({
          id: s.id,
          cpse: s.cpse,
          label: s.label ?? s.id,
          version: s.version,
          description: s.description,
          fieldMapping: s.fieldMapping,
        }))}
      />

      <section className="detail-card" aria-label="Integration history">
        <h2 className="hq3-sec"><span className="hq6-secno">02</span> Integration history</h2>
        {runs.length === 0 ? (
          <p className="note">No integration runs yet. Analyze a source feed above and execute the import.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Import</th>
                  <th>CPSE</th>
                  <th>Adapter</th>
                  <th>Source file</th>
                  <th className="num">Canonical rows</th>
                  <th>Status</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.importId}>
                    <td>
                      <Link href={r.importUrl}>#{r.importId}</Link>
                    </td>
                    <td>
                      <span className="mw-org">{r.cpse}</span>
                    </td>
                    <td className="mono">{r.adapterVersion}</td>
                    <td className="mono">{r.sourceFileName}</td>
                    <td className="num">{r.canonicalRecordCount ?? '—'}</td>
                    <td>
                      <span className={statusBadge(r.workflowStatus)}>{r.workflowStatus.replace(/_/g, ' ')}</span>
                    </td>
                    <td className="mono">{r.createdAt.slice(0, 19).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
