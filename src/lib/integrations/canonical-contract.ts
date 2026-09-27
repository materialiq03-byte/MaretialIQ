/**
 * Step 22 — Canonical ingestion contract.
 *
 * ONE contract between heterogeneous CPSE source systems and MaterialIQ.
 * Source-specific adapters translate their feed INTO this contract; the
 * canonical rows then flow through the EXISTING Import Center (analyze →
 * async import job) — the canonical contract is an ingestion BOUNDARY, never
 * a replacement for the material master.
 *
 * The shape deliberately mirrors the Import Center's column mapping (the
 * fields the existing pipeline consumes) plus source identity metadata the
 * integration layer adds around it. Semantic fields the existing pipeline
 * extracts from descriptions (voltage, pressure class, seal type, …) are
 * deliberately NOT canonical inputs — the Import Center's technical-column
 * mapping carries them when a source provides them.
 */

/** The five synthetic demo CPSEs of this prototype (aligned with seed data). */
export const CPSE_CODES = ['CPCL', 'NTPC', 'BHEL', 'NLC', 'SAIL'] as const;
export type CpseCode = (typeof CPSE_CODES)[number];

/** Prototype source formats. CSV is implemented; XLSX rides the same engine. */
export const SOURCE_FORMATS = ['CSV', 'XLSX'] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

/** Stable machine-readable failure codes for the integration boundary. */
export const INTEGRATION_ERROR_CODES = [
  'SOURCE_ERROR',
  'VALIDATION_ERROR',
  'MAPPING_ERROR',
  'DUPLICATE_SOURCE_RECORD',
  'UNSUPPORTED_FORMAT',
  'ADAPTER_ERROR',
  'IMPORT_ERROR',
] as const;
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

/** One canonical material row — the output of a deterministic adapter transform. */
export interface CanonicalMaterialRow {
  /** Owning CPSE — always from the ADAPTER's identity, never guessed. */
  cpse: CpseCode;
  /** Which source system produced the row (adapter id, e.g. 'CPCL'). */
  sourceSystem: string;
  /** The source system's own record identifier (its material code). */
  sourceRecordId: string;
  /** Material master code to register (equals sourceRecordId in this design). */
  materialCode: string;
  description: string;
  category: string | null;
  subcategory: string | null;
  manufacturer: string | null;
  partNumber: string | null;
  /** Source-specific material/grade token (e.g. 'WCB', 'EN8'). */
  material: string | null;
  uom: string | null;
  /** Source raw text for description — preserved verbatim for traceability. */
  sourceDescription: string;
  /** Unknown source columns, retained (never silently discarded). */
  sourceMetadata: Record<string, string>;
  /** 1-based data-row number in the source file (diagnostics reference it). */
  sourceRowNumber: number;
}

/** Stable source identity of one record (§10): CPSE + sourceSystem + sourceRecordId. */
export function sourceIdentityOf(row: Pick<CanonicalMaterialRow, 'cpse' | 'sourceSystem' | 'sourceRecordId'>): string {
  return `${row.cpse}+${row.sourceSystem}+${row.sourceRecordId}`;
}

/** Deliberate non-fields, documented for §3 compliance (see docs). */
export const CANONICAL_CONTRACT_NOTES = {
  noCpseInferenceFromDescription: 'cpse comes only from the adapter profile — never inferred from data.',
  noIdentityFromDescription: 'source identity uses material code, never description or a generated UUID.',
  semanticFieldsExtractedLater: 'voltage/pressure/seal/etc. are extracted by the EXISTING pipeline, not the contract.',
} as const;
