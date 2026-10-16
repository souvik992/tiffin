// What the POS screens offer to add-on screens (window.__POS__). Add-ons are bundled with React, react/jsx-runtime and
// 'pos-host' left out; their build maps those to this object, so they share the POS's React and sign-in session.
// Keep this stable: an add-on built against it must keep working with newer POS versions.
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import type { ComponentType } from 'react';
import { ApiError, newKey } from './lib/api.ts';
import { messageOf, useSession } from './lib/session.tsx';
import { Modal, PageShell } from './components/ui.tsx';
import { formatPaise, paiseToInput, parseRupees } from './lib/money.ts';
import { registerAddon, refreshAddons } from './lib/addons.ts';
import type { Role } from './lib/api.ts';

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
}

export const posHost = {
  React, jsxRuntime,
  useSession, PageShell, Modal, newKey, messageOf, ApiError,
  money: { formatPaise, parseRupees, paiseToInput },
  /** Re-render the POS after an add-on's own state changed (for example to show or hide its menu item). */
  refresh: refreshAddons,
  register: (def: AddonUi) => registerAddon(def),
};
export type PosHost = typeof posHost;

declare global { interface Window { __POS__?: PosHost } }
export function installHost(): void { window.__POS__ = posHost; }
