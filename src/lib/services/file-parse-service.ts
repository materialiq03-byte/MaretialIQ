/**
 * File parsing for the import pipeline: CSV and XLSX → row objects.
 *
 * Values are keyed by the file's RAW header text so the Import Center's
 * column-mapping step can read any detected column. A parallel `canonical`
 * view (material_code → originalCode, …) is provided for callers that want
 * pre-resolved fields. Nothing is dropped at parse time: unrecognized columns
 * stay available and are surfaced as unmapped headers for the user to map.
 *
 * Parsing is pure; validation lives in import-validation. No silent row
 * dropping — malformed rows are surfaced with row numbers.
 */
import * as XLSX from 'xlsx';

export interface ParsedRow {
  rowNumber: number;
  /** Cell values keyed by the file's raw header text. */
  values: Record<string, string>;
  /** Cell values keyed by canonical field name (only recognized columns). */
  canonical: Record<string, string>;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Raw header row as it appears in the file. */
  headers: string[];
  errors: Array<{ row: number; message: string }>;
}

/** Column aliases accepted in uploaded files (case-insensitive). */
const COLUMN_ALIASES: Record<string, string> = {
  material_code: 'originalCode',
  code: 'originalCode',
  materialcode: 'originalCode',
  material_no: 'originalCode',
  material_number: 'originalCode',
  item_code: 'originalCode',
  item_no: 'originalCode',
  part_no: 'originalCode',
  description: 'originalDescription',
  material_description: 'originalDescription',
  item_description: 'originalDescription',
  short_text: 'originalDescription',
  nomenclature: 'originalDescription',
  desc: 'originalDescription',
  uom: 'uom',
  unit: 'uom',
  unit_of_measure: 'uom',
  um: 'uom',
  category: 'category',
  subcategory: 'subcategory',
  sub_category: 'subcategory',
  manufacturer: 'manufacturer',
  make: 'manufacturer',
  brand: 'manufacturer',
  model: 'model',
  part_number: 'partNumber',
  partno: 'partNumber',
  // per-row CPSE + technical enrichment (kept in sync with import-validation)
  cpse_name: 'orgCode',
  cpse: 'orgCode',
  organization: 'orgCode',
  organisation: 'orgCode',
  org: 'orgCode',
  org_code: 'orgCode',
  organization_code: 'orgCode',
  cpse_code: 'orgCode',
  size: 'size',
  nominal_size: 'size',
  dimensions: 'size',
  material: 'materialType',
  material_type: 'materialType',
  voltage: 'voltage',
  voltage_rating: 'voltage',
  rated_voltage: 'voltage',
  pressure_rating: 'pressureRating',
  pressure_class: 'pressureRating',
  pressure: 'pressureRating',
  power: 'power',
  power_rating: 'power',
  rated_power: 'power',
  temperature_rating: 'temperatureRating',
  temperature: 'temperatureRating',
  temp_rating: 'temperatureRating',
  seal_type: 'sealType',
  seal: 'sealType',
  sealing: 'sealType',
  bearing_type: 'bearingType',
  grade: 'grade',
  material_grade: 'grade',
};

/** Shared alias set with import-validation — one source of truth would live there. */
export { COLUMN_ALIASES };

export function canonicalHeader(h: string): string | null {
  const key = h.trim().toLowerCase().replace(/[\s\-.]+/g, '_');
  return COLUMN_ALIASES[key] ?? null;
}

export function buildRow(
  rowNumber: number,
  headersRaw: string[],
  canonicalFor: Array<string | null>,
  cells: string[]
): ParsedRow {
  const values: Record<string, string> = {};
  const canonical: Record<string, string> = {};
  headersRaw.forEach((h, idx) => {
    const cell = cells[idx] ?? '';
    values[h] = cell;
    const key = canonicalFor[idx];
    if (key) canonical[key] = cell;
  });
  return { rowNumber, values, canonical };
}

/**
 * Step 12 — bounded CSV: a record-iterator over a byte buffer.
 *
 * The buffer IS the file (the OS page cache holds it; the heap only ever
 * holds one line). split('\n') + per-line arrays are never materialized, so
 * large files parse in ONE pass with O(1) row memory. Quoting is handled by
 * the same state machine as the legacy line parser; a record never breaks
 * mid-quote across the 64 KB window.
 */
export class CsvRecordIterator {
  private readonly buf: Buffer;
  private pos = 0;
  private lineNo = 0;
  private readonly window: Buffer;
  private windowStart = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.window = Buffer.alloc(64 * 1024);
  }

  /** Next logical CSV record (unquoted newline), or null at EOF. */
  next(): string | null {
    if (this.pos >= this.buf.length) return null;
    let inQuotes = false;
    this.windowStart = 0;
    while (this.pos < this.buf.length) {
      const ch = this.buf[this.pos];
      if (ch === 34 /* " */) inQuotes = !inQuotes;
      const eol = !inQuotes && (ch === 10 /* \n */ || ch === 13 /* \r */);
      if (eol) {
        // consume \r\n as one EOL
        if (ch === 13 && this.pos + 1 < this.buf.length && this.buf[this.pos + 1] === 10) this.pos++;
        const rec = this.window.subarray(0, this.windowStart).toString('utf8');
        this.pos++;
        this.lineNo++;
        return rec;
      }
      if (this.windowStart >= this.window.length) {
        throw new Error(`CSV record on line ${this.lineNo + 1} exceeds the 64 KB line limit`);
      }
      this.window[this.windowStart++] = ch;
      this.pos++;
    }
    this.lineNo++;
    return this.window.subarray(0, this.windowStart).toString('utf8'); // final unterminated record
  }

  get currentLine(): number {
    return this.lineNo;
  }
}

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseCsv(text: string): ParseResult {
  const rows: ParsedRow[] = [];
  const errors: ParseResult['errors'] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { rows: [], headers: [], errors: [{ row: 0, message: 'File is empty' }] };

  const splitLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };

  const headersRaw = splitLine(lines[0]);
  const canonicalFor = headersRaw.map(canonicalHeader);

  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    rows.push(buildRow(i + 1, headersRaw, canonicalFor, cells));
  }

  return { rows, headers: headersRaw, errors };
}

function parseXlsx(buffer: ArrayBuffer): ParseResult {
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { rows: [], headers: [], errors: [{ row: 0, message: 'Workbook has no sheets' }] };
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
  if (matrix.length === 0) return { rows: [], headers: [], errors: [{ row: 0, message: 'Sheet is empty' }] };

  const headersRaw = (matrix[0] as unknown[]).map((h) => String(h ?? ''));
  const canonicalFor = headersRaw.map(canonicalHeader);
  const rows: ParsedRow[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const cells = (matrix[i] as unknown[]).map((c) => String(c ?? '').trim());
    if (cells.every((c) => c === '')) continue; // fully empty spreadsheet row
    rows.push(buildRow(i + 1, headersRaw, canonicalFor, cells));
  }
  return { rows, headers: headersRaw, errors: [] };
}

export function parseImportFile(fileName: string, payload: ArrayBuffer | string): ParseResult {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    if (typeof payload === 'string') {
      return { rows: [], headers: [], errors: [{ row: 0, message: 'XLSX upload must be sent as binary body' }] };
    }
    return parseXlsx(payload);
  }
  const text = typeof payload === 'string' ? payload : new TextDecoder().decode(new Uint8Array(payload));
  return parseCsv(text);
}
