/**
 * Synthetic demonstration dataset. All codes and descriptions are invented.
 * The BH-4410 record (6205-ZZ) is intentionally similar in wording to the
 * 6205-2RS records but carries a critical seal_type difference.
 */

export interface AttrSeed {
  name: string;
  value: string;
  unit?: string;
  critical?: boolean;
}

export interface MaterialSeed {
  code: string;
  description: string;
  category: string;
  subcategory?: string;
  manufacturer?: string;
  model?: string;
  materialType?: string;
  uom?: string;
  attrs: AttrSeed[];
}

export interface OrgSeed {
  code: string;
  name: string;
  materials: MaterialSeed[];
}

const bearingAttrs = (seal: string, extra: AttrSeed[] = []): AttrSeed[] => [
  { name: 'bore_diameter', value: '25', unit: 'mm', critical: true },
  { name: 'outer_diameter', value: '52', unit: 'mm' },
  { name: 'width', value: '15', unit: 'mm' },
  { name: 'seal_type', value: seal, critical: true },
  { name: 'bearing_type', value: 'Deep groove ball' },
  ...extra,
];

const valveAttrs: AttrSeed[] = [
  { name: 'nominal_size', value: '6', unit: 'inch', critical: true },
  { name: 'pressure_class', value: '600#', critical: true },
  { name: 'end_connection', value: 'RTJ flanged' },
  { name: 'body_material', value: 'ASTM A216 WCB' },
];

const motorAttrs: AttrSeed[] = [
  { name: 'rated_power', value: '75', unit: 'kW', critical: true },
  { name: 'voltage_rating', value: '415', unit: 'V', critical: true },
  { name: 'frequency', value: '50', unit: 'Hz' },
  { name: 'mounting', value: 'B3' },
];

const pumpAttrs: AttrSeed[] = [
  { name: 'suction_size', value: '200', unit: 'mm', critical: true },
  { name: 'discharge_size', value: '150', unit: 'mm', critical: true },
  { name: 'stage_count', value: '11' },
  { name: 'casing_material', value: 'Cast iron' },
];

const boltAttrs: AttrSeed[] = [
  { name: 'thread_size', value: 'M20', critical: true },
  { name: 'length', value: '80', unit: 'mm', critical: true },
  { name: 'material_grade', value: 'A2-70 (SS304)' },
];

export const SEED: OrgSeed[] = [
  {
    code: 'CPCL',
    name: 'Chennai Petroleum Corporation Ltd (synthetic demo)',
    materials: [
      {
        code: 'CP-1001',
        description: 'SKF BALL BEARING 6205-2RS',
        category: 'Bearings',
        subcategory: 'Ball bearings',
        manufacturer: 'SKF',
        model: '6205-2RS',
        materialType: 'Rolling element bearing',
        attrs: bearingAttrs('2RS (rubber contact seals both sides)'),
      },
      {
        code: 'CP-2005',
        description: 'GATE VALVE SLAB 6IN 600# RTJ',
        category: 'Valves',
        subcategory: 'Gate valves',
        manufacturer: 'L&T',
        materialType: 'Slab gate valve',
        attrs: valveAttrs,
      },
      {
        code: 'CP-3001',
        description: 'INDUCTION MOTOR 3PH 75KW 415V B3',
        category: 'Motors',
        subcategory: 'Induction motors',
        manufacturer: 'Siemens',
        model: '1LE1501',
        materialType: 'Induction motor',
        attrs: motorAttrs,
      },
      {
        code: 'CP-4001',
        description: 'CENTRIFUGAL PUMP 8X6-11 CAST IRON CASING',
        category: 'Pumps',
        subcategory: 'Centrifugal pumps',
        manufacturer: 'KSB',
        model: 'ETB-125',
        materialType: 'Centrifugal pump',
        attrs: pumpAttrs,
      },
      {
        code: 'CP-5001',
        description: 'HEX BOLT M20X80 SS304 WITH NUT',
        category: 'Fasteners',
        subcategory: 'Bolts',
        materialType: 'Hex bolt assembly',
        attrs: boltAttrs,
      },
    ],
  },
  {
    code: 'NTPC',
    name: 'NTPC Limited (synthetic demo)',
    materials: [
      {
        code: 'NT-8821',
        description: 'SKF DEEP GROOVE BRG 6205 2RS',
        category: 'Bearings',
        subcategory: 'Ball bearings',
        manufacturer: 'SKF',
        model: '6205-2RS',
        materialType: 'Rolling element bearing',
        attrs: bearingAttrs('2RS (rubber contact seals both sides)'),
      },
      {
        code: 'NT-7150',
        description: 'GATE VALVE SLAB 6IN 600# RTJ FLANGED END',
        category: 'Valves',
        subcategory: 'Gate valves',
        manufacturer: 'L&T',
        materialType: 'Slab gate valve',
        attrs: valveAttrs,
      },
      {
        code: 'NT-6320',
        description: 'SIEMENS 3PH IND MOT 75KW 415V B3 MOUNT',
        category: 'Motors',
        subcategory: 'Induction motors',
        manufacturer: 'Siemens',
        model: '1LE1501',
        materialType: 'Induction motor',
        attrs: motorAttrs,
      },
      {
        code: 'NT-9450',
        description: 'KSB CENTRIFUGAL PUMP 8X6-11 CI CASING',
        category: 'Pumps',
        subcategory: 'Centrifugal pumps',
        manufacturer: 'KSB',
        model: 'ETB-125',
        materialType: 'Centrifugal pump',
        attrs: pumpAttrs,
      },
      {
        code: 'NT-5510',
        description: 'HEX BOLT M20X80 SS304',
        category: 'Fasteners',
        subcategory: 'Bolts',
        materialType: 'Hex bolt assembly',
        attrs: boltAttrs,
      },
    ],
  },
  {
    code: 'SAIL',
    name: 'Steel Authority of India Ltd (synthetic demo)',
    materials: [
      {
        code: 'SL-7721',
        description: 'SKF BALL BRG 6205-2RS',
        category: 'Bearings',
        subcategory: 'Ball bearings',
        manufacturer: 'SKF',
        model: '6205-2RS',
        materialType: 'Rolling element bearing',
        attrs: bearingAttrs('2RS (rubber contact seals both sides)'),
      },
      {
        code: 'SL-3312',
        description: 'SLAB GATE VALVE 6IN 600# RTJ',
        category: 'Valves',
        subcategory: 'Gate valves',
        manufacturer: 'L&T',
        materialType: 'Slab gate valve',
        attrs: valveAttrs,
      },
      {
        code: 'SL-2298',
        description: 'SIEMENS 3PH INDUCTION MOTOR 75KW 415V B3',
        category: 'Motors',
        subcategory: 'Induction motors',
        manufacturer: 'Siemens',
        model: '1LE1501',
        materialType: 'Induction motor',
        attrs: motorAttrs,
      },
      {
        code: 'SL-6640',
        description: 'CENTRIFUGAL PUMP 8X6-11 CAST IRON CASING',
        category: 'Pumps',
        subcategory: 'Centrifugal pumps',
        manufacturer: 'KSB',
        model: 'ETB-125',
        materialType: 'Centrifugal pump',
        attrs: pumpAttrs,
      },
      {
        code: 'SL-8805',
        description: 'HEX BOLT M20X80 SS304',
        category: 'Fasteners',
        subcategory: 'Bolts',
        materialType: 'Hex bolt assembly',
        attrs: boltAttrs,
      },
    ],
  },
  {
    code: 'BHEL',
    name: 'Bharat Heavy Electricals Ltd (synthetic demo)',
    materials: [
      {
        // THE critical demo case: same bearing family, different seal config.
        code: 'BH-4410',
        description: 'SKF BEARING 6205-ZZ',
        category: 'Bearings',
        subcategory: 'Ball bearings',
        manufacturer: 'SKF',
        model: '6205-ZZ',
        materialType: 'Rolling element bearing',
        attrs: bearingAttrs('ZZ (metal shielded both sides)'),
      },
      {
        code: 'BH-2210',
        description: 'GATE VALVE SLAB 6IN 600# RTJ',
        category: 'Valves',
        subcategory: 'Gate valves',
        manufacturer: 'L&T',
        materialType: 'Slab gate valve',
        attrs: valveAttrs,
      },
      {
        code: 'BH-7730',
        description: 'SIEMENS 3PH INDUCTION MOTOR 75KW 415V B3',
        category: 'Motors',
        subcategory: 'Induction motors',
        manufacturer: 'Siemens',
        model: '1LE1501',
        materialType: 'Induction motor',
        attrs: motorAttrs,
      },
      {
        code: 'BH-9005',
        description: 'CENTRIFUGAL PUMP 8X6-11 CAST IRON CASING',
        category: 'Pumps',
        subcategory: 'Centrifugal pumps',
        manufacturer: 'KSB',
        model: 'ETB-125',
        materialType: 'Centrifugal pump',
        attrs: pumpAttrs,
      },
      {
        code: 'BH-1102',
        description: 'HEX BOLT M20X80 SS304',
        category: 'Fasteners',
        subcategory: 'Bolts',
        materialType: 'Hex bolt assembly',
        attrs: boltAttrs,
      },
    ],
  },
  {
    code: 'NLC',
    name: 'Neyveli Lignite Corporation (synthetic demo)',
    materials: [
      {
        code: 'NL-3310',
        description: 'SKF BALL BEARING 6205-2RS C3 CLEARANCE',
        category: 'Bearings',
        subcategory: 'Ball bearings',
        manufacturer: 'SKF',
        model: '6205-2RS C3',
        materialType: 'Rolling element bearing',
        attrs: bearingAttrs('2RS (rubber contact seals both sides)', [
          { name: 'internal_clearance', value: 'C3' },
        ]),
      },
      {
        code: 'NL-4420',
        description: 'GATE VALVE SLAB 6IN 600# RTJ',
        category: 'Valves',
        subcategory: 'Gate valves',
        manufacturer: 'L&T',
        materialType: 'Slab gate valve',
        attrs: valveAttrs,
      },
      {
        code: 'NL-6610',
        description: 'SIEMENS 3PH MOTOR 75KW 415V B3',
        category: 'Motors',
        subcategory: 'Induction motors',
        manufacturer: 'Siemens',
        model: '1LE1501',
        materialType: 'Induction motor',
        attrs: motorAttrs,
      },
      {
        code: 'NL-9920',
        description: 'CENTRIFUGAL PUMP 8X6-11 CAST IRON CASING',
        category: 'Pumps',
        subcategory: 'Centrifugal pumps',
        manufacturer: 'KSB',
        model: 'ETB-125',
        materialType: 'Centrifugal pump',
        attrs: pumpAttrs,
      },
      {
        code: 'NL-2214',
        description: 'HEX BOLTS M20X80 SS304',
        category: 'Fasteners',
        subcategory: 'Bolts',
        materialType: 'Hex bolt assembly',
        attrs: boltAttrs,
      },
    ],
  },
];
