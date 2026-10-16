import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/**
 * Add-on packages: a folder with manifest.json, the files it lists, and an Ed25519 signature over the manifest.
 * The POS only runs add-ons signed by a key it trusts (src/addons/trust.ts), and only the exact bytes the manifest lists.
 */

export interface AddonManifest {
  id: string;
  name: string;
  version: string;
  /** Oldest POS version the add-on works with. */
  minPosVersion: string;
  description?: string;
  /** Relative file names inside the package. */
  backend?: string;
  ui?: string;
  /** Every file in the package and its SHA-256 (hex). */
  files: Record<string, string>;
  /** Base64 Ed25519 signature over canonical(manifest without "signature"). */
  signature?: string;
}

export const ADDON_ID = /^[a-z][a-z0-9-]{1,40}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/; // flat names only: no folders, no "..", no drive letters

/** JSON with sorted keys and no spaces, so the signed bytes are the same on every machine. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const sha256hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** -1, 0 or 1. Pre-release suffixes are ignored (0.2.0-dev counts as 0.2.0). */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a), pb = SEMVER.exec(b);
  if (!pa || !pb) return NaN;
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/** Checks the shape; returns the problem in plain words, or null. */
export function manifestProblem(m: unknown): string | null {
  if (!m || typeof m !== 'object') return 'manifest.json is not an object';
  const x = m as Record<string, unknown>;
  if (typeof x.id !== 'string' || !ADDON_ID.test(x.id)) return 'the add-on id is not valid';
  if (typeof x.name !== 'string' || !x.name.trim() || x.name.length > 60) return 'the add-on name is not valid';
  if (typeof x.version !== 'string' || !SEMVER.test(x.version)) return 'the add-on version is not valid';
  if (typeof x.minPosVersion !== 'string' || !SEMVER.test(x.minPosVersion)) return 'minPosVersion is not valid';
  if (!x.files || typeof x.files !== 'object') return 'the file list is missing';
  for (const [f, h] of Object.entries(x.files as Record<string, unknown>)) {
    if (!FILE.test(f) || f === 'manifest.json') return `the file name "${f}" is not allowed`;
    if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return `the fingerprint of ${f} is not valid`;
  }
  for (const k of ['backend', 'ui'] as const) if (x[k] !== undefined && (typeof x[k] !== 'string' || !((x[k] as string) in (x.files as object)))) return `${k} must be one of the listed files`;
  return null;
}

export function signManifest(m: Omit<AddonManifest, 'signature'>, privateKeyPem: string): AddonManifest {
  const signature = sign(null, Buffer.from(canonical(m)), createPrivateKey(privateKeyPem)).toString('base64');
  return { ...m, signature };
}

/** True when one of the trusted public keys (PEM) signed this manifest. */
export function signatureOk(m: AddonManifest, trustedPublicKeys: readonly string[]): boolean {
  if (typeof m.signature !== 'string') return false;
  const { signature, ...rest } = m;
  const data = Buffer.from(canonical(rest));
  const sig = Buffer.from(signature, 'base64');
  return trustedPublicKeys.some((pem) => { try { return verify(null, data, createPublicKey(pem), sig); } catch { return false; } });
}
