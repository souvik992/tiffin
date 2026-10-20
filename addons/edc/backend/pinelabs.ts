// Pine Labs card machines (Plutus).
//  - Wireless: Pine Labs Cloud Integration over the internet: upload the bill amount, the machine shows it, ask for
//    the status, cancel while the customer has not entered the PIN. developer.pinelabs.com/in/instore/cloud-integration
//  - Wired: Pine Labs' PAD Controller (their free Windows program) talks to the machine over USB, serial or a LAN cable;
//    billing software sends it framed CSV messages on TCP port 8082 (Wired Integration document: 0x1000 source,
//    0x0997 function, big-endian length, CSV, 0xFF). The controller may run on this PC or another PC in the shop.
import net from 'node:net';
import { last4, paidByOf, TerminalError } from './types.ts';
import type { Connector, SaleRequest, TerminalResult } from './types.ts';

export const PINE_TEST_URL = 'https://www.plutuscloudserviceuat.in:8201';
export const PINE_LIVE_URL = 'https://www.plutuscloudservice.in:8201';
const API = '/API/CloudBasedIntegration/V1';

export interface PineCloudConfig { merchantId: string; storeId: string; clientId?: string; env: 'test' | 'live' }
export interface PineWiredConfig { host: string; port?: number }

type Fetch = typeof fetch;
const MODE: Record<string, string> = { CARD: '1', UPI: '10', ANY: '0' };

/** Words in Pine Labs' messages that mean the payment is over without money taken. Anything else non-final waits. */
const ENDED = /DECLIN|FAIL|CANCEL|VOID|EXPIR|REJECT|INVALID|NOT ALLOWED|TIMEOUT|TIMED OUT/i;

export class PineCloud implements Connector {
  private cfg: PineCloudConfig; private token: string; private f: Fetch;
  constructor(cfg: PineCloudConfig, securityToken: string, f: Fetch = fetch) { this.cfg = cfg; this.token = securityToken; this.f = f; }

  private async post(op: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const base = this.cfg.env === 'live' ? PINE_LIVE_URL : PINE_TEST_URL;
    let r: Response;
    try {
      r = await this.f(`${base}${API}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    } catch { throw new TerminalError('Could not reach Pine Labs. Check the internet connection.'); }
    const j = await r.json().catch(() => null) as Record<string, unknown> | null;
    if (!j || j.ResponseCode === undefined) throw new TerminalError(`Pine Labs answered ${r.status} without a result.`);
    return j;
  }

  private who() {
    return { MerchantID: Number(this.cfg.merchantId), SecurityToken: this.token, StoreId: Number(this.cfg.storeId), ...(this.cfg.clientId ? { ClientId: Number(this.cfg.clientId) } : {}) };
  }

  async start(req: SaleRequest): Promise<TerminalResult> {
    const j = await this.post('UploadBilledTransaction', {
      TransactionNumber: req.merchantTxnId, SequenceNumber: 1, AllowedPaymentMode: MODE[req.mode], Amount: req.amount, TotalInvoiceAmount: req.amount,
      ...this.who(), AutoCancelDurationInMinutes: 5,
    });
    if (Number(j.ResponseCode) !== 0) return { status: 'FAILED', message: String(j.ResponseMessage ?? 'Pine Labs did not accept the request.') };
    return { status: 'PENDING', message: 'Sent to the machine. Waiting for the customer.', providerRef: String(j.PlutusTransactionReferenceID ?? '') || null };
  }

  async status(req: SaleRequest, ref: string | null): Promise<TerminalResult> {
    if (!ref) return { status: 'FAILED', message: 'No Pine Labs reference for this payment.' };
    const j = await this.post('GetCloudBasedTxnStatus', { ...this.who(), PlutusTransactionReferenceID: Number(ref), TransactionNumber: req.merchantTxnId });
    const code = Number(j.ResponseCode), msg = String(j.ResponseMessage ?? '');
    const tags = new Map<string, string>(((j.TransactionData ?? []) as Array<{ Tag?: string; Value?: string }>).map((t) => [String(t.Tag ?? '').toLowerCase(), String(t.Value ?? '')]));
    if (code === 0 && /APPROVED/i.test(msg)) {
      return { status: 'APPROVED', message: msg, providerRef: ref, paidBy: paidByOf(tags.get('paymentmode') ?? tags.get('card type')), approvalCode: tags.get('approvalcode') ?? null,
        rrn: tags.get('rrn') ?? null, cardLast4: last4(tags.get('card number')), cardType: tags.get('card type') ?? null, acquirer: tags.get('acquirer name') ?? null,
        invoiceNo: tags.get('invoice number') ?? null };
    }
    if (code !== 0 && ENDED.test(msg)) return { status: /CANCEL/i.test(msg) ? 'CANCELLED' : 'FAILED', message: msg };
    return { status: 'PENDING', message: msg || 'Waiting for the customer on the machine' };
  }

  async cancel(req: SaleRequest, ref: string | null): Promise<TerminalResult> {
    if (!ref) return { status: 'CANCELLED', message: 'Cancelled.' };
    const j = await this.post('CancelTransaction', { ...this.who(), StoreID: Number(this.cfg.storeId), PlutusTransactionReferenceID: Number(ref), Amount: req.amount });
    return Number(j.ResponseCode) === 0 ? { status: 'CANCELLED', message: 'Cancelled on the machine.' } : { status: 'PENDING', message: `Not cancelled: ${String(j.ResponseMessage ?? '')}. Cancel it on the machine.` };
  }

  async check(): Promise<{ ok: boolean; message: string }> {
    try {
      const j = await this.post('GetCloudBasedTxnStatus', { ...this.who(), PlutusTransactionReferenceID: 1 });
      const msg = String(j.ResponseMessage ?? '');
      if (/SECURITY|TOKEN|MERCHANT|STORE|CLIENT|IMEI|DEVICE/i.test(msg) && !/TXN REF|REFERENCE/i.test(msg)) return { ok: false, message: `Pine Labs: ${msg}` };
      return { ok: true, message: `Pine Labs answered (${msg || 'OK'}). The details look right.` };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }
}

// ---------------------------------------------------------------- wired, through the PAD Controller

/** One request/response with the controller: [0x10 0x00][0x09 0x97][len BE][CSV][0xFF]. */
export function frame(csv: string): Buffer {
  const data = Buffer.from(csv, 'latin1');
  const out = Buffer.alloc(6 + data.length + 1);
  out.writeUInt16BE(0x1000, 0); out.writeUInt16BE(0x0997, 2); out.writeUInt16BE(data.length, 4);
  data.copy(out, 6); out[out.length - 1] = 0xff;
  return out;
}

/** Splits Pine Labs' CSV (values may be in double quotes). */
export function csvFields(s: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (const ch of s) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export class PineWired implements Connector {
  private cfg: PineWiredConfig;
  constructor(cfg: PineWiredConfig) { this.cfg = cfg; }

  /** Sends one CSV request and waits for the controller's answer (the customer may take up to two minutes). */
  exchange(csv: string, timeoutMs = 150_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.cfg.host || '127.0.0.1', port: this.cfg.port ?? 8082 });
      let buf = Buffer.alloc(0), done = false;
      const finish = (e: Error | null, v?: string) => { if (done) return; done = true; s.destroy(); if (e) reject(e); else resolve(v!); };
      s.setTimeout(timeoutMs, () => finish(new TerminalError('The machine did not answer in time. Check its screen.')));
      s.on('error', () => finish(new TerminalError(`Cannot reach the Pine Labs PAD Controller at ${this.cfg.host || '127.0.0.1'}:${this.cfg.port ?? 8082}. Is it running?`)));
      s.on('connect', () => s.write(frame(csv)));
      s.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 8) return;
        const len = buf.readUInt16BE(6);
        if (buf.length < 8 + len + 1) return;
        if (buf.readUInt16BE(4) !== 0x0001) return finish(new TerminalError('The PAD Controller answered "invalid request".'));
        finish(null, buf.subarray(8, 8 + len).toString('latin1'));
      });
      s.on('end', () => finish(new TerminalError('The PAD Controller closed the connection.')));
    });
  }

  async start(req: SaleRequest): Promise<TerminalResult> {
    if (req.mode === 'UPI') return { status: 'FAILED', message: 'UPI through the Pine Labs cable connection is not supported yet. Use Card, or the internet connection.' };
    const f = csvFields(await this.exchange(`4001,${req.merchantTxnId.slice(0, 25)},${req.amount},,,,,,,`));
    const approval = f[1] ?? '';
    if (approval) {
      return { status: 'APPROVED', message: f[2] || 'APPROVED', approvalCode: approval, cardLast4: last4(f[3]), cardType: f[6] || null, invoiceNo: f[7] || null,
        acquirer: f[12] || null, rrn: f[14] || null, bankCode: f[21] || null, paidBy: 'CARD', providerRef: [f[9], f[8], f[7]].filter(Boolean).join('/') || null };
    }
    return { status: 'FAILED', message: f[11] || f[2] || 'Not approved' };
  }

  async void(original: SaleRequest, result: TerminalResult): Promise<TerminalResult> {
    if (!result.invoiceNo) return { status: 'FAILED', message: 'The machine did not give an invoice number for this payment. Void it on the machine.' };
    const r = (await this.exchange(`4006,${original.merchantTxnId.slice(0, 25)},${original.amount},${result.bankCode ?? ''},,,${result.invoiceNo},,,,,`)).trim();
    const ok = /APPROVED/i.test(csvFields(r)[0] ?? r) || /APPROVED/i.test(r);
    return ok ? { status: 'APPROVED', message: 'Payment reversed (void).' } : { status: 'FAILED', message: r || 'The void was not approved.' };
  }

  async check(): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      const s = net.createConnection({ host: this.cfg.host || '127.0.0.1', port: this.cfg.port ?? 8082 });
      s.setTimeout(5000, () => { s.destroy(); resolve({ ok: false, message: 'The PAD Controller did not answer in 5 seconds.' }); });
      s.on('connect', () => { s.destroy(); resolve({ ok: true, message: `The Pine Labs PAD Controller is running at ${this.cfg.host || '127.0.0.1'}:${this.cfg.port ?? 8082}.` }); });
      s.on('error', () => resolve({ ok: false, message: `Cannot reach the PAD Controller at ${this.cfg.host || '127.0.0.1'}:${this.cfg.port ?? 8082}. Install and start Pine Labs' PAD Controller and connect the machine to it.` }));
    });
  }
}
