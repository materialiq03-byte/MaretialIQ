/**
 * Embedding provider abstraction.
 *
 * `EmbeddingProvider` is the seam for a real sentence-embedding model (local
 * ONNX/transformers.js now, or a Python sidecar later — the interface is the
 * contract, not the implementation). The only implementation shipped in this
 * step is a DETERMINISTIC LOCAL FALLBACK: a character-trigram hashing
 * embedding with TF weighting and cosine similarity.
 *
 * It is NOT a neural model and must never be presented as one: `isFallback`
 * is true, the name says "deterministic-hashing-fallback", and the evidence
 * persisted with every match records it. It approximates lexical/character
 * overlap — genuinely useful for material descriptions (codes, dimensions,
 * mnemonics survive abbreviation well) — while the interface keeps the door
 * open for a real semantic model without touching call sites.
 */

export interface EmbeddingProvider {
  readonly name: string;
  /** True when this is the deterministic non-neural fallback. */
  readonly isFallback: boolean;
  readonly dimensions: number;
  generateEmbedding(text: string): number[];
}

const DIM = 256;

function hashTrigram(trigram: string): number {
  // FNV-1a 32-bit — deterministic across processes and platforms.
  let h = 0x811c9dc5;
  for (let i = 0; i < trigram.length; i++) {
    h ^= trigram.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function trigrams(text: string): string[] {
  const cleaned = `  ${text.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
  const out: string[] = [];
  for (let i = 0; i < cleaned.length - 2; i++) out.push(cleaned.slice(i, i + 3));
  return out;
}

/**
 * Deterministic trigram-hashing embedding. TF-weighted; not length-normalised
 * (cosine handles magnitude). Same input always yields the same vector.
 */
export class DeterministicHashingProvider implements EmbeddingProvider {
  readonly name = 'deterministic-hashing-fallback';
  readonly isFallback = true;
  readonly dimensions = DIM;

  generateEmbedding(text: string): number[] {
    const vec = new Array<number>(DIM).fill(0);
    for (const tg of trigrams(text)) {
      vec[hashTrigram(tg) % DIM] += 1;
    }
    return vec;
  }
}

/** Cosine similarity between two vectors (0 when either is empty). */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cosine from a dot product and precomputed norms (Step 6).
 *
 * dot / (√(Σa²) · √(Σb²)) with the sums now computed once per vector per run:
 * the IEEE-754 result is bit-identical to cosineSimilarity — the same dot
 * accumulation in the same index order, and √(na)·√(nb) computed from the
 * same integer-exact Σa²/Σb² float64 sums. `normsKnown` asserts the caller's
 * norms were derived from the same arrays being compared (both zero → 0,
 * mirroring the empty-vector guard).
 */
export function cosineFromNorms(
  a: number[],
  b: number[],
  normA: number,
  normB: number,
  normsKnown: boolean
): number {
  if (!normsKnown || normA === 0 || normB === 0) return 0;
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot / (normA * normB);
}

let active: EmbeddingProvider | null = null;

/** The process-wide provider. Swap point for a real model in a later step. */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!active) active = new DeterministicHashingProvider();
  return active;
}

/** Test/alternative-provider hook. */
export function setEmbeddingProvider(provider: EmbeddingProvider): void {
  active = provider;
}
