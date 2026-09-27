/**
 * Unit normalization for structured attribute values.
 *
 * Scope is deliberately narrow: canonicalise spelling ("VOLTS" → "V") and
 * parse value+unit pairs. NO conversions are performed (no inch→mm, no
 * W→kW) because silent conversions corrupt engineering data. Unknown units
 * are returned unchanged so the quality checker can flag them.
 */
import { UNIT_TOKENS } from './normalize';

/** All unit symbols the system recognises (after canonicalisation). */
export const KNOWN_UNITS = new Set(Object.values(UNIT_TOKENS));

const QUANTITY = /^(\d+(?:\.\d+)?)\s*([A-Z#]{1,6})?$/;

export interface ParsedQuantity {
  value: string;
  unit: string | null;
  raw: string;
}

/**
 * Parse a quantity string like "220 V", "220V", "220 volts", "75", "600#".
 * Returns null when the text is not a clean quantity (prose, ranges, models).
 */
export function parseQuantity(raw: string): ParsedQuantity | null {
  const cleaned = raw.toUpperCase().trim();
  const m = QUANTITY.exec(cleaned);
  if (!m) return null;
  const unit = m[2] ? canonicalUnit(m[2]) : null;
  return { value: m[1], unit, raw };
}

/** Canonical unit spelling, or null when the token is not a known unit. */
export function canonicalUnit(unit: string): string | null {
  const token = unit.toUpperCase().replace(/[^A-Z#]/g, '');
  if (!token) return null;
  return UNIT_TOKENS[token] ?? null;
}

/** True when the unit is part of the recognised set. */
export function isKnownUnit(unit: string): boolean {
  const canonical = canonicalUnit(unit);
  return canonical !== null && KNOWN_UNITS.has(canonical);
}
