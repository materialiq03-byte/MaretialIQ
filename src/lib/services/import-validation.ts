/**
 * Import validation — pure functions, no DB access.
 *
 * Severity contract:
 *   ERROR   → cannot safely import (missing required fields, duplicates,
 *             malformed values). Never enters the material master.
 *   WARNING → importable, but the user should review (unknown UOM, missing
 *             optional fields, format oddities).
 *   VALID   → no detected issue.
 *
 * Missing optional technical attributes are NEVER errors. Missing values are
 * never auto-invented: an invalid row is excluded, not "fixed".
 */
import { canonicalValue } from '../pipeline/normalize';


export type Severity = 'ERROR' | 'WARNING' | 'VALID';

export interface ImportColumnMapping {
  originalCode: string | null;
  originalDescription: string | null;
  category: string | null;
  subcategory: string | null;
  manufacturer: string | null;
  model: string | null;
  partNumber: string | null;
  uom: string | null;
  /** Per-row CPSE code column (e.g. "cpse_name" → CPCL/NTPC/…). When mapped,
   *  one uploaded file may carry several organizations; each row goes to the
   *  CPSE named in its own cell. The file-level org remains the default for
   *  rows whose CPSE cell is blank or unknown. */
  orgCode: string | null;
  /** Technical enrichment columns — never required, always preserved as
   *  import-sourced material_attributes when mapped. */
  size: string | null;
  materialType: string | null;
  voltage: string | null;
  pressureRating: string | null;
  power: string | null;
  temperatureRating: string | null;
  sealType: string | null;
  bearingType: string | null;
  grade: string | null;
}

/** Canonical target fields for the Import Center mapping UI. */
export const MAPPING_TARGETS = [
  { key: 'originalCode', label: 'material_code', required: true },
  { key: 'originalDescription', label: 'description', required: true },
  { key: 'orgCode', label: 'cpse_name (organization)' },
  { key: 'category', label: 'category' },
  { key: 'subcategory', label: 'subcategory' },
  { key: 'manufacturer', label: 'manufacturer' },
  { key: 'model', label: 'model' },
  { key: 'partNumber', label: 'part_number' },
  { key: 'uom', label: 'uom' },
  { key: 'size', label: 'size' },
  { key: 'materialType', label: 'material' },
  { key: 'voltage', label: 'voltage' },
  { key: 'pressureRating', label: 'pressure_rating' },
  { key: 'power', label: 'power' },
  { key: 'temperatureRating', label: 'temperature_rating' },
  { key: 'sealType', label: 'seal_type' },
  { key: 'bearingType', label: 'bearing_type' },
  { key: 'grade', label: 'grade' },
] as const;

export type MappingTargetKey = Exclude<keyof ImportColumnMapping, undefined>;

/** Technical mapping targets persisted as material_attributes. */
export const TECHNICAL_TARGETS = [
  'size', 'materialType', 'voltage', 'pressureRating', 'power', 'temperatureRating', 'sealType', 'bearingType', 'grade',
] as const;

/** Canonical material_attributes names for each technical mapping target. */
export const TECHNICAL_ATTRIBUTE_NAMES: Record<(typeof TECHNICAL_TARGETS)[number], string> = {
  size: 'size',
  materialType: 'material_type',
  voltage: 'voltage_rating',
  pressureRating: 'pressure_class',
  power: 'power_rating',
  temperatureRating: 'temperature_rating',
  sealType: 'seal_type',
  bearingType: 'bearing_type',
  grade: 'material_grade',
};

/** Critical attribute names per technical mapping target (matching engine weights these double). */
const TECHNICAL_CRITICAL = new Set(['voltage_rating', 'pressure_class', 'power_rating', 'seal_type']);

/** Unit suffix implied by a technical column, when unambiguous. */
const TECHNICAL_UNITS: Partial<Record<(typeof TECHNICAL_TARGETS)[number], string>> = {
  voltage: 'V',
  power: 'KW',
  temperatureRating: 'C',
};

/** Technical attribute derived from a technical column cell, or null when blank. */
export function technicalAttributeFrom(
  target: (typeof TECHNICAL_TARGETS)[number],
  raw: string | undefined
): { attributeName: string; value: string; normalizedValue: string | null; unit: string | null; isCritical: boolean } | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const attributeName = TECHNICAL_ATTRIBUTE_NAMES[target];
  const unit = TECHNICAL_UNITS[target] ?? null;
  return {
    attributeName,
    value,
    normalizedValue: canonicalValue(value),
    unit,
    isCritical: TECHNICAL_CRITICAL.has(attributeName),
  };
}

export interface RawRow {
  rowNumber: number;
  values: Record<string, string>;
}

export interface RowProblem {
  rule: string;
  severity: Exclude<Severity, 'VALID'>;
  message: string;
  suggestion?: string;
}

export interface RowReport {
  rowNumber: number;
  values: Record<string, string>;
  severity: Severity;
  empty: boolean;
  problems: RowProblem[];
  /** Set when this row duplicates a code already in the database. */
  duplicateOf?: { materialId: number; originalCode: string };
}

export interface ValidationSummary {
  totalRows: number;
  valid: number;
  warnings: number;
  errors: number;
  emptyRows: number;
  duplicateInFile: number;
  duplicateInDatabase: number;
  missingDescription: number;
  missingCode: number;
  unknownUom: number;
  unknownCategory: number;
}

export interface ValidationResult {
  rows: RowReport[];
  summary: ValidationSummary;
}

/* --------------------------- accepted vocabularies ------------------------ */

/** UOM allowlist — unknown UOM is a warning, not an error. */
export const KNOWN_UOMS = new Set([
  'NOS', 'EA', 'EACH', 'PCS', 'SET', 'PAIR', 'MTR', 'M', 'METER', 'METRE', 'MM',
  'CM', 'KM', 'KG', 'G', 'TON', 'TONNE', 'L', 'LTR', 'LITRE', 'LITER', 'ML',
  'M2', 'M3', 'SQM', 'KVA', 'KW', 'HP', 'BOX', 'ROLL', 'DRUM', 'BOTTLE', 'CAN',
]);

/** Categories the classifier pipeline knows; unknown provided category = error. */
export const KNOWN_CATEGORIES = new Set([
  'Bearings', 'Valves', 'Motors', 'Pumps', 'Fasteners', 'Uncategorised',
]);

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-/_.]*$/;
const LIMITS = {
  code: 50,
  description: 500,
  category: 80,
  subcategory: 80,
  manufacturer: 120,
  model: 80,
  partNumber: 80,
  uom: 20,
} as const;

/* ---------------------------- column mapping ------------------------------ */

const HEADER_ALIASES: Record<string, string> = {
  // organization / CPSE (per-row column); the file-level org is chosen in the wizard
  cpse_name: 'orgCode', cpse: 'orgCode', organization: 'orgCode', organisation: 'orgCode',
  org: 'orgCode', org_code: 'orgCode', organization_code: 'orgCode', cpse_code: 'orgCode',
  company: 'orgCode', owner: 'orgCode',
  // material code — many enterprise spellings
  material_code: 'originalCode', code: 'originalCode', materialcode: 'originalCode',
  material_no: 'originalCode', materialno: 'originalCode', material_number: 'originalCode',
  materialnumber: 'originalCode', item_code: 'originalCode', itemcode: 'originalCode',
  item_no: 'originalCode', item_number: 'originalCode', part_no: 'originalCode',
  mat_code: 'originalCode', mat_no: 'originalCode',
  // description
  description: 'originalDescription', material_description: 'originalDescription',
  materialdescription: 'originalDescription', item_description: 'originalDescription',
  itemdescription: 'originalDescription', short_text: 'originalDescription',
  shorttext: 'originalDescription', desc: 'originalDescription', nomenclature: 'originalDescription',
  // technical enrichment columns (optional)
  size: 'size', nominal_size: 'size', dimensions: 'size',
  material: 'materialType', material_type: 'materialType',
  voltage: 'voltage', voltage_rating: 'voltage', rated_voltage: 'voltage',
  pressure_rating: 'pressureRating', pressure_class: 'pressureRating', pressure: 'pressureRating',
  power: 'power', power_rating: 'power', rated_power: 'power',
  temperature_rating: 'temperatureRating', temperature: 'temperatureRating', temp_rating: 'temperatureRating',
  seal_type: 'sealType', seal: 'sealType', sealing: 'sealType',
  bearing_type: 'bearingType',
  grade: 'grade', material_grade: 'grade',
  // others
  category: 'category', sub_category: 'subcategory', subcategory: 'subcategory',
  manufacturer: 'manufacturer', make: 'manufacturer', brand: 'manufacturer', oem: 'manufacturer',
  model: 'model', part_number: 'partNumber', partnumber: 'partNumber', partno: 'partNumber',
  uom: 'uom', unit: 'uom', unit_of_measure: 'uom', unitofmeasure: 'uom', um: 'uom',
};

export function canonicalHeaderKey(header: string): string {
  return header.trim().toLowerCase().replace(/[\s\-.]+/g, '_');
}

export interface MappingSuggestion {
  mapping: ImportColumnMapping;
  /** header → suggested target, for UI display */
  suggestions: Array<{ header: string; target: string | null; confident: boolean }>;
  unmappedHeaders: string[];
}

/**
 * Suggest a column mapping from detected headers. A mapping is only suggested
 * when the header is a known alias — ambiguous headers stay unmapped for the
 * user to decide ("do not assume a mapping if confidence is insufficient").
 */
export function suggestMapping(headers: string[]): MappingSuggestion {
  const used = new Set<string>();
  const suggestions: MappingSuggestion['suggestions'] = [];
  const mapping: ImportColumnMapping = {
    originalCode: null,
    originalDescription: null,
    category: null,
    subcategory: null,
    manufacturer: null,
    model: null,
    partNumber: null,
    uom: null,
    orgCode: null,
    size: null,
    materialType: null,
    voltage: null,
    pressureRating: null,
    power: null,
    temperatureRating: null,
    sealType: null,
    bearingType: null,
    grade: null,
  };

  for (const header of headers) {
    const key = canonicalHeaderKey(header);
    const target = HEADER_ALIASES[key] ?? null;
    if (target && !used.has(target)) {
      used.add(target);
      (mapping as unknown as Record<string, string | null>)[target] = header;
      suggestions.push({ header, target, confident: true });
    } else {
      suggestions.push({ header, target: null, confident: false });
    }
  }
  const unmappedHeaders = suggestions.filter((s) => !s.target).map((s) => s.header);
  return { mapping, suggestions, unmappedHeaders };
}

/** True when the mapping covers both required fields. */
export function mappingIsUsable(mapping: ImportColumnMapping): boolean {
  return Boolean(mapping.originalCode && mapping.originalDescription);
}

/* ------------------------------ validation -------------------------------- */

function isBlankRow(values: Record<string, string>): boolean {
  return Object.values(values).every((v) => (v ?? '').trim() === '');
}

function maxLengthField(mapping: ImportColumnMapping, values: Record<string, string>): string | null {
  const checks: Array<[string, string | null, number]> = [
    ['material_code', mapping.originalCode, LIMITS.code],
    ['description', mapping.originalDescription, LIMITS.description],
    ['category', mapping.category, LIMITS.category],
    ['subcategory', mapping.subcategory, LIMITS.subcategory],
    ['manufacturer', mapping.manufacturer, LIMITS.manufacturer],
    ['model', mapping.model, LIMITS.model],
    ['part_number', mapping.partNumber, LIMITS.partNumber],
    ['uom', mapping.uom, LIMITS.uom],
  ];
  for (const [name, header, max] of checks) {
    if (!header) continue;
    const v = (values[header] ?? '').trim();
    if (v.length > max) return `${name} exceeds ${max} characters (${v.length})`;
  }
  return null;
}

/**
 * Validate every parsed row against the mapping. `existingCodes` is the set
 * of material codes already in the database for the target CPSE (with their
 * record ids) so duplicates can be reported precisely.
 *//**
 * Step 12: stateful per-row validator. `validateRows` is a thin wrapper over
 * this class so BATCH and STREAMING validation share one rule engine — the
 * rules, severities and summary accounting below are the frozen Step-5
 * semantics, moved verbatim (not re-implemented).
 */
export class RowValidator {
  readonly summary: ValidationSummary;
  private readonly seenInFile = new Map<string, number>(); // code → first rowNumber
  private readonly mapping: ImportColumnMapping;
  private readonly existingCodes: Map<string, { materialId: number; originalCode: string; itemSummary?: string }>;

  constructor(
    mapping: ImportColumnMapping,
    existingCodes: Map<string, { materialId: number; originalCode: string; itemSummary?: string }>,
  ) {
    this.mapping = mapping;
    this.existingCodes = existingCodes;
    this.summary = {
      totalRows: 0, valid: 0, warnings: 0, errors: 0, emptyRows: 0,
      duplicateInFile: 0, duplicateInDatabase: 0, missingDescription: 0,
      missingCode: 0, unknownUom: 0, unknownCategory: 0,
    };
  }

  /** Validate one parsed row, returning its full report. */
  next(row: RawRow): RowReport {
    const mapping = this.mapping;
    const summary = this.summary;
    summary.totalRows++;
    if (isBlankRow(row.values)) {
      summary.emptyRows++;
      return { rowNumber: row.rowNumber, values: row.values, severity: 'VALID', empty: true, problems: [] };
    }

    const problems: RowProblem[] = [];
    const code = mapping.originalCode ? (row.values[mapping.originalCode] ?? '').trim() : '';
    const description = mapping.originalDescription ? (row.values[mapping.originalDescription] ?? '').trim() : '';

    // Required: material code
    if (!code) {
      problems.push({
        rule: 'required_material_code',
        severity: 'ERROR',
        message: 'Required field "material_code" is missing.',
        suggestion: 'Correct the spreadsheet and upload again — codes are never invented by the system.',
      });
      summary.missingCode++;
    } else if (!CODE_PATTERN.test(code)) {
      problems.push({
        rule: 'invalid_code_format',
        severity: 'ERROR',
        message: `Material code "${code}" contains unsupported characters.`,
        suggestion: 'Allowed: letters, digits, dash, slash, underscore, dot. Fix the code in the source file.',
      });
    } else if (code.length > LIMITS.code) {
      problems.push({ rule: 'code_too_long', severity: 'ERROR', message: `Material code exceeds ${LIMITS.code} characters.` });
    }

    // Required: description
    if (!description) {
      problems.push({
        rule: 'required_description',
        severity: 'ERROR',
        message: 'Required field "description" is missing.',
        suggestion: 'Add the material description in the source file — descriptions are never invented.',
      });
      summary.missingDescription++;
    } else if (description.length < 3) {
      problems.push({ rule: 'description_too_short', severity: 'ERROR', message: 'Description is shorter than 3 characters.' });
    } else if (description.length > LIMITS.description) {
      problems.push({ rule: 'description_too_long', severity: 'ERROR', message: `Description exceeds ${LIMITS.description} characters.` });
    }

    // Duplicate within the uploaded file (case-insensitive).
    const codeKey = code.toUpperCase();
    if (code && this.seenInFile.has(codeKey)) {
      problems.push({
        rule: 'duplicate_in_file',
        severity: 'ERROR',
        message: `Material code "${code}" already appears at row ${this.seenInFile.get(codeKey)} of this file.`,
        suggestion: 'Remove the duplicate row or correct the code.',
      });
      summary.duplicateInFile++;
    } else if (code) {
      this.seenInFile.set(codeKey, row.rowNumber);
    }

    // Duplicate already in the database for this CPSE.
    let duplicateOf: RowReport['duplicateOf'] | undefined;
    if (code && this.existingCodes.has(codeKey)) {
      const hit = this.existingCodes.get(codeKey)!;
      duplicateOf = { materialId: hit.materialId, originalCode: hit.originalCode };
      const itemNote = hit.itemSummary ? ` — existing record: ${hit.itemSummary}` : '';
      problems.push({
        rule: 'duplicate_in_database',
        severity: 'ERROR',
        message: `Material code "${code}" already exists for this CPSE (record #${hit.materialId})${itemNote}.`,
        suggestion: 'Choose "Skip existing" to exclude it, or "Update existing" to refresh optional fields. Original code and description are never overwritten.',
      });
      summary.duplicateInDatabase++;
    }

    // Category provided but unknown → error (likely data-entry mistake).
    if (mapping.category) {
      const category = (row.values[mapping.category] ?? '').trim();
      if (category && !KNOWN_CATEGORIES.has(category)) {
        problems.push({
          rule: 'unknown_category',
          severity: 'ERROR',
          message: `Category "${category}" is not a recognised category.`,
          suggestion: `Use one of: ${[...KNOWN_CATEGORIES].filter((c) => c !== 'Uncategorised').join(', ')} — or leave blank for automatic classification.`,
        });
        summary.unknownCategory++;
      }
    }

    // Malformed numeric quantity in the description ("415XX V", "30KWQ") →
    // warning. Narrow pattern to avoid false positives on compact engineering
    // codes (6205-2RS, M20X80, 8X6-11) which are legitimate.
    if (/\b\d+(XX|YY|ZZ\s*V)\b/i.test(description)) {
      problems.push({
        rule: 'malformed_quantity',
        severity: 'WARNING',
        message: 'Description contains a malformed numeric value (e.g. "415XX"). Verify the rating in the source file.',
      });
    }

    // UOM provided but unknown → warning (importable after review).
    if (mapping.uom) {
      const uom = (row.values[mapping.uom] ?? '').trim();
      if (uom && !KNOWN_UOMS.has(uom.toUpperCase())) {
        problems.push({
          rule: 'unknown_uom',
          severity: 'WARNING',
          message: `Unit of measure "${uom}" is not in the recognised list.`,
          suggestion: 'Verify against the CPSE master data. The row can still be imported with the UOM as given.',
        });
        summary.unknownUom++;
      }
    }

    // Excessive field length on optional fields → warning.
    const longField = maxLengthField(mapping, row.values);
    if (longField && !longField.startsWith('material_code') && !longField.startsWith('description')) {
      problems.push({ rule: 'field_too_long', severity: 'WARNING', message: longField });
    }

    // Missing optional enrichment → informational warnings.
    if (mapping.manufacturer && !(row.values[mapping.manufacturer] ?? '').trim()) {
      problems.push({
        rule: 'optional_manufacturer_missing',
        severity: 'WARNING',
        message: 'Manufacturer not provided — extraction will rely on the description.',
      });
    }

    const severity: Severity = problems.some((p) => p.severity === 'ERROR')
      ? 'ERROR'
      : problems.length > 0
        ? 'WARNING'
        : 'VALID';
    if (severity === 'VALID') summary.valid++;
    else if (severity === 'WARNING') summary.warnings++;
    else summary.errors++;

    return { rowNumber: row.rowNumber, values: row.values, severity, empty: false, problems, duplicateOf };
  }
}

/**
 * Batch validation (frozen Step-5 API): a thin wrapper over RowValidator so
 * batch and streaming share ONE rule engine. Behavior is unchanged.
 */
export function validateRows(
  rows: RawRow[],
  mapping: ImportColumnMapping,
  existingCodes: Map<string, { materialId: number; originalCode: string; itemSummary?: string }>
): ValidationResult {
  const validator = new RowValidator(mapping, existingCodes);
  const rowReports: RowReport[] = [];
  for (const row of rows) rowReports.push(validator.next(row));
  return { rows: rowReports, summary: validator.summary };
}
