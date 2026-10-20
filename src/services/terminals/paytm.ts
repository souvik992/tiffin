// Paytm card machines (EDC).
//  - Wireless: Paytm's ECR APIs over the internet (sale request, status, void), each signed with the merchant key
//    (paytmChecksum.ts). paytmpayments.com/docs/api/pos-sale-api, pos-status-enquiry-api, pos-void-api.
//  - Wired (USB cable, Windows): Paytm's own .NET library (github.com/paytm/Paytm_EDC, wired/netV4.0) talks to the
//    machine; the shop downloads it from Paytm and Settings points to its folder. It is called from a constant
//    PowerShell script (like printing): every value travels in environment variables, never on the command line.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runPowerShell } from '../printing/powershell.ts';
import type { PsRunner } from '../printing/powershell.ts';
import { paytmChecksum } from './paytmChecksum.ts';
import { istStamp, last4, paidByOf, TerminalError } from './types.ts';
import type { Connector, SaleRequest, TerminalResult } from './types.ts';

export const PAYTM_TEST_URL = 'https://securegw-stage.paytmpayments.in';

export interface PaytmCloudConfig { mid: string; tid: string; channelId: string; env: 'test' | 'live'; liveUrl?: string }
export interface PaytmWiredConfig { mid: string; comPort: string; baud?: number; libFolder: string }

type Fetch = typeof fetch;

const PAYTM_MODE: Record<string, string> = { CARD: 'CARD', UPI: 'QR' };

/** Result of Paytm's status enquiry (resultStatus S success, F failed, A accepted / U pending). */
function fromStatus(body: Record<string, unknown>): TerminalResult {
  const info = (body.resultInfo ?? {}) as Record<string, unknown>;
  const st = String(info.resultStatus ?? ''), code = String(info.resultCodeId ?? ''), msg = String(info.resultMsg ?? '');
  const details = {
    providerRef: (body.acquirementId as string | undefined) ?? null, paidBy: paidByOf(body.payMethod),
    approvalCode: (body.authCode as string | undefined) ?? null, rrn: (body.retrievalReferenceNo as string | undefined) ?? null,
    cardLast4: last4(body.issuerMaskCardNo), cardType: [body.cardScheme, body.cardType].filter(Boolean).join(' ') || null,
    acquirer: (body.acquiringBank as string | undefined) ?? (body.issuingBankName as string | undefined) ?? null,
  };
  if (st === 'S' || code === '0000') return { status: 'APPROVED', message: msg || 'Approved', ...details };
  if (st === 'F' && code !== '0010' && code !== '0030') return { status: 'FAILED', message: msg || 'Not approved' };
  return { status: 'PENDING', message: msg || 'Waiting for the customer on the machine' };
}

export class PaytmCloud implements Connector {
  private cfg: PaytmCloudConfig; private key: string; private f: Fetch;
  constructor(cfg: PaytmCloudConfig, merchantKey: string, f: Fetch = fetch) { this.cfg = cfg; this.key = merchantKey; this.f = f; }

  private base(): string {
    if (this.cfg.env === 'live') {
      if (!this.cfg.liveUrl) throw new TerminalError('Enter the live server address Paytm gave you (Settings > Payment machines).');
      return this.cfg.liveUrl.replace(/\/+$/, '');
    }
    return PAYTM_TEST_URL;
  }

  /** Signs the body exactly as it is sent. */
  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bodyText = JSON.stringify(body);
    const head = { requestTimeStamp: istStamp(Date.now()), channelId: this.cfg.channelId, checksum: paytmChecksum(bodyText, this.key), version: '3.1' };
    let r: Response;
    try {
      r = await this.f(this.base() + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"head":${JSON.stringify(head)},"body":${bodyText}}`, signal: AbortSignal.timeout(20_000) });
    } catch { throw new TerminalError('Could not reach Paytm. Check the internet connection.'); }
    const j = await r.json().catch(() => null) as { body?: Record<string, unknown> } | null;
    if (!j?.body) throw new TerminalError(`Paytm answered ${r.status} without a result.`);
    return j.body;
  }

  private ids(req: SaleRequest) {
    return { paytmMid: this.cfg.mid, paytmTid: this.cfg.tid, transactionDateTime: istStamp(req.startedAt), merchantTransactionId: req.merchantTxnId };
  }

  async start(req: SaleRequest): Promise<TerminalResult> {
    const body: Record<string, unknown> = { ...this.ids(req), merchantReferenceNo: req.reference.slice(0, 32), transactionAmount: String(req.amount) };
    if (PAYTM_MODE[req.mode]) body.merchantExtendedInfo = JSON.stringify({ paymentMode: PAYTM_MODE[req.mode] });
    const b = await this.post('/ecr/payment/request', body);
    const info = (b.resultInfo ?? {}) as Record<string, unknown>;
    if (String(info.resultStatus) === 'A') return { status: 'PENDING', message: 'Sent to the machine. Waiting for the customer.' };
    return { status: 'FAILED', message: String(info.resultMsg ?? 'Paytm did not accept the request.') };
  }

  async status(req: SaleRequest): Promise<TerminalResult> { return fromStatus(await this.post('/ecr/V2/payment/status', this.ids(req))); }

  async void(original: SaleRequest): Promise<TerminalResult> {
    const b = await this.post('/ecr/void', this.ids(original));
    const info = (b.resultInfo ?? {}) as Record<string, unknown>;
    if (String(info.resultStatus) !== 'A') return { status: 'FAILED', message: String(info.resultMsg ?? 'Paytm did not accept the void.') };
    // the void finishes on the machine: ask for it like a sale (event VOID)
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 3000));
      const s = fromStatus(await this.post('/ecr/V2/payment/status', { ...this.ids(original), event: 'VOID' }));
      if (s.status !== 'PENDING') return s.status === 'APPROVED' ? { ...s, message: 'Payment reversed (void).' } : s;
    }
    return { status: 'PENDING', message: 'The void was sent; check the machine.' };
  }

  async check(): Promise<{ ok: boolean; message: string }> {
    // a status enquiry for an id that does not exist: a wrong key or ID is refused, right details say "not found"
    try {
      const b = await this.post('/ecr/V2/payment/status', { paytmMid: this.cfg.mid, paytmTid: this.cfg.tid, transactionDateTime: istStamp(Date.now()), merchantTransactionId: `CHECK${Date.now()}` });
      const info = (b.resultInfo ?? {}) as Record<string, unknown>;
      const code = String(info.resultCodeId ?? ''), msg = String(info.resultMsg ?? '');
      if (code === '0330') return { ok: false, message: 'Paytm says the merchant key is wrong (invalid checksum).' };
      if (['0007', '9001', '0022', '0902'].includes(code)) return { ok: false, message: `Paytm: ${msg}` };
      return { ok: true, message: `Paytm answered (${msg || 'OK'}). The details look right.` };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }
}

// ---------------------------------------------------------------- wired (USB), Windows

const WIRED_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $dir = $env:PAYTM_LIB
  $dll = Get-ChildItem -Path $dir -Filter 'PaytmPayments*.dll' | Select-Object -First 1
  if (-not $dll) { throw 'The Paytm library (PaytmPayments .dll) is not in the chosen folder.' }
  $json = Join-Path $dir 'Newtonsoft.Json.dll'
  if (Test-Path $json) { Add-Type -Path $json }
  Add-Type -Path $dll.FullName
  $p = New-Object Paytm.EDC.ECR.Payments
  $port = $env:PAYTM_PORT; $baud = [int]$env:PAYTM_BAUD
  switch ($env:PAYTM_OP) {
    'SALE'   { $r = $p.Sale($port, $baud, 0, 8, 1, 0, $env:PAYTM_MID, $env:PAYTM_ORDER, $env:PAYTM_MODE, $env:PAYTM_AMOUNT, '', '', '', '', 'ALL') }
    'STATUS' { $r = $p.Status($port, $baud, 0, 8, 1, 0, $env:PAYTM_MID, $env:PAYTM_ORDER) }
    'VOID'   { $r = $p.Void($port, $baud, 0, 8, 1, 0, $env:PAYTM_MID, $env:PAYTM_ORDER, '') }
    'CHECK'  { $r = $p.ConnectionCheck($port, $baud, 0, 8, 1, 0) }
  }
  [Console]::Out.Write([string]$r)
} catch { [Console]::Out.Write('{"statusCode":"ERR","statusMessage":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}') }
`;

/** statusCode 101 = done, 001/103/1101 = still running (Paytm's library settings), anything else = not approved. */
function fromWired(j: Record<string, unknown>): TerminalResult {
  const code = String(j.statusCode ?? ''), msg = String(j.statusMessage ?? '');
  if (code === '101') {
    return { status: 'APPROVED', message: msg || 'Approved', providerRef: (j.txnId as string | undefined) ?? null, paidBy: paidByOf(j.payMethod),
      approvalCode: (j.authCode as string | undefined) ?? null, rrn: (j.rrn as string | undefined) ?? null, cardLast4: last4(j.cardNo),
      cardType: [j.cardScheme, j.cardType].filter(Boolean).join(' ') || null, acquirer: (j.acquiringBank as string | undefined) ?? (j.issuingBank as string | undefined) ?? null };
  }
  if (['001', '103', '1101'].includes(code)) return { status: 'PENDING', message: msg || 'Waiting for the customer on the machine' };
  return { status: 'FAILED', message: code === 'ERR' ? msg : msg || `Not approved (code ${code || 'none'})` };
}

export class PaytmWired implements Connector {
  private cfg: PaytmWiredConfig; private run: PsRunner; private platform: string;
  constructor(cfg: PaytmWiredConfig, run: PsRunner = runPowerShell, platform: string = process.platform) { this.cfg = cfg; this.run = run; this.platform = platform; }

  private async call(op: 'SALE' | 'STATUS' | 'VOID' | 'CHECK', req?: SaleRequest, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.platform !== 'win32') throw new TerminalError('A Paytm machine on a USB cable works with the Windows POS. On Android use the internet connection.');
    try { if (!readdirSync(this.cfg.libFolder).some((f) => /^PaytmPayments.*\.dll$/i.test(f))) throw new Error(); } catch {
      throw new TerminalError(`The Paytm library is not in ${this.cfg.libFolder}. Download it from Paytm (Paytm_EDC, wired, netV4.0) into that folder.`);
    }
    const r = await this.run({
      script: WIRED_SCRIPT, timeoutMs, maxOutput: 64 * 1024,
      env: { PAYTM_LIB: join(this.cfg.libFolder), PAYTM_OP: op, PAYTM_PORT: this.cfg.comPort, PAYTM_BAUD: String(this.cfg.baud ?? 115200), PAYTM_MID: this.cfg.mid,
        PAYTM_ORDER: req?.merchantTxnId ?? '', PAYTM_AMOUNT: req ? String(req.amount) : '', PAYTM_MODE: req ? (PAYTM_MODE[req.mode] ?? 'ALL') : 'ALL' },
    });
    if (r.timedOut) throw new TerminalError('The machine did not answer in time. Check its screen.');
    try { return JSON.parse(r.stdout) as Record<string, unknown>; } catch { throw new TerminalError('The Paytm library answered something unexpected.'); }
  }

  /** Paytm's library waits for the customer itself (up to about 2 minutes) and then answers. */
  async start(req: SaleRequest): Promise<TerminalResult> {
    const j = await this.call('SALE', req, 180_000);
    // the library failed in the middle of a sale: the machine may still have taken the money, so the result is unclear
    // (thrown: the counter shows "check the machine"); only "no machine / no port" is a clear failure
    if (String(j.statusCode) === 'ERR' && !/not available|port|access|denied|could not load|not in/i.test(String(j.statusMessage ?? ''))) throw new TerminalError(`${String(j.statusMessage)} Check the machine.`);
    return fromWired(j);
  }
  async status(req: SaleRequest): Promise<TerminalResult> { return fromWired(await this.call('STATUS', req)); }
  async void(original: SaleRequest): Promise<TerminalResult> {
    const r = fromWired(await this.call('VOID', original, 180_000));
    return r.status === 'APPROVED' ? { ...r, message: 'Payment reversed (void).' } : r;
  }
  async check(): Promise<{ ok: boolean; message: string }> {
    try {
      const j = await this.call('CHECK');
      return String(j.statusCode) === '000' ? { ok: true, message: `Connected to the machine on ${this.cfg.comPort} (library ${String(j.version ?? '')}).` } : { ok: false, message: String(j.statusMessage ?? 'The machine did not answer.') };
    } catch (e) { return { ok: false, message: (e as Error).message }; }
  }
}
