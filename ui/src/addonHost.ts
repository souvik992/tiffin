// What the POS screens offer to add-on screens (window.__POS__). Add-ons are bundled with React, react/jsx-runtime and
// 'pos-host' left out; their build maps those to this object, so they share the POS's React and sign-in session.
// Keep this stable: an add-on built against it must keep working with newer POS versions.
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import type { ComponentType } from 'react';
import { ApiError, newKey } from './lib/api.ts';
import { currentToken, messageOf, useSession } from './lib/session.tsx';
import { Modal, PageShell } from './components/ui.tsx';
import { formatPaise, paiseToInput, parseRupees } from './lib/money.ts';
import { registerAddon, refreshAddons } from './lib/addons.ts';
import type { Cart, FinalizeResult, PayMode, Role } from './lib/api.ts';

type Icon = ComponentType<{ className?: string }>;

export interface AddonNavItem { route: string; label: string; icon: Icon; /** Shown only while this returns true (read on every render). */ visible?: () => boolean }
export interface AddonSettingsSection { key: string; label: string; hint: string; icon: Icon; component: ComponentType; roles?: Role[] }
export interface AddonUi {
  id: string;
  nav?: AddonNavItem[];
  /** Screens by route name (#/route). */
  routes?: Record<string, ComponentType>;
  settings?: AddonSettingsSection[];
  /** Small status shown at the bottom of the side menu. */
  railFooter?: ComponentType;
  /** POS 0.3.8: other ways to take a payment at the counter (for example a card machine). */
  checkout?: CheckoutPlugin;
  /** POS 0.3.8: extra panels in a bill's detail (Orders). */
  invoicePanels?: Array<ComponentType<{ invoiceId: string }>>;
}

/** A way to take a payment for a mode, shown under the payment buttons ("On machine: Counter Paytm"). */
export interface CheckoutOption { id: string; label: string; isDefault?: boolean }
export interface CheckoutDialogProps { cart: Cart; mode: PayMode; optionId: string; resume?: unknown; onClose: () => void; onPaid: (r: FinalizeResult) => void }
export interface CheckoutPlugin {
  /** The options for a payment mode right now (read on every render; call refresh() when they change). */
  options(mode: PayMode): CheckoutOption[];
  /** Takes the payment and saves the bill; calls onPaid with the saved bill. */
  Dialog: ComponentType<CheckoutDialogProps>;
  /** After a reload: a payment for this open bill that still needs attention. */
  pending?(orderId: string): Promise<{ mode: PayMode; optionId: string; resume: unknown } | null>;
}

/**
 * A live feed (Server-Sent Events) from a signed-in API path, e.g. '/addons/ods/events'. Reconnects by itself after a drop.
 * Returns a function that closes it.
 */
function stream(path: string, onEvent: (type: string, data: unknown) => void, onStatus?: (live: boolean) => void): () => void {
  let stopped = false;
  let ctl: AbortController | null = null;
  const run = async () => {
    while (!stopped) {
      ctl = new AbortController();
      try {
        const token = currentToken();
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const r = await fetch(`/api${path}`, { headers, signal: ctl.signal });
        if (!r.ok || !r.body) throw new Error(String(r.status));
        onStatus?.(true);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i = buf.indexOf('\n\n');
          while (i >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const type = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
            const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            if (data) { try { onEvent(type, JSON.parse(data)); } catch { /* ignore a bad message */ } }
            i = buf.indexOf('\n\n');
          }
        }
      } catch { /* dropped: try again */ }
      onStatus?.(false);
      if (!stopped) await new Promise((res) => setTimeout(res, 2000));
    }
  };
  void run();
  return () => { stopped = true; ctl?.abort(); };
}

export const posHost = {
  React, jsxRuntime,
  useSession, PageShell, Modal, newKey, messageOf, ApiError,
  money: { formatPaise, parseRupees, paiseToInput },
  /** Live feed from a signed-in API path (added in POS 0.3.0; add-ons check it exists before using it). */
  stream,
  /** Re-render the POS after an add-on's own state changed (for example to show or hide its menu item). */
  refresh: refreshAddons,
  register: (def: AddonUi) => registerAddon(def),
};
export type PosHost = typeof posHost;

declare global { interface Window { __POS__?: PosHost } }
export function installHost(): void { window.__POS__ = posHost; }
