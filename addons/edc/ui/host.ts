// The POS's toolbox for add-on screens (see ui/src/addonHost.ts). Present before this script runs.
import type { PosHost } from '../../../ui/src/addonHost.ts';

export const host: PosHost = (window as unknown as { __POS__: PosHost }).__POS__;
export const BASE = '/addons/edc';
export const onAndroid = () => typeof (window as unknown as { PosAndroid?: unknown }).PosAndroid !== 'undefined';

export type Provider = 'paytm' | 'pinelabs';
export type Connection = 'cloud' | 'wired';
export interface Machine {
  id: string; name: string; provider: Provider; providerName: string; connection: Connection; modes: Array<'CARD' | 'UPI'>;
  config: Record<string, string | number>; hasSecret: boolean; needsSecret: boolean; isDefault: boolean; active: boolean;
}
export interface MachineInput { name: string; provider: Provider; connection: Connection; modes: Array<'CARD' | 'UPI'>; config: Record<string, string | number>; secret?: string | null; isDefault?: boolean; active?: boolean }
export type TxnStatus = 'PENDING' | 'APPROVED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
export interface Txn {
  id: string; kind: 'SALE' | 'VOID'; terminalId: string; terminalName: string; provider: Provider; connection: Connection; orderId: string;
  mode: 'CARD' | 'UPI' | 'ANY'; amount: number; status: TxnStatus; message: string | null; invoiceId: string | null; canCancel: boolean; createdAt: number;
  result: { approvalCode?: string | null; rrn?: string | null; cardLast4?: string | null; cardType?: string | null; paidBy?: string } | null;
}
export interface MatchRow { at: number; machine: string; what: string; status: string; amount: number; invoiceNo: string; approval: string; match: string; message: string }

type Api = ReturnType<typeof host.useSession>['api'];
type Override = { userId: string; pin: string };
/** This add-on's routes, through the POS's own client (sign-in, request keys, errors). */
export const edc = (api: Api) => ({
  machines: () => api.request<Machine[]>('GET', `${BASE}/terminals`),
  save: (id: string | null, input: MachineInput, key: string) => api.request<Machine>(id ? 'PUT' : 'POST', id ? `${BASE}/terminals/${encodeURIComponent(id)}` : `${BASE}/terminals`, input, key),
  remove: (id: string, key: string) => api.request<{ ok: boolean }>('DELETE', `${BASE}/terminals/${encodeURIComponent(id)}`, {}, key),
  check: (id: string) => api.request<{ ok: boolean; message: string }>('POST', `${BASE}/terminals/${encodeURIComponent(id)}/check`, {}),
  report: (from: string, to: string) => api.request<{ rows: MatchRow[]; approvedTotal: number; noBill: number; unclear: number }>('GET', `${BASE}/report?from=${from}&to=${to}`),
  start: (orderId: string, mode: 'CARD' | 'UPI', terminalId: string | null, key: string) => api.request<Txn>('POST', `${BASE}/charges`, { orderId, mode, terminalId }, key),
  get: (id: string) => api.request<Txn>('GET', `${BASE}/charges/${encodeURIComponent(id)}`),
  pending: (orderId: string) => api.request<Txn | null>('GET', `${BASE}/orders/${encodeURIComponent(orderId)}/charge`),
  cancel: (id: string) => api.request<Txn>('POST', `${BASE}/charges/${encodeURIComponent(id)}/cancel`, {}),
  recheck: (id: string) => api.request<Txn>('POST', `${BASE}/charges/${encodeURIComponent(id)}/recheck`, {}),
  complete: (id: string, key: string) => api.request<Parameters<import('../../../ui/src/addonHost.ts').CheckoutDialogProps['onPaid']>[0]>('POST', `${BASE}/charges/${encodeURIComponent(id)}/complete`, {}, key),
  reverse: (id: string, override: Override | undefined, key: string) => api.request<Txn>('POST', `${BASE}/charges/${encodeURIComponent(id)}/void`, override ? { override } : {}, key),
  forInvoice: (invoiceId: string) => api.request<Txn[]>('GET', `${BASE}/invoices/${encodeURIComponent(invoiceId)}/charges`),
});
