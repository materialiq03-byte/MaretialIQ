/**
 * Step 9 — CMI short-circuit for redundant matching work (SHADOW by default).
 *
 * A pair whose materials are ALREADY mapped to the SAME ACTIVE common material
 * identity (CMI) is an explicitly approved human relationship. The matching
 * pipeline nevertheless re-scores such pairs on EVERY run, because runs wipe
 * pending candidates (`deletePendingMatches`) and rebuild everything. On the
 * reference corpus (Sep 2026) the live CMI CMI-BRG-6205 (CP-1001, NT-8821,
 * SL-7721) yields 3 same-CMI pairs: 1 APPROVED and 2 PENDING — the approved
 * one is re-scored and upsert-guarded to no effect every single run.
 *
 * ELIGIBILITY (exact, no inference):
 *   both materials have a row in material_mappings AND the two rows point at
 *   the SAME cmi_id AND that CMI has is_active = 1.
 * Category / description / manufacturer / tokens / scores / prior candidates
 * / NEEDS_REVIEW decisions never qualify. Membership is read fresh from the
 * database at run start (run-scoped map, same lifecycle as MatchingRunCache),
 * so external changes (mapping edits, CMI deactivation) are always respected.
 *
 * MODES (env CMI_SHORT_CIRCUIT):
 *   off    (default) — feature fully inert; zero behavioral difference.
 *   shadow          — detect and count same-CMI pairs; score everything;
 *                     record the skip-candidates in the run audit. No
 *                     persistence difference.
 *   on              — skip re-scoring pairs whose EXISTING candidate row is
 *                     DECIDED (approved/rejected/deferred). The row's scores,
 *                     evidence and review history are preserved verbatim;
 *                     upsertMatch's own guard would reject re-writes anyway,
 *                     so 'on' removes provably wasted work only.
 *
 * PENDING same-CMI pairs are NEVER short-circuited even in 'on' mode: the
 * pipeline deletes pending rows and rebuilds them, and a pending relationship
 * still awaits its human decision — skipping it would silently remove an
 * open review item. A future decision-state-aware persistence redesign could
 * revisit that; this step does not.
 *
 * SAFETY: the short-circuit can only skip work whose OUTPUT the pipeline
 * discards (decided rows are upsert-guarded: `WHERE status = 'pending'`).
 * No evidence, mapping, decision, or audit requirement is lost; the skipped
 * set is reported in the run summary/audit for governance.
 */
import { getDb } from '../db/client';

export type CmiShortCircuitMode = 'off' | 'shadow' | 'on';

export function cmiShortCircuitMode(): CmiShortCircuitMode {
  const raw = (process.env.CMI_SHORT_CIRCUIT ?? 'off').toLowerCase();
  return raw === 'shadow' || raw === 'on' ? (raw as CmiShortCircuitMode) : 'off';
}

/**
 * Fresh per-run CMI membership: material_id → active cmi_id.
 * Reads current DB state (never cached across runs); materials mapped to an
 * inactive CMI are treated as unmapped. Multiple mappings per material are
 * impossible today (`material_mappings.material_id UNIQUE`) but the code
 * below does not rely on that: a material with several mappings would keep
 * its first active one deterministically.
 */
export function loadCmiMembership(): Map<number, number> {
  const rows = getDb()
    .prepare(
      `SELECT mm.material_id, mm.cmi_id
         FROM material_mappings mm
         JOIN common_materials cm ON cm.id = mm.cmi_id AND cm.is_active = 1
        ORDER BY mm.material_id, mm.cmi_id`
    )
    .all() as Array<{ material_id: number; cmi_id: number }>;
  const map = new Map<number, number>();
  for (const r of rows) if (!map.has(r.material_id)) map.set(r.material_id, r.cmi_id);
  return map;
}

/** Statuses a pair's candidate row may hold for 'on'-mode skipping. */
const DECIDED_STATUSES = new Set(['approved', 'rejected', 'deferred']);

export interface CmiShortCircuitRuntime {
  membership: Map<number, number>;
  /** CMI ids seen in skipped/detected pairs (audit detail). */
  cmiIds: Set<number>;
  /** Material ids involved in skipped/detected pairs (audit detail). */
  materialIds: Set<number>;
  /**
   * 'on' mode only: pair key → existing candidate row's status + decision
   * state (from stored evidence). Lets the run audit reconcile the summary:
   * byDecision(on) + cmiSkippedByState == byDecision(off).
   */
  decidedStatusById?: Map<number, { status: string; state: string }>;
  /** 'on' mode: skipped pairs by the existing row's decision state. */
  skippedByState: Record<string, number>;
}

export interface CmiPairVerdict {
  eligible: boolean;
  cmiId?: number;
  /** Present in 'on' mode: the existing candidate row status, when known. */
  existingStatus?: string;
  skippable: boolean;
}

/**
 * The exact eligibility + skip rule for one ordered pair. Pure — no I/O — so
 * it is directly unit-testable and deterministic.
 */
export function evaluateCmiPair(
  runtime: CmiShortCircuitRuntime,
  sourceMaterialId: number,
  candidateMaterialId: number,
  mode: CmiShortCircuitMode
): CmiPairVerdict {
  if (mode === 'off') return { eligible: false, skippable: false };
  const cmiA = runtime.membership.get(sourceMaterialId);
  if (cmiA === undefined) return { eligible: false, skippable: false };
  const cmiB = runtime.membership.get(candidateMaterialId);
  if (cmiB !== cmiA) return { eligible: false, skippable: false };
  // Same active CMI. In 'on' mode a pair is skippable only when its existing
  // candidate row is DECIDED (approved/rejected/deferred); unknown status ⇒
  // not skippable (fail-safe: score it).
  let existingStatus: string | undefined;
  let skippable = false;
  if (mode === 'on') {
    const existing = runtime.decidedStatusById?.get(pairKey(sourceMaterialId, candidateMaterialId));
    existingStatus = existing?.status;
    skippable = existingStatus !== undefined && DECIDED_STATUSES.has(existingStatus);
  }
  return { eligible: true, cmiId: cmiA, existingStatus, skippable };
}

/** Deterministic unordered pair key (works within Number.MAX_SAFE_INTEGER). */
export function pairKey(a: number, b: number): number {
  return a < b ? a * 4294967296 + b : b * 4294967296 + a;
}

/**
 * matchType → decision-state mapping for rows whose stored evidence lacks a
 * decision.state (exactly one row in the seed data: the pre-approved flagship
 * pair inserted by scripts/seed.ts with evidence = NULL). matchType and
 * decision state are 1:1 in this pipeline (finishPair persists both from the
 * same core), so the mapping is faithful — not an approximation.
 */
const MATCH_TYPE_TO_STATE: Record<string, string> = {
  identical: 'HIGH_CONFIDENCE_MATCH',
  near_duplicate: 'HIGH_CONFIDENCE_MATCH',
  functional_equivalent: 'HIGH_CONFIDENCE_MATCH',
  needs_review: 'NEEDS_TECHNICAL_REVIEW',
  different: 'LOW_CONFIDENCE',
};

/**
 * Candidate-row index for 'on' mode: pair key → status + decision state.
 * Decided rows only — pending rows are absent, which makes them
 * non-skippable by default. The decision state comes from the row's stored
 * evidence JSON ($.decision.state), matching the byDecision accounting; rows
 * without stored evidence (seeded pre-approvals) fall back to the 1:1
 * matchType mapping.
 */
export function loadDecidedCandidateStatuses(): Map<number, { status: string; state: string }> {
  const rows = getDb()
    .prepare(
      `SELECT source_material_id, candidate_material_id, status, match_type,
              json_extract(evidence, '$.decision.state') AS evidenceState
         FROM match_candidates WHERE status != 'pending'`
    )
    .all() as Array<{ source_material_id: number; candidate_material_id: number; status: string; match_type: string; evidenceState: string | null }>;
  const map = new Map<number, { status: string; state: string }>();
  for (const r of rows) {
    const state = r.evidenceState ?? MATCH_TYPE_TO_STATE[r.match_type] ?? 'UNKNOWN';
    map.set(pairKey(r.source_material_id, r.candidate_material_id), { status: r.status, state });
  }
  return map;
}

export function makeCmiRuntime(mode: CmiShortCircuitMode): CmiShortCircuitRuntime {
  if (mode === 'off') return { membership: new Map(), cmiIds: new Set(), materialIds: new Set(), skippedByState: {} };
  const runtime: CmiShortCircuitRuntime = {
    membership: loadCmiMembership(),
    cmiIds: new Set(),
    materialIds: new Set(),
    skippedByState: {},
  };
  if (mode === 'on') runtime.decidedStatusById = loadDecidedCandidateStatuses();
  return runtime;
}

/** Record a skipped pair's existing decision state for audit reconciliation. */
export function trackCmiSkip(runtime: CmiShortCircuitRuntime, state: string): void {
  runtime.skippedByState[state] = (runtime.skippedByState[state] ?? 0) + 1;
}

/** Record a detected/skipped pair in the run-scoped audit detail. */
export function trackCmiPair(runtime: CmiShortCircuitRuntime, verdict: CmiPairVerdict, a: number, b: number): void {
  if (verdict.cmiId !== undefined) runtime.cmiIds.add(verdict.cmiId);
  runtime.materialIds.add(a);
  runtime.materialIds.add(b);
}
