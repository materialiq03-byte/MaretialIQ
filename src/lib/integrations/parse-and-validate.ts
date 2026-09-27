/**
 * Step 22 — Feed parsing + canonical validation + source quality report.
 *
 * Parsing REUSES the Import Center's parsing engine (splitCsvLine /
 * parseImportFile) — no second spreadsheet engine. Validation happens BEFORE
 * canonical ingestion; every row is adapter-transformed, and the results are
 * aggregated into the read-only source-quality report (§15) computed from
 * ACTUAL data (nothing fabricated).
 */
import { splitCsvLine, parseImportFile } from '../services/file-parse-service';
import { KNOWN_CATEGORIES, KNOWN_UOMS } from '../services/import-validation';
import type { AdapterDiagnostic, CpseSourceAdapter } from './adapter-interface';
import type { CanonicalMaterialRow, SourceFormat } from './canonical-contract';
import { errors } from '../errors';

/** Total budget for the HTTP payload — mirrors the Import Center's bounding. */
const MAX_DIAGNOSTICS = 500;
const MAX_PREVIEW_ROWS = 50;

/** One validated feed row: canonical form (when accepted) + diagnostics. */
export interface ValidatedFeedRow {
  rowNumber: number;
  sourceValues: Record<string, string>;
  canonical: CanonicalMaterialRow | null;
  diagnostics: AdapterDiagnostic[];
  severity: 'VALID' | 'WARNING' | 'ERROR';
}

/** Field coverage per canonical field — computed from ACTUAL parsed rows (§15). */
export interface FieldCoverage {
  field: string;
  populated: number;
  total: number;
  coveragePct: number;
}

/** The complete, read-only result of analyzing one CPSE feed (§13). */
export interface FeedAnalysis {
  cpse: string;
  adapterId: string;
  adapterVersion: string;
  sourceFormat: SourceFormat;
  headers: string[];
  fieldMapping: Array<{ sourceField: string; canonicalField: string }>;
  rowsReceived: number;
  rowsValid: number;
  rowsWithWarnings: number;
  rowsWithError: number;
  duplicatesInFeed: number;
  emptyRows: number;
  diagnostics: AdapterDiagnostic[];
  fieldCoverage: FieldCoverage[];
  canonicalPreview: CanonicalMaterialRow[];
  /** True when at least one row can be handed to the Import Center. */
  canExecute: boolean;
}

function detectFormat(fileName: string): SourceFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return 'CSV';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'XLSX';
  throw errors.badRequest('Unsupported source format: only .csv and .xlsx feeds are accepted', {
    code: 'UNSUPPORTED_FORMAT',
  });
}

/**
 * Parse a source feed into raw header→cell row maps. CSV uses the EXISTING
 * splitCsvLine engine; XLSX delegates to the existing parseImportFile (same
 * spreadsheet engine — no duplicated parsing logic, §7).
 */
export function parseFeed(
  fileName: string,
  payload: ArrayBuffer | string,
): { headers: string[]; rows: Array<{ rowNumber: number; values: Record<string, string> }> } {
  if (!fileName.toLowerCase().endsWith('.csv')) {
    // XLSX (and any format the existing engine understands) → existing parser.
    const result = parseImportFile(fileName, payload);
    return {
      headers: result.headers,
      rows: result.rows.map((r) => ({ rowNumber: r.rowNumber, values: r.values })),
    };
  }
  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(new Uint8Array(payload));
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]);
  const rows: Array<{ rowNumber: number; values: Record<string, string> }> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const values: Record<string, string> = {};
    headers.forEach((h, idx) => {
      values[h] = (cells[idx] ?? '').trim();
    });
    rows.push({ rowNumber: i + 1, values });
  }
  return { headers, rows };
}

/**
 * Analyze a feed with the given adapter: parse → validate+transform every
 * row → aggregate the source-quality report. Pure: touches NO database and
 * creates NO import record (§28: analyze is read-only and idempotent).
 */
export function analyzeFeed(
  adapter: CpseSourceAdapter,
  fileName: string,
  payload: ArrayBuffer | string,
): FeedAnalysis {
  const sourceFormat = detectFormat(fileName);
  const { headers, rows } = parseFeed(fileName, payload);

  const fieldMapping = Object.entries(adapter.fieldMap).map(([canonicalField, sourceField]) => ({
    sourceField,
    canonicalField,
  }));

  const allDiagnostics: AdapterDiagnostic[] = [];
  const canonicalPreview: CanonicalMaterialRow[] = [];
  const canonicalRows: CanonicalMaterialRow[] = [];
  const fieldTotals = new Map<string, { populated: number; total: number }>();
  const seenSourceIds = new Map<string, number>(); // sourceRecordId → first row

  let rowsValid = 0;
  let rowsWithWarnings = 0;
  let rowsWithError = 0;
  let duplicatesInFeed = 0;
  let emptyRows = 0;

  const track = (field: string, populated: boolean) => {
    const cur = fieldTotals.get(field) ?? { populated: 0, total: 0 };
    if (populated) cur.populated++;
    cur.total++;
    fieldTotals.set(field, cur);
  };

  for (const row of rows) {
    // Fully empty source row — counted, not diagnosed.
    if (Object.values(row.values).every((v) => (v ?? '').trim() === '')) {
      emptyRows++;
      continue;
    }

    const { canonical, diagnostics } = adapter.validateAndTransform(row.values, row.rowNumber);
    let rowDiagnostics = diagnostics;

    let severity: ValidatedFeedRow['severity'] = diagnostics.some((d) => d.severity === 'ERROR')
      ? 'ERROR'
      : diagnostics.length > 0
        ? 'WARNING'
        : 'VALID';

    // Duplicate source record WITHIN the feed (idempotent replay signal, §10).
    if (canonical) {
      const key = canonical.sourceRecordId.toUpperCase();
      const firstRow = seenSourceIds.get(key);
      if (firstRow !== undefined) {
        duplicatesInFeed++;
        severity = 'ERROR';
        rowDiagnostics = [
          ...rowDiagnostics,
          {
            row: row.rowNumber,
            field: adapter.fieldMap.materialCode,
            code: 'CONFLICT',
            message: `Duplicate source record "${canonical.sourceRecordId}" — first seen at row ${firstRow} (identity: ${canonical.cpse}+${canonical.sourceSystem}+${canonical.sourceRecordId}).`,
            severity: 'ERROR',
          },
        ];
      } else {
        seenSourceIds.set(key, row.rowNumber);
      }
    }

    if (severity === 'VALID') rowsValid++;
    else if (severity === 'WARNING') rowsWithWarnings++;
    else rowsWithError++;
    allDiagnostics.push(...rowDiagnostics);

    if (canonical) {
      canonicalRows.push(canonical);
      if (canonicalPreview.length < MAX_PREVIEW_ROWS) canonicalPreview.push(canonical);
      // Field coverage from actual parsed values.
      track('materialCode', Boolean(canonical.materialCode));
      track('description', Boolean(canonical.description));
      track('category', Boolean(canonical.category));
      track('subcategory', Boolean(canonical.subcategory));
      track('manufacturer', Boolean(canonical.manufacturer));
      track('partNumber', Boolean(canonical.partNumber));
      track('material', Boolean(canonical.material));
      track('uom', Boolean(canonical.uom));

      // Source-vocabulary warnings against the EXISTING vocabularies (§16:
      // adapter normalization already ran; unknown tokens surface honestly).
      if (canonical.category && !KNOWN_CATEGORIES.has(canonical.category)) {
        allDiagnostics.push({
          row: canonical.sourceRowNumber, field: 'category', code: 'INVALID_VALUE',
          message: `Category "${canonical.category}" is not a recognised MaterialIQ category (it would be classified as Uncategorised).`,
          severity: 'WARNING',
        });
      }
      if (canonical.uom && !KNOWN_UOMS.has(canonical.uom.toUpperCase())) {
        allDiagnostics.push({
          row: canonical.sourceRowNumber, field: 'uom', code: 'INVALID_VALUE',
          message: `UOM "${canonical.uom}" is not in the recognised list (importable as given).`,
          severity: 'WARNING',
        });
      }
    }
  }

  const fieldCoverage: FieldCoverage[] = [...fieldTotals.entries()].map(([field, t]) => ({
    field,
    populated: t.populated,
    total: t.total,
    coveragePct: t.total === 0 ? 0 : Math.round((t.populated / t.total) * 1000) / 10,
  }));

  return {
    cpse: adapter.cpse,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    sourceFormat,
    headers,
    fieldMapping,
    rowsReceived: rows.length,
    rowsValid,
    rowsWithWarnings,
    rowsWithError,
    duplicatesInFeed,
    emptyRows,
    diagnostics: allDiagnostics.slice(0, MAX_DIAGNOSTICS),
    fieldCoverage,
    canonicalPreview,
    canExecute: rowsWithError === 0 && rowsValid + rowsWithWarnings > 0,
  };
}
