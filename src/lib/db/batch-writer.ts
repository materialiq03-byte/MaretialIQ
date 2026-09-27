/**
 * Bounded multi-row batch helpers (Step 2 performance work).
 *
 * Goal: cut per-row database round trips during import chunk execution by
 * issuing bounded multi-row statements instead of one statement per row.
 * Every helper speaks the EXISTING dialect-neutral DataApi
 * (getDb().prepare() -> run/get/all) — no dialect-specific SQL, no bypassed
 * abstraction:
 *
 *   - multi-row `INSERT ... VALUES (?,?,..),(?,?,..) ... RETURNING ...`
 *     behaves identically on node:sqlite (bundled SQLite >= 3.35) and
 *     PostgreSQL 15, returning generated ids in input order;
 *   - multi-row `INSERT ... ON CONFLICT (<key>) DO UPDATE SET ...` likewise
 *     (caller must not repeat a conflict key inside one statement — allowed
 *     by SQLite, rejected by PostgreSQL; upsertAttribute callers dedupe);
 *   - searched `UPDATE ... CASE ... END` is core SQL on both engines.
 *
 * Bounds: statements are capped at MAX_BATCH_ROWS value tuples so SQL text
 * and host-parameter counts stay bounded regardless of job chunk size (a
 * 5,000-row chunk produces a series of at most MAX_BATCH_ROWS-row statements,
 * never one unbounded statement). 250 rows x 17 columns = 4,250 parameters,
 * far below node:sqlite's 32,766 host-parameter ceiling (SQLite >= 3.32) and
 * PostgreSQL's 65,535.
 */
import { getDb } from './client';

/**
 * Value tuples per statement. Tunable for benchmarking via
 * IMPORT_BATCH_ROWS (clamped to [10, 1000]); default 250 was the best
 * measured trade-off (Step 2 benchmarks): large enough to amortize WAN
 * round trips, small enough to keep statements/parameters bounded and
 * per-statement memory flat.
 */
const BATCH_DEFAULT = 250;
const BATCH_MIN = 10;
const BATCH_MAX = 1000;

export function maxBatchRows(): number {
  const raw = Number.parseInt(process.env.IMPORT_BATCH_ROWS ?? '', 10);
  return Number.isFinite(raw) ? Math.min(Math.max(raw, BATCH_MIN), BATCH_MAX) : BATCH_DEFAULT;
}

/** `(?, ?, ...)`,`(?, ?, ...)` — `rowCount` tuples of `columnCount` params. */
export function valuesPlaceholders(rowCount: number, columnCount: number): string {
  const one = '(' + new Array(columnCount).fill('?').join(', ') + ')';
  return new Array(rowCount).fill(one).join(', ');
}

export interface BatchInsertReturningOptions {
  /** INSERT statement up to (not including) VALUES, e.g. `INSERT INTO t (a, b)`. */
  insertSql: string;
  columnCount: number;
  /** One flat parameter array per row, in insertion order. */
  rows: unknown[][];
  /** e.g. `id, original_code` — returned rows preserve input order. */
  returning: string;
}

/**
 * Bounded multi-row INSERT ... RETURNING. Returns every returned row across
 * all internal statements, in input order (identities are assigned in VALUES
 * order on both engines). Uses .all() because RETURNING is a row-producing
 * statement on both dialects.
 */
export function batchInsertReturning<T>(opts: BatchInsertReturningOptions): T[] {
  const db = getDb();
  const cap = maxBatchRows();
  const out: T[] = [];
  for (let i = 0; i < opts.rows.length; i += cap) {
    const slice = opts.rows.slice(i, i + cap);
    const stmt = db.prepare(
      `${opts.insertSql} VALUES ${valuesPlaceholders(slice.length, opts.columnCount)} RETURNING ${opts.returning}`,
    );
    out.push(...(stmt.all(...(slice.flat() as never[])) as T[]));
  }
  return out;
}

export interface BatchUpsertOptions {
  insertSql: string;
  columnCount: number;
  rows: unknown[][];
  /** e.g. `material_id, attribute_name` (must match the schema unique key). */
  conflictTarget: string;
  /** e.g. `value = excluded.value, ...` (the DO UPDATE SET list). */
  updateSet: string;
}

/**
 * Bounded multi-row upsert. Rows within one statement must not repeat a
 * conflict key (PostgreSQL rejects `ON CONFLICT DO UPDATE` twice touching
 * the same row); callers dedupe beforehand. Uses .run() — no results needed.
 */
export function batchUpsert(opts: BatchUpsertOptions): void {
  const db = getDb();
  const cap = maxBatchRows();
  for (let i = 0; i < opts.rows.length; i += cap) {
    const slice = opts.rows.slice(i, i + cap);
    db.prepare(
      `${opts.insertSql} VALUES ${valuesPlaceholders(slice.length, opts.columnCount)} ` +
        `ON CONFLICT (${opts.conflictTarget}) DO UPDATE SET ${opts.updateSet}`,
    ).run(...(slice.flat() as never[]));
  }
}

export interface IdValuePair {
  id: number;
  value: unknown;
}

/**
 * Bounded per-row value update driven by a single searched UPDATE:
 *   UPDATE t SET col = CASE WHEN id = ? THEN ? WHEN id = ? THEN ? ... END
 *   WHERE id IN (?, ?, ...)
 * Semantically identical to one UPDATE per row, in one round trip.
 */
export function batchUpdateColumn(
  table: string,
  column: string,
  pairs: IdValuePair[],
): void {
  if (pairs.length === 0) return;
  const db = getDb();
  const cap = maxBatchRows();
  for (let i = 0; i < pairs.length; i += cap) {
    const slice = pairs.slice(i, i + cap);
    const cases = slice.map(() => `WHEN id = ? THEN ?`).join(' ');
    const params: unknown[] = [];
    for (const p of slice) params.push(p.id, p.value);
    params.push(...slice.map((p) => p.id));
    db.prepare(
      `UPDATE ${table} SET ${column} = CASE ${cases} ELSE ${column} END ` +
        `WHERE id IN (${slice.map(() => '?').join(', ')})`,
    ).run(...(params as never[]));
  }
}
