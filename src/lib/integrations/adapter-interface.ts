/**
 * Step 22 — Source adapter abstraction.
 *
 * An adapter is a DETERMINISTIC, DECLARED translation profile for one CPSE's
 * material-master feed: source header → canonical field, plus source-syntax
 * normalization (abbreviations, unit spellings). It contains no guessing and
 * no AI: every mapping is declared and inspectable, and every row validated
 * BEFORE the canonical row is handed to the existing Import Center. Semantic
 * harmonization (matching/CMI) happens later in the existing engines.
 */
import type {
  CanonicalMaterialRow,
  CpseCode,
  SourceFormat,
} from './canonical-contract';
import { CPSE_CODES } from './canonical-contract';

/* ------------------------------ diagnostics -------------------------------- */

/** Structured row-level diagnostic ({row, field, code, message}) — §9. */
export interface AdapterDiagnostic {
  row: number; // 1-based data-row number in the source file
  field: string; // source field name (or the canonical field when unmapped)
  code: 'REQUIRED_FIELD' | 'INVALID_VALUE' | 'CONFLICT' | 'MAPPING_ERROR';
  message: string;
  severity: 'ERROR' | 'WARNING';
}

/** Adapter-declared source vocabulary → canonical vocabulary normalization. */
export interface SourceVocabulary {
  /** Category abbreviations: 'BRG' → 'Bearings' etc. */
  categories?: Record<string, string>;
  /** UOM spellings: 'MTRS' → 'MTR' etc. */
  uoms?: Record<string, string>;
}

/**
 * Declared field mapping. Keys are canonical fields; values are the EXACT
 * source headers this adapter reads. A header not in the map is unknown to
 * the adapter — its values are RETAINED in sourceMetadata, never dropped.
 */
export interface AdapterFieldMap {
  materialCode: string;
  description: string;
  category?: string;
  subcategory?: string;
  manufacturer?: string;
  partNumber?: string;
  material?: string;
  uom?: string;
}

/** The declared, inspectable contract of one CPSE source system. */
export interface CpseSourceAdapter {
  /** Registry id (stable): CPCL | NTPC | BHEL | NLC | SAIL. */
  readonly id: string;
  /** Owning CPSE (narrowed to the known codes). */
  readonly cpse: (typeof CPSE_CODES)[number];
  /** Human label. */
  readonly label: string;
  /** Ingestion contract version: CPCL-MATERIAL-v1, NTPC-MATERIAL-v1, … */
  readonly version: string;
  /** Prototype source formats this adapter accepts. */
  readonly supportedFormats: readonly SourceFormat[];
  /** Declared source field → canonical field mapping (§8). */
  readonly fieldMap: AdapterFieldMap;
  /** Declared source vocabulary normalization (BRG → Bearings, …). */
  readonly vocabulary: SourceVocabulary;
  /** Demo feed file (clearly labelled synthetic) for this profile. */
  readonly sampleFile: string;
  /** Short description of the (synthetic) source system. */
  readonly description: string;

  /**
   * Validate one row of raw source values and produce a canonical row.
   * Deterministic; throws nothing — diagnostics are returned, never thrown,
   * so one bad row never aborts the feed. `cpse` always comes from THIS
   * adapter (fail-closed CPSE identity), never from the payload.
   */
  validateAndTransform(values: Record<string, string>, rowNumber: number): {
    canonical: CanonicalMaterialRow | null;
    diagnostics: AdapterDiagnostic[];
  };
}

/* ------------------------------ shared helpers ------------------------------ */

/**
 * Value-conflict detector (§17): flags a row whose description references a
 * DIFFERENT material code with the SAME alpha prefix as its own code (e.g.
 * code CP-1001 whose description carries "CP-9999" — a likely copy-paste
 * error). Deliberately narrow: other-prefix codes inside a description
 * (cross-references, competitor mentions) are NOT conflicts, and a code
 * appearing in its own description is fine.
 */
export function codeConflictsWithDescription(code: string, description: string): boolean {
  const c = code.trim().toUpperCase();
  const d = description.trim().toUpperCase();
  if (!c || !d) return false;
  const ownPrefix = (c.match(/^[A-Z]+/) ?? [''])[0];
  if (!ownPrefix || !/\d/.test(c)) return false;
  // Real material numbers are multi-digit; requiring 3+ digits avoids false
  // positives on compact engineering tokens ("CP-2X1.5" pump sizes etc.).
  const re = new RegExp(`${ownPrefix}\\s?-?\\s?(\\d{3,})`, 'g');
  const ownDigits = (c.match(/\d+/g) ?? []).join('');
  for (const match of d.matchAll(re)) {
    if (match[1] !== ownDigits) return true;
  }
  return false;
}

/** Normalize a cell per the adapter's declared vocabulary (case-insensitive). */
export function normalizeVocabularyValue(
  vocab: Record<string, string> | undefined,
  raw: string | null | undefined,
): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (!vocab) return value;
  return vocab[value.toUpperCase()] ?? value;
}

/**
 * Build a canonical row from mapped source values. Shared by every adapter
 * so identity, traceability and metadata-retention behave identically.
 * `unknownHeaders` are the source headers NOT in the field map — their cells
 * are retained in sourceMetadata (nothing silently discarded, §8).
 */
export function buildCanonicalRow(
  adapter: Pick<CpseSourceAdapter, 'id' | 'cpse' | 'fieldMap'>,
  values: Record<string, string>,
  mapped: {
    materialCode: string;
    description: string;
    category: string | null;
    subcategory: string | null;
    manufacturer: string | null;
    partNumber: string | null;
    material: string | null;
    uom: string | null;
  },
  rowNumber: number,
): CanonicalMaterialRow {
  const mappedHeaders = new Set(Object.values(adapter.fieldMap));
  const sourceMetadata: Record<string, string> = {};
  for (const [header, cell] of Object.entries(values)) {
    if (!mappedHeaders.has(header) && (cell ?? '').trim() !== '') sourceMetadata[header] = cell;
  }
  return {
    cpse: adapter.cpse,
    sourceSystem: adapter.id,
    sourceRecordId: mapped.materialCode,
    materialCode: mapped.materialCode,
    description: mapped.description,
    category: mapped.category,
    subcategory: mapped.subcategory,
    manufacturer: mapped.manufacturer,
    partNumber: mapped.partNumber,
    material: mapped.material,
    uom: mapped.uom,
    sourceDescription: (values[adapter.fieldMap.description] ?? '').trim(),
    sourceMetadata,
    sourceRowNumber: rowNumber,
  };
}

/** All CPSE codes as a runtime-checked set (fail-closed identity checks). */
export function isKnownCpse(code: string): code is CpseCode {
  return (CPSE_CODES as readonly string[]).includes(code);
}
