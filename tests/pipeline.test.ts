/**
 * Pipeline tests: normalization, classification, extraction, units, quality.
 * Plain runnable assertions — `npx tsx tests/pipeline.test.ts` — kept
 * framework-free to match the project's zero-config toolchain.
 */
import assert from 'node:assert/strict';
import { normalizeDescription, attachUnits, normalizeTokens } from '../src/lib/pipeline/normalize';
import { classifyDescription } from '../src/lib/pipeline/classify';
import { extractAttributes } from '../src/lib/pipeline/extract';
import { parseQuantity, canonicalUnit, isKnownUnit } from '../src/lib/pipeline/units';
import { evaluateQuality } from '../src/lib/pipeline/quality';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  FAIL - ${name}`);
  }
}

/* ------------------------- 1. abbreviation expansion ---------------------- */

test('BRG → BEARING expansion', () => {
  assert.equal(normalizeDescription('SKF DEEP GROOVE BRG 6205 2RS'), 'SKF DEEP GROOVE BEARING 6205 2RS');
});

test('BEAR → BEARING expansion', () => {
  assert.equal(normalizeDescription('SKF BEAR 6205'), 'SKF BEARING 6205');
});

test('MTR / PMP / VLV expansions', () => {
  assert.equal(normalizeDescription('MTR 75KW'), 'MOTOR 75 KW');
  assert.equal(normalizeDescription('CENTRIFUGAL PMP 8X6-11'), 'CENTRIFUGAL PUMP 8X6-11');
  assert.equal(normalizeDescription('GATE VLV 6IN'), 'GATE VALVE 6 IN');
});

test('abbreviation replacement is token-exact (no substring damage)', () => {
  // "BRG6205" is a single compact code token: it must NOT become BEARING6205
  // mid-token via blind substitution — but it does match the <=3-char
  // substring rule in classification. Normalization keeps it intact.
  assert.equal(normalizeDescription('BRG6205'), 'BRG6205');
  assert.equal(normalizeDescription('6205-2RS'), '6205-2RS');
  assert.equal(normalizeDescription('M20X80'), 'M20X80');
  assert.equal(normalizeDescription('8X6-11'), '8X6-11');
});

/* --------------------------- 2. spacing variants -------------------------- */

test('different spacing collapses consistently', () => {
  assert.equal(
    normalizeDescription('  SKF   BALL   BEARING    6205-2RS  '),
    'SKF BALL BEARING 6205-2RS'
  );
});

test('punctuation variation normalizes identically', () => {
  assert.equal(normalizeDescription('SKF Ball Bearing, 6205-2RS.'), 'SKF BALL BEARING 6205-2RS');
  assert.equal(normalizeDescription('SKF/BALL/BEARING/6205-2RS'), 'SKF BALL BEARING 6205-2RS');
});

test('case differences normalize identically', () => {
  assert.equal(normalizeDescription('skf ball bearing 6205-2rs'), normalizeDescription('SKF BALL BEARING 6205-2RS'));
});

/* ------------------------ 3. bearing extraction --------------------------- */

test('6205-2RS extraction (compound token)', () => {
  const attrs = extractAttributes('Bearings', normalizeDescription('SKF BALL BEARING 6205-2RS'));
  const series = attrs.find((a) => a.attributeName === 'series');
  const seal = attrs.find((a) => a.attributeName === 'seal_type');
  const bore = attrs.find((a) => a.attributeName === 'bore_diameter');
  assert.equal(series?.normalizedValue, '6205');
  assert.equal(seal?.value, '2RS');
  assert.equal(bore?.normalizedValue, '25');
  assert.equal(seal?.isCritical, true);
});

test('6205 2RS extraction (spacing variant)', () => {
  const attrs = extractAttributes('Bearings', normalizeDescription('SKF DEEP GROOVE BRG 6205 2RS'));
  const series = attrs.find((a) => a.attributeName === 'series');
  const seal = attrs.find((a) => a.attributeName === 'seal_type');
  assert.equal(series?.normalizedValue, '6205');
  assert.equal(seal?.value, '2RS');
  assert.equal(attrs.find((a) => a.attributeName === 'bearing_type')?.normalizedValue, 'DEEP_GROOVE_BALL');
  assert.equal(attrs.find((a) => a.attributeName === 'manufacturer')?.value, 'SKF');
});

test('6205-ZZ extraction (shield code in compound token)', () => {
  const attrs = extractAttributes('Bearings', normalizeDescription('SKF BEARING 6205-ZZ'));
  const series = attrs.find((a) => a.attributeName === 'series');
  const seal = attrs.find((a) => a.attributeName === 'seal_type');
  assert.equal(series?.normalizedValue, '6205');
  assert.equal(seal?.value, 'ZZ');
  // No explicit type wording: 6xxx series implies deep groove.
  assert.equal(attrs.find((a) => a.attributeName === 'bearing_type')?.normalizedValue, 'DEEP_GROOVE_BALL');
});

test('2RS vs ZZ produce distinct seal_type values', () => {
  const rs = extractAttributes('Bearings', normalizeDescription('SKF BALL BEARING 6205-2RS')).find(
    (a) => a.attributeName === 'seal_type'
  );
  const zz = extractAttributes('Bearings', normalizeDescription('SKF BEARING 6205-ZZ')).find(
    (a) => a.attributeName === 'seal_type'
  );
  assert.notEqual(rs?.normalizedValue, zz?.normalizedValue);
  assert.equal(rs?.normalizedValue, '2RS');
  assert.equal(zz?.normalizedValue, 'ZZ');
});

test('missing attributes: unknown category yields none (no fabrication)', () => {
  const attrs = extractAttributes('Uncategorised', normalizeDescription('OFFICE CHAIR REVOLVING'));
  assert.equal(attrs.length, 0);
  // Missing seal on a bearing description: attribute simply absent, never dummy.
  const attrs2 = extractAttributes('Bearings', normalizeDescription('PLAIN STEEL PLATE'));
  assert.equal(attrs2.some((a) => a.attributeName === 'seal_type'), false);
});

test('motor extraction: power/voltage/frequency/phase/mounting', () => {
  const attrs = extractAttributes('Motors', normalizeDescription('SIEMENS 3PH INDUCTION MOTOR 75KW 415V B3'));
  const get = (n: string) => attrs.find((a) => a.attributeName === n);
  assert.equal(get('power_rating')?.normalizedValue, '75');
  assert.equal(get('power_rating')?.unit, 'KW');
  assert.equal(get('voltage_rating')?.normalizedValue, '415');
  assert.equal(get('voltage_rating')?.unit, 'V');
  assert.equal(get('frequency'), undefined); // not present in the text
  assert.equal(get('phase')?.normalizedValue, 'THREE');
  assert.equal(get('mounting')?.value, 'B3');
  assert.equal(get('motor_type')?.normalizedValue, 'INDUCTION');
});

test('valve extraction: nominal size, pressure class, connection', () => {
  const attrs = extractAttributes('Valves', normalizeDescription('GATE VALVE SLAB 6IN 600# RTJ'));
  const get = (n: string) => attrs.find((a) => a.attributeName === n);
  assert.equal(get('nominal_size')?.normalizedValue, '6');
  assert.equal(get('nominal_size')?.unit, 'IN');
  assert.equal(get('pressure_class')?.value, '600#');
  assert.equal(get('end_connection')?.value, 'RTJ');
  assert.equal(get('valve_type')?.normalizedValue, 'GATE');
});

test('pump extraction: size designation and casing material', () => {
  const attrs = extractAttributes('Pumps', normalizeDescription('CENTRIFUGAL PUMP 8X6-11 CAST IRON CASING'));
  const get = (n: string) => attrs.find((a) => a.attributeName === n);
  assert.equal(get('suction_size')?.normalizedValue, '8');
  assert.equal(get('suction_size')?.unit, 'IN');
  assert.equal(get('discharge_size')?.normalizedValue, '6');
  assert.equal(get('stage_count')?.value, '11');
  assert.equal(get('casing_material')?.normalizedValue, 'CAST_IRON');
});

test('fastener extraction: thread, diameter, length, grade', () => {
  const attrs = extractAttributes('Fasteners', normalizeDescription('HEX BOLT M20X80 SS304'));
  const get = (n: string) => attrs.find((a) => a.attributeName === n);
  assert.equal(get('fastener_type')?.normalizedValue, 'HEX_BOLT');
  assert.equal(get('thread_specification')?.value, 'M20X80');
  assert.equal(get('diameter')?.normalizedValue, '20');
  assert.equal(get('diameter')?.unit, 'MM');
  assert.equal(get('length')?.normalizedValue, '80');
  assert.equal(get('material_grade')?.value, 'SS304');
});

test('unit normalization: 220V / 220 V / 220 volts identical', () => {
  assert.equal(normalizeDescription('415V'), '415 V');
  assert.equal(normalizeDescription('415 V'), '415 V');
  assert.equal(normalizeDescription('415 VOLTS'), '415 V');
  const q1 = parseQuantity('220V');
  assert.equal(q1?.value, '220');
  assert.equal(q1?.unit, 'V');
  const q2 = parseQuantity('220 volts');
  assert.equal(q2?.value, '220');
  assert.equal(q2?.unit, 'V');
});

test('unit normalization: no unsafe conversions performed', () => {
  // 1 IN must NOT become 25 (mm) — magnitudes are never converted.
  assert.equal(normalizeDescription('6IN'), '6 IN');
  assert.equal(parseQuantity('6 IN')?.value, '6');
  assert.equal(canonicalUnit('VOLTS'), 'V');
  assert.equal(isKnownUnit('KV'), false);
});

/* -------------------------- classification tests -------------------------- */

test('classification: BRG → Bearings', () => {
  assert.equal(classifyDescription(normalizeDescription('SKF DEEP GROOVE BRG 6205 2RS')).category, 'Bearings');
});

test('classification: VALVE/VLV → Valves', () => {
  assert.equal(classifyDescription(normalizeDescription('GATE VLV 6IN 600# RTJ')).category, 'Valves');
});

test('classification: MOTOR/MTR → Motors', () => {
  assert.equal(classifyDescription(normalizeDescription('3PH IND MTR 75KW')).category, 'Motors');
});

test('classification: PUMP/PMP → Pumps', () => {
  assert.equal(classifyDescription(normalizeDescription('CENTRIFUGAL PMP 8X6-11')).category, 'Pumps');
});

test('classification: BOLT/NUT → Fasteners', () => {
  assert.equal(classifyDescription(normalizeDescription('HEX BOLTS M20X80 SS304')).category, 'Fasteners');
});

test('classification: unknown → null with null confidence', () => {
  const r = classifyDescription(normalizeDescription('OFFICE CHAIR REVOLVING'));
  assert.equal(r.category, null);
  assert.equal(r.confidence, null);
});

test('classification confidence is rule-derived (unambiguous = 100, contested lower)', () => {
  const clean = classifyDescription(normalizeDescription('GATE VALVE SLAB 6IN 600# RTJ'));
  assert.equal(clean.confidence, 100);
  const contested = classifyDescription(normalizeDescription('VALVE FOR PUMP STATION'));
  assert.ok((contested.confidence ?? 100) < 100);
});

/* --------------------------- invalid input tests -------------------------- */

test('invalid material input: empty description', () => {
  assert.equal(normalizeDescription(''), '');
  const q = evaluateQuality({
    originalDescription: '',
    normalizedDescription: '',
    category: null,
    attributes: [],
  });
  assert.equal(q.status, 'invalid');
});

test('invalid material input: over-long junk passes through unchanged, quality flags it', () => {
  const junk = '!!!';
  assert.equal(normalizeDescription(junk), '');
  const q = evaluateQuality({
    originalDescription: junk,
    normalizedDescription: '',
    category: null,
    attributes: [],
  });
  assert.equal(q.status, 'invalid');
});

test('incomplete: category known but critical attributes missing', () => {
  const q = evaluateQuality({
    originalDescription: 'SKF BEARING UNKNOWN MODEL',
    normalizedDescription: 'SKF BEARING UNKNOWN MODEL',
    category: 'Bearings',
    attributes: [],
  });
  assert.equal(q.status, 'incomplete');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
