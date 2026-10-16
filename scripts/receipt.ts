// Checks a receipt design file (.tiffinreceipt) and shows the bill it prints, using a sample sale. No database needed.
// Usage: npm run receipt -- <file.tiffinreceipt> [--width 58|80] [--credit] [--duplicate] [--upi shop@upi]
// Exit code 0 when the file is valid, 1 when it is not (the reasons are listed).
import { readFileSync } from 'node:fs';
import { parseEscPos } from '../src/services/printing/virtual.ts';
import { buildReceipt, sampleReceiptData } from '../src/services/printing/receipt.ts';
import { parseTemplate } from '../src/services/printing/receiptTemplate.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && !a.includes('@'));
if (!file) {
  console.error('Usage: npm run receipt -- <file.tiffinreceipt> [--width 58|80] [--credit] [--duplicate] [--upi shop@upi]');
  process.exit(2);
}
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const width = Number(opt('--width') ?? 80);
if (width !== 58 && width !== 80) { console.error('--width must be 58 or 80'); process.exit(2); }

const parsed = parseTemplate(readFileSync(file, 'utf8'));
if (!parsed.ok) {
  console.error(`${file} cannot be used:`);
  for (const e of parsed.errors) console.error(`  - ${e}`);
  process.exit(1);
}
const data = sampleReceiptData({ name: 'Demo Burger House', address: '12 MG Road, Bengaluru 560001', gstin: '29ABCDE1234F1Z5', fssaiNo: '11223344556677', phone: '9876543210' }, Date.now());
if (args.includes('--credit')) { data.invoice.docType = 'CREDIT_NOTE'; data.invoice.originalInvoiceNo = 'A1/26-27/000123'; data.payments = [{ mode: 'CASH', amount: data.invoice.grandTotal, tendered: null }]; }
const cols = width === 58 ? 32 : 48;
const bytes = buildReceipt(data, { cols, copyNo: args.includes('--duplicate') ? 2 : 1, footer: 'Thank you! Visit again.', drawer: false, sample: false, template: parsed.template, upiId: opt('--upi') });
const lines = parseEscPos(bytes, { widen: true }).lines;
console.log(`"${parsed.template.name}" is valid. Sample bill on ${width} mm paper (${cols} characters):\n`);
console.log(`+${'-'.repeat(cols)}+`);
for (const l of lines) console.log(`|${l.padEnd(cols)}|`);
console.log(`+${'-'.repeat(cols)}+`);
