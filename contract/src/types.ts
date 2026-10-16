// Online order contract v1: data shapes. Money is integer paise, quantities integer thousandths, times ms since epoch (UTC).
import type { Fulfilment, OrderState, PaymentMethod } from './order.ts';

export interface Customer { name: string | null; mobile: string; /** true when the mobile was confirmed by OTP */ verified: boolean }
export interface Address { line1: string; line2: string | null; landmark: string | null; city: string; pincode: string }
export interface Rider { name: string; phone: string | null }

export const REJECT_REASONS = ['ITEM_UNAVAILABLE', 'TOO_BUSY', 'CLOSING', 'OUT_OF_DELIVERY_AREA', 'OTHER'] as const;
export type RejectReason = typeof REJECT_REASONS[number];

/** What a customer app sends to place an order. The hub re-prices it from the published menu; the totals here are what the customer saw. */
export interface PlaceOrderRequest {
  fulfilment: Fulfilment;
  payment: PaymentMethod;
  customer: { name?: string | null; mobile: string };
  /** Proof that the mobile was verified by OTP (from POST /v1/otp/verify). Required for COD. */
  otpToken?: string | null;
  address?: Address | null;
  /** Delivery: the customer's map point (from the app's map or the phone's location). Distance and fees are measured to it. */
  location?: { lat: number; lng: number } | null;
  /** Which sales channel the order comes from (default website). */
  channel?: 'app' | 'website';
  lines: Array<{ itemId: string; qtyMilli: number; modifierIds?: string[]; note?: string | null }>;
  note?: string | null;
  /** The menu version the customer ordered from (see F5: price changes). */
  menuVersion: number;
  /** The total the customer was shown, in paise. */
  expectedTotal: number;
}

export interface OrderLine { itemId: string; name: string; qtyMilli: number; unitPrice: number; modifiers: Array<{ id: string; name: string; price: number }>; note: string | null; lineTotal: number }

/** An order as the hub stores it and sends it to the POS. */
export interface Order {
  id: string;
  /** Short number for people, e.g. "W-1042" (website), "A-77" (app). */
  number: string;
  storeId: string;
  channel: 'app' | 'website' | 'swiggy' | 'zomato';
  state: OrderState;
  fulfilment: Fulfilment;
  payment: PaymentMethod;
  paid: boolean;
  customer: Customer;
  address: Address | null;
  lines: OrderLine[];
  note: string | null;
  itemsTotal: number;
  deliveryFee: number;
  packagingFee: number;
  total: number;
  /** Delivery: distance used for the fee (km, road estimate), and the customer's map point. */
  distanceKm: number | null;
  location: { lat: number; lng: number } | null;
  /** Set when the store accepts: preparation minutes and the promised time. */
  prepMinutes: number | null;
  etaAt: number | null;
  menuVersion: number;
  placedAt: number;
  /** Manual mode: the hub auto-rejects at this time unless the store answers. Null in auto-accept mode. */
  acceptBy: number | null;
  rider: Rider | null;
  posBillNo: string | null;
  rejectReason: RejectReason | null;
  reasonText: string | null;
}

/** Events the hub pushes down the POS's SSE stream (GET /v1/pos/events). `seq` is the SSE event id; the POS resumes with Last-Event-ID. */
export type PosEvent =
  | { seq: number; type: 'order.created'; at: number; order: Order }
  | { seq: number; type: 'order.cancelled'; at: number; orderId: string; by: 'customer'; reasonText: string | null }
  | { seq: number; type: 'order.auto_rejected'; at: number; orderId: string }
  | { seq: number; type: 'order.updated'; at: number; orderId: string; state: OrderState; by: 'pos' };

/** Events the hub pushes to the customer app (GET /v1/orders/{id}/events). */
export type CustomerEvent = { seq: number; type: 'order.state'; at: number; orderId: string; state: OrderState; label: string; etaMinutes: number | null; rider: Rider | null };

/** Store settings the POS publishes with its menu (PUT /v1/pos/menu). */
export interface StoreOnlineSettings {
  acceptMode: 'manual' | 'auto';
  /** Manual mode: minutes before an unanswered order is auto-rejected (2-15, default 5). */
  acceptTimeoutMin: number;
  channels: { app: boolean; website: boolean; swiggy: boolean; zomato: boolean };
  fulfilment: { pickup: boolean; delivery: boolean };
  payments: { online: boolean; cod: boolean };
}
