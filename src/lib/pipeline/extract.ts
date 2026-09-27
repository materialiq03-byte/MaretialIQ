/**
 * Deterministic technical attribute extraction.
 *
 * Every rule reads the normalized token list (order preserved — token
 * sequences like "75 KW 415 V" carry the meaning). Rules never fabricate:
 * when a fact is absent the attribute is simply not emitted. Missing values
 * are represented by absence plus the data-quality checker, never by dummy
 * strings.
 */
import { parseQuantity, canonicalUnit } from './units';
import { canonicalValue } from './normalize';
import type { ExtractionMethod } from '../types/domain';

export interface ExtractedAttribute {
  attributeName: string;
  /** Text as found in the description context, e.g. "75 KW". */
  value: string;
  normalizedValue: string | null;
  unit: string | null;
  isCritical: boolean;
  extractionMethod: ExtractionMethod;
  /** Null unless a rule has a genuinely derived basis for it. */
  confidence: number | null;
}

const RULE: ExtractionMethod = 'rule';

function attr(
  attributeName: string,
  value: string,
  opts: {
    normalizedValue?: string | null;
    unit?: string | null;
    isCritical?: boolean;
  } = {}
): ExtractedAttribute {
  return {
    attributeName,
    value,
    normalizedValue: opts.normalizedValue ?? canonicalValue(value),
    unit: opts.unit ?? null,
    isCritical: opts.isCritical ?? false,
    extractionMethod: RULE,
    confidence: null,
  };
}

/** Manufacturers recognised in descriptions (whole-token match). */
export const KNOWN_MANUFACTURERS = new Set([
  'SKF', 'FAG', 'NSK', 'NTN', 'TIMKEN', 'NACHI', 'SKF-INDIA',
  'SIEMENS', 'ABB', 'WEG', 'CG', 'CROMPTON',
  'KSB', 'GRUNDFOS', 'KIRLOSKAR', 'CRI',
  'AUDCO', 'LNT', 'LT', 'AVEVA',
]);

/* ------------------------------- helpers --------------------------------- */

function isNumber(token: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(token);
}

function unitAt(tokens: string[], i: number): string | null {
  if (i + 1 >= tokens.length) return null;
  return canonicalUnit(tokens[i + 1]);
}

/** Find "number unit" pairs ("75 KW", "415 V", "6 IN"). */
function quantityPairs(tokens: string[]): Array<{ index: number; value: string; unit: string }> {
  const out: Array<{ index: number; value: string; unit: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isNumber(tokens[i])) continue;
    const unit = unitAt(tokens, i);
    if (unit) out.push({ index: i, value: tokens[i], unit });
  }
  return out;
}

function first(tokens: string[], test: (t: string) => boolean): { token: string; index: number } | null {
  for (let i = 0; i < tokens.length; i++) {
    if (test(tokens[i])) return { token: tokens[i], index: i };
  }
  return null;
}

/* ------------------------------- bearings -------------------------------- */

/** Seal/shield suffix codes (whole token after separator split). */
export const SEAL_CODES = new Set(['2RS', '2RS1', '2RSH', 'RS', 'RZ', '2RZ', 'ZZ', '2Z', 'Z', 'LLU', 'LLB', 'DD']);

/** ISO 15 bore convention for 6xxx series: 00→10, 01→12, 02→15, 03→17, else last-two×5. */
const BORE_SPECIAL: Record<string, number> = { '00': 10, '01': 12, '02': 15, '03': 17 };

function extractBearing(tokens: string[]): ExtractedAttribute[] {
  const out: ExtractedAttribute[] = [];

  const maker = first(tokens, (t) => KNOWN_MANUFACTURERS.has(t));
  if (maker) out.push(attr('manufacturer', maker.token));

  if (tokens.includes('DEEP') && tokens.includes('GROOVE')) {
    out.push(attr('bearing_type', 'DEEP GROOVE BALL', { normalizedValue: 'DEEP_GROOVE_BALL' }));
  } else if (tokens.includes('TAPER')) {
    out.push(attr('bearing_type', 'TAPER ROLLER', { normalizedValue: 'TAPER_ROLLER' }));
  } else if (tokens.includes('CYLINDRICAL')) {
    out.push(attr('bearing_type', 'CYLINDRICAL ROLLER', { normalizedValue: 'CYLINDRICAL_ROLLER' }));
  } else if (tokens.includes('SPHERICAL')) {
    out.push(attr('bearing_type', 'SPHERICAL ROLLER', { normalizedValue: 'SPHERICAL_ROLLER' }));
  } else if (tokens.includes('BALL')) {
    // Bare "BALL" on a 6xxx series description: the 6xxxx family IS deep
    // groove, so canonicalise to the same value the explicit wording yields.
    // Prevents a false bearing_type disagreement between
    // "SKF BALL BEARING 6205-2RS" and "SKF DEEP GROOVE BRG 6205 2RS".
    const isDeepGrooveSeries = tokens.some((t) => /^6\d{3}(-|$)/.test(t));
    out.push(
      isDeepGrooveSeries
        ? attr('bearing_type', 'DEEP GROOVE BALL', { normalizedValue: 'DEEP_GROOVE_BALL' })
        : attr('bearing_type', 'BALL', { normalizedValue: 'BALL' })
    );
  }

  // Series: 4-digit 6xxx designation — standalone ("6205") or compound
  // ("6205-2RS", "6205-ZZ", "6205 2RS"), where the suffix carries the seal code.
  const series = first(tokens, (t) => /^6\d{3}$/.test(t) || /^6\d{3}-.+$/.test(t));
  if (series) {
    const m = /^(6\d{3})(?:-(.+))?$/.exec(series.token);
    if (m) {
      out.push(attr('series', m[1]));
      const suffix = m[1].slice(2);
      const bore = BORE_SPECIAL[suffix] ?? (Number(suffix) >= 4 ? Number(suffix) * 5 : null);
      if (bore !== null) {
        out.push(attr('bore_diameter', String(bore), { unit: 'MM', isCritical: true }));
      }
      if (m[2] && SEAL_CODES.has(m[2])) {
        out.push(attr('seal_type', m[2], { isCritical: true }));
      }
    }
  }

  // Standalone seal token ("6205 2RS" spacing style).
  const seal = first(tokens, (t) => SEAL_CODES.has(t));
  if (seal && !out.some((a) => a.attributeName === 'seal_type')) {
    out.push(attr('seal_type', seal.token, { isCritical: true }));
  }

  // A 6xxx-series designation is by definition a deep groove ball bearing;
  // when no explicit type wording exists ("SKF BEARING 6205-ZZ"), derive it
  // so equal records compare equal instead of one side missing the attribute.
  if (!out.some((a) => a.attributeName === 'bearing_type') && tokens.some((t) => /^6\d{3}(-|$)/.test(t))) {
    out.push(attr('bearing_type', 'DEEP GROOVE BALL', { normalizedValue: 'DEEP_GROOVE_BALL' }));
  }

  const clearance = first(tokens, (t) => /^C[0-5]$/.test(t));
  if (clearance) out.push(attr('internal_clearance', clearance.token));

  return out;
}

/* -------------------------------- motors --------------------------------- */

function extractMotor(tokens: string[]): ExtractedAttribute[] {
  const out: ExtractedAttribute[] = [];

  const maker = first(tokens, (t) => KNOWN_MANUFACTURERS.has(t));
  if (maker) out.push(attr('manufacturer', maker.token));

  if (tokens.includes('THREE_PHASE')) out.push(attr('phase', '3', { normalizedValue: 'THREE' }));
  else if (tokens.includes('SINGLE_PHASE')) out.push(attr('phase', '1', { normalizedValue: 'SINGLE' }));

  if (tokens.includes('INDUCTION')) {
    out.push(attr('motor_type', 'INDUCTION', { normalizedValue: 'INDUCTION' }));
  } else if (tokens.includes('SYNCHRONOUS')) {
    out.push(attr('motor_type', 'SYNCHRONOUS', { normalizedValue: 'SYNCHRONOUS' }));
  }

  for (const q of quantityPairs(tokens)) {
    if (q.unit === 'KW' || q.unit === 'HP' || q.unit === 'W') {
      out.push(attr('power_rating', `${q.value} ${q.unit}`, { normalizedValue: q.value, unit: q.unit, isCritical: true }));
    } else if (q.unit === 'V') {
      out.push(attr('voltage_rating', `${q.value} ${q.unit}`, { normalizedValue: q.value, unit: q.unit, isCritical: true }));
    } else if (q.unit === 'HZ') {
      out.push(attr('frequency', `${q.value} ${q.unit}`, { normalizedValue: q.value, unit: q.unit }));
    } else if (q.unit === 'A') {
      out.push(attr('current_rating', `${q.value} ${q.unit}`, { normalizedValue: q.value, unit: q.unit }));
    } else if (q.unit === 'RPM') {
      out.push(attr('speed', `${q.value} ${q.unit}`, { normalizedValue: q.value, unit: q.unit }));
    }
  }

  // Mounting arrangement codes: B3, B35, B5, V1…
  const mounting = first(tokens, (t) => /^B\d{1,2}$|^V\d$/.test(t));
  if (mounting) out.push(attr('mounting', mounting.token));

  // Ingress protection: IP55, IP54B…
  const ip = first(tokens, (t) => /^IP\d{2}[A-Z]?$/.test(t));
  if (ip) out.push(attr('protection_rating', ip.token));

  return out;
}

/* --------------------------------- pumps --------------------------------- */

function extractPump(tokens: string[]): ExtractedAttribute[] {
  const out: ExtractedAttribute[] = [];

  const maker = first(tokens, (t) => KNOWN_MANUFACTURERS.has(t));
  if (maker) out.push(attr('manufacturer', maker.token));

  if (tokens.includes('CENTRIFUGAL')) {
    out.push(attr('pump_type', 'CENTRIFUGAL', { normalizedValue: 'CENTRIFUGAL' }));
  } else if (tokens.includes('SUBMERSIBLE')) {
    out.push(attr('pump_type', 'SUBMERSIBLE', { normalizedValue: 'SUBMERSIBLE' }));
  } else if (tokens.includes('MONOBLOCK')) {
    out.push(attr('pump_type', 'MONOBLOCK', { normalizedValue: 'MONOBLOCK' }));
  }

  // Size designation NNXNN-NN (suction x discharge - stages), e.g. 8X6-11.
  const size = first(tokens, (t) => /^\d{1,2}X\d{1,2}(?:-\d{1,3})?$/.test(t));
  if (size) {
    const m = /^(\d{1,2})X(\d{1,2})(?:-(\d{1,3}))?$/.exec(size.token);
    if (m) {
      out.push(attr('suction_size', `${m[1]} IN`, { normalizedValue: m[1], unit: 'IN', isCritical: true }));
      out.push(attr('discharge_size', `${m[2]} IN`, { normalizedValue: m[2], unit: 'IN', isCritical: true }));
      if (m[3]) out.push(attr('stage_count', m[3]));
    }
  }

  for (const q of quantityPairs(tokens)) {
    if (q.unit === 'BAR' || q.unit === 'PSI') {
      out.push(attr('pressure_rating', `${q.value} ${q.unit}`, { normalizedValue: q.value, unit: q.unit, isCritical: true }));
    } else if (q.unit === 'KW' || q.unit === 'HP') {
      out.push(attr('power_rating', `${q.value} ${q.unit}`, { normalizedValue: q.value, unit: q.unit, isCritical: true }));
    }
  }

  if (tokens.includes('CAST') && tokens.includes('IRON')) {
    out.push(attr('casing_material', 'CAST IRON', { normalizedValue: 'CAST_IRON' }));
  } else if (tokens.includes('STAINLESS') && tokens.includes('STEEL')) {
    out.push(attr('casing_material', 'STAINLESS STEEL', { normalizedValue: 'STAINLESS_STEEL' }));
  }

  return out;
}

/* --------------------------------- valves -------------------------------- */

const VALVE_TYPES: Array<[string, string]> = [
  ['GATE', 'GATE'],
  ['GLOBE', 'GLOBE'],
  ['BUTTERFLY', 'BUTTERFLY'],
  ['CHECK', 'CHECK'],
  ['PLUG', 'PLUG'],
  ['BALL', 'BALL'],
];

function extractValve(tokens: string[]): ExtractedAttribute[] {
  const out: ExtractedAttribute[] = [];

  const maker = first(tokens, (t) => KNOWN_MANUFACTURERS.has(t));
  if (maker) out.push(attr('manufacturer', maker.token));

  for (const [token, label] of VALVE_TYPES) {
    if (tokens.includes(token)) {
      out.push(attr('valve_type', label, { normalizedValue: label }));
      break;
    }
  }

  for (const q of quantityPairs(tokens)) {
    if (q.unit === 'IN' || q.unit === 'MM') {
      out.push(attr('nominal_size', `${q.value} ${q.unit}`, { normalizedValue: q.value, unit: q.unit, isCritical: true }));
      break;
    }
  }

  // Pressure class: 600#, PN16, ANSI600, CLASS300, 150LB.
  const pc = first(tokens, (t) => /^\d{2,4}#$/.test(t) || /^PN\d{1,3}$/.test(t) || /^ANSI\d{2,4}$/.test(t) || /^CLASS\d{2,4}$/.test(t));
  if (pc) out.push(attr('pressure_class', pc.token, { isCritical: true }));

  const conn = first(tokens, (t) => ['RTJ', 'RF', 'FF', 'SW', 'BUTT_WELD', 'THREADED', 'FLANGED', 'SCREWED'].includes(t));
  if (conn) out.push(attr('end_connection', conn.token, { normalizedValue: conn.token }));

  if (tokens.includes('CAST') && tokens.includes('IRON')) {
    out.push(attr('body_material', 'CAST IRON', { normalizedValue: 'CAST_IRON' }));
  } else if (tokens.includes('STAINLESS') && tokens.includes('STEEL')) {
    out.push(attr('body_material', 'STAINLESS STEEL', { normalizedValue: 'STAINLESS_STEEL' }));
  } else if (tokens.includes('WCB')) {
    out.push(attr('body_material', 'WCB', { normalizedValue: 'WCB' }));
  }

  return out;
}

/* ------------------------------- fasteners ------------------------------- */

function extractFastener(tokens: string[]): ExtractedAttribute[] {
  const out: ExtractedAttribute[] = [];

  const type = first(tokens, (t) => ['BOLT', 'NUT', 'SCREW', 'WASHER', 'STUD'].includes(t));
  if (type) {
    const label = tokens.includes('HEX') && type.token === 'BOLT' ? 'HEX_BOLT' : type.token;
    out.push(attr('fastener_type', label, { normalizedValue: label }));
  }

  // Thread designation: M20, M20X80, M16X2 (metric), or 1/2X4 kept as-is when single token.
  const thread = first(tokens, (t) => /^M\d{1,3}(?:X\d{1,3})?$/.test(t));
  if (thread) {
    const m = /^M(\d{1,3})(?:X(\d{1,3}))?$/.exec(thread.token);
    if (m) {
      out.push(attr('thread_specification', thread.token));
      out.push(attr('diameter', m[1], { unit: 'MM', isCritical: true }));
      if (m[2]) out.push(attr('length', m[2], { unit: 'MM', isCritical: true }));
    }
  }

  // Grades: SS304/SS316, A2-70, A4-80, 8.8, 10.9.
  const ss = first(tokens, (t) => /^SS(304|316)$/.test(t));
  if (ss) out.push(attr('material_grade', ss.token));
  const aGrade = first(tokens, (t) => /^A[24]-\d{2}$/.test(t));
  if (aGrade) out.push(attr('material_grade', aGrade.token));
  const prop = first(tokens, (t) => /^\d{1,2}\.\d$/.test(t));
  if (prop && !ss && !aGrade) out.push(attr('material_grade', prop.token));

  return out;
}

/* ------------------------------- dispatcher ------------------------------ */

const EXTRACTORS: Record<string, (tokens: string[]) => ExtractedAttribute[]> = {
  Bearings: extractBearing,
  Motors: extractMotor,
  Pumps: extractPump,
  Valves: extractValve,
  Fasteners: extractFastener,
};

/**
 * Extract attributes for a category from an already-normalized description.
 * Unknown categories yield no attributes (the quality checker reports that).
 */
export function extractAttributes(category: string | null, normalizedDescription: string): ExtractedAttribute[] {
  if (!category) return [];
  const extractor = EXTRACTORS[category];
  if (!extractor) return [];
  const tokens = normalizedDescription.split(/\s+/).filter(Boolean);
  const found = extractor(tokens);
  // De-duplicate by attribute name, keeping the first (leftmost) occurrence.
  const seen = new Set<string>();
  return found.filter((a) => (seen.has(a.attributeName) ? false : (seen.add(a.attributeName), true)));
}
