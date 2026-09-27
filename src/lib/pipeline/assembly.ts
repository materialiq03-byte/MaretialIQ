/**
 * Assembly / kit-variant awareness — pure description-level detector.
 *
 * Some catalogue lines describe more (or less) than a bare component:
 * "HEX BOLT M20X80 SS304 WITH NUT" is a bolt sold with a nut — arguably the
 * same procurement item as the bare bolt, arguably not. Attribute extraction
 * cannot see that difference (both records carry identical thread/diameter/
 * grade attributes), so the distinction lives in the wording.
 *
 * `detectAssembly` recognises a configurable phrase vocabulary and returns a
 * structured signal (status + included components + the matched evidence).
 * `compareAssemblySignals` turns two signals into an AttributeComparison:
 *
 *   • same assembly state (+ same components)  → null (no signal, no impact)
 *   • different state or component sets        → CONFLICT row that the engine
 *     surfaces as a critical review signal — the pair goes to NEEDS_TECHNICAL
 *     _REVIEW, never auto-approved, and never NOT_A_MATCH (the extra component
 *     may or may not change procurement identity — a human decides).
 *
 * Pure functions: input descriptions are never mutated or rewritten anywhere.
 */

export type AssemblyStatus = 'standalone' | 'with_component' | 'kit' | 'assembly' | 'complete_set';

export interface AssemblySignal {
  status: AssemblyStatus;
  /** Canonical component nouns included beyond the base item (e.g. ['NUT']). */
  components: string[];
  /** The matched phrase(s) from the description — the preserved evidence. */
  evidence: string[];
}

/**
 * Components recognised after "WITH". Deliberately a closed, documented list —
 * extending it is a code-reviewed vocabulary change, not a silent behavior
 * shift. Compound "WITH NUT AND WASHER" yields both components.
 */
export const ASSEMBLY_COMPONENTS = [
  'NUT',
  'WASHER',
  'SEAL',
  'GASKET',
  'COUPLING',
  'ADAPTER',
  'BOLT',
  'SCREW',
  'FLANGE',
  'CAP',
  'SPRING',
  'KEY',
  'PLATE',
  'O-RING',
  'ORING',
] as const;

const WITH_COMPONENT_RE = new RegExp(
  `\\bWITH\\s+((?:${ASSEMBLY_COMPONENTS.join('|')})(?:\\s+(?:AND|\\+|&)\\s+(?:${ASSEMBLY_COMPONENTS.join('|')}))?)S?\\b`,
  'g'
);

const KIT_RE = /\bKITS?\b/g;
const ASSEMBLY_RE = /\bASSEMBL(?:Y|IES)\b/g;
const COMPLETE_SET_RE = /\bCOMPLETE\s+SETS?\b|\bSET\s+OF\b/g;

/**
 * Bare "SET" is deliberately NOT a trigger: it appears in product names
 * ("SET SCREW" = grub screw) and inside words ("OFFSET") with no kit meaning.
 * Only "COMPLETE SET" / "SET OF" indicate an assembly.
 */
export function detectAssembly(description: string | null | undefined): AssemblySignal {
  const text = (description ?? '').toUpperCase();
  if (!text) return { status: 'standalone', components: [], evidence: [] };

  const evidence: string[] = [];
  const components: string[] = [];

  for (const m of text.matchAll(WITH_COMPONENT_RE)) {
    evidence.push(m[0].trim());
    for (const part of m[1].split(/\s+(?:AND|\+|&)\s+/)) {
      const c = part.trim();
      if (c && !components.includes(c)) components.push(c);
    }
  }

  let status: AssemblyStatus = components.length > 0 ? 'with_component' : 'standalone';
  for (const [re, s] of [
    [COMPLETE_SET_RE, 'complete_set'],
    [KIT_RE, 'kit'],
    [ASSEMBLY_RE, 'assembly'],
  ] as Array<[RegExp, AssemblyStatus]>) {
    if (re.test(text)) {
      status = s;
      const hit = text.match(re);
      if (hit) evidence.push(hit[0].trim());
      break;
    }
  }

  return { status, components, evidence };
}

/** Human label used in comparisons and explanations ("Standalone", "With Nut", …). */
export function assemblyLabel(signal: AssemblySignal): string {
  switch (signal.status) {
    case 'standalone':
      return 'Standalone';
    case 'with_component':
      return `With ${signal.components.join(' + ') || 'component'}`;
    case 'kit':
      return 'Kit';
    case 'assembly':
      return 'Assembly';
    case 'complete_set':
      return 'Complete set';
  }
}

/**
 * Compare two assembly signals. Equal state + equal components → null (the
 * signal must never create a false conflict between identically-configured
 * records). Any difference → a CONFLICT comparison the engine routes to
 * human review. Values keep the human-readable labels as evidence.
 */
export function compareAssemblySignals(a: AssemblySignal, b: AssemblySignal): import('../matching/types').AttributeComparison | null {
  const sameStatus = a.status === b.status;
  const sameComponents =
    a.components.length === b.components.length && a.components.every((c) => b.components.includes(c));
  if (sameStatus && sameComponents) return null;

  return {
    attributeName: 'assembly_configuration',
    type: 'CONFLICT',
    valueA: assemblyLabel(a),
    valueB: assemblyLabel(b),
    critical: false,
    detail: `assembly/kit variation detected (${[...a.evidence, ...b.evidence].join(', ') || 'configuration differs'}) — the additional component may or may not change the procurement identity`,
  };
}
