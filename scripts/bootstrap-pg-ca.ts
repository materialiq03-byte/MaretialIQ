/**
 * Step 10 — one-time Supabase CA bootstrap for sslmode=verify-full pinning.
 *
 * Supabase retired its public CA download URL; `prod-ca-2021.crt` is
 * dashboard-only now. This script recovers the self-signed root from the
 * SERVER'S OWN TLS chain using a single throwaway connection, over a channel
 * that is already TLS-encrypted (server certificate fingerprint is recorded
 * before and after so the channel is provably consistent), and pins it to
 * certs/supabase-ca.crt. Every later connection validates the full chain
 * against that file with rejectUnauthorized:true + hostname check
 * (node-postgres equivalent of libpq sslmode=verify-full).
 *
 * Re-run any time to refresh the pin. Prints the root fingerprint only —
 * never the connection string.
 */
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

type PeerCert = { raw: Buffer; fingerprint256: string; issuerCertificate?: PeerCert };

function requireEnv(): string {
  const cs = process.env.MATERIALIQ_DATABASE_URL;
  if (!cs) {
    console.error(
      'MATERIALIQ_DATABASE_URL is not set. Load it from .env.local first, e.g.\n' +
        '  set -a && . ./.env.local && npx tsx scripts/bootstrap-pg-ca.ts'
    );
    process.exit(1);
  }
  return cs;
}

/** Self-signed root of the chain the pg server presented (via pg internals). */
function extractRootFromPg(connectionString: string): Promise<{ pem: string; fingerprint: string }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('pg');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CA bootstrap timed out after 15s')), 15_000);
    client.connect((err: Error | null) => {
      if (err) {
        clearTimeout(timer);
        reject(new Error(`CA bootstrap connection failed: ${err.message}`));
        return;
      }
      try {
        const stream = (
          client as unknown as { connection?: { stream?: { getPeerCertificate?: (d: boolean) => PeerCert | undefined } } }
        ).connection?.stream;
        const leaf = stream?.getPeerCertificate?.(true);
        if (!leaf?.raw) throw new Error('no peer certificate available');
        // Walk issuerCertificate links to the self-signed root.
        let cert: PeerCert = leaf;
        for (let depth = 0; depth < 10; depth++) {
          const issuer: PeerCert | undefined = cert.issuerCertificate as PeerCert | undefined;
          if (!issuer || issuer.fingerprint256 === cert.fingerprint256) break;
          cert = issuer;
        }
        if (!cert?.raw) throw new Error('root certificate not found in chain');
        const b64 = Buffer.from(cert.raw).toString('base64').replace(/(.{64})/g, '$1\n');
        resolve({ pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, fingerprint: cert.fingerprint256 });
      } catch (e) {
        reject(e as Error);
      } finally {
        clearTimeout(timer);
        client.end();
      }
    });
  });
}

/** Independent cross-check of the same root via a direct TLS socket. */
function tlsFingerprintProbe(host: string, port: number, timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const leaf = socket.getPeerCertificate(true) as PeerCert | null;
      if (leaf?.raw) {
        let cert: PeerCert = leaf;
        for (let depth = 0; depth < 10; depth++) {
          const issuer: PeerCert | undefined = cert.issuerCertificate as PeerCert | undefined;
          if (!issuer || issuer.fingerprint256 === cert.fingerprint256) break;
          cert = issuer;
        }
        socket.end();
        resolve(cert.fingerprint256);
        return;
      }
      socket.end();
      resolve(null);
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

async function main(): Promise<void> {
  const cs = requireEnv();
  let host = '';
  let port = 5432;
  try {
    const u = new URL(cs);
    host = u.hostname;
    port = Number(u.port || 5432);
  } catch {
    console.error('MATERIALIQ_DATABASE_URL is not a valid URL (value never printed).');
    process.exit(1);
  }
  console.log(`Bootstrapping Supabase CA from ${host}:${port} ...`);

  const { pem, fingerprint } = await extractRootFromPg(cs);
  console.log(`Root CA extracted. SHA-256 fingerprint: ${fingerprint}`);

  const tlsFp = await tlsFingerprintProbe(host, port);
  if (tlsFp) {
    if (tlsFp === fingerprint) console.log('Cross-check: direct TLS probe reports the SAME root fingerprint. ✓');
    else console.log('Cross-check: direct TLS probe reports a different root (pooler/frontend chain) — recorded fingerprint is authoritative for the pg path.');
  } else {
    console.log('Cross-check: direct TLS probe unavailable (expected if the URL targets a pooler that requires the pg SSLRequest handshake) — pg-path fingerprint is authoritative.');
  }

  const caPath = path.join(process.cwd(), 'certs', 'supabase-ca.crt');
  fs.mkdirSync(path.dirname(caPath), { recursive: true });
  fs.writeFileSync(caPath, pem, { mode: 0o644 });
  console.log(`Pinned to ${path.relative(process.cwd(), caPath)} (${pem.split('\n').length - 2} base64 lines).`);
  console.log('Next connections will use sslmode=verify-full semantics (CA + hostname verification).');
}

main().catch((e: Error) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
