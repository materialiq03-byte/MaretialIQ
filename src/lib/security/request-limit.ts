/**
 * Step 25 — bounded request-body reading for JSON APIs.
 *
 * Next.js route handlers buffer request bodies before `request.json()` runs;
 * there is no per-handler body cap in the framework. This helper enforces an
 * explicit server-side cap so a hostile client cannot stream an unbounded
 * payload into memory, and returns a stable 413 when the cap is exceeded.
 */
import { errors, AppError } from '../errors';

/** Default cap: the largest legitimate API payload here is a review decision
 *  or rule mutation (a few KB). 1 MB is a generous, conservative ceiling. */
export const DEFAULT_MAX_JSON_BYTES = 1_000_000;

/** Read the request body as text, failing safely when over the cap. */
export async function readBoundedJson<T>(request: Request, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<T> {
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader) {
    const declared = parseInt(lengthHeader, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw errors.payloadTooLarge();
    }
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw errors.badRequest('Request body is required.');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw errors.payloadTooLarge();
    }
    chunks.push(value);
  }
  try {
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    if (text.length === 0) throw errors.badRequest('Request body is required.');
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw errors.badRequest('Request body is not valid JSON.');
  }
}

/**
 * Read the body with a fallback for ABSENT/UNPARSEABLE bodies (preserves the
 * historical routes' tolerant contract: missing JSON → fallback → downstream
 * zod validation returns the 400), but a body over the size cap stays a fatal
 * 413 — tolerant parsing must not become a size-bypass.
 */
export async function readBoundedJsonOr<T>(request: Request, fallback: T, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<T> {
  try {
    return await readBoundedJson<T>(request, maxBytes);
  } catch (err) {
    if (err instanceof AppError && err.status === 413) throw err;
    return fallback;
  }
}
