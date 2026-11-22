import { createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../store/db.ts';
import type { Actor, Ctx } from './ctx.ts';
import { assertPerm } from './permissions.ts';
import { getSetting, setSetting } from './settings.ts';
import { cloudLink } from './salesSync.ts';
import { loadInvoiceFull } from './invoiceView.ts';
import type { InvoiceFull } from './invoiceView.ts';

/**
 * Bills on WhatsApp through PosiNext Cloud (posinext-cloud hub/src/whatsapp-bills.ts). Two ways, both off unless used:
 *  - The QR on the bill (Settings > Receipt "WhatsApp bill QR", setting whatsapp_bill_qr = 1): the receipt prints
 *    "Get this bill on WhatsApp" and a QR to <cloud>/wa/bill/<code>; the bill goes up with its bill.printed sync event
 *    (payload.share). The customer scans, sends the message WhatsApp opens, and the cloud answers with the bill as a
 *    PDF (free for the shop: the customer wrote first). Only while this POS is linked with the cloud.
 *  - "Send on WhatsApp" on a bill (Orders): the backend posts the bill to the cloud, which sends it to the customer's
 *    number with an approved template (Meta charges per message).
 * A bill's code is 12 characters made from the invoice id and a secret kept in this database (whatsapp_bill_secret_key;
 * "_key" settings never leave the backend), so every reprint prints the same code without storing it.
 * Nothing here calculates money: the bill goes up with the figures it was printed with.
 */

export const WHATSAPP_QR = 'whatsapp_bill_qr';
const SECRET = 'whatsapp_bill_secret_key';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32: no I, O, 0 or 1

function secret(ctx: Ctx): string {
  let s = getSetting(ctx, SECRET);
  if (!s) { s = randomBytes(24).toString('hex'); setSetting(ctx, SECRET, s); }
  return s;
}

/** The bill's code on PosiNext Cloud (A-Z and 2-9 without I and O, 12 characters). */
export function shareCode(ctx: Ctx, invoiceId: string): string {
  const mac = createHmac('sha256', secret(ctx)).update(`whatsapp-bill:${invoiceId}`).digest();
  let code = '';
  for (let i = 0; i < 12; i++) code += CODE_CHARS[mac[i]! % 32];
  return code;
}

/** What a bill's QR opens, per invoice: null when the QR is off or this POS is not linked with the cloud. */
export function whatsappQrFor(ctx: Ctx): ((invoiceId: string) => string) | null {
  if (getSetting(ctx, WHATSAPP_QR) !== '1') return null;
  const link = cloudLink(ctx);
  if (!link) return null;
  const base = link.url.replace(/\/+$/, '');
  return (invoiceId) => `${base}/wa/bill/${shareCode(ctx, invoiceId)}`;
}

/** The cloud's bill shape (hub/src/bill-doc.ts BillDoc). */
export interface HubBill {
  store: { name: string; address?: string; phone?: string; gstin?: string; fssai?: string };
  title: string; billNo: string; issuedAt: string; orderLabel?: string;
  lines: Array<{ name: string; qty: string; amountPaise: number }>;
  summary: Array<{ label: string; amountPaise: number }>;
  totalPaise: number;
  payments: Array<{ mode: string; amountPaise: number }>;
  footer?: string;
}

const qtyText = (milli: number) => (milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toFixed(3).replace(/0+$/, ''));
const rate = (bp: number) => `${bp / 100}%`.replace(/(\.\d)0+%/, '$1%');
const MODE: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', WALLET: 'Wallet', CREDIT: 'Credit', OTHER: 'Other' };
const CHANNEL: Record<string, string> = { APP: 'App order', WEBSITE: 'Website order', SWIGGY: 'Swiggy', ZOMATO: 'Zomato' };

/** A tax invoice as the cloud keeps it: the printed figures (store details as at issue time), nothing recalculated. */
export function hubBill(f: InvoiceFull, footer: string): HubBill {
  const iv = f.invoice;
  // prices that include GST: the tax lines are part of the subtotal, so they say so (the figures stay as printed)
  const inclusive = iv.grossTotal - iv.discountTotal + iv.roundOff === iv.grandTotal && iv.cgst + iv.sgst + iv.igst + iv.cess > 0;
  const incl = inclusive ? ' (included)' : '';
  const summary: HubBill['summary'] = [{ label: 'Subtotal', amountPaise: iv.grossTotal }];
  if (iv.discountTotal > 0) summary.push({ label: 'Discount', amountPaise: -iv.discountTotal });
  const byRate = new Map<number, { cgst: number; sgst: number; igst: number }>();
  for (const l of f.lines) {
    const g = byRate.get(l.rateBp) ?? { cgst: 0, sgst: 0, igst: 0 };
    g.cgst += l.cgst; g.sgst += l.sgst; g.igst += l.igst;
    byRate.set(l.rateBp, g);
  }
  for (const [bp, g] of [...byRate].sort((a, b) => a[0] - b[0])) {
    if (g.igst > 0) summary.push({ label: `IGST @${rate(bp)}${incl}`, amountPaise: g.igst });
    else if (g.cgst + g.sgst > 0) summary.push({ label: `CGST @${rate(bp / 2)}${incl}`, amountPaise: g.cgst }, { label: `SGST @${rate(bp / 2)}${incl}`, amountPaise: g.sgst });
  }
  if (iv.cess > 0) summary.push({ label: `Cess${incl}`, amountPaise: iv.cess });
  if (iv.roundOff !== 0) summary.push({ label: 'Round off', amountPaise: iv.roundOff });
  const o = f.outlet;
  return {
    store: { name: o.name, ...(o.address ? { address: o.address } : {}), ...(o.phone ? { phone: o.phone } : {}), ...(o.gstin ? { gstin: o.gstin } : {}), ...(o.fssaiNo ? { fssai: o.fssaiNo } : {}) },
    title: 'Tax invoice',
    billNo: iv.invoiceNo,
    issuedAt: new Date(iv.issuedAt).toISOString(),
    orderLabel: [CHANNEL[f.orderChannel] ?? 'Counter', iv.tokenNo !== null ? `Token ${iv.tokenNo}` : ''].filter(Boolean).join(' · '),
    lines: f.lines.map((l) => ({ name: l.modifiers.length ? `${l.name} (${l.modifiers.map((m) => m.name).join(', ')})` : l.name, qty: qtyText(l.qtyMilli), amountPaise: l.lineTotal })),
    summary,
    totalPaise: iv.grandTotal,
    payments: f.payments.filter((p) => p.amount !== 0).map((p) => ({ mode: MODE[p.mode] ?? p.mode, amountPaise: p.amount })),
    ...(footer.trim() ? { footer: footer.trim() } : {}),
  };
}

/** 10 digits for an Indian mobile (+91 / 0 in front taken off), else null. */
export function indianMobile(s: string): string | null {
  let d = s.replace(/\D/g, '');
  if (d.length > 10) d = d.replace(/^(0091|91|0)/, '');
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

async function callCloud<T>(ctx: Ctx, path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  const link = cloudLink(ctx);
  if (!link) throw new AppError('NOT_LINKED', 'Link this POS with PosiNext Cloud first (Settings > Licence: sign in to your account).', 409);
  let res: Response;
  try {
    res = await fetchImpl(`${link.url.replace(/\/+$/, '')}${path}`, { ...init, signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${link.key}`, 'content-type': 'application/json' } });
  } catch {
    throw new AppError('OFFLINE', 'Could not reach PosiNext Cloud. Check the internet and try again.', 503);
  }
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok) {
    if (res.status === 401) throw new AppError('NOT_LINKED', 'This POS is no longer linked with PosiNext Cloud. Sign in to your account again in Settings > Licence.', 409);
    const msg = body?.error?.message ?? `PosiNext Cloud answered ${res.status}.`;
    throw new AppError(res.status === 400 ? 'VALIDATION' : res.status === 429 ? 'RATE_LIMITED' : 'WHATSAPP_FAILED', msg, res.status === 400 ? 400 : res.status === 429 ? 429 : 409);
  }
  return body as T;
}

/** Whether the cloud can send bills to a number now (the button shows only then). Never fails. */
export async function whatsappStatus(ctx: Ctx, actor: Actor, fetchImpl: typeof fetch = fetch): Promise<{ linked: boolean; bills: boolean }> {
  assertPerm(actor, 'invoice.read');
  if (!cloudLink(ctx)) return { linked: false, bills: false };
  const r = await callCloud<{ bills?: boolean }>(ctx, '/v1/pos/whatsapp', { method: 'GET' }, fetchImpl).catch(() => null);
  return { linked: true, bills: r?.bills === true };
}

/** Orders > a bill > "Send on WhatsApp": the cloud sends the bill to the customer's mobile. Writes nothing here. */
export async function sendBillOnWhatsApp(ctx: Ctx, actor: Actor, input: { invoiceId: string; mobile: string }, fetchImpl: typeof fetch = fetch) {
  assertPerm(actor, 'invoice.read');
  const mobile = indianMobile(input.mobile);
  if (!mobile) throw new AppError('VALIDATION', "Enter the customer's 10-digit mobile number.", 400);
  const f = loadInvoiceFull(ctx, input.invoiceId);
  if (f.invoice.docType !== 'TAX_INVOICE') throw new AppError('VALIDATION', 'Only bills can be sent on WhatsApp, not credit notes.', 400);
  if (f.invoice.status === 'CANCELLED') throw new AppError('VALIDATION', 'This bill is cancelled: it cannot be sent.', 400);
  const r = await callCloud<{ sent: boolean; to: string }>(ctx, `/v1/pos/bills/${shareCode(ctx, f.invoice.id)}/whatsapp`, {
    method: 'POST', body: JSON.stringify({ mobile, billId: f.invoice.id, bill: hubBill(f, getSetting(ctx, 'receipt_footer')) }),
  }, fetchImpl);
  return { sent: true, to: r.to, invoiceNo: f.invoice.invoiceNo };
}
