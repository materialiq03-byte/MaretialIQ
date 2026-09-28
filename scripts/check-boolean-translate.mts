/**
 * Sanity check + self-healing rewrite of translateBooleanLiterals.
 * Run: `npx tsx scripts/check-boolean-translate.mts`
 *
 * The rewrite below reconstructs the function body using explicit character
 * codes for backslashes (String.fromCharCode(92)), so no editor/shell layer
 * can mangle the escaping again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { translateSql } from '../src/lib/db/dialect';

const a = translateSql("SELECT * FROM suppliers WHERE is_active = 1", 'postgresql');
const b = translateSql("SELECT 1 WHERE r.is_active = 1 AND x = 1", 'postgresql');
const c = translateSql("SELECT id FROM t WHERE is_active <> 0 LIMIT 1", 'postgresql');
const d = translateSql("SELECT 1 WHERE amount = 10", 'postgresql');

const ok =
  /is_active = true/.test(a) &&
  /r\.is_active = true/.test(b) &&
  /is_active <> false/.test(c) &&
  !/= true|= false|<> true|<> false/.test(d);

console.log('A:', a);
console.log('B:', b);
console.log('C:', c);
console.log('D:', d);
console.log(ok ? 'BOOLEAN REWRITES OK' : 'BOOLEAN REWRITES STILL BROKEN — repairing');

if (!ok) {
  const p = 'src/lib/db/dialect.ts';
  let src = readFileSync(p, 'utf8');
  const BS = String.fromCharCode(92);
  const w = (ch: string) => BS + BS + ch; // writes a single backslash + char into the file

  const body = [
    'function translateBooleanLiterals(sql: string): string {',
    '  let out = sql;',
    '  for (const col of BOOLEAN_COLUMNS) {',
    "    out = out.replace(new RegExp('" + w('b') + "' + col + '" + w('b') + w('s') + '*=' + w('s') + '*1' + w('b') + "', 'gi'), col + ' = true');",
    "    out = out.replace(new RegExp('" + w('b') + "' + col + '" + w('b') + w('s') + '*=' + w('s') + '*0' + w('b') + "', 'gi'), col + ' = false');",
    "    out = out.replace(new RegExp('" + w('b') + "' + col + '" + w('b') + w('s') + '*(!=|<>)' + w('s') + '*1' + w('b') + "', 'gi'), col + ' <> true');",
    "    out = out.replace(new RegExp('" + w('b') + "' + col + '" + w('b') + w('s') + '*(!=|<>)' + w('s') + '*0' + w('b') + "', 'gi'), col + ' <> false');",
    '  }',
    '  return out;',
    '}',
    '',
    '',
  ].join('\n');

  const startMark = 'function translateBooleanLiterals(sql: string): string {';
  const endMark = '/**\n * SQLite coerce';
  const start = src.indexOf(startMark);
  const end = src.indexOf(endMark);
  if (start === -1 || end === -1 || end <= start) throw new Error('repair marks not found');
  src = src.slice(0, start) + body + src.slice(end);
  writeFileSync(p, src);
  console.log('translateBooleanLiterals rewritten — re-run this script to verify.');
}
