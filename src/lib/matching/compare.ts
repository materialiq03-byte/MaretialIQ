/**
 * Comparison primitives: fuzzy description similarity and typed attribute
 * comparison. Pure functions, fully deterministic.
 */
import { canonicalValue } from '../pipeline/normalize';
import { compareAssemblySignals, detectAssembly, type AssemblySignal } from '../pipeline/assembly';
import type { AttributeComparison, ComparisonType, MaterialAttributeLite, MatchableMaterial } from './types';
import { criticalAttributesFor, attributeStrategyFor, nominalAttributesFor } from './config';

const STOPWORDS = new Set(['AND', 'WITH', 'FOR', 'THE', 'OF', 'TYPE', 'MAKE', 'MOUNT']);
/** Abbreviation equivalences recognised when scoring fuzzy overlap. */
const EQUIVALENCES: Record<string, string> = {
  BRG: 'BEARING',
  BRGS: 'BEARING',
  BEAR: 'BEARING',
  VLV: 'VALVE',
  MTR: 'MOTOR',
  MOT: 'MOTOR',
  PMP: 'PUMP',
  IND: 'INDUCTION',
  '3PH': 'THREE_PHASE',
  '1PH': 'SINGLE_PHASE',
  SS: 'STAINLESS_STEEL',
  MS: 'MILD_STEEL',
  CI: 'CAST_IRON',
};

/**
 * Pressure-class spellings collapse to one token so "CL300", "CL 300",
 * "CLASS 300" and "300#" all overlap in the fuzzy signal. Applied AFTER
 * token splitting, so only exact whole tokens (or an adjacent CL/CLASS +
 * number pair) are rewritten.
 */
function normalizeSpecTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    // Spaced form: "CL" / "CLASS" immediately followed by the rating.
    if (/^(CL|CLASS)$/.test(t) && next && /^\d{2,4}$/.test(next)) {
      out.push(`CLASS_${next}`);
      i++;
      continue;
    }
    // Glued forms: "CL300", "CLASS300", "300#".
    const glued = /^(?:(?:CL|CLASS)#?(\d{2,4})|(\d{2,4})#)$/.exec(t);
    out.push(glued ? `CLASS_${glued[1] ?? glued[2]}` : t);
  }
  return out;
}

/**
 * Fuzzy tokenization of a raw description. Exported so the run-scoped
 * runtime cache (matching/runtime.ts) can precompute per-material tokens;
 * fuzzyScore and the cached path share this one implementation, so results
 * are arithmetically identical by construction.
 */
export function fuzzyTokens(description: string): string[] {
  return normalizeSpecTokens(
    description
      .toUpperCase()
      .replace(/[^A-Z0-9#]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
      .map((t) => EQUIVALENCES[t] ?? t)
  );
}

/** Dice coefficient over synonym-normalised token multisets. */
export function fuzzyScore(a: string, b: string): number {
  return diceFromTokens(fuzzyTokens(a), fuzzyTokens(b));
}

/**
 * Token Dice similarity (0–100) from pre-tokenized inputs. The single
 * arithmetic kernel shared by fuzzyScore (per-pair tokenization) and the
 * cached scoring path (run-scoped token reuse).
 */
export function diceFromTokens(ta: string[], tb: string[]): number {
  if (ta.length === 0 || tb.length === 0) return 0;
  const setB = new Set(tb);
  let shared = 0;
  const seen = new Set<string>();
  for (const t of ta) {
    if (!seen.has(t) && setB.has(t)) shared++;
    seen.add(t);
  }
  return Math.round((2 * shared * 100) / (ta.length + tb.length));
}

/**
 * Allocation-free Dice over PRE-UNIQUED token sets (Step 6).
 *
 * EXACTLY equivalent to diceFromTokens(ta, tb) when `ua`/`ub` are the unique
 * token sets of `ta`/`tb` and `sizeA`/`sizeB` are their ORIGINAL array
 * lengths: diceFromTokens counts each DISTINCT token of ta at most once
 * (the `seen` set) and membership in tb ignores multiplicity (setB), so its
 * shared count is precisely |unique(ta) ∩ unique(tb)|, and its denominator
 * is ta.length + tb.length — passed here as sizeA + sizeB. The two Sets the
 * old kernel allocated per pair are now built once per material per run.
 */
export function diceFromUniqueTokens(
  ua: ReadonlySet<string>,
  ub: ReadonlySet<string>,
  sizeA: number,
  sizeB: number
): number {
  if (sizeA === 0 || sizeB === 0) return 0;
  let shared = 0;
  for (const t of ua) if (ub.has(t)) shared++;
  return Math.round((2 * shared * 100) / (sizeA + sizeB));
}

function toNumber(v: string): number | null {
  const n = parseFloat(v.replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** One attribute fact with its pair-independent comparison facts precomputed. */
export interface PreparedAttribute {
  /** The stored fact (raw values preserved verbatim in every comparison row). */
  readonly fact: MaterialAttributeLite;
  /** canonicalValue(normalizedValue ?? value) — was recomputed per pair. */
  readonly canon: string;
  /** canonicalFact(name, canon) — value-vocabulary collapse, was per pair. */
  readonly factCanon: string;
  /** toNumber(canon) — parsed once; the pair rule still gates its use. */
  readonly num: number | null;
}

/** Build the prepared comparison facts for one attribute (run-scoped, Step 6). */
export function prepareAttribute(name: string, fact: MaterialAttributeLite): PreparedAttribute {
  const canon = canonicalValue(fact.normalizedValue ?? fact.value);
  return { fact, canon, factCanon: canonicalFact(name, canon), num: toNumber(canon) };
}

/**
 * Canonical fact forms for attribute values where two vocabularies express
 * the same fact — rule-extracted wording vs supplier/import wording
 * ("DEEP GROOVE BALL" vs "Deep Groove"; "150#" vs "Class 150"). Stored
 * values are never rewritten; this only decides whether two stored values
 * denote the same fact. "150" and "300" still never collapse.
 */
const ATTRIBUTE_VALUE_CANON: Record<string, Array<[RegExp, string]>> = {
  bearing_type: [
    [/^DEEP\s*GROOVE(\s*BALL)?$/, 'DEEP_GROOVE_BALL'],
    [/^TAPER(\s*ROLLER)?(\s*BEARING)?$/, 'TAPER_ROLLER'],
    [/^CYLINDRICAL(\s*ROLLER)?$/, 'CYLINDRICAL_ROLLER'],
    [/^SPHERICAL(\s*ROLLER)?$/, 'SPHERICAL_ROLLER'],
  ],
  pressure_class: [
    [/^(\d+)\s*#$/, 'CLASS_$1'],
    [/^CLASS\s*(\d+)$/, 'CLASS_$1'],
  ],
};

/**
 * Nominal-designation attributes: their numbers are identifiers, not
 * measurements. A bearing series 6205 vs 6310 differs by only ~1.7% — inside
 * the generic numeric tolerance — yet they are different products with
 * different dimensions. Such attributes must be equal or conflicting, never
 * "close". The set is DERIVED from the category-aware registry in config
 * (ATTRIBUTE_STRATEGIES) — see nominalAttributesFor.
 */

function canonicalFact(name: string, norm: string): string {
  for (const [re, to] of ATTRIBUTE_VALUE_CANON[name] ?? []) {
    if (re.test(norm)) return norm.replace(re, to);
  }
  return norm;
}

/**
 * Compare one attribute across two materials and type the result.
 * Missing information is MISSING — never treated as agreement.
 */
export function compareAttribute(
  name: string,
  a: MaterialAttributeLite | undefined,
  b: MaterialAttributeLite | undefined,
  critical: boolean,
  category?: string
): AttributeComparison | null {
  const nominal = category ? nominalAttributesFor(category).has(name) : false;
  if (!a && !b) return null;
  if (!a || !b) {
    return {
      attributeName: name,
      type: 'MISSING',
      valueA: a?.value ?? null,
      valueB: b?.value ?? null,
      critical,
      detail: critical ? 'present on one record only — cannot confirm equality' : 'present on one record only',
    };
  }

  const rawA = a.value;
  const rawB = b.value;
  const na = canonicalValue(a.normalizedValue ?? a.value);
  const nb = canonicalValue(b.normalizedValue ?? b.value);

  if (rawA === rawB) {
    return { attributeName: name, type: 'EXACT_MATCH', valueA: rawA, valueB: rawB, critical, detail: 'identical stored values' };
  }
  if (na === nb) {
    return { attributeName: name, type: 'NORMALIZED_MATCH', valueA: rawA, valueB: rawB, critical, detail: 'equal after normalization' };
  }
  const fa = canonicalFact(name, na);
  const fb = canonicalFact(name, nb);
  if (fa === fb) {
    return {
      attributeName: name,
      type: 'NORMALIZED_MATCH',
      valueA: rawA,
      valueB: rawB,
      critical,
      detail: 'same fact after value canonicalization (stored values preserved)',
    };
  }

  // Numeric closeness (unit-consistent): CLOSE_MATCH within tolerance.
  // Nominal designations (per the category-aware registry) are exempt —
  // their numbers identify a product variant, so any numeric difference is
  // a CONFLICT, not a "close" match.
  const numA = !nominal && a.unit === b.unit ? toNumber(na) : null;
  const numB = !nominal && a.unit === b.unit ? toNumber(nb) : null;
  if (numA !== null && numB !== null) {
    const base = Math.max(Math.abs(numA), Math.abs(numB));
    const tolerance = base > 0 ? Math.abs(numA - numB) / base : 0;
    if (tolerance <= 0.02) {
      return {
        attributeName: name,
        type: 'CLOSE_MATCH',
        valueA: rawA,
        valueB: rawB,
        critical,
        detail: `values within ${Math.round(tolerance * 10000) / 100}% (numeric tolerance)`,
      };
    }
    return {
      attributeName: name,
      type: 'CONFLICT',
      valueA: rawA,
      valueB: rawB,
      critical,
      detail: `numeric values differ beyond tolerance (${Math.round(tolerance * 10000) / 100}%)`,
    };
  }

  return {
    attributeName: name,
    type: 'CONFLICT',
    valueA: rawA,
    valueB: rawB,
    critical,
    detail: 'values differ',
  };
}

export interface TechnicalComparisonResult {
  score: number;
  comparisons: AttributeComparison[];
  criticalConflicts: string[];
  missingCritical: string[];
  /** Non-null when the two records differ in assembly/kit configuration. */
  assemblyComparison: AttributeComparison | null;
}
/**
 * Compare all structured attributes of two materials. Score = weighted
 * agreement: MATCH types count fully, CLOSE_MATCH at 0.5, MISSING/CONFLICT
 * at 0; missing critical attributes are reported separately and cap the
 * classification ceiling.
 */
type MaterialAttributeFact = MatchableMaterial['attributes'][number];

/**
 * Technical comparison of two materials. `indexA`/`indexB` are optional
 * per-material attributeName→attribute maps (from the run-scoped runtime
 * cache); when omitted, lookups fall back to the original list scan.
 * Attribute names are unique per material (UNIQUE(material_id, attribute_name)),
 * so both lookup strategies select the same fact.
 */
export function compareTechnical(
  a: MatchableMaterial,
  b: MatchableMaterial,
  indexA?: Map<string, MaterialAttributeFact>,
  indexB?: Map<string, MaterialAttributeFact>
): TechnicalComparisonResult {
  const criticals = criticalAttributesFor(a.category) ?? criticalAttributesFor(b.category);
  const names = new Set([...a.attributes.map((x) => x.attributeName), ...b.attributes.map((x) => x.attributeName)]);
  const comparisons: AttributeComparison[] = [];
  const criticalConflicts: string[] = [];
  const missingCritical: string[] = [];
  let weighted = 0;
  let total = 0;

  for (const name of names) {
    const av = indexA ? indexA.get(name) : a.attributes.find((x) => x.attributeName === name);
    const bv = indexB ? indexB.get(name) : b.attributes.find((x) => x.attributeName === name);
    const critical = criticals.has(name) || av?.isCritical === true || bv?.isCritical === true;
    // Category-aware strategy: e.g. valve pressure_class is a nominal class
    // designation while pump pressure_class is a measured bar rating.
    const cmp = compareAttribute(name, av, bv, critical, a.category || b.category);
    if (!cmp) continue;
    comparisons.push(cmp);
    const weight = critical ? 2 : 1;
    total += weight;
    if (cmp.type === 'EXACT_MATCH' || cmp.type === 'NORMALIZED_MATCH') weighted += weight;
    else if (cmp.type === 'CLOSE_MATCH') weighted += weight * 0.5;
    else if (cmp.type === 'MISSING' && critical) missingCritical.push(name);
    if (cmp.type === 'CONFLICT' && critical) {
      criticalConflicts.push(`${name}: ${cmp.valueA} vs ${cmp.valueB}`);
    }
  }

  // Assembly/kit awareness: a bare component vs the same component sold with
  // an extra part is a review-worthy configuration difference that attribute
  // extraction cannot see. It routes to human review (never auto-approve,
  // never NOT_A_MATCH) and is excluded from the score so wording alone cannot
  // drag a genuinely identical item below the auto-match floor.
  const assemblyComparison = compareAssemblySignals(detectAssembly(a.originalDescription), detectAssembly(b.originalDescription));
  if (assemblyComparison) comparisons.push(assemblyComparison);

  const score = total === 0 ? 0 : Math.round((weighted * 100) / total);
  comparisons.sort((x, y) => x.attributeName.localeCompare(y.attributeName));
  return { score, comparisons, criticalConflicts, missingCritical, assemblyComparison };
}

/**
 * Per-material side of the prepared technical comparison (Step 6).
 *
 * Structural view of the run-scoped MaterialRuntime (matching/runtime.ts):
 * everything here is a pure function of ONE material, built once per run.
 * Declared structurally so compare.ts does not depend on the runtime module.
 */
export interface PreparedMaterialSide {
  /** attributeName → stored fact (first occurrence; names are unique per material). */
  readonly attributeIndex: Map<string, MaterialAttributeFact>;
  /** Attribute names in stored order (= attributeIndex insertion order). */
  readonly attributeNames: readonly string[];
  /** attributeName → precomputed canonical facts (canon/factCanon/num). */
  readonly preparedAttributes: Map<string, PreparedAttribute>;
  /** detectAssembly(originalDescription) — was re-run per pair. */
  readonly assembly: AssemblySignal;
}

/**
 * Prepared variant of compareAttribute: identical decision tree and rows,
 * with the per-side canonicalization facts (canon / factCanon / num)
 * precomputed once per material instead of per pair.
 *
 * `nominal` is the memoized nominalAttributesFor set of the PAIR's category
 * (a.category || b.category, resolved by the caller exactly like the legacy
 * path) — or null when the category is empty, exactly like the legacy
 * `category ? … : false` guard.
 */
function compareAttributePrepared(
  name: string,
  pa: PreparedAttribute | undefined,
  pb: PreparedAttribute | undefined,
  critical: boolean,
  nominal: ReadonlySet<string> | null
): AttributeComparison | null {
  const isNominal = nominal ? nominal.has(name) : false;
  if (!pa && !pb) return null;
  if (!pa || !pb) {
    return {
      attributeName: name,
      type: 'MISSING',
      valueA: pa?.fact.value ?? null,
      valueB: pb?.fact.value ?? null,
      critical,
      detail: critical ? 'present on one record only — cannot confirm equality' : 'present on one record only',
    };
  }

  const a = pa.fact;
  const b = pb.fact;
  const rawA = a.value;
  const rawB = b.value;

  if (rawA === rawB) {
    return { attributeName: name, type: 'EXACT_MATCH', valueA: rawA, valueB: rawB, critical, detail: 'identical stored values' };
  }
  if (pa.canon === pb.canon) {
    return { attributeName: name, type: 'NORMALIZED_MATCH', valueA: rawA, valueB: rawB, critical, detail: 'equal after normalization' };
  }
  if (pa.factCanon === pb.factCanon) {
    return {
      attributeName: name,
      type: 'NORMALIZED_MATCH',
      valueA: rawA,
      valueB: rawB,
      critical,
      detail: 'same fact after value canonicalization (stored values preserved)',
    };
  }

  // Numeric closeness (unit-consistent): CLOSE_MATCH within tolerance.
  // Nominal designations are exempt — their numbers identify a product
  // variant, so any numeric difference is a CONFLICT, not a "close" match.
  const useNumeric = !isNominal && a.unit === b.unit;
  const numA = useNumeric ? pa.num : null;
  const numB = useNumeric ? pb.num : null;
  if (numA !== null && numB !== null) {
    const base = Math.max(Math.abs(numA), Math.abs(numB));
    const tolerance = base > 0 ? Math.abs(numA - numB) / base : 0;
    if (tolerance <= 0.02) {
      return {
        attributeName: name,
        type: 'CLOSE_MATCH',
        valueA: rawA,
        valueB: rawB,
        critical,
        detail: `values within ${Math.round(tolerance * 10000) / 100}% (numeric tolerance)`,
      };
    }
    return {
      attributeName: name,
      type: 'CONFLICT',
      valueA: rawA,
      valueB: rawB,
      critical,
      detail: `numeric values differ beyond tolerance (${Math.round(tolerance * 10000) / 100}%)`,
    };
  }

  return {
    attributeName: name,
    type: 'CONFLICT',
    valueA: rawA,
    valueB: rawB,
    critical,
    detail: 'values differ',
  };
}

/**
 * Prepared technical comparison (Step 6): byte-identical output to
 * `compareTechnical(a, b, indexA, indexB)` when sideA/sideB were prepared
 * from a and b, but with all per-pair re-derivation eliminated:
 *
 *   - attribute-name union: iterated from precomputed per-material lists
 *     (same sequence as the legacy Set insertion: A's names, then B's new
 *     names) instead of rebuilding two mapped arrays + a Set per pair;
 *   - attribute lookups: prepared maps (built from the same first-occurrence
 *     rule as the legacy runtime-cache attributeIndex);
 *   - value canonicalization / fact canonicalization / numeric parsing:
 *     computed once per attribute per run;
 *   - assembly detection: precomputed per material per run.
 *
 * The comparison rows, their order (union iteration + attributeName sort),
 * the weighted-score arithmetic order, missingCritical/criticalConflicts
 * strings, and the assembly row are all produced identically.
 */
export function compareTechnicalPrepared(
  a: MatchableMaterial,
  b: MatchableMaterial,
  sideA: PreparedMaterialSide,
  sideB: PreparedMaterialSide
): TechnicalComparisonResult {
  const criticals = criticalAttributesFor(a.category) ?? criticalAttributesFor(b.category);
  const category = a.category || b.category;
  const nominal = category ? nominalAttributesFor(category) : null;
  const comparisons: AttributeComparison[] = [];
  const criticalConflicts: string[] = [];
  const missingCritical: string[] = [];
  let weighted = 0;
  let total = 0;

  const emit = (name: string): void => {
    const pa = sideA.preparedAttributes.get(name);
    const pb = sideB.preparedAttributes.get(name);
    const critical = criticals.has(name) || pa?.fact.isCritical === true || pb?.fact.isCritical === true;
    const cmp = compareAttributePrepared(name, pa, pb, critical, nominal);
    if (!cmp) return;
    comparisons.push(cmp);
    const weight = critical ? 2 : 1;
    total += weight;
    if (cmp.type === 'EXACT_MATCH' || cmp.type === 'NORMALIZED_MATCH') weighted += weight;
    else if (cmp.type === 'CLOSE_MATCH') weighted += weight * 0.5;
    else if (cmp.type === 'MISSING' && critical) missingCritical.push(name);
    if (cmp.type === 'CONFLICT' && critical) {
      criticalConflicts.push(`${name}: ${cmp.valueA} vs ${cmp.valueB}`);
    }
  };

  // Same union sequence as the legacy names-Set insertion order.
  for (const name of sideA.attributeNames) emit(name);
  for (const name of sideB.attributeNames) if (!sideA.attributeIndex.has(name)) emit(name);

  const assemblyComparison = compareAssemblySignals(sideA.assembly, sideB.assembly);
  if (assemblyComparison) comparisons.push(assemblyComparison);

  const score = total === 0 ? 0 : Math.round((weighted * 100) / total);
  comparisons.sort((x, y) => x.attributeName.localeCompare(y.attributeName));
  return { score, comparisons, criticalConflicts, missingCritical, assemblyComparison };
}
