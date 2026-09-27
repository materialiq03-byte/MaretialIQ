/**
 * Run-scoped runtime representation cache (Step 2 scale hardening).
 *
 * A `MatchingRunCache` instance is created by ONE matching/evaluation run and
 * passed explicitly to retrieval and `scorePair`. It holds per-material
 * derived representations that are pure functions of the material record and
 * were previously recomputed for every candidate pair:
 *
 *   - embedding        (semantic vector of the normalized description)
 *   - fuzzyTokens      (tokenized original description for Dice similarity)
 *   - retrievalTokens  (distinctive-token set used by blocking retrieval)
 *   - attributeIndex   (attributeName → attribute lookup map)
 *
 * Step 6 additions (same lifecycle rules, all pure per-material functions):
 *   - uniqueFuzzyTokens / fuzzyTokenCount (allocation-free Dice inputs)
 *   - embeddingNorm (cosine without per-pair norm recomputation)
 *   - prepared (attribute name order + canonicalized value facts + assembly
 *     signal — the per-material side of compareTechnicalPrepared)
 *
 * LIFECYCLE / STALE-DATA SAFETY:
 *   - No module-level or global state: the cache lives only as long as the
 *     run that created it. A new run (matcher run, evaluation, test) creates
 *     a new cache; representations are never shared across runs, databases,
 *     imports, or material states.
 *   - Keyed by material id within that single cache instance; representations
 *     are built lazily on first use and reused for every subsequent pair of
 *     the same run.
 *   - All builders are the exact functions the uncached path uses
 *     (getEmbeddingProvider().generateEmbedding, fuzzyTokens,
 *     distinctiveTokens), so cached and uncached scoring are identical by
 *     construction — asserted by tests/runtime-cache.test.ts over every
 *     retrieval pair.
 *
 * Instrumentation counters (embeddingsBuilt, fuzzyTokenizations,
 * retrievalTokenSets, representationsBuilt) let benchmarks and tests prove
 * the once-per-material behavior without any production logging.
 */
import type { MatchableMaterial } from './types';
import { getEmbeddingProvider, cosineSimilarity } from './embedding';
import { fuzzyTokens, prepareAttribute, type PreparedAttribute, type PreparedMaterialSide } from './compare';
import { distinctiveTokens } from './retrieval';
import { detectAssembly } from '../pipeline/assembly';

export interface MaterialRuntime {
  readonly materialId: number;
  /** Semantic vector — exactly what scorePair computes per pair uncached. */
  readonly embedding: number[];
  /** Tokenized original description for the fuzzy Dice kernel. */
  readonly fuzzyTokens: string[];
  /** Distinctive-token set consumed by blocking retrieval. */
  readonly retrievalTokens: Set<string>;
  /** attributeName → attribute (names are unique per material). */
  readonly attributeIndex: Map<string, MatchableMaterial['attributes'][number]>;

  // ——— Step 6 prepared scoring facts (pure functions of this material) ———

  /** Unique fuzzy-token set + original length: allocation-free Dice inputs. */
  readonly uniqueFuzzyTokens: ReadonlySet<string>;
  /** Original token-array length feeding the Dice denominator. */
  readonly fuzzyTokenCount: number;
  /** ‖embedding‖₂ — cosine recomputes it per pair otherwise. */
  readonly embeddingNorm: number;
  /** Prepared-side view consumed by compareTechnicalPrepared. */
  readonly prepared: PreparedMaterialSide;
}

export interface RuntimeCounters {
  representationsBuilt: number;
  embeddingsBuilt: number;
  fuzzyTokenizations: number;
  retrievalTokenSets: number;
}

export class MatchingRunCache {
  private readonly representations = new Map<number, MaterialRuntime>();
  readonly counters: RuntimeCounters = {
    representationsBuilt: 0,
    embeddingsBuilt: 0,
    fuzzyTokenizations: 0,
    retrievalTokenSets: 0,
  };

  /** Number of distinct materials represented so far in this run. */
  get size(): number {
    return this.representations.size;
  }

  /** Cached-or-built runtime representation for one material (this run only). */
  representation(material: MatchableMaterial): MaterialRuntime {
    const existing = this.representations.get(material.id);
    if (existing) return existing;

    const text = material.normalizedDescription ?? material.originalDescription;
    const embedding = getEmbeddingProvider().generateEmbedding(text);
    const tokens = fuzzyTokens(material.originalDescription);
    const retrievalSet = distinctiveTokens(material);
    const attributeIndex = new Map<string, MatchableMaterial['attributes'][number]>();
    for (const attr of material.attributes) {
      if (!attributeIndex.has(attr.attributeName)) attributeIndex.set(attr.attributeName, attr);
    }

    // Step 6 prepared facts — the same builders the uncached path runs per
    // pair, executed once per material instead.
    let embeddingNorm = 0;
    for (let i = 0; i < embedding.length; i++) embeddingNorm += embedding[i] * embedding[i];
    embeddingNorm = Math.sqrt(embeddingNorm);
    const uniqueFuzzyTokens = new Set(tokens);
    const preparedAttributes = new Map<string, PreparedAttribute>();
    for (const attr of material.attributes) {
      if (!preparedAttributes.has(attr.attributeName)) {
        preparedAttributes.set(attr.attributeName, prepareAttribute(attr.attributeName, attr));
      }
    }
    const prepared: PreparedMaterialSide = {
      attributeIndex,
      attributeNames: material.attributes.map((x) => x.attributeName),
      preparedAttributes,
      assembly: detectAssembly(material.originalDescription),
    };

    this.counters.representationsBuilt++;
    this.counters.embeddingsBuilt++;
    this.counters.fuzzyTokenizations++;
    this.counters.retrievalTokenSets++;
    const runtime: MaterialRuntime = {
      materialId: material.id,
      embedding,
      fuzzyTokens: tokens,
      retrievalTokens: retrievalSet,
      attributeIndex,
      uniqueFuzzyTokens,
      fuzzyTokenCount: tokens.length,
      embeddingNorm,
      prepared,
    };
    this.representations.set(material.id, runtime);
    return runtime;
  }
}
