/**
 * Step 7 — SHADOW blocking: OR-union of independent key families.
 *
 * NOT active in the matching pipeline. The production retrieval path is and
 * remains `BlockingRetrieval` (retrieval.ts). This module exists so the
 * measured Step-7 conclusion is reproducible and so a future strategy change
 * starts from tested code instead of from scratch.
 *
 * WHY IT IS SHADOW-ONLY (measured — .freebuff/step7-referee.ts,
 * step7-arm-coverage.ts):
 *
 *   Candidate generation can only safely remove pairs the pipeline itself
 *   drops after scoring (the persistence floor). On the real reference corpus
 *   1,289 of 1,303 baseline pairs SURVIVE that floor (98.9%) — different-series
 *   bearings, class/voltage conflicts, cross-brand pairs and weak pairs are
 *   all persisted for review or audit. The theoretical best reduction of ANY
 *   blocker is therefore the drop share itself, already captured losslessly by
 *   the Step-5 prefilter (measured 3.6–4.7% on synthetic corpora).
 *
 *   Every pruning mechanism tested lost actionable pairs:
 *     - document-frequency gate on the unified keys at every α (0.5 → 0.02):
 *       real-corpus actionable recall fell to 35.7% / 13.2% / 1.7% / 0.2%.
 *       Genuinely actionable pairs hang on generic keys (BEARING) because
 *       distinctive tokens exclude pure digits — series numbers pair only
 *       through the category noun.
 *     - part-number family as a sole gate: 13/31 actionable GT pairs kept.
 *   Additive OR-unions (α = ∞) are strict supersets of the baseline (measured
 *   +16 pairs on the reference corpus) — they only ADD work.
 *
 * DESIGN
 *
 * A pair becomes a candidate when it shares ANY key (OR-union) within the
 * same category and different organizations. Key families:
 *   - `T:`   distinctive normalized description tokens (the baseline signal)
 *   - `A:`   canonicalized attribute values over category-aware families
 *            (scoring's own canonicalizer — value equality here is exactly
 *            value equality under compareAttribute)
 *   - `PN:`  part-number family (alphanumeric, leading-zero-collapsed)
 *
 * Key generation is SUBSET-TOLERANT: a material lacking an attribute emits no
 * key for that family, so a missing attribute can never split a pair — the
 * pair must simply share some other key.
 *
 * The per-key document-frequency gate `df(key) < α · categorySize` is an
 * EXPERIMENT dial only (α default ∞ = disabled). α < 1 trades recall for
 * reduction and is rejected by the measured safety gate; it exists so future
 * experiments measure against the same harness.
 *
 * Determinism: pairs are emitted per category (first-appearance order),
 * keys sorted, member ids ascending, a < b, deduplicated across keys. This
 * ordering differs from the baseline row-major order — any future activation
 * must sort the merged stream (documented remapping, Step-7 report §17).
 */
import type { MatchableMaterial } from './types';
import { distinctiveTokens } from './retrieval';
import { prepareAttribute } from './compare';

/** Category-aware attribute families for value-equality keys. */
const VALUE_FAMILIES: Record<string, string[]> = {
  Bearings: ['series', 'bore_diameter', 'seal_type'],
  Valves: ['nominal_size', 'pressure_class', 'valve_type'],
  Motors: ['power_rating', 'voltage_rating', 'phase', 'frequency'],
  Pumps: ['suction_size', 'discharge_size', 'power_rating'],
  Fasteners: ['thread_specification', 'diameter', 'length'],
};

const ENUM_FAMILIES: Record<string, string[]> = {
  Bearings: ['bearing_type', 'seal_type', 'material_type', 'material_grade', 'manufacturer'],
  Valves: ['valve_type', 'body_material', 'end_connection', 'material_type', 'material_grade'],
  Motors: ['motor_type', 'phase', 'mounting', 'material_type', 'material_grade'],
  Pumps: ['pump_type', 'casing_material', 'material_type', 'material_grade'],
  Fasteners: ['fastener_type', 'material_grade', 'material_type'],
};

/** α gate for the per-key document-frequency experiment (Infinity = off). */
export function blockingAlpha(): number {
  const raw = process.env.BLOCKING_ALPHA;
  if (!raw || raw === 'inf') return Number.POSITIVE_INFINITY;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

/**
 * Canonical key of one attribute value — the scoring canonicalizer's own
 * canonical form, so blocking "equal" ≡ compareAttribute "equal after
 * canonicalization".
 */
function valueKey(name: string, value: string, normalizedValue: string | null): string {
  return prepareAttribute(name, { attributeName: name, value, normalizedValue, unit: null, isCritical: 0 } as never)
    .factCanon;
}

/** All blocking keys of one material (subset-tolerant per family). */
export function blockingKeys(m: MatchableMaterial): string[] {
  const keys: string[] = [];
  for (const t of distinctiveTokens(m)) keys.push(`T:${t}`);
  const byName = new Map(m.attributes.map((a) => [a.attributeName, a]));
  const families = [...(VALUE_FAMILIES[m.category] ?? []), ...(ENUM_FAMILIES[m.category] ?? [])];
  for (const name of families) {
    const a = byName.get(name);
    if (!a) continue;
    const k = valueKey(name, a.value, a.normalizedValue);
    if (k) keys.push(`A:${name}=${k}`);
  }
  const pn = m.partNumber?.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (pn) {
    const fam = pn.replace(/0+(?=\d)/g, '');
    if (fam.length >= 3) keys.push(`PN:${fam}`);
  }
  return keys;
}

export interface ShadowCandidatePair {
  materialIdA: number;
  materialIdB: number;
}

export interface ShadowStats {
  /** Categories processed. */
  categories: number;
  /** Key → postings entries built across categories (after the α gate). */
  keysIndexed: number;
  /** Keys pruned by the document-frequency gate. */
  keysPrunedByAlpha: number;
  /** Blocks (posting lists with ≥2 members) after the gate. */
  blocks: number;
  /** Largest posting list (diagnostic — no truncation anywhere). */
  maxBlockSize: number;
  /** Unique candidate pairs emitted (cross-org, same category). */
  pairsEmitted: number;
  /** Same-category same-org pairs suppressed (mirrors baseline accounting). */
  sameOrganizationSuppressed: number;
}

/**
 * Shadow OR-union blocking. Pure (no DB, no I/O); iterate for streaming
 * consumers. Deterministic emission: per category (first-appearance order),
 * keys sorted, member ids ascending, a < b, deduplicated across keys.
 */
export function* iterateShadowCandidates(
  materials: MatchableMaterial[],
  alpha: number = blockingAlpha(),
  stats?: ShadowStats
): Generator<ShadowCandidatePair> {
  const byCategory = new Map<string, MatchableMaterial[]>();
  for (const m of materials) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }
  if (stats) {
    stats.categories = byCategory.size;
    stats.keysIndexed = 0;
    stats.keysPrunedByAlpha = 0;
    stats.blocks = 0;
    stats.maxBlockSize = 0;
    stats.pairsEmitted = 0;
    stats.sameOrganizationSuppressed = 0;
  }

  for (const [, members] of byCategory) {
    const allKeys = members.map((m) => blockingKeys(m));
    // Document frequency per key within the category.
    const df = new Map<string, number>();
    for (const keys of allKeys) {
      for (const k of keys) df.set(k, (df.get(k) ?? 0) + 1);
    }
    // α gate (a key must appear in strictly fewer than α·|category| docs).
    const postings = new Map<string, number[]>();
    for (let i = 0; i < members.length; i++) {
      for (const k of allKeys[i]) {
        if (df.get(k)! >= alpha * members.length) {
          if (stats) stats.keysPrunedByAlpha++;
          continue;
        }
        const list = postings.get(k);
        if (list) list.push(i);
        else postings.set(k, [i]);
      }
    }
    if (stats) stats.keysIndexed += postings.size;

    // Emit per key in sorted key order; a pair sharing several keys is
    // emitted ONCE (dedupe set, category-scoped — never module state).
    const emitted = new Set<string>();
    const sortedKeys = [...postings.keys()].sort();
    for (const key of sortedKeys) {
      const memberIdxs = postings.get(key)!;
      if (memberIdxs.length < 2) continue;
      if (stats) {
        stats.blocks++;
        if (memberIdxs.length > stats.maxBlockSize) stats.maxBlockSize = memberIdxs.length;
      }
      for (let x = 0; x < memberIdxs.length; x++) {
        for (let y = x + 1; y < memberIdxs.length; y++) {
          const A = members[memberIdxs[x]];
          const B = members[memberIdxs[y]];
          if (A.organizationId === B.organizationId) {
            if (stats) stats.sameOrganizationSuppressed++;
            continue;
          }
          const lo = A.id < B.id ? A.id : B.id;
          const hi = A.id < B.id ? B.id : A.id;
          const pairKey = `${lo}:${hi}`;
          if (emitted.has(pairKey)) continue;
          emitted.add(pairKey);
          if (stats) stats.pairsEmitted++;
          yield { materialIdA: lo, materialIdB: hi };
        }
      }
    }
  }
}
