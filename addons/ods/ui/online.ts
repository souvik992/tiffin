import { useEffect, useReducer } from 'react';
import { BASE, host } from './host.ts';

export interface OnlineSettingsInput {
  enabled: boolean; channels: { app: boolean; website: boolean; swiggy: boolean; zomato: boolean };
  acceptMode: 'manual' | 'auto'; acceptTimeoutMin: number;
  fulfilment: { pickup: boolean; delivery: boolean }; payments: { online: boolean; cod: boolean };
}
export interface OnlineConfig extends OnlineSettingsInput { mode: 'online' | 'offline' }

// One shared copy of the setting: the side menu (ODS item, status dot) and the screens read it.
let current: OnlineConfig | null = null;
let loading = false;
const listeners = new Set<() => void>();
export function setOnlineConfig(c: OnlineConfig | null): void {
  current = c;
  for (const l of listeners) l();
  host.refresh(); // the POS side menu shows or hides ODS
}
export const onlineEnabled = () => current?.enabled === true;

export function useOnlineConfig(): OnlineConfig | null {
  const { api, user } = host.useSession();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { listeners.add(rerender); return () => { listeners.delete(rerender); }; }, []);
  useEffect(() => {
    if (user && !current && !loading) {
      loading = true;
      api.request<OnlineConfig>('GET', `${BASE}/config`).then(setOnlineConfig).catch(() => { /* menu shows no ODS */ }).finally(() => { loading = false; });
    }
  }, [api, user]);
  return current;
}

export const CHANNEL_LABELS: Record<keyof OnlineConfig['channels'], string> = { app: 'App', website: 'Website', swiggy: 'Swiggy', zomato: 'Zomato' };
