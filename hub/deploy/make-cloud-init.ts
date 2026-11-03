// Writes a ready-to-paste cloud-init file with a fresh random admin key to %USERPROFILE%\.tiffinpos\hub\.
// The key stays out of the repo. Usage: node hub/deploy/make-cloud-init.ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(homedir(), '.tiffinpos', 'hub');
const outFile = join(outDir, 'oracle-cloud-init.yaml');
const keyFile = join(outDir, 'admin-key.txt');

if (existsSync(keyFile)) {
  console.error(`An admin key already exists in ${keyFile}. Delete it first to make a new one.`);
  process.exit(1);
}
const key = randomBytes(24).toString('base64url');
const template = readFileSync(join(here, 'oracle-cloud-init.yaml'), 'utf8');
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, template.replace('__HUB_ADMIN_KEY__', key));
writeFileSync(keyFile, `${key}\n`);
console.log(`Cloud-init file: ${outFile}`);
console.log(`Admin key (also in ${keyFile}): ${key}`);
