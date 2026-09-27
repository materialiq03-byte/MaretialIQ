/**
 * Description normalization — deterministic, token-based.
 *
 * Safety rule: abbreviations are expanded ONLY on exact whole-token matches
 * after splitting on non-alphanumerics. Model/designation tokens that contain
 * digits or are not in the map ("6205-2RS", "M20X80", "8X6-11", "1LE1501")
 * pass through untouched, so technical meaning cannot be changed.
 *
 * The original description is NEVER modified — callers store the output of
 * normalizeDescription() alongside the untouched original.
 */

/** Word expansions applied to whole tokens only. */
export const ABBREVIATIONS: Record<string, string> = {
  // Equipment nouns
  BRG: 'BEARING',
  BRGS: 'BEARINGS',
  BEAR: 'BEARING',
  VLV: 'VALVE',
  VLVS: 'VALVES',
  MTR: 'MOTOR',
  MOT: 'MOTOR',
  PMP: 'PUMP',
  PMPS: 'PUMPS',
  CENT: 'CENTRIFUGAL',
  IND: 'INDUCTION',
  BLK: 'BLOCK',
  // Phase
  '1PH': 'SINGLE_PHASE',
  '3PH': 'THREE_PHASE',
  // Materials
  SS: 'STAINLESS_STEEL',
  MS: 'MILD_STEEL',
  CI: 'CAST_IRON',
};

/**
 * Unit tokens are canonicalised but never converted (no V↔kV, no mm↔inch).
 * Values keep their original magnitude; only spelling collapses.
 */
export const UNIT_TOKENS: Record<string, string> = {
  VOLT: 'V',
  VOLTS: 'V',
  WATT: 'W',
  WATTS: 'W',
  KILOWATT: 'KW',
  KILOWATTS: 'KW',
  HERTZ: 'HZ',
  HZ: 'HZ',
  AMP: 'A',
  AMPS: 'A',
  AMPERE: 'A',
  AMPERES: 'A',
  MILLIMETRE: 'MM',
  MILLIMETRES: 'MM',
  MILLIMETER: 'MM',
  MILLIMETERS: 'MM',
  MM: 'MM',
  CM: 'CM',
  INCH: 'IN',
  INCHES: 'IN',
  IN: 'IN',
  BAR: 'BAR',
  PSI: 'PSI',
  RPM: 'RPM',
  KW: 'KW',
  KVA: 'KVA',
  HP: 'HP',
  W: 'W',
  V: 'V',
  A: 'A',
};

const UNIT_ATTACHMENT =
  /(\d)(VOLTS?|KILOWATTS?|WATTS?|HERTZ|AMPERES?|AMPS?|MILLIMETRES?|MILLIMETERS?|INCHES?|HZ|KW|KVA|HP|MM|CM|BAR|PSI|RPM|W|V|A|IN)\b/g;

/**
 * Split glued unit suffixes from numbers: "75KW" → "75 KW", "415V" → "415 V",
 * "6IN" → "6 IN". "6205", "M20X80", "8X6-11", "IP55" are unaffected.
 */
export function attachUnits(text: string): string {
  return text.replace(UNIT_ATTACHMENT, '$1 $2');
}

/** Split a description into cleaned tokens with abbreviation/unit expansion. */
export function normalizeTokens(text: string): string[] {
  return normalizeDescription(text).split(/\s+/).filter(Boolean);
}

/**
 * Full normalization: uppercase, glued-unit splitting, whitespace/punctuation
 * collapse (keeping `#` for pressure classes like 600#) and safe abbreviation
 * expansion. Compact engineering codes — digit/X/hyphen joins such as
 * "M20X80", "8X6-11", "6205-2RS", "A2-70" — are protected and never split.
 * Pure — the input is never mutated.
 */
export function normalizeDescription(text: string): string {
  const upper = attachUnits(text.toUpperCase());
  // Protect separators inside compact codes: substitute digit[- or X]digit
  // separators with sentinel characters that survive the punctuation strip,
  // then restore them afterwards. "6205-2RS" and "8X6-11" stay whole.
  const protectedText = upper
    .replace(/(?<=\d)-(?=\d)/g, '\u0001')
    .replace(/(?<=\d)X(?=\d)/g, '\u0002');
  const spaced = protectedText.replace(/[^A-Z0-9#\u0001\u0002]+/g, ' ').trim();
  if (!spaced) return '';
  return spaced
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      const restored = t.replace(/\u0001/g, '-').replace(/\u0002/g, 'X');
      return UNIT_TOKENS[restored] ?? ABBREVIATIONS[restored] ?? restored;
    })
    .join(' ');
}

/** Canonical comparison form of a stored attribute value (case/whitespace). */
export function canonicalValue(value: string): string {
  return value.toUpperCase().replace(/\s+/g, ' ').trim();
}
