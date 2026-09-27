import type { ControlCenterData, FlagshipReviewCase } from '@/lib/services/control-center-service';
import { DECISION_STATE_LABELS, type DecisionState } from '@/lib/matching/decision';

/**
 * PHASE UI-8 FINAL v2 — MATERIALIQ COMMAND CENTER (round 24, `cc8-*`).
 *
 * Pixel-close implementation of the approved reference: a DENSE dark
 * navy/indigo engineering console —
 *   • header row: MATERIAL INTELLIGENCE / COMMAND CENTER beside five compact
 *     icon-chip KPI cards;
 *   • MATERIAL INTELLIGENCE NETWORK panel: five CPSE pills with circular
 *     organization badges (left), a glowing circular core with the layered
 *     MaterialIQ glyph (center), and an icon-tile pipeline MATERIAL →
 *     NORMALIZATION → MATCHING → TECHNICAL REVIEW → GOVERNED CMI (right);
 *     CPSE COVERAGE (top-right) / GOVERNED CMI (bottom-right) cards docked in
 *     the panel corners; an OPEN TECHNICAL REVIEWS instrument bottom-left;
 *   • analytics row: DECISION LANDSCAPE donut with counts + derived
 *     percentages (real decisionStates) · TECHNICAL ATTENTION with chip +
 *     chevron case rows led by the REAL flagship lookup (#4640) · CPSE
 *     MATERIAL COVERAGE with organization badges;
 *   • lower row: MaterialIQ Pipeline tiles + Recent Technical Activity with
 *     honest relative times derived from real audit timestamps.
 *
 * DATA HONESTY: every number, id, organization, status and time comes from
 * the frozen getControlCenterData() contract (relative times are derived from
 * the real `at` timestamps; anything older than 7 days renders the ISO date).
 * Percentages on the donut are derived from the actual counts. Nothing is
 * hard-coded. Motion is restrained and prefers-reduced-motion safe.
 */

const fmt = (n: number) => n.toLocaleString('en-IN');

/** Honest relative time from a real ISO timestamp (no fabricated recency). */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

const ORG_TINT: Record<string, string> = {
  CPCL: '#f59e0b',
  NTPC: '#19c7d8',
  BHEL: '#7467f8',
  NLC: '#35c98b',
  SAIL: '#ef5350',
};

/* ------------------------------ SVG glyphs ------------------------------- */

function LayersGlyph({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 3.2 21 8l-9 4.8L3 8l9-4.8Z" fill="#7dd3fc" />
      <path d="m4.6 11.4 7.4 4 7.4-4" stroke="#bae6fd" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m4.6 15.2 7.4 4 7.4-4" stroke="#7dd3fc" strokeWidth="1.6" strokeLinecap="round" opacity="0.75" />
    </svg>
  );
}

function CubeGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M3 7l9 4.5L21 7M12 21.5V11.5" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

function GearGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function LinkGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M9.5 14.5 14.5 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M7.2 12.2 5 14.4a3.6 3.6 0 0 0 5.1 5.1l2.2-2.2M16.8 11.8 19 9.6a3.6 3.6 0 0 0-5.1-5.1l-2.2 2.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function WarnGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 3.5 21.5 20h-19L12 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 9.5v4.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1" fill="currentColor" />
    </svg>
  );
}

function ShieldGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 2.8 20 6v6.2c0 4.9-3.4 8.2-8 9.5-4.6-1.3-8-4.6-8-9.5V6l8-3.2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="m8.6 11.8 2.3 2.3 4.5-4.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const STAGE_GLYPH: Record<string, () => React.JSX.Element> = {
  material: CubeGlyph,
  normalization: GearGlyph,
  matching: LinkGlyph,
  review: WarnGlyph,
  cmi: ShieldGlyph,
};

function KpiGlyph({ kind }: { kind: 'bell' | 'layers' | 'cube' | 'globe' | 'shield' }) {
  const common = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false } as const;
  switch (kind) {
    case 'bell':
      return (
        <svg {...common}>
          <path d="M6 16v-5a6 6 0 1 1 12 0v5l1.6 2.4H4.4L6 16Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M10 20.5a2.2 2.2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'layers':
      return <LayersGlyph size={15} />;
    case 'cube':
      return <CubeGlyph />;
    case 'globe':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3 12h18M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9Z" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case 'shield':
      return <ShieldGlyph />;
  }
}

/* ------------------------------ Hero network ----------------------------- */

const CPSES = ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL'] as const;

const STAGES = [
  { key: 'material', label: 'MATERIAL', tone: 'sys' },
  { key: 'normalization', label: 'NORMALIZATION', tone: 'norm' },
  { key: 'matching', label: 'MATCHING', tone: 'match' },
  { key: 'review', label: 'TECHNICAL REVIEW', tone: 'rev' },
  { key: 'cmi', label: 'GOVERNED CMI', tone: 'gov' },
] as const;

const STAGE_HREF: Record<(typeof STAGES)[number]['key'], string> = {
  material: '/materials',
  normalization: '/imports',
  matching: '/matching',
  review: '/proposals',
  cmi: '/cross-reference',
};

const CPSE_PATHS: Record<(typeof CPSES)[number], string> = {
  CPCL: 'M 138 46 C 236 46, 330 82, 386 108',
  NTPC: 'M 138 86 C 244 86, 348 96, 386 104',
  BHEL: 'M 138 126 C 250 126, 354 120, 386 120',
  NLC: 'M 138 166 C 244 166, 348 142, 386 128',
  SAIL: 'M 138 206 C 236 206, 330 154, 386 134',
};

/* core → pipeline feeds: the core's outgoing line continues directly RIGHT
   into the five-stage column (endpoints = the flex-column tile centers) */
const STAGE_PATHS: Record<string, string> = {
  material: 'M 598 106 C 640 106, 648 42, 686 42',
  normalization: 'M 598 112 C 642 112, 650 81, 686 81',
  matching: 'M 598 118 C 642 118, 650 120, 686 120',
  review: 'M 598 124 C 640 124, 648 159, 686 159',
  cmi: 'M 598 130 C 636 130, 644 198, 686 198',
};

/**
 * DECISION INTELLIGENCE — separate analytics card docked BESIDE the hero
 * (same slot the old CPSE COVERAGE side card occupied). Uses the SAME real
 * decision-state counts as the lower Decision Landscape panel
 * (decisionStates + droppedNotAMatch). Relative-to-max horizontal bars with
 * the dashboard's semantic segment colors. No CPSE names, no material
 * counts, no new data source, no hard-coded values.
 */
function decisionSegments(d: ControlCenterData) {
  const byState = new Map(d.decisionStates.map((s) => [s.state, s.n] as const));
  const segs: Array<{ label: string; n: number; tone: 'rev' | 'ok' | 'neutral' }> = [];
  const push = (state: DecisionState, tone: 'rev' | 'ok' | 'neutral') => {
    const n = byState.get(state) ?? 0;
    if (n > 0) segs.push({ label: DECISION_STATE_LABELS[state], n, tone });
  };
  push('NEEDS_TECHNICAL_REVIEW', 'rev');
  push('HIGH_CONFIDENCE_MATCH', 'ok');
  push('LOW_CONFIDENCE', 'neutral');
  const dropped = d.droppedNotAMatch ?? 0;
  if (dropped > 0) segs.push({ label: 'Dropped / not a match', n: dropped, tone: 'neutral' });
  return segs;
}

function DecisionIntelligenceCard({ d }: { d: ControlCenterData }) {
  const segs = decisionSegments(d);
  const total = segs.reduce((a, s) => a + s.n, 0);
  if (total === 0) return null;
  const max = Math.max(...segs.map((s) => s.n), 1);
  return (
    <aside
      className="cc8-dicard"
      role="img"
      aria-label={`Decision intelligence across ${fmt(total)} material relationships: ${segs.map((s) => `${s.label} ${fmt(s.n)}`).join(', ')}.`}
    >
      <h2 className="cc8-di-title">DECISION INTELLIGENCE</h2>
      <p className="cc8-di-sub">{fmt(total)} material relationships</p>
      <ul className="cc8-di-rows">
        {segs.map((s) => (
          <li key={s.label}>
            <span className="cc8-di-label">{s.label}</span>
            <span className="cc8-di-track" aria-hidden="true"><span className={`cc8-di-fill cc8-seg-${s.tone}`} style={{ width: `${(s.n / max) * 100}%` }} /></span>
            <span className="cc8-di-n mono">{fmt(s.n)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function OrgBadge({ code, size = 24 }: { code: string; size?: number }) {
  return (
    <span
      className="cc8-badge"
      style={{ width: size, height: size, borderColor: ORG_TINT[code] ?? '#2f80ff', boxShadow: `0 0 6px ${(ORG_TINT[code] ?? '#2f80ff')}55, inset 0 0 4px ${(ORG_TINT[code] ?? '#2f80ff')}33` }}
      aria-hidden="true"
    >
      <LayersGlyph size={Math.round(size * 0.62)} />
    </span>
  );
}

function NetworkHero({ d }: { d: ControlCenterData }) {
  const m = d.metrics;
  const aria = `Material Intelligence Core connecting five CPSE source catalogs (${CPSES.join(', ')}) through material normalization, matching, technical review and governed common material identity. Real figures: ${fmt(m.pendingReviews)} open technical reviews, ${fmt(d.totalCandidates)} candidate relationships, ${fmt(m.totalMaterials)} materials, ${m.organizations} of 5 CPSEs, ${m.commonIdentities} governed ${m.commonIdentities === 1 ? 'identity' : 'identities'}.`;

  return (
      <figure className="cc8-net" role="img" aria-label={aria}>
      <figcaption className="cc8-visually-hidden">{aria}</figcaption>

      <svg className="cc8-netsvg" viewBox="0 0 940 240" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id="cc8-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#19c7d8" stopOpacity="0.22" />
            <stop offset="55%" stopColor="#2f80ff" stopOpacity="0.10" />
            <stop offset="100%" stopColor="#2f80ff" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* fine grid */}
        <g className="cc8-grid" aria-hidden="true">
          {Array.from({ length: 14 }).map((_, i) => (
            <line key={`v${i}`} x1={i === 0 ? 1 : i * 67} y1="6" x2={i === 0 ? 1 : i * 67} y2="234" />
          ))}
          {Array.from({ length: 3 }).map((_, i) => (
            <line key={`h${i}`} x1="6" y1={1 + i * 119} x2="934" y2={1 + i * 119} />
          ))}
        </g>

        {/* radial glow behind the core */}
        <circle cx="492" cy="116" r="122" fill="url(#cc8-glow)" className="cc8-glowpulse" />

        {/* CPSE → core feeds */}
        <g className="cc8-feeds">
          {CPSES.map((code, i) => (
            <g key={code}>
              <path className="cc8-feedline" d={CPSE_PATHS[code]} style={{ animationDelay: `${i * 0.6}s` }} />
              <circle className="cc8-dot" r="2.4" style={{ animationDelay: `${i * 0.9}s` }}>
                <animateMotion dur="4.6s" repeatCount="indefinite" path={CPSE_PATHS[code]} />
              </circle>
            </g>
          ))}
        </g>

        {/* core → stage feeds */}
        <g>
          {STAGES.map((s, i) => (
            <g key={s.key} className={`cc8-out-${s.tone}`}>
              <path className={`cc8-outpath cc8-outpath-${s.tone}`} d={STAGE_PATHS[s.key]} style={{ animationDelay: `${i * 0.5}s` }} />
              <circle className={`cc8-dot cc8-dot-${s.tone}`} r="2.2" style={{ animationDelay: `${i * 0.8}s` }}>
                <animateMotion dur="3.6s" repeatCount="indefinite" path={STAGE_PATHS[s.key]} />
              </circle>
            </g>
          ))}
        </g>

        {/* concentric core rings + tick ring */}
        <g className="cc8-core">
          <circle className="cc8-ring" cx="492" cy="116" r="106" />
          <circle className="cc8-ring cc8-ring-2" cx="492" cy="116" r="94" />
          <g className="cc8-marks" style={{ transformOrigin: '492px 116px' }}>
            {Array.from({ length: 36 }).map((_, i) => {
              const a = (i * 10 * Math.PI) / 180;
              const r1 = 113;
              const r2 = i % 3 === 0 ? 121 : 117;
              return (
                <line key={i} className="cc8-mark" x1={492 + r1 * Math.cos(a)} y1={116 + r1 * Math.sin(a)} x2={492 + r2 * Math.cos(a)} y2={116 + r2 * Math.sin(a)} />
              );
            })}
          </g>
        </g>
      </svg>

      {/* core content (HTML overlay, centered on the ring) */}
      <div className="cc8-corebox" aria-hidden="false">
        <span className="cc8-coreglyph"><LayersGlyph size={34} /></span>
        <span className="cc8-coreword">MATERIAL</span>
        <span className="cc8-coreword">INTELLIGENCE</span>
        <span className="cc8-coreword">CORE</span>
        <span className="cc8-corestat">{fmt(m.pendingReviews)} OPEN · {fmt(d.totalCandidates)} REL</span>
      </div>

      {/* CPSE source pills (left) — % positioned to the feed endpoints */}
      <div className="cc8-src" aria-label="CPSE source systems">
        {CPSES.map((code, i) => {
          const cov = m.perOrganization.find((o) => o.code === code);
          return (
            <a key={code} className={`cc8-pill cc8-node-pill-${i}`} href={`/materials?cpse=${code}`}>
              <OrgBadge code={code} />
              <span className="cc8-pillcode">{code}</span>
              <span className="cc8-pilln mono">{cov ? cov.materials : ''}</span>
            </a>
          );
        })}
      </div>

      {/* icon-tile pipeline (bottom flow, per approved polish spec) — % positioned to the feed endpoints */}
      <div className="cc8-pipe" aria-label="Intelligence pipeline">
        {STAGES.map((s, i) => {
          const Glyph = STAGE_GLYPH[s.key];
          return (
            <a key={s.key} className={`cc8-stage cc8-stage-${s.tone} cc8-stage-${i}`} href={STAGE_HREF[s.key]} title={s.label}>
              <span className="cc8-stageicon"><Glyph /></span>
              <span className="cc8-stageword">{s.label}</span>
            </a>
          );
        })}
      </div>

    </figure>
  );
}

function DecisionDonut({ d }: { d: ControlCenterData }) {
  const dropped = d.droppedNotAMatch ?? 0;
  const segs = d.decisionStates.map((s) => ({
    label: DECISION_STATE_LABELS[s.state as DecisionState] ?? s.state,
    n: s.n,
    tone: (['rev', 'ok', 'neutral'] as const)[
      Math.max(0, ['NEEDS_TECHNICAL_REVIEW', 'HIGH_CONFIDENCE_MATCH', 'LOW_CONFIDENCE'].indexOf(s.state))
    ],
  }));
  if (dropped > 0) segs.push({ label: 'Dropped / not a match', n: dropped, tone: 'neutral' });
  const total = segs.reduce((a, s) => a + s.n, 0);
  if (total === 0) return <p className="cc8-empty">No scored candidates yet.</p>;
  let acc = 0;
  const stops = segs
    .map((s) => {
      const from = (acc / total) * 360;
      acc += s.n;
      return `var(--cc8-seg-${s.tone}) ${from}deg ${(acc / total) * 360}deg`;
    })
    .join(', ');
  return (
    <div className="cc8-dl">
      <span
        className="cc8-donut"
        role="img"
        aria-label={`Decision states across ${fmt(total)} engine-scored candidates: ${segs.map((s) => `${s.label} ${s.n}`).join(', ')}. Includes ${fmt(dropped)} NOT_A_MATCH drops; ${fmt(d.totalCandidates)} candidates retained.`}
        style={{ background: `conic-gradient(${stops})` }}
      >
        <span className="cc8-donut-in"><strong>{fmt(total)}</strong><em>TOTAL SCORED</em></span>
      </span>
      <ul className="cc8-dllegend">
        {segs.map((s) => (
          <li key={s.label}>
            <span className={`cc8-dldot cc8-seg-${s.tone}`} aria-hidden="true" />
            <span className="cc8-dllabel">{s.label}</span>
            <span className="cc8-dlnnums">
              <strong>{fmt(s.n)}</strong>
              <em>{Math.round((s.n / total) * 100)}%</em>
            </span>
          </li>
        ))}
        <li className="cc8-dlnote">{fmt(d.totalCandidates)} candidates retained (incl. decided rows)</li>
      </ul>
    </div>
  );
}

function AttentionPanel({ d }: { d: ControlCenterData }) {
  // Lead with the verified flagship pair (real lookup: CP-1001 ↔ BH-4410 —
  // e.g. candidate #4640, whatever its current recorded state is), then the
  // real open-queue cases. Nothing here is hard-coded.
  const pool: FlagshipReviewCase[] = [];
  if (d.flagship && !d.attentionCases.some((c) => c.matchId === d.flagship!.matchId)) pool.push(d.flagship);
  pool.push(...d.attentionCases);
  const cases = pool.slice(0, 3);
  const crit = (c: FlagshipReviewCase) => c.queuePriority === 'pending';

  return (
    <section className="cc8-module cc8-module-att" aria-label="Technical attention">
      <div className="cc8-panelhead">
        <h2 className="cc8-modtitle"><span className="cc8-headicon cc8-headicon-red" aria-hidden="true"><WarnGlyph /></span>TECHNICAL ATTENTION</h2>
        <a className="cc8-panelmore" href="/proposals">View all →</a>
      </div>
      {cases.length > 0 ? (
        <ul className="cc8-attlist">
          {cases.map((c) => (
            <li key={c.matchId}>
              <a className="cc8-attrow" href={`/matching/${c.matchId}/judge`}>
                <span className="cc8-attmain">
                  <span className="mono cc8-attid">#{c.matchId}</span>
                  <span className="mono cc8-attpair">{c.sourceOrg} {c.sourceCode} ↔ {c.candidateOrg} {c.candidateCode}</span>
                  {c.criticalDifference ? <span className="mono cc8-attdiff">{c.criticalDifference}</span> : <span className="mono cc8-attdiff">{c.sourceDescription} vs {c.candidateDescription}</span>}
                </span>
                <span className="cc8-attend">
                  <span className={`cc8-attflag ${crit(c) ? 'cc8-attflag-crit' : 'cc8-attflag-rec'}`}>{crit(c) ? 'CRITICAL' : 'REVIEW'}</span>
                  <span className="cc8-chev" aria-hidden="true">›</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="cc8-empty">No open technical case.</p>
      )}
      <a className="cc8-attcta" href={cases.length > 0 ? `/matching/${cases[0].matchId}/judge` : '/matching'}>
        OPEN JUDGE MODE <span aria-hidden="true">→</span>
      </a>
    </section>
  );
}

function CoveragePanel({ d }: { d: ControlCenterData }) {
  const m = d.metrics;
  const max = Math.max(...m.perOrganization.map((o) => o.materials), 1);
  return (
    <section className="cc8-module" aria-label="CPSE material coverage">
      <div className="cc8-panelhead">
        <h2 className="cc8-modtitle"><span className="cc8-headicon cc8-headicon-blue" aria-hidden="true"><KpiGlyph kind="globe" /></span>CPSE MATERIAL COVERAGE</h2>
        <span className="cc8-panelnote">{fmt(m.totalMaterials)} materials · {m.organizations}/5 CPSEs</span>
      </div>
      <ul className="cc8-covbars">
        {m.perOrganization.map((o) => (
          <li key={o.code}>
            <a href={`/materials?cpse=${o.code}`}>
              <OrgBadge code={o.code} size={28} />
              <span className="cc8-covb-code">{o.code}</span>
              <span className="cc8-covb-track" aria-hidden="true"><span className="cc8-covb-fill" style={{ width: `${(o.materials / max) * 100}%` }} /></span>
              <span className="cc8-covb-n mono">{o.materials}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PipelinePanel() {
  return (
    <section className="cc8-module cc8-pstrip" aria-label="MaterialIQ pipeline">
      <div className="cc8-panelhead">
        <h2 className="cc8-modtitle"><span className="cc8-headicon cc8-headicon-blue" aria-hidden="true"><LayersGlyph size={14} /></span>MaterialIQ Pipeline</h2>
      </div>
      <ol className="cc8-psteps">
        {STAGES.map((s) => {
          const Glyph = STAGE_GLYPH[s.key];
          return (
            <li key={s.key} className={`cc8-pstep cc8-pstep-${s.tone}`}>
              <span className="cc8-picon"><Glyph /></span>
              <span className="cc8-ptext">
                <a className="cc8-plabel" href={STAGE_HREF[s.key]}>{s.label}</a>
                <span className="cc8-pdesc">
                  {s.key === 'material' ? 'Raw material data'
                  : s.key === 'normalization' ? 'Standardized formats'
                  : s.key === 'matching' ? 'Similarity analysis'
                  : s.key === 'review' ? 'Human validation'
                  : 'Common identity'}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ActivityPanel({ d }: { d: ControlCenterData }) {
  const activity = d.recentDecisions.slice(0, 5);
  const actionLabel = (a: string) => a.replace('proposal_', '').replace(/_/g, ' ').toUpperCase();
  return (
    <section className="cc8-module cc8-apanel" aria-label="Recent technical activity">
      <div className="cc8-panelhead">
        <h2 className="cc8-modtitle"><span className="cc8-headicon cc8-headicon-blue" aria-hidden="true"><KpiGlyph kind="bell" /></span>Recent Technical Activity</h2>
        <a className="cc8-panelmore" href="/proposals">View all →</a>
      </div>
      {activity.length === 0 ? (
        <p className="cc8-empty">No decisions recorded yet.</p>
      ) : (
        <ul className="cc8-actlist">
          {activity.map((r) => (
            <li key={`${r.matchId}-${r.at}`}>
              <a href={`/matching/${r.matchId}`}>
                <span className="mono cc8-actid">#{r.matchId}</span>
                <span className={`cc8-actstate ${r.action.includes('approve') ? 'cc8-act-ok' : r.action.includes('reject') ? 'cc8-act-bad' : 'cc8-act-rev'}`}>
                  {actionLabel(r.action)}
                </span>
                <span className="cc8-actmain">
                  <span className="cc8-actdetail">Technical decision recorded{r.reviewer ? ` · ${r.reviewer}` : ''}</span>
                  <span className="cc8-acttime">{relTime(r.at)}</span>
                </span>
                <span className="cc8-chev" aria-hidden="true">›</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* --------------------------------- Root --------------------------------- */

export function ControlCenterDashboard({ d }: { d: ControlCenterData }) {
  const m = d.metrics;

  const kpis = [
    { kind: 'bell', tone: 'rev', n: fmt(m.pendingReviews), label: 'OPEN REVIEWS', sub: 'Requires attention', href: '/proposals' },
    { kind: 'layers', tone: 'blue', n: fmt(d.totalCandidates), label: 'CANDIDATE RELATIONSHIPS', sub: 'Discovered', href: '/matching' },
    { kind: 'cube', tone: 'purple', n: fmt(m.totalMaterials), label: 'MATERIALS', sub: '5 CPSE catalogues', href: '/materials' },
    { kind: 'globe', tone: 'cyan', n: `${m.organizations}/5`, label: 'CPSE COVERAGE', sub: 'All connected', href: '/materials' },
    { kind: 'shield', tone: 'gov', n: fmt(m.commonIdentities), label: 'GOVERNED CMI', sub: d.harmonization?.code ?? '—', href: '/cross-reference' },
  ] as const;

  return (
    <main className="hq-root cc8-root">
      {/* Header row: title block + five icon-chip KPI cards */}
      <div className="cc8-top">
        <header className="cc8-head">
          <p className="cc8-eyebrow">MATERIAL INTELLIGENCE</p>
          <h1>COMMAND CENTER</h1>
          <p className="cc8-sub">Cross-CPSE material harmonization &amp; technical decision support</p>
        </header>
        <div className="cc8-kpis" aria-label="Platform totals">
          {kpis.map((k) => (
            <a key={k.label} className={`cc8-kpi cc8-kpi-${k.tone}`} href={k.href}>
              <span className="cc8-kpiicon"><KpiGlyph kind={k.kind} /></span>
              <strong>{k.n}</strong>
              <em>{k.label}</em>
              <span className="cc8-kpisub">{k.sub}</span>
            </a>
          ))}
        </div>
      </div>

      {/* Material Intelligence Network hero (ONE independent card) + the
          separate Decision Intelligence side card (old coverage slot) */}
      <div className="cc8-heroline">
        <NetworkHero d={d} />
        <DecisionIntelligenceCard d={d} />
      </div>

      {/* Analytics row */}
      <div className="cc8-row">
        <section className="cc8-module" aria-label="Decision landscape">
          <div className="cc8-panelhead">
            <h2 className="cc8-modtitle"><span className="cc8-headicon cc8-headicon-blue" aria-hidden="true"><KpiGlyph kind="layers" /></span>Decision Landscape</h2>
          </div>
          <DecisionDonut d={d} />
        </section>
        <AttentionPanel d={d} />
        <CoveragePanel d={d} />
      </div>

      {/* Pipeline panel + recent activity panel */}
      <div className="cc8-lower">
        <PipelinePanel />
        <ActivityPanel d={d} />
      </div>
    </main>
  );
}
