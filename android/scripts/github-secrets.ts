// Writes the four GitHub secrets for signed Android builds into a text file next to the key (outside the repository):
//   %USERPROFILE%\.tiffinpos\android-signing\github-secrets.txt
// Open it, paste each value into GitHub (repository Settings > Secrets and variables > Actions > New repository secret),
// then delete the file. Nothing is printed on screen. Run: node android/scripts/github-secrets.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(homedir(), '.tiffinpos', 'android-signing');
const jks = join(dir, 'release.jks'), props = join(dir, 'release.properties');
if (!existsSync(jks) || !existsSync(props)) { console.error(`No signing key in ${dir}.`); process.exit(1); }
const p = Object.fromEntries(readFileSync(props, 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const out = join(dir, 'github-secrets.txt');
writeFileSync(out, [
  'Add each as a repository secret on GitHub: Settings > Secrets and variables > Actions > New repository secret.',
  'Name on the first line of each block, value on the second. Delete this file afterwards.',
  '',
  'POS_ANDROID_KEYSTORE_B64', readFileSync(jks).toString('base64'), '',
  'POS_ANDROID_KEYSTORE_PASSWORD', p.storePassword ?? '', '',
  'POS_ANDROID_KEY_ALIAS', p.keyAlias ?? '', '',
  'POS_ANDROID_KEY_PASSWORD', p.keyPassword ?? '', '',
].join('\n'), { mode: 0o600 });
console.log(`Written: ${out} (open it, add the 4 secrets on GitHub, then delete it)`);
