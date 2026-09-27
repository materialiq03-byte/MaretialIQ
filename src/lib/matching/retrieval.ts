/**
 * Candidate retrieval — the pre-filter before expensive pairwise comparison.
 *
 * Blocking rule (unchanged): materials sharing at least
 * `minSharedTokens` distinctive normalized tokens, same category and
 * * different organisation become candidate pairs.
 *
 * Step 3 implementation: a per-category inverted index
 * (token → member indices) accumulates shared-token counts per unordered
 * member pair, then emits the SAME pairs in the SAME order the previous
 * quadratic scan produced —
 *   - categories in first-appearance order,
 *   - within a category, pairs in (memberIndex i, j) ascending order,
 *   - pair objects normalized so `a` is the smaller material id.
 * Equivalence is asserted against the preserved quadratic reference
 * (`findCandidatesQuadratic`) by tests and by an old-vs-new comparison over
 * the production dataset and synthetic datasets. When `minSharedTokens`
 * is ≤ 0 (pairs with ZERO shared tokens qualify), the index cannot observe
 * such pairs, so the strategy falls back to the exhaustive reference scan —
 * the shipped default threshold is 1, so the index path is the live one.
 *
 * Step 4 — bounded-memory counting. The Step-3 implementation kept ONE
 * sharedCounts Map per category holding an entry for EVERY unordered pair
 * sharing ≥1 token — O(N²) entries in a dense category (15.7M entries at
 * 20k members; V8's ~2^24 Map-entry limit throws RangeError from ~25k).
 * Counting is now ROW-WISE: for each member i, a row-local Map counts
 * shared tokens with partners j > i only, pairs are threshold/org filtered
 * and emitted immediately, and the Map dies with the row. Peak auxiliary
 * memory is O(N) entries (one row) instead of O(N²) (the category), while
 * the arithmetic is IDENTICAL: a pair (i, j) is counted exactly once per
 * shared token — in row i — so its final count equals the old accumulator's.
 * Emission order is unchanged: row-major (i, j) is exactly the old global
 * survivors sort. Deterministic, and no exception is caught or swallowed.
 *
 * The strategy interface remains the seam where a vector search (pgvector,
 * SQLite-vss, or an embedding cache) plugs in without touching the matching
 * service.
 */
import type { MatchableMaterial } from './types';
import { THRESHOLDS } from './config';

export interface CandidatePair {
  a: MatchableMaterial;
  b: MatchableMaterial;
}

/** Minimal structural view of the run-scoped runtime cache (avoids an import cycle). */
interface TokenCache {
  representation(material: MatchableMaterial): { retrievalTokens: Set<string> };
}

/** Optional per-call instrumentation sink (diagnostics only; never affects results). */
export interface RetrievalStats {
  /** Materials grouped into categories. */
  materialsIndexed: number;
  /** Total token → postings entries built across categories. */
  tokenPostings: number;
  /** Unique unordered pairs observed sharing ≥1 token (before threshold). */
  pairKeysBeforeThreshold: number;
  /** Pairs emitted after the shared-token threshold. */
  candidatePairsEmitted: number;
  /** Pairs discarded because both materials share an organization. */
  sameOrganizationDiscarded: number;
  /** Cross-category pairs produced (always 0 — categories are index scopes). */
  crossCategoryPairs: number;
  /** Quadratic reference only: (i, j) checks that reached token comparison. */
  pairwiseChecks: number;
}

export interface RetrievalStrategy {
  readonly name: string;
  findCandidates(materials: MatchableMaterial[], tokenCache?: TokenCache, stats?: RetrievalStats): CandidatePair[];
  /**
   * Streaming equivalent of findCandidates — yields the SAME pairs in the
   * SAME order without materializing the O(pairs) array. Optional so custom
   * strategies only implement the array form; consumers fall back to it.
   */
  iterate?(materials: MatchableMaterial[], tokenCache?: TokenCache, stats?: RetrievalStats): Iterable<CandidatePair>;
}

const STOPWORDS = new Set(['AND', 'WITH', 'FOR', 'THE', 'OF', 'TYPE', 'MAKE', 'MOUNT']);

/**
 * Distinctive tokens of a material description (already normalized upstream).
 * Exported so the run-scoped runtime cache (matching/runtime.ts) can
 * precompute one token set per material; retrieval consumes the cached sets
 * and never re-tokenizes when a cache is supplied.
 */
export function distinctiveTokens(m: MatchableMaterial): Set<string> {
  const tokens = (m.normalizedDescription ?? m.originalDescription)
    .toUpperCase()
    .split(/[^A-Z0-9#]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  return new Set(tokens);
}

function tokensOf(m: MatchableMaterial, tokenCache?: TokenCache): Set<string> {
  return tokenCache ? tokenCache.representation(m).retrievalTokens : distinctiveTokens(m);
}

function groupByCategory(materials: MatchableMaterial[]): Map<string, MatchableMaterial[]> {
  const byCategory = new Map<string, MatchableMaterial[]>();
  for (const m of materials) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }
  return byCategory;
}

/** Emit one candidate pair, normalized exactly like the reference: `a` = smaller id. */
function orderedPair(a: MatchableMaterial, b: MatchableMaterial): CandidatePair {
  return a.id < b.id ? { a, b } : { a: b, b: a };
}

/**
 * Step-3 retrieval: per-category inverted index (token → member indices).
 * Shared-token counting via pair accumulation is arithmetically identical to
 * set intersection: each material appears once per token in a posting list
 * (token sets), so a pair's accumulator increments exactly once per shared
 * token. Pairs are emitted per category in ascending (memberIndex i, j)
 * order — the same sequence as the reference scan.
 */
export class BlockingRetrieval implements RetrievalStrategy {
  readonly name = 'inverted-index-blocking';

  /** Array form — delegates to the generator (single source of truth for order). */
  findCandidates(materials: MatchableMaterial[], tokenCache?: TokenCache, stats?: RetrievalStats): CandidatePair[] {
    return [...this.iterate(materials, tokenCache, stats)];
  }

  /**
   * Step 5 — streaming form. Identical emission order to findCandidates:
   * categories in first-appearance order, row-major (i, j) ascending,
   * `a` = smaller id. Consumers that process pairs one at a time (matching
   * jobs) never hold the O(pairs) array — at 25k+ dense categories that
   * array was the Step-4 heap ceiling, not retrieval state.
   */
  *iterate(materials: MatchableMaterial[], tokenCache?: TokenCache, stats?: RetrievalStats): Generator<CandidatePair> {
    const minShared = Math.max(0, THRESHOLDS.minCandidateSharedTokens);
    if (stats) {
      stats.materialsIndexed = materials.length;
      stats.tokenPostings = 0;
      stats.pairKeysBeforeThreshold = 0;
      stats.candidatePairsEmitted = 0;
      stats.sameOrganizationDiscarded = 0;
      stats.crossCategoryPairs = 0;
      stats.pairwiseChecks = 0;
    }
    if (minShared <= 0) {
      // A zero (or negative) threshold qualifies pairs sharing NO tokens,
      // which a token index cannot enumerate — fall back to the exhaustive
      // reference scan to stay exactly equivalent for that configuration.
      yield* findCandidatesQuadratic(materials, tokenCache, stats);
      return;
    }

    const byCategory = groupByCategory(materials);

    for (const [, members] of byCategory) {
      // Build the inverted index for this category: token → member indices.
      const postings = new Map<string, number[]>();
      for (let idx = 0; idx < members.length; idx++) {
        for (const token of tokensOf(members[idx], tokenCache)) {
          const list = postings.get(token);
          if (list) list.push(idx);
          else postings.set(token, [idx]);
        }
      }
      if (stats) stats.tokenPostings += postings.size;

      // Step 4: row-wise shared-token counting (bounded memory).
      // For member i, counts[j] = |tokens(i) ∩ tokens(j)| for j > i — each
      // posting list contains every member at most once (token SETS), so one
      // increment per shared token is arithmetically identical to the old
      // per-pair accumulator. The row Map never outlives its row: peak
      // auxiliary memory is O(members.length) entries, NOT O(pairs).
      for (let i = 0; i < members.length; i++) {
        const tokensI = tokensOf(members[i], tokenCache);
        if (tokensI.size === 0) continue;
        const counts = new Map<number, number>();
        for (const token of tokensI) {
          const list = postings.get(token);
          if (!list || list.length < 2) continue;
          for (const j of list) {
            if (j <= i) continue;
            counts.set(j, (counts.get(j) ?? 0) + 1);
          }
        }
        if (counts.size === 0) continue;
        // Every pair sharing ≥1 token is counted exactly once (in its own
        // row), so summing row map sizes reproduces the old accumulator's
        // unique-pair-key count exactly.
        if (stats) stats.pairKeysBeforeThreshold += counts.size;

        // Threshold first, then organization filter — the same order as the
        // old accumulator drain (and the same stats semantics).
        const orgI = members[i].organizationId;
        const qualified: number[] = [];
        for (const [j, shared] of counts) {
          if (shared < minShared) continue;
          if (members[j].organizationId === orgI) {
            if (stats) stats.sameOrganizationDiscarded++;
            continue;
          }
          qualified.push(j);
        }
        qualified.sort((a, b) => a - b);
        for (const j of qualified) {
          yield orderedPair(members[i], members[j]);
        }
        if (stats) stats.candidatePairsEmitted += qualified.length;
      }
    }
  }
}

/**
 * REFERENCE — the pre-Step-3 quadratic scan, preserved verbatim for
 * old-vs-new equivalence tests and benchmarks. Never used by the live
 * strategy except in the minSharedTokens ≤ 0 fallback documented above.
 */
export function findCandidatesQuadratic(
  materials: MatchableMaterial[],
  tokenCache?: TokenCache,
  stats?: RetrievalStats
): CandidatePair[] {
  const minShared = Math.max(0, THRESHOLDS.minCandidateSharedTokens);
  const byCategory = groupByCategory(materials);

  const seen = new Set<string>();
  const pairs: CandidatePair[] = [];
  if (stats) {
    stats.materialsIndexed = materials.length;
    stats.crossCategoryPairs = 0;
    stats.sameOrganizationDiscarded = 0;
    stats.pairKeysBeforeThreshold = 0;
    stats.tokenPostings = 0;
    stats.candidatePairsEmitted = 0;
  }
  for (const [, members] of byCategory) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        if (a.organizationId === b.organizationId) {
          if (stats) stats.sameOrganizationDiscarded++;
          continue;
        }
        if (stats) stats.pairwiseChecks++;
        const shared = countShared(tokensOf(a, tokenCache), tokensOf(b, tokenCache));
        if (shared < minShared) continue;
        const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push(orderedPair(a, b));
        if (stats) stats.candidatePairsEmitted++;
      }
    }
  }
  return pairs;
}

function countShared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

let active: RetrievalStrategy | null = null;

export function getRetrievalStrategy(): RetrievalStrategy {
  if (!active) active = new BlockingRetrieval();
  return active;
}

export function setRetrievalStrategy(strategy: RetrievalStrategy): void {
  active = strategy;
}
