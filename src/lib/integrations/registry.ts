/**
 * Step 22 — Source adapter registry (§5): the ONE resolution mechanism.
 *
 * Adapters are never hard-coded at call sites; callers resolve by id or by
 * CPSE, and receive versioned, declared profiles. Repeated registration of
 * the same id fails loudly (fail-closed) rather than silently shadowing.
 */
import { errors } from '../errors';
import { ALL_ADAPTERS } from './adapters';
import type { CpseSourceAdapter } from './adapter-interface';
import type { CpseCode } from './canonical-contract';

const registry = new Map<string, CpseSourceAdapter>();

/** Register once at module load — shipped adapters are always available. */
for (const adapter of ALL_ADAPTERS) {
  if (registry.has(adapter.id)) {
    throw new Error(`integration registry: duplicate adapter id "${adapter.id}"`);
  }
  for (const other of registry.values()) {
    if (other.cpse === adapter.cpse) {
      throw new Error(`integration registry: adapter "${other.id}" already owns CPSE ${adapter.cpse}`);
    }
  }
  registry.set(adapter.id, adapter);
}

/** Resolve an adapter by its stable id, or fail closed. */
export function getAdapterRequired(adapterId: string): CpseSourceAdapter {
  const adapter = registry.get(adapterId);
  if (!adapter) throw errors.notFound(`Source adapter "${adapterId}"`);
  return adapter;
}

/** Resolve the adapter owning a CPSE (one adapter per CPSE by design). */
export function getAdapterByCpseRequired(cpse: string): CpseSourceAdapter {
  for (const adapter of registry.values()) {
    if (adapter.cpse === cpse) return adapter;
  }
  throw errors.notFound(`Source adapter for CPSE "${cpse}"`);
}

/** All registered adapters (stable order). */
export function listAdapters(): CpseSourceAdapter[] {
  return [...registry.values()];
}

/** Registry entry in API shape (§29): no secrets, no infrastructure config. */
export function describeAdapter(adapter: CpseSourceAdapter) {
  return {
    id: adapter.id,
    cpse: adapter.cpse,
    label: adapter.label,
    adapter: adapter.version,
    version: adapter.version,
    supportedFormats: [...adapter.supportedFormats],
    status: 'ACTIVE' as const,
    fieldMapping: Object.entries(adapter.fieldMap).map(([canonicalField, sourceField]) => ({
      sourceField,
      canonicalField,
    })),
    sampleFile: adapter.sampleFile,
    description: adapter.description,
  };
}
