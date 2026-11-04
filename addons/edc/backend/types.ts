// Payment machines (card machines / EDC). Every company and connection is a Connector with the same shape, so the
// counter, the settings screen and the daily match never depend on a company. Amounts are always integer paise.

export type Provider = 'paytm' | 'pinelabs';
export type Connection = 'cloud' | 'wired';
export type TxnMode = 'CARD' | 'UPI' | 'ANY';
export type TxnStatus = 'PENDING' | 'APPROVED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
/** How the customer actually paid, as the POS records it. */
export type PaidBy = 'CARD' | 'UPI' | 'WALLET' | 'OTHER';

export interface SaleRequest {
  /** Our id for this attempt (8-25 letters and digits): unique, sent to the company, returned in its reports. */
  merchantTxnId: string;
  amount: number;
  mode: TxnMode;
  /** Shown on the machine where it can be (token or bill reference). */
  reference: string;
  /** When the attempt started (Paytm needs the same date for status and void). */
  startedAt: number;
}

/** What a machine said. PENDING: still waiting for the customer; the others are final. */
export interface TerminalResult {
  status: Exclude<TxnStatus, 'UNKNOWN'>;
  message: string;
  providerRef?: string | null;
  paidBy?: PaidBy;
  approvalCode?: string | null;
  rrn?: string | null;
  cardLast4?: string | null;
  cardType?: string | null;
  acquirer?: string | null;
  /** Wired Pine Labs: needed to void (invoice/ROC number and acquiring bank code). */
  invoiceNo?: string | null;
  bankCode?: string | null;
}

export interface Connector {
  /** Sends the amount to the machine. Wired machines answer only when the customer is done (final result). */
  start(req: SaleRequest): Promise<TerminalResult>;
  /** Asks for the result of a sent amount (internet machines). */
  status?(req: SaleRequest, providerRef: string | null): Promise<TerminalResult>;
  /** Stops a waiting payment from the POS (internet machines); otherwise it is cancelled on the machine. */
  cancel?(req: SaleRequest, providerRef: string | null): Promise<TerminalResult>;
  /** Reverses an approved payment of today (where the company allows it from billing software). */
  void?(original: SaleRequest, result: TerminalResult, voidTxnId: string): Promise<TerminalResult>;
  /** Settings > Payment machines > Test: can the POS reach the machine or the company, with these details? */
  check(): Promise<{ ok: boolean; message: string }>;
}

export class TerminalError extends Error {}

/** "yyyy-MM-dd HH:mm:ss" in Indian time (Paytm's format). */
export function istStamp(ms: number): string {
  const d = new Date(ms + 330 * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Last 4 digits of a masked card number ("XXXX XXXX XXXX 2802" -> "2802"). Never keeps more. */
export const last4 = (masked: unknown): string | null => {
  const d = String(masked ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
};

/** Card / UPI / wallet from a company's own payment method name. */
export function paidByOf(method: unknown): PaidBy {
  const m = String(method ?? '').toUpperCase();
  if (/UPI|QR|BHARAT|VPA/.test(m)) return 'UPI';
  if (/CARD|CREDIT|DEBIT|EMI|VISA|MASTER|RUPAY|AMEX/.test(m)) return 'CARD';
  if (/WALLET|BALANCE|PAYTM/.test(m)) return 'WALLET';
  return 'OTHER';
}
