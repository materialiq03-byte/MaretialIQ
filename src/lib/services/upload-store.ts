/**
 * Disk-backed upload store (Step 5).
 *
 * Uploaded import files are persisted under DATA_DIR/uploads/import-<id>/ so
 * that (a) the browser does not have to re-upload for re-validation and
 * (b) large imports never need their full row set duplicated inside the
 * data_imports.row_report JSON blob — the file on disk IS the row store, and
 * the report keeps only bounded summary/diagnostic data.
 *
 * Filenames are sanitized and path-traversal-safe (basename + charset filter).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { getDbFile } from '../db/client';

function safeName(fileName: string): string {
  return path.basename(fileName).replace(/[^\w.\- ]+/g, '_');
}

/**
 * Uploads live next to the ACTIVE database file (DATA_DIR in production;
 * the temp test DB's directory under tests). An injected test connection
 * opened directly has no known path, so fall back to DATA_DIR.
 */
function uploadsRoot(): string {
  const dbFile = getDbFile();
  const base = dbFile ? path.dirname(dbFile) : config.dataDir;
  return path.join(base, 'uploads');
}

function dirFor(dataImportId: number): string {
  return path.join(uploadsRoot(), `import-${dataImportId}`);
}

export function storeUpload(dataImportId: number, fileName: string, data: ArrayBuffer | Buffer): string {
  const dir = dirFor(dataImportId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeName(fileName));
  fs.writeFileSync(dest, Buffer.isBuffer(data) ? data : Buffer.from(data));
  return dest;
}

export function readStoredUpload(dataImportId: number, fileName: string): Buffer | null {
  const p = path.join(dirFor(dataImportId), safeName(fileName));
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}
