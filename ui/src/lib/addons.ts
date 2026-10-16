import { useEffect, useReducer } from 'react';
import type { AddonUi } from '../addonHost.ts';
import type { Api } from './api.ts';

// Add-on screens: the backend lists active add-ons (GET /api/addons); their ui.js is loaded once per session and calls
// window.__POS__.register(). One shared list, so the side menu, routes and Settings update together.
let defs: AddonUi[] = [];
let state: 'idle' | 'loading' | 'ready' = 'idle';
let version = 0;
const listeners = new Set<() => void>();
const notify = () => { version++; for (const l of listeners) l(); };

export function registerAddon(def: AddonUi): void {
  defs = [...defs.filter((d) => d.id !== def.id), def];
  notify();
}
export function refreshAddons(): void { notify(); }

/** Loads the screens of every active add-on (after sign-in). Never throws: a broken add-on just does not appear. */
export async function loadAddonScreens(api: Api): Promise<void> {
  if (state !== 'idle') return;
  state = 'loading'; notify();
  try {
    const list = await api.addons();
    await Promise.all(list.filter((a) => a.status === 'active' && a.ui).map((a) => new Promise<void>((resolve) => {
      const s = document.createElement('script');
      s.src = `/api${a.ui!.replace(/^\/api/, '')}`;
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.head.appendChild(s);
    })));
  } catch { /* no add-ons */ }
  state = 'ready'; notify();
}

/** The registered add-ons, re-rendering when they change. `ready` is false until the first load finished. */
export function useAddons(): { addons: AddonUi[]; ready: boolean; version: number } {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { listeners.add(rerender); return () => { listeners.delete(rerender); }; }, []);
  return { addons: defs, ready: state === 'ready', version };
}
