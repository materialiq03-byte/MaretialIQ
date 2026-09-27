/**
 * Matching configuration: signal weights, classification thresholds and
 * per-category critical attributes. Every value is env-overridable; nothing
 * is hardcoded inside engine logic.
 *
 * Weights are PROTOTYPE values for the demo, not accuracy claims.
 */
import path from 'node:path';

function num(value: string | undefined, fallback: number): number {
  const n = value ? parseFloat(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Raw configured weights (may not sum to 1; engine normalises and records both). */
export const RAW_WEIGHTS = {
  semantic: num(process.env.MATCH_WEIGHT_SEMANTIC, 0.3),
  fuzzy: num(process.env.MATCH_WEIGHT_FUZZY, 0.2),
  technical: num(process.env.MATCH_WEIGHT_TECHNICAL, 0.3),
  category: num(process.env.MATCH_WEIGHT_CATEGORY, 0.2),
};

export const THRESHOLDS = {
  /** identical: attribute agreement and both text signals very high */
  identicalTechnical: num(process.env.MATCH_T_IDENTICAL_TECHNICAL, 90),
  identicalFuzzy: num(process.env.MATCH_T_IDENTICAL_FUZZY, 92),
  identicalSemantic: num(process.env.MATCH_T_IDENTICAL_SEMANTIC, 90),
  /** near duplicate / functional equivalent band */
  strongTechnical: num(process.env.MATCH_T_STRONG_TECHNICAL, 80),
  strongFuzzy: num(process.env.MATCH_T_STRONG_FUZZY, 55),
  strongSemantic: num(process.env.MATCH_T_STRONG_SEMANTIC, 70),
  /** moderate band: comparable but not confident */
  moderateTechnical: num(process.env.MATCH_T_MODERATE_TECHNICAL, 55),
  moderateFuzzy: num(process.env.MATCH_T_MODERATE_FUZZY, 40),
  /** retrieval */
  minCandidateSharedTokens: num(process.env.MATCH_MIN_SHARED_TOKENS, 1),
  /** numeric attribute closeness tolerance (relative) for CLOSE_MATCH */
  closeMatchRelativeTolerance: num(process.env.MATCH_CLOSE_TOLERANCE, 0.02),
};

/** Category-specific critical attributes — a conflict forces NEEDS_HUMAN_REVIEW. */
export const CRITICAL_RULES: Record<string, string[]> = {
  Bearings: ['series', 'seal_type', 'bearing_type', 'bore_diameter'],
  Motors: ['motor_type', 'power_rating', 'voltage_rating', 'frequency', 'phase', 'speed'],
  Pumps: ['pump_type', 'suction_size', 'discharge_size', 'power_rating', 'casing_material'],
  Valves: ['valve_type', 'nominal_size', 'pressure_class', 'body_material', 'end_connection'],
  Fasteners: ['fastener_type', 'thread_specification', 'diameter', 'length', 'material_grade'],
};

/**
 * How to compare an attribute value, beyond plain normalization.
 *
 *   nominal   — standardized designation/identifier. Numbers here name a
 *               product variant; they are NOT measurements. Equal (after
 *               value canonicalization) or CONFLICT, never "close".
 *               Examples: bearing series 6205 vs 6310 (1.7% apart numerically,
 *               different products), valve Class 150 vs Class 300, thread
 *               M16 vs M20.
 *   measured  — physical/electrical quantity. Numeric closeness within the
 *               configured tolerance earns partial credit (CLOSE_MATCH) and
 *               differences beyond tolerance conflict.
 *   enum      — enumerated vocabulary (equal after canonicalization or
 *               conflict; no numeric interpretation ever).
 *   text      — free text: normalized-string equality only.
 *
 * The registry is CATEGORY-AWARE because the same attribute name can carry
 * different value kinds per category: pump `pressure_class` stores a measured
 * rating ("10 bar"), while valve `pressure_class` stores a standardized class
 * designation ("150#" / "Class 300").
 */
export type AttributeStrategy = 'nominal' | 'measured' | 'enum' | 'text';

export const ATTRIBUTE_STRATEGIES: Record<string, Record<string, AttributeStrategy>> = {
  Bearings: {
    series: 'nominal',
    bearing_type: 'enum',
    seal_type: 'enum',
    internal_clearance: 'enum',
    bore_diameter: 'measured',
    size: 'text',
    material_type: 'enum',
    material_grade: 'enum',
    manufacturer: 'enum',
  },
  Valves: {
    valve_type: 'enum',
    nominal_size: 'nominal',
    pressure_class: 'nominal',
    body_material: 'enum',
    end_connection: 'enum',
    material_type: 'enum',
    material_grade: 'enum',
    size: 'text',
  },
  Motors: {
    motor_type: 'enum',
    phase: 'enum',
    mounting: 'enum',
    power_rating: 'measured',
    voltage_rating: 'measured',
    frequency: 'measured',
    speed: 'measured',
    material_type: 'enum',
    material_grade: 'enum',
    size: 'text',
  },
  Pumps: {
    pump_type: 'enum',
    suction_size: 'nominal',
    discharge_size: 'nominal',
    pressure_class: 'measured',
    power_rating: 'measured',
    stage_count: 'measured',
    casing_material: 'enum',
    material_type: 'enum',
    material_grade: 'enum',
    size: 'text',
  },
  Fasteners: {
    fastener_type: 'enum',
    thread_specification: 'nominal',
    diameter: 'measured',
    length: 'measured',
    material_grade: 'enum',
    material_type: 'enum',
    size: 'text',
  },
};

/** Strategy for an attribute within a category; 'measured' when unlisted. */
export function attributeStrategyFor(category: string, attributeName: string): AttributeStrategy {
  return ATTRIBUTE_STRATEGIES[category]?.[attributeName] ?? 'measured';
}

/**
 * Nominal designation attributes within a category (equal-or-conflict rule).
 *
 * Memoized: derived from the static module-level registry above (never from
 * run/tenant data), and scoring asks this per attribute per pair — a fresh
 * Set per call was a measured top cost of pair scoring (Step 6 profile).
 * Cached per category and frozen: every caller receives the SAME Set, so
 * mutation by one caller would be visible to all — but callers only read
 * (.has/.size/spread), verified across src/tests/scripts.
 */
const NOMINAL_CACHE = new Map<string, ReadonlySet<string>>();
export function nominalAttributesFor(category: string): ReadonlySet<string> {
  const cached = NOMINAL_CACHE.get(category);
  if (cached) return cached;
  const rules = ATTRIBUTE_STRATEGIES[category];
  const built: ReadonlySet<string> = Object.freeze(
    new Set(rules ? Object.entries(rules).filter(([, s]) => s === 'nominal').map(([a]) => a) : [])
  );
  NOMINAL_CACHE.set(category, built);
  return built;
}

/** Global overrides/additions from env (mirrors the pipeline critical list). */
const ENV_GLOBAL_CRITICALS = list(process.env.MATCH_CRITICAL_ATTRIBUTES);

/**
 * Critical attribute names for a category (category rules + env globals).
 * Memoized per category like nominalAttributesFor (static derivation, read-only
 * callers), for the same measured reason.
 */
const CRITICAL_CACHE = new Map<string, ReadonlySet<string>>();
export function criticalAttributesFor(category: string): ReadonlySet<string> {
  const cached = CRITICAL_CACHE.get(category);
  if (cached) return cached;
  const names = CRITICAL_RULES[category] ?? [];
  const built: ReadonlySet<string> = Object.freeze(new Set([...names, ...ENV_GLOBAL_CRITICALS]));
  CRITICAL_CACHE.set(category, built);
  return built;
}

/**
 * Normalised weights (sum to 1) used by the engine; raw values are recorded
 * in evidence. Memoized: pure arithmetic over module constants read once at
 * load, called per pair (3×) — the division results are identical every call.
 */
let NORMALIZED_WEIGHTS_CACHE: { semantic: number; fuzzy: number; technical: number; category: number } | null = null;
export function normalizedWeights(): { semantic: number; fuzzy: number; technical: number; category: number } {
  if (NORMALIZED_WEIGHTS_CACHE) return NORMALIZED_WEIGHTS_CACHE;
  const sum = RAW_WEIGHTS.semantic + RAW_WEIGHTS.fuzzy + RAW_WEIGHTS.technical + RAW_WEIGHTS.category;
  NORMALIZED_WEIGHTS_CACHE =
    sum <= 0
      ? { semantic: 0.25, fuzzy: 0.25, technical: 0.25, category: 0.25 }
      : {
          semantic: RAW_WEIGHTS.semantic / sum,
          fuzzy: RAW_WEIGHTS.fuzzy / sum,
          technical: RAW_WEIGHTS.technical / sum,
          category: RAW_WEIGHTS.category / sum,
        };
  return NORMALIZED_WEIGHTS_CACHE;
}

export const MATCHING_CONFIG_FILE = path.basename(__filename);
