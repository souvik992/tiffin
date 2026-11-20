// CI only: after a failed end-to-end test, turns the end of its output and the app's log into GitHub annotations,
// which show on the run's summary page (job logs need admin rights to download; annotations do not).
// Usage: node scripts/ci-report.mjs <test output file>
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tail = (text, lines) => text.split(/\r?\n/).slice(-lines).join('\n');
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const annotate = (title, text) => console.log(`::error title=${title}::${esc(text.slice(-30_000))}`);

const out = process.argv[2];
if (out && existsSync(out)) annotate('End-to-end test output', tail(readFileSync(out, 'utf8'), 80));

// the newest test data folder (pos-desktop-*), kept by the test when it fails
const homes = readdirSync(tmpdir()).filter((n) => n.startsWith('pos-desktop-')).map((n) => join(tmpdir(), n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const log = homes.map((h) => join(h, 'logs', 'pos.log')).find((f) => existsSync(f));
annotate('POS log', log ? tail(readFileSync(log, 'utf8'), 60) : `no pos.log (test folders: ${homes.join(', ') || 'none'})`);
