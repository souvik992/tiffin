// GSTIN checks: 15 characters = state code (2) + PAN (10) + entity number + 'Z' + check character.
// The check character is the GSTN mod-36 checksum, so a typo is caught before it is printed on bills.

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The check character for the first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36]!;
}

/** null when the GSTIN is valid, otherwise what is wrong (plain words). */
export function gstinProblem(g: string): string | null {
  if (g.length !== 15) return 'A GSTIN has 15 characters.';
  if (/[a-z]/.test(g)) return 'Type the GSTIN in capital letters.';
  if (!FORMAT.test(g)) return 'This is not in GSTIN format (2 digits, 10-character PAN, 1 character, Z, 1 character).';
  const state = Number(g.slice(0, 2));
  if (state < 1 || state > 38) return `The state code ${g.slice(0, 2)} at the start of the GSTIN does not exist.`;
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return 'The GSTIN has a typo: its last character (the check digit) does not match. Copy it again from the GST certificate.';
  return null;
}
