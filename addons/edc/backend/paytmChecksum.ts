import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Paytm's request checksum, the same steps as Paytm's own open-source "paytmchecksum" package (1.5.x), written here so
 * the POS needs no outside package: SHA-256 of "<body>|<salt>" in hex, plus the 4-character salt, encrypted with
 * AES-128-CBC using the merchant key and Paytm's fixed IV, in base64. The body is the exact JSON text sent.
 */
const IV = '@@@@&&&&####$$$$';

export function paytmChecksum(body: string, merchantKey: string, salt = randomBytes(3).toString('base64')): string {
  if (Buffer.byteLength(merchantKey) !== 16) throw new Error('The Paytm merchant key must be 16 characters.');
  const hash = createHash('sha256').update(`${body}|${salt}`).digest('hex') + salt;
  const c = createCipheriv('aes-128-cbc', merchantKey, IV);
  return c.update(hash, 'binary', 'base64') + c.final('base64');
}

/** For tests and Paytm callbacks: does the checksum belong to this body? */
export function verifyPaytmChecksum(body: string, merchantKey: string, checksum: string): boolean {
  try {
    const d = createDecipheriv('aes-128-cbc', merchantKey, IV);
    const hash = d.update(checksum, 'base64', 'binary') + d.final('binary');
    const salt = hash.slice(-4);
    return hash === createHash('sha256').update(`${body}|${salt}`).digest('hex') + salt;
  } catch { return false; }
}
