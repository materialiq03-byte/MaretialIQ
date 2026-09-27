/**
 * Step-4 job execution model for matching runs.
 *
 * Matching semantics are untouched — scoring, thresholds, decisions, evidence
 * and persistence payloads are produced by the same repository calls as the
 * legacy `runMatching` code path. What changes is *how* a run executes:
 *
 *   BEFORE (Steps 1–3 baseline): one synchronous HTTP request holds a single
 *   transaction over the whole run.
 *
 *   AFTER: `createMatchingJob` inserts a QUEUED row (DB-authoritative
 *   single-active-run guard via a partial unique index) and returns
 *   immediately. `startQueuedRun` executes the run in bounded chunks —
 *   retrieval first, then chunk-sized scoring/persistence transactions, each
 *   committing independently — updating progress and heartbeat as it goes.
 *   A run interrupted by a process crash stays RUNNING until its heartbeat
 *   goes stale, after which `resumeRun` may re-execute it from scratch using
 *   the same deterministic retrieval (committed chunks are preserved because
 *   candidate persistence is idempotent upserts).
 *
 * PROTOTYPE LIMITATION: the runner is an in-process async task scoped to the
 * Next.js server process — not a distributed worker. It survives the HTTP
 * request (the request only creates the job) but not a server restart; the
 * job table + stale-heartbeat recovery exists precisely to make that visible
 * and recoverable. This is deliberately not Redis/BullMQ/PostgreSQL.
 */
import { randomUUID } from 'node:crypto';
import { getDb, withTransaction } from '../db/client';
import { config } from '../config';
import { errors } from '../errors';
import { listAllMaterialsForMatching } from '../db/repositories/matching-queries';
import { iteratePairs, countPairs, scorePairCore, finishPair } from '../matching/engine';
import { MatchingRunCache } from '../matching/runtime';
import { prefilterEnabled, survivesPersistenceFloor } from '../matching/prefilter';
import {
  cmiShortCircuitMode,
  makeCmiRuntime,
  evaluateCmiPair,
  trackCmiPair,
  trackCmiSkip,
} from '../matching/cmi-shortcircuit';
import {
  upsertMatch,
  deletePendingMatches,
  enqueueReview,
} from '../db/repositories/matching-repository';
import { recordAudit } from '../db/repositories/audit-repository';
import { DECISION_THRESHOLDS } from '../matching/decision';
import type { MatchableMaterial } from '../matching/types';

export type MatchJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface MatchJobRow {
  id: string;
  status: MatchJobStatus;
  total_candidates: number;
  processed_candidates: number;
  successful_candidates: number;
  failed_candidates: number;
  chunk_size: number;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface MatchJobSummary {
  jobId: string;
  status: MatchJobStatus;
  total: number;
  processed: number;
  successful: number;
  failed: number;
  chunkSize: number;
  progressPct: number;
  startedAt: string | null;
  completedAt: string | null;
  heartbeatAt: string | null;
  error: string | null;
  retryable: boolean;
}

const QUEUE_REASON: Record<string, string> = {
  identical: 'Confirmed identical candidates ready for approval',
  near_duplicate: 'Near duplicate requiring confirmation',
  functional_equivalent: 'Functionally equivalent candidate requiring confirmation',
  needs_review: 'Critical technical difference requires expert review',
  different: 'Low-similarity pair proposed for completeness',
};
const QUEUE_PRIORITY: Record<string, 'low' | 'medium' | 'high'> = {
  identical: 'low',
  near_duplicate: 'medium',
  functional_equivalent: 'medium',
  needs_review: 'high',
  different: 'low',
};

function toSummary(row: MatchJobRow): MatchJobSummary {
  const pct = row.total_candidates > 0 ? (row.processed_candidates / row.total_candidates) * 100 : 0;
  const staleSec = row.heartbeat_at
    ? (Date.now() - new Date(row.heartbeat_at).getTime()) / 1000
    : null;
  const stale = row.status === 'RUNNING' && staleSec !== null && staleSec > config.pipeline.jobHeartbeatTimeoutSec;
  return {
    jobId: row.id,
    status: row.status,
    total: row.total_candidates,
    processed: row.processed_candidates,
    successful: row.successful_candidates,
    failed: row.failed_candidates,
    chunkSize: row.chunk_size,
    progressPct: Math.round(pct * 10) / 10,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    heartbeatAt: row.heartbeat_at,
    error: row.error_message,
    // A RUNNING job whose heartbeat is stale is recoverable (see resumeRun).
    retryable: row.status === 'FAILED' || stale,
  };
}

function getJobRow(jobId: string): MatchJobRow {
  const row = getDb().prepare(`SELECT * FROM matching_runs WHERE id = ?`).get(jobId) as
    | MatchJobRow
    | undefined;
  if (!row) throw errors.notFound('Matching job');
  return row;
}

/** Fetch one job as an API-shaped summary. */
export function getMatchingJob(jobId: string): MatchJobSummary {
  return toSummary(getJobRow(jobId));
}

/** Newest jobs first — small observability helper (bounded by the caller). */
export function listMatchingJobs(limit = 10): MatchJobSummary[] {
  const rows = getDb()
    .prepare(`SELECT * FROM matching_runs ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(Math.max(1, Math.min(limit, 100))) as unknown as MatchJobRow[];
  return rows.map(toSummary);
}

/**
 * Create a matching job. The DB is the authority for the single-active-run
 * policy: a partial unique index rejects a second QUEUED/RUNNING job with a
 * constraint error, which we translate to a 409. No in-memory flags involved.
 * Run identity is a UUID — never a bare timestamp.
 */
export function createMatchingJob(actor: string, requestedBy?: string): MatchJobSummary {
  const jobId = `job_${randomUUID()}`;
  try {
    withTransaction(() => {
      getDb()
        .prepare(
          `INSERT INTO matching_runs (id, status, chunk_size) VALUES (?, 'QUEUED', ?)`
        )
        .run(jobId, config.pipeline.matchingChunkSize);
      recordAudit({
        action: 'match_generated',
        entityType: 'matching_job',
        actor,
        details: { jobId, event: 'job_created', requestedBy: requestedBy ?? actor },
      });
    });
  } catch (err) {
    // Partial unique index uq_matching_runs_active: another job is active.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('uq_matching_runs_active')) {
      throw errors.conflict(
        'A matching run is already queued or running. Wait for it to finish (GET /api/matching/runs) before starting another.'
      );
    }
    throw err;
  }
  return getMatchingJob(jobId);
}

/**
 * Execute a QUEUED job (or resume a stale/failed one) inside this process.
 * Fire-and-forget from the request path via startQueuedRunAsync; tests call
 * the synchronous form.
 */
export function runJob(jobId: string): MatchJobSummary {
  const now = () => new Date().toISOString();
  const db = getDb();

  // Captured by the claim transaction, consumed by the chunk executor.
  let materials: MatchableMaterial[] = [];
  // Step 5: the O(pairs) array is NEVER materialized. The claim transaction
  // computes the deterministic pair COUNT (total_candidates + chunk plan),
  // and the executor re-enumerates the same sequence while streaming chunks.
  let totalPairs = 0;
  let cache = new MatchingRunCache();
  // The persisted job.chunk_size is authoritative for the whole run — using
  // live config here would misalign chunk indices if the config changed
  // between an interruption and its resume.
  let chunkSizeForRun = config.pipeline.matchingChunkSize;

  // ---- claim + initialize (single transaction) --------------------------
  withTransaction(() => {
    const job = db.prepare(`SELECT * FROM matching_runs WHERE id = ?`).get(jobId) as
      | MatchJobRow
      | undefined;
    if (!job) throw errors.notFound('Matching job');
    if (job.status === 'RUNNING') {
      // Only a stale heartbeat makes a RUNNING job claimable; otherwise it
      // is being executed by a live worker right now.
      const staleSec = job.heartbeat_at
        ? (Date.now() - new Date(job.heartbeat_at).getTime()) / 1000
        : Infinity;
      if (staleSec <= config.pipeline.jobHeartbeatTimeoutSec) {
        throw errors.conflict('Matching job is already running.');
      }
    } else if (job.status === 'COMPLETED') {
      throw errors.conflict('Matching job already completed.');
    }
    chunkSizeForRun = job.chunk_size;
    // Deterministic retrieval is computed inside the same transaction so
    // total_candidates reflects reality before the first chunk commits.
    materials = listAllMaterialsForMatching();
    cache = new MatchingRunCache();
    totalPairs = countPairs(materials, cache);
    if (job.status !== 'RUNNING') {
      // Fresh (or retryable-FAILED) run: reset the phase in one transaction.
      // Idempotent persistence (upserts + INSERT OR IGNORE + deletePending at
      // the start) keeps re-execution safe; decided rows are never touched.
      deletePendingMatches();
      db.prepare(
        `UPDATE matching_runs
            SET status = 'RUNNING', started_at = ?, completed_at = NULL,
                heartbeat_at = ?, error_message = NULL,
                total_candidates = ?, processed_candidates = 0,
                successful_candidates = 0, failed_candidates = 0
          WHERE id = ?`
      ).run(now(), now(), totalPairs, jobId);
      db.prepare(`DELETE FROM matching_run_chunks WHERE run_id = ?`).run(jobId);
    } else {
      // Resuming a stale RUNNING job: committed chunks' rows are already in
      // place, so pending rows MUST NOT be deleted (that would erase the
      // work we are about to skip). Counters stay as-is; heartbeat refreshes.
      db.prepare(`UPDATE matching_runs SET heartbeat_at = ? WHERE id = ?`).run(now(), jobId);
    }
    // Persist the chunk plan so progress is observable per chunk.
    const insertChunk = db.prepare(
      `INSERT OR IGNORE INTO matching_run_chunks (run_id, chunk_index, first_pair, pair_count, status)
       VALUES (?, ?, ?, ?, 'PENDING')`
    );
    for (let start = 0; start < totalPairs; start += chunkSizeForRun) {
      insertChunk.run(
        jobId,
        start / chunkSizeForRun,
        start,
        Math.min(chunkSizeForRun, totalPairs - start),
      );
    }
    if (totalPairs === 0) {
      db.prepare(
        `UPDATE matching_runs SET status = 'COMPLETED', completed_at = ?, heartbeat_at = ? WHERE id = ?`
      ).run(now(), now(), jobId);
    }
  });

  // ---- phase execution outside the claim transaction ---------------------
  // Step 9: CMI short-circuit (off by default; shadow counts only; 'on'
  // skips re-scoring of DECIDED same-CMI pairs). Membership/statuses are
  // loaded ONCE per run — fresh from the DB, so external mapping changes
  // between runs are always respected.
  const cmiMode = cmiShortCircuitMode();
  const cmiRuntime = makeCmiRuntime(cmiMode);
  let cmiShortCircuited = 0;
  const runPairs = (materials: MatchableMaterial[], cache: MatchingRunCache): void => {
    const chunkSize = chunkSizeForRun;
    const started = Date.now();
    let successful = 0;
    let failed = 0;
    let droppedByPrefilter = 0; // fast path: pairs that skipped the evidence tail (legacy path counts them in the audit below)
    const droppedByState: Record<string, number> = {}; // fast path: drop breakdown by the state legacy accounting would record
    const fastPath = prefilterEnabled();
    // Step 5: the persistence-floor fast path — dropped pairs are exactly
    // those the legacy path scores and then skips (its own rule, applied
    // before the expensive tail). MATCH_PREFILTER=off restores
    // score-everything accounting bit-for-bit.

    // Single streaming pass over the deterministic pair sequence. Chunk k
    // occupies positions [k·chunkSize, …); committed chunks (resume) are
    // consumed — never re-scored — so positioning stays exact without ever
    // holding more than one chunk's pairs in memory.
    const pairStream = iteratePairs(materials, cache);
    for (let start = 0; start < totalPairs; start += chunkSize) {
      const chunkIndex = start / chunkSize;
      const count = Math.min(chunkSize, totalPairs - start);
      // Idempotent resume: a chunk already durably COMMITTED (crash between
      // commit and completion, stale-RUNNING takeover) is skipped — its rows
      // exist and its counters were already applied.
      const prior = db
        .prepare(`SELECT status FROM matching_run_chunks WHERE run_id = ? AND chunk_index = ?`)
        .get(jobId, chunkIndex) as { status: string } | undefined;
      const slice: Array<[MatchableMaterial, MatchableMaterial]> = [];
      for (let k = 0; k < count; k++) {
        const next = pairStream.next();
        slice.push(next.value);
      }
      if (prior?.status === 'COMMITTED') continue;
      // Per-chunk transaction: a failure rolls back ONLY this chunk.
      try {
        withTransaction(() => {
          db.prepare(
            `UPDATE matching_run_chunks SET status = 'RUNNING' WHERE run_id = ? AND chunk_index = ?`
          ).run(jobId, chunkIndex);
          let created = 0;
          let reviewItems = 0;
          for (const [a, b] of slice) {
            // Step 9: same-active-CMI pairs. shadow: count and continue to
            // normal scoring. on: skip ONLY decided pairs (fail-safe).
            const cmiVerdict = evaluateCmiPair(cmiRuntime, a.id, b.id, cmiMode);
            if (cmiVerdict.eligible) {
              trackCmiPair(cmiRuntime, cmiVerdict, a.id, b.id);
              if (cmiMode === 'shadow') {
                // Detection only: the pair continues through normal scoring.
                cmiShortCircuited++;
              } else if (cmiVerdict.skippable) {
                cmiShortCircuited++;
                trackCmiSkip(
                  cmiRuntime,
                  cmiRuntime.decidedStatusById?.get(
                    a.id < b.id ? a.id * 4294967296 + b.id : b.id * 4294967296 + a.id
                  )?.state ?? 'UNKNOWN'
                );
                continue;
              }
            }
            // Step 5: cheap core first; the expensive explanation/evidence
            // tail is paid only for survivors (bit-identical to full scoring).
            const core = scorePairCore(a, b, cache);
            if (!survivesPersistenceFloor(core)) {
              if (fastPath) {
                droppedByPrefilter++;
                droppedByState[core.decision.state] = (droppedByState[core.decision.state] ?? 0) + 1;
              }
              continue;
            }
            const score = finishPair(a, b, core);
            const inserted = upsertMatch({
              sourceMaterialId: a.id,
              candidateMaterialId: b.id,
              semanticScore: score.semanticScore,
              fuzzyScore: score.fuzzyScore,
              technicalScore: score.technicalScore,
              categoryCompatible: score.categoryCompatible,
              finalScore: score.finalScore,
              matchType: score.matchType,
              explanation: score.explanation,
              criticalDifference: score.criticalDifference,
              evidence: JSON.stringify(score.evidence),
              matchRunId: jobId,
            });
            if (inserted.created) created++;
            const enqueued = enqueueReview({
              matchId: inserted.id,
              priority: QUEUE_PRIORITY[score.matchType],
              reason: QUEUE_REASON[score.matchType],
              criticalDifference: score.criticalDifference,
            });
            if (enqueued) reviewItems++;
          }
          db.prepare(
            `UPDATE matching_run_chunks SET status = 'COMMITTED' WHERE run_id = ? AND chunk_index = ?`
          ).run(jobId, chunkIndex);
          // Progress is derived from committed work only.
          db.prepare(
            `UPDATE matching_runs
                SET processed_candidates = processed_candidates + ?,
                    successful_candidates = successful_candidates + ?,
                    heartbeat_at = ?
              WHERE id = ?`
          ).run(slice.length, created, new Date().toISOString(), jobId);
          successful += created;
          void reviewItems;
        });
      } catch (err) {
        failed += slice.length;
        // Roll back this chunk's marker; preserve prior chunks.
        withTransaction(() => {
          db.prepare(
            `UPDATE matching_run_chunks SET status = 'FAILED' WHERE run_id = ? AND chunk_index = ?`
          ).run(jobId, chunkIndex);
          db.prepare(
            `UPDATE matching_runs SET status = 'FAILED', completed_at = ?, heartbeat_at = ?, error_message = ? WHERE id = ?`
          ).run(new Date().toISOString(), new Date().toISOString(), err instanceof Error ? err.message : String(err), jobId);
        });
        // Audit the failure outside the failed chunk's transaction.
        try {
          recordAudit({
            action: 'match_generated',
            entityType: 'matching_job',
            actor: 'system',
            details: { jobId, event: 'job_failed', chunkIndex, error: err instanceof Error ? err.message : String(err) },
          });
        } catch {
          /* audit failure must not mask the job failure */
        }
        return; // stop at first failed chunk; job is retryable
      }
    }

    // All chunks committed: close the job and audit the summary.
    withTransaction(() => {
      db.prepare(
        `UPDATE matching_runs SET status = 'COMPLETED', completed_at = ?, heartbeat_at = ? WHERE id = ?`
      ).run(new Date().toISOString(), new Date().toISOString(), jobId);
      recordAudit({
        action: 'match_generated',
        entityType: 'matching_job',
        actor: 'system',
        details: {
          jobId,
          event: 'job_completed',
          pairsCompared: totalPairs,
          candidatesCreated: successful,
          failedCandidates: failed,
          droppedByPrefilter,
          droppedByState,
          prefilterEnabled: fastPath,
          cmiShortCircuit: cmiMode,
          cmiShortCircuited,
          cmiIds: [...cmiRuntime.cmiIds].sort((x, y) => x - y),
          cmiMaterialIds: [...cmiRuntime.materialIds].sort((x, y) => x - y),
          cmiSkippedByState: { ...cmiRuntime.skippedByState },
          durationMs: Date.now() - started,
        },
      });
    });
  };

  try {
    runPairs(materials, cache);
  } catch (err) {
    // Unexpected failure outside chunk execution (e.g. retrieval threw).
    withTransaction(() => {
      getDb()
        .prepare(
          `UPDATE matching_runs SET status = 'FAILED', completed_at = ?, heartbeat_at = ?, error_message = ? WHERE id = ?`
        )
        .run(new Date().toISOString(), new Date().toISOString(), err instanceof Error ? err.message : String(err), jobId);
    });
  }

  return getMatchingJob(jobId);
}

/**
 * Request-path entrypoint: create the job row, then kick off execution
 * without awaiting it, so the HTTP response returns immediately with the
 * job id. The promise is intentionally not awaited; rejections are already
 * handled inside runJob (job marked FAILED), but a .catch guards against
 * unhandled-rejection noise.
 */
export function createAndStartMatchingJob(actor: string): MatchJobSummary {
  const job = createMatchingJob(actor);
  // Detached async execution — the request must not wait for matching.
  void Promise.resolve().then(() => {
    try {
      runJob(job.jobId);
    } catch (err) {
      console.error(`[matching-job] run ${job.jobId} crashed:`, err);
    }
  });
  return job;
}

/** Human-readable status for API/tests. */
export function describeMatchingJob(jobId: string): string {
  const s = getMatchingJob(jobId);
  return `${s.status} ${s.processed}/${s.total} (${s.progressPct}%) chunks=${Math.ceil(s.total / s.chunkSize)}${s.error ? ` error=${s.error}` : ''}`;
}

// Re-exported for API/test convenience.
export { getJobRow as _getJobRowInternal };
