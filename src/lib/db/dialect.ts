/**
 * Dialect layer (Step 6B): translates the application's SQLite-flavoured SQL
 * into the active database's dialect.
 *
 * Design rules:
 *  - The SQLite dialect is the project's lingua franca: repositories write
 *    SQLite SQL, and on the SQLite path the translator is a no-op so the SQL
 *    reaching node:sqlite is BYTE-IDENTICAL to pre-6B behavior.
 *  - A real engine exists only for PostgreSQL. It is deterministic and unit
 *    tested (tests/adapter.test.ts) but NOT wired to a live database in 6B —
 *    no Supabase tables exist yet (schema apply is a later step).
 *  - Nothing here changes business semantics: translations are syntactic
 *    equivalents of the §6A findings:
 *      INSERT OR IGNORE  -> INSERT ... ON CONFLICT (<key>) DO NOTHING
 *      LIKE ? COLLATE NOCASE -> ILIKE ?
 *      json_extract(col, '$.a.b') -> (col #>> '{a,b}')
 *      strftime('%Y-...','now')   -> now()
 *      length(x)                  -> char_length(x)
 *      INTEGER PRIMARY KEY AUTOINCREMENT -> identity column
 *      BEGIN IMMEDIATE            -> BEGIN
 *  - Unknown INSERT OR IGNORE targets fail fast on PostgreSQL instead of
 *    silently changing duplicate semantics.
 */

export type Dialect = 'sqlite' | 'postgresql';

export function getDialect(): Dialect {
  const raw = (process.env.MATERIALIQ_DB_DIALECT ?? 'sqlite').toLowerCase();
  // 'postgres' and 'postgresql' are accepted aliases; everything else -> sqlite.
  return raw === 'postgres' || raw === 'postgresql' ? 'postgresql' : 'sqlite';
}

export function isPostgres(): boolean {
  return getDialect() === 'postgresql';
}

/**
 * INSERT OR IGNORE call sites with their PG conflict targets. Kept explicit
 * (not inferred) because PostgreSQL requires the concrete key and guessing it
 * from SQL text could silently change duplicate-handling semantics.
 */
const IGNORE_SITES: Array<{ table: RegExp; target: string }> = [
  { table: /INSERT\s+OR\s+IGNORE\s+INTO\s+review_queue\b/i, target: '(match_id)' },
  { table: /INSERT\s+OR\s+IGNORE\s+INTO\s+matching_run_chunks\b/i, target: '(run_id, chunk_index)' },
  { table: /INSERT\s+OR\s+IGNORE\s+INTO\s+import_run_chunks\b/i, target: '(run_id, chunk_index)' },
];

/**
 * Boolean columns are real booleans on PostgreSQL but 0/1 INTEGERs on SQLite.
 * Application SQL is written SQLite-style (`boolcol = 1`), which PostgreSQL
 * rejects (`operator does not exist: boolean = integer`). Translate inline
 * integer literals on the schema's boolean columns only — explicit list, no
 * guessing (Step 8 parity gate finding).
 */
const BOOLEAN_COLUMNS = ['category_compatible', 'is_active', 'is_critical'];

/**
 * Boolean literal translation, TABLE-AWARE. The migrated schema splits
 * boolean-ish columns into two families:
 *   - native booleans (baseline tables): common_materials.is_active,
 *     material_records.is_active, match_candidates.category_compatible,
 *     material_attributes.is_critical -- reject SQLite-style '= 1';
 *   - integer 0/1 columns (v13+ DDL kept CHECK IN (0,1)):
 *     suppliers.is_active, uom_conversion_rules.is_active -- REQUIRE '= 1'.
 * A blanket rewrite of (col = 1) to (col = true) breaks the integer family
 * (integer = boolean); no rewrite breaks the boolean family. Only
 * qualified references resolving to a boolean table are rewritten;
 * boolean-table call sites always qualify via FROM/JOIN aliases, and a
 * bare is_active = 1 (integer-table statements) stays untouched.
 */
const BOOLEAN_QUALIFIED_TABLES = ['common_materials', 'material_records'];

function translateBooleanLiterals(sql: string): string {
  let out = sql;
  // Always-boolean columns (unique across tables): rewrite everywhere.
  for (const col of ['category_compatible', 'is_critical']) {
    out = out.replace(new RegExp('\\b' + col + '\\s*=\\s*1\\b', 'gi'), col + ' = true');
    out = out.replace(new RegExp('\\b' + col + '\\s*=\\s*0\\b', 'gi'), col + ' = false');
    out = out.replace(new RegExp('\\b' + col + '\\s*(!=|<>)\\s*1\\b', 'gi'), col + ' <> true');
    out = out.replace(new RegExp('\\b' + col + '\\s*(!=|<>)\\s*0\\b', 'gi'), col + ' <> false');
  }
  // is_active: table-aware. Qualified refs are rewritten when the qualifier
  // is the table name itself or a real alias (SQL keywords excluded); bare
  // refs are rewritten only when the statement references no integer-family
  // is_active table, which would make a bare reference ambiguous.
  const INTEGER_IS_ACTIVE_TABLES = ['suppliers', 'uom_conversion_rules'];
  const KEYWORDS = /^(?:WHERE|ON|GROUP|ORDER|LEFT|RIGHT|INNER|OUTER|JOIN|SET|VALUES|AS|AND|OR)$/i;
  const refsIntegerTable = INTEGER_IS_ACTIVE_TABLES.some((t) => new RegExp('\\b' + t + '\\b', 'i').test(out));
  for (const table of BOOLEAN_QUALIFIED_TABLES) {
    const qualifiers = new Set<string>([table]);
    const aliasRe = new RegExp('\\b(?:FROM|JOIN)\\s+' + table + '\\s+([A-Za-z_][\\w$]*)', 'gi');
    let m: RegExpExecArray | null;
    while ((m = aliasRe.exec(out)) !== null) {
      if (!KEYWORDS.test(m[1])) qualifiers.add(m[1]);
    }
    for (const qualifier of qualifiers) {
      const q = qualifier + '.';
      out = out.replace(new RegExp('\\b' + q + 'is_active\\s*=\\s*1\\b', 'gi'), q + 'is_active = true');
      out = out.replace(new RegExp('\\b' + q + 'is_active\\s*(!=|<>)\\s*0\\b', 'gi'), q + 'is_active <> false');
    }
    if (!refsIntegerTable) {
      // Bare is_active in a statement that touches no integer-family table.
      out = out.replace(/(?<![\w$.])is_active\s*=\s*1\b/gi, 'is_active = true');
      out = out.replace(/(?<![\w$.])is_active\s*(!=|<>)\s*0\b/gi, 'is_active <> false');
    }
  }
  return out;
}
/**
 * SQLite coerces TEXT-affinity decimal columns (quantity, unit_price — stored
 * as text in the frozen schema) to numeric inside arithmetic and ROUND();
 * PostgreSQL has no text*integer operator and no round(text). Rewrite every
 * top-level ROUND(<arg>) to ROUND(CAST(<arg'> AS numeric)) where bare
 * decimal-column references inside the argument are CAST(...) to REAL first,
 * so the multiplication happens in the numeric domain exactly as SQLite's
 * affinity would. SQLite never sees this rewrite (PostgreSQL dialect only).
 */
const NUMERIC_AFFINITY_COLUMNS = ['quantity', 'unit_price'];

function translateRound(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const m = /\bROUND\s*\(/gi.exec(sql.slice(i));
    if (!m || m.index === undefined) {
      out += sql.slice(i);
      break;
    }
    const start = i + m.index; // position of ROUND
    const open = start + m[0].length - 1; // position of '(' after ROUND
    // Paren-balanced scan of the argument, respecting single-quoted strings.
    let depth = 0;
    let j = open;
    let inQuote = false;
    for (; j < sql.length; j++) {
      const c = sql[j];
      if (inQuote) {
        if (c === "'") {
          if (sql[j + 1] === "'") j++; // escaped ''
          else inQuote = false;
        }
      } else if (c === "'") inQuote = true;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= sql.length) {
      // Unbalanced (should not happen) — leave the text untouched.
      out += sql.slice(i);
      break;
    }
    const arg = sql.slice(open + 1, j);
    // Coerce bare and qualified decimal-column references to REAL (mirroring
    // SQLite's TEXT->NUMERIC affinity coercion): pr.quantity ->
    // CAST(pr.quantity AS REAL). Nested inside an existing CAST(...) the
    // result is a harmless double cast (both engines accept it).
    const coerced = arg.replace(
      new RegExp('([A-Za-z_][\\w$]*\\.)?(?:' + NUMERIC_AFFINITY_COLUMNS.join('|') + ')\\b', 'gi'),
      (ref: string) => `CAST(${ref} AS REAL)`
    );
    out += sql.slice(i, start) + `ROUND(CAST(${coerced} AS numeric))`;
    i = j + 1;
  }
  return out;
}

/** Translate SQLite-flavoured SQL (identity unless the PostgreSQL dialect is active). */
export function translateSql(sql: string, dialect: Dialect = getDialect()): string {
  if (dialect !== 'postgresql') return sql;

  let out = sql;

  // strftime('%Y-%m-%dT%H:%M:%fZ','now') -> now()  (timestamp DDL + defaults)
  out = out.replace(/strftime\(\s*'(?:[^']|'')*'\s*,\s*'(?:now|localtime)[^']*'\s*\)/gi, 'now()');

  // INTEGER PRIMARY KEY AUTOINCREMENT -> identity (DDL only; repositories
  // never send DDL, kept for completeness so the module can render schema DDL).
  out = out.replace(
    /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi,
    'integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'
  );

  // length( -> char_length(  (same semantics for text on both engines)
  out = out.replace(/\blength\(/gi, 'char_length(');

  // LIKE <param|literal> COLLATE NOCASE -> ILIKE <param|literal>
  out = out.replace(/LIKE\s+(\?|'(?:[^']|'')*')\s+COLLATE\s+NOCASE/gi, 'ILIKE $1');

  // <expr> = ? COLLATE NOCASE -> (lower(expr) = lower(?))   (Step 8 finding)
  // Expression-level NOCASE (e.g. `original_code = ? COLLATE NOCASE`) is not a
  // LIKE, so the ILIKE rule never sees it and PostgreSQL rejects the unknown
  // "nocase" collation. Case-insensitive equality via lower() on both sides
  // is the semantically equivalent comparison (codes are ASCII in this
  // dataset, matching SQLite's ASCII-only NOCASE behavior).
  out = out.replace(
    /\b([A-Za-z_][\w."]*)\s*=\s*\?\s*COLLATE\s*NOCASE\b/gi,
    '(lower($1) = lower(?))'
  );

  // boolean columns: SQLite-style integer literals -> PG booleans
  out = translateBooleanLiterals(out);

  // TEXT-affinity decimals under ROUND() -> explicit numeric coercion
  out = translateRound(out);

  // GROUP_CONCAT(expr)        -> string_agg(expr::text, ',')
  // GROUP_CONCAT(expr, 'sep') -> string_agg(expr::text, 'sep')
  // SQLite's optional-separator aggregate has a PostgreSQL spelling with the
  // same semantics; the ::text cast mirrors SQLite's implicit TEXT affinity.
  out = out.replace(
    /\bGROUP_CONCAT\s*\(\s*((?:[^'()]|'(?:[^']|'')*'|\((?:[^()]|\([^()]*\))*\))*?)\s*(?:,\s*('(?:[^']|'')*')\s*)?\)/gi,
    (_m: string, expr: string, sep?: string) =>
      `string_agg((${expr.trim()})::text, ${sep ?? "','"})`
  );

  // json_extract(col, '$.a.b') -> (col #>> '{a,b}')  — dotted paths only,
  // which covers every production call site.
  out = out.replace(
    /\bjson_extract\s*\(\s*([A-Za-z_][\w."]*(?:\s*\.\s*[A-Za-z_][\w"]*)*)\s*,\s*'(\$[\w.[\]]+)'\s*\)/gi,
    (_m: string, col: string, path: string) => {
      const parts = path
        .replace(/^\$/, '')
        .split(/[.[\]]+/)
        .filter(Boolean);
      return `(${col.trim()}#>>'{${parts.join(',')}}')`;
    }
  );

  // json_array_length(col, '$.key') -> jsonb_array_length((col #> '{key}'))
  // Supabase stores evidence as jsonb (v11 translation) and PG's
  // json_array_length only accepts json. jsonb_array_length returns the same
  // integer semantics as SQLite for arrays present at the path. A missing key
  // would raise in PG where SQLite returns 0, so the translation guards with
  // a jsonb typeof check — arrays count their elements, anything else (absent
  // key, object, scalar, SQL NULL) counts as 0, byte-identical to SQLite.
  out = out.replace(
    /\bjson_array_length\s*\(\s*([A-Za-z_][\w."]*)\s*,\s*'(\$(?:\.[A-Za-z_][\w]*)+)'\s*\)/gi,
    (_m: string, col: string, path: string) => {
      const parts = path
        .replace(/^\$\.?/, '')
        .split('.')
        .filter(Boolean);
      const pgPath = `{${parts.join(',')}}`;
      return `(CASE WHEN jsonb_typeof((${col.trim()} #> '${pgPath}')) = 'array' THEN jsonb_array_length((${col.trim()} #> '${pgPath}')) ELSE 0 END)`;
    }
  );

  // INSERT OR IGNORE: the statement translator resolves known targets below;
  // unknown ones must fail loudly rather than change duplicate semantics.
  return out;
}

/** Translate one statement, including call-site-aware OR IGNORE handling. */
export function translateStatement(sql: string, dialect: Dialect = getDialect()): string {
  const base = translateSql(sql, dialect);
  if (dialect !== 'postgresql') return base;

  const ignoreMatch = /\bINSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)/i.exec(base);
  if (ignoreMatch) {
    for (const site of IGNORE_SITES) {
      if (site.table.test(base)) {
        return base.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO') + ` ON CONFLICT ${site.target} DO NOTHING`;
      }
    }
    throw new Error(
      `PG dialect: INSERT OR IGNORE into "${ignoreMatch[1]}" has no registered conflict target — refusing to translate (duplicate semantics would change).`
    );
  }
  return base;
}
