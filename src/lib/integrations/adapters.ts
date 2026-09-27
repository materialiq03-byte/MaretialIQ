/**
 * Step 22 — Synthetic demo source adapters for the five prototype CPSEs.
 *
 * ⚠ SYNTHETIC / DEMO SOURCE FORMATS. These adapters model realistic-looking
 * heterogeneity (different header spellings, vocabularies, code formats) for
 * the prototype; they are NOT the proprietary schemas of the real CPSEs, and
 * this layer is NOT a live ERP connection (§36).
 *
 * Every adapter is a DECLARED profile over the same CpseSourceAdapter
 * contract: explicit header mapping, explicit vocabulary normalization,
 * identical validation rules. Different field names in, one canonical
 * contract out.
 */
import {
  codeConflictsWithDescription,
  normalizeVocabularyValue,
  buildCanonicalRow,
  type AdapterDiagnostic,
  type AdapterFieldMap,
  type CpseSourceAdapter,
  type SourceVocabulary,
} from './adapter-interface';
import type { CanonicalMaterialRow, SourceFormat } from './canonical-contract';

/** Per-CPSE profile pieces that differ between adapters. */
interface AdapterProfile {
  id: string;
  cpse: 'CPCL' | 'NTPC' | 'BHEL' | 'NLC' | 'SAIL';
  label: string;
  version: string;
  fieldMap: AdapterFieldMap;
  vocabulary: SourceVocabulary;
  sampleFile: string;
  description: string;
}

/**
 * Shared adapter engine — the ONLY code that turns declared profiles into
 * validating adapters. Identical rules for all five CPSEs: required code +
 * description, code format, description length, category/UOM normalization
 * with unknown tokens surfaced as warnings, code/description conflict
 * detection. Deterministic and side-effect free.
 */
function defineAdapter(profile: AdapterProfile, supportedFormats: readonly SourceFormat[]): CpseSourceAdapter {
  const codePattern = /^[A-Za-z0-9][A-Za-z0-9\-/_.]*$/;
  return {
    id: profile.id,
    cpse: profile.cpse,
    label: profile.label,
    version: profile.version,
    supportedFormats,
    fieldMap: profile.fieldMap,
    vocabulary: profile.vocabulary,
    sampleFile: profile.sampleFile,
    description: profile.description,
    validateAndTransform(values, rowNumber) {
      const diagnostics: AdapterDiagnostic[] = [];
      const map = profile.fieldMap;

      const code = (values[map.materialCode] ?? '').trim();
      const rawDescription = (values[map.description] ?? '').trim();

      // Required source identity: the material code IS the source record id.
      if (!code) {
        diagnostics.push({
          row: rowNumber, field: map.materialCode, code: 'REQUIRED_FIELD',
          message: `Material code is required (source field "${map.materialCode}").`,
          severity: 'ERROR',
        });
      } else if (!codePattern.test(code)) {
        diagnostics.push({
          row: rowNumber, field: map.materialCode, code: 'INVALID_VALUE',
          message: `Material code "${code}" contains unsupported characters (allowed: letters, digits, - / _ .).`,
          severity: 'ERROR',
        });
      }

      // Required description (raw source text; canonical trims later).
      if (!rawDescription) {
        diagnostics.push({
          row: rowNumber, field: map.description, code: 'REQUIRED_FIELD',
          message: `Description is required (source field "${map.description}").`,
          severity: 'ERROR',
        });
      } else if (rawDescription.length < 3) {
        diagnostics.push({
          row: rowNumber, field: map.description, code: 'INVALID_VALUE',
          message: `Description is shorter than 3 characters.`,
          severity: 'ERROR',
        });
      } else if (rawDescription.length > 500) {
        diagnostics.push({
          row: rowNumber, field: map.description, code: 'INVALID_VALUE',
          message: `Description exceeds 500 characters (${rawDescription.length}).`,
          severity: 'ERROR',
        });
      }

      // Source conflicts are surfaced, never silently resolved (§17): the
      // original values remain in the row and in sourceMetadata.
      if (code && rawDescription && codeConflictsWithDescription(code, rawDescription)) {
        diagnostics.push({
          row: rowNumber, field: map.materialCode, code: 'CONFLICT',
          message: `Row carries conflicting source identity: code "${code}" but description references a different code.`,
          severity: 'WARNING',
        });
      }

      // Declared source vocabulary normalization (source syntax → canonical).
      const category = normalizeVocabularyValue(profile.vocabulary.categories, values[map.category ?? '']);
      const subcategory = normalizeVocabularyValue(profile.vocabulary.categories, values[map.subcategory ?? '']);
      const uom = normalizeVocabularyValue(profile.vocabulary.uoms, values[map.uom ?? '']);
      if (map.category && (values[map.category] ?? '').trim() && !category) {
        diagnostics.push({
          row: rowNumber, field: map.category, code: 'MAPPING_ERROR',
          message: `Category value could not be normalized.`,
          severity: 'WARNING',
        });
      }

      if (diagnostics.some((d) => d.severity === 'ERROR')) {
        return { canonical: null, diagnostics };
      }

      const canonical: CanonicalMaterialRow = buildCanonicalRow(
        { id: profile.id, cpse: profile.cpse, fieldMap: profile.fieldMap },
        values,
        {
          materialCode: code,
          description: rawDescription,
          category,
          subcategory,
          manufacturer: (values[map.manufacturer ?? ''] ?? '').trim() || null,
          partNumber: (values[map.partNumber ?? ''] ?? '').trim() || null,
          material: (values[map.material ?? ''] ?? '').trim() || null,
          uom,
        },
        rowNumber,
      );
      return { canonical, diagnostics };
    },
  };
}

/** Vocabulary shared by several feeds below (source abbreviations → canonical). */
const COMMON_CATEGORY_VOCAB: Record<string, string> = {
  BRG: 'Bearings',
  BEARING: 'Bearings',
  BEARINGS: 'Bearings',
  VLV: 'Valves',
  VALVE: 'Valves',
  VALVES: 'Valves',
  MOT: 'Motors',
  MOTOR: 'Motors',
  MOTORS: 'Motors',
  PMP: 'Pumps',
  PUMP: 'Pumps',
  PUMPS: 'Pumps',
  FST: 'Fasteners',
  FSTNR: 'Fasteners',
  FASTENER: 'Fasteners',
  FASTENERS: 'Fasteners',
};

const COMMON_UOM_VOCAB: Record<string, string> = {
  NOS: 'NOS',
  EA: 'EA',
  N: 'NOS',
  MTRS: 'MTR',
  MTR: 'MTR',
  M: 'MTR',
  METER: 'MTR',
  KG: 'KG',
  KGS: 'KG',
  L: 'L',
  LTR: 'L',
  LITRE: 'L',
  PCS: 'PCS',
  PC: 'PCS',
  EACH: 'EA',
  SET: 'SET',
  SETS: 'SET',
};

export const CPCL_ADAPTER: CpseSourceAdapter = defineAdapter(
  {
    id: 'CPCL',
    cpse: 'CPCL',
    label: 'CPCL Material Master Feed',
    version: 'CPCL-MATERIAL-v1',
    // Synthetic profile: terse legacy petrochemical-style headers.
    fieldMap: {
      materialCode: 'MAT_CODE',
      description: 'MAT_DESC',
      category: 'MAT_GROUP',
      manufacturer: 'MFR',
      partNumber: 'PART_NO',
      material: 'MAT_GRADE',
      uom: 'UOM',
    },
    vocabulary: { categories: COMMON_CATEGORY_VOCAB, uoms: COMMON_UOM_VOCAB },
    sampleFile: 'data/cpse-feeds/CPCL-materials.csv',
    description: 'Synthetic CPCL feed: legacy terse headers (MAT_CODE/MAT_DESC/MAT_GROUP), abbreviated groups (BRG/VLV).',
  },
  ['CSV'],
);

export const NTPC_ADAPTER: CpseSourceAdapter = defineAdapter(
  {
    id: 'NTPC',
    cpse: 'NTPC',
    label: 'NTPC Material Master Feed',
    version: 'NTPC-MATERIAL-v1',
    // Synthetic profile: verbose ERP-style headers.
    fieldMap: {
      materialCode: 'MATERIAL_ID',
      description: 'MATERIAL_DESCRIPTION',
      category: 'MATERIAL_GROUP',
      subcategory: 'MATERIAL_SUBGROUP',
      manufacturer: 'MANUFACTURER',
      partNumber: 'OEM_PART',
      uom: 'BASE_UOM',
    },
    vocabulary: { categories: COMMON_CATEGORY_VOCAB, uoms: COMMON_UOM_VOCAB },
    sampleFile: 'data/cpse-feeds/NTPC-materials.csv',
    description: 'Synthetic NTPC feed: verbose ERP headers (MATERIAL_ID/MATERIAL_DESCRIPTION), OEM part references.',
  },
  ['CSV'],
);

export const BHEL_ADAPTER: CpseSourceAdapter = defineAdapter(
  {
    id: 'BHEL',
    cpse: 'BHEL',
    label: 'BHEL Item Master Feed',
    version: 'BHEL-MATERIAL-v1',
    // Synthetic profile: heavy-engineering "item" terminology.
    fieldMap: {
      materialCode: 'ITEM_CODE',
      description: 'ITEM_TEXT',
      category: 'ITEM_CATEGORY',
      subcategory: 'ITEM_SUBCLASS',
      manufacturer: 'MAKE',
      partNumber: 'PART_REFERENCE',
      material: 'MATERIAL_SPEC',
      uom: 'UNIT',
    },
    vocabulary: { categories: COMMON_CATEGORY_VOCAB, uoms: COMMON_UOM_VOCAB },
    sampleFile: 'data/cpse-feeds/BHEL-materials.csv',
    description: 'Synthetic BHEL feed: item-master terminology (ITEM_CODE/ITEM_TEXT), material spec column.',
  },
  ['CSV'],
);

export const NLC_ADAPTER: CpseSourceAdapter = defineAdapter(
  {
    id: 'NLC',
    cpse: 'NLC',
    label: 'NLC Material Feed',
    version: 'NLC-MATERIAL-v1',
    // Synthetic profile: minimal lignite-era headers with class codes.
    fieldMap: {
      materialCode: 'MATERIAL_NO',
      description: 'DESCRIPTION',
      category: 'CLASS',
      manufacturer: 'OEM',
      partNumber: 'OEM_PART_NO',
      uom: 'UOM',
    },
    vocabulary: { categories: COMMON_CATEGORY_VOCAB, uoms: COMMON_UOM_VOCAB },
    sampleFile: 'data/cpse-feeds/NLC-materials.csv',
    description: 'Synthetic NLC feed: minimal headers (MATERIAL_NO/DESCRIPTION), class codes (BRG/PMP).',
  },
  ['CSV'],
);

export const SAIL_ADAPTER: CpseSourceAdapter = defineAdapter(
  {
    id: 'SAIL',
    cpse: 'SAIL',
    label: 'SAIL Stock Item Feed',
    version: 'SAIL-MATERIAL-v1',
    // Synthetic profile: steel-plant stock-code terminology.
    fieldMap: {
      materialCode: 'STOCK_CODE',
      description: 'MATERIAL_NAME',
      category: 'MATERIAL_TYPE',
      subcategory: 'STEEL_GRADE',
      manufacturer: 'MAKE',
      partNumber: 'PART_NO',
      uom: 'UNIT_OF_MEASURE',
    },
    vocabulary: { categories: COMMON_CATEGORY_VOCAB, uoms: COMMON_UOM_VOCAB },
    sampleFile: 'data/cpse-feeds/SAIL-materials.csv',
    description: 'Synthetic SAIL feed: stock-item terminology (STOCK_CODE/MATERIAL_NAME), steel grade column.',
  },
  ['CSV'],
);

/** All shipped adapters (registry owns lookup; this list is the source). */
export const ALL_ADAPTERS: readonly CpseSourceAdapter[] = [
  CPCL_ADAPTER,
  NTPC_ADAPTER,
  BHEL_ADAPTER,
  NLC_ADAPTER,
  SAIL_ADAPTER,
];
