import type { Actor } from '../../../src/services/ctx.ts';
import type { HostApi } from '../../../src/addons/host.ts';

/**
 * Online orders settings. Off by default: the POS is fully offline and makes no internet connection for orders.
 * isOnlineMode() is the single check for anything in this add-on that would connect out (map tiles, address search,
 * and later the order hub). The options are what the POS publishes to the hub (contract StoreOnlineSettings).
 */

export const CHANNELS = ['app', 'website', 'swiggy', 'zomato'] as const;
export type Channel = typeof CHANNELS[number];
export type Channels = Record<Channel, boolean>;
export interface OnlineOptions {
  acceptMode: 'manual' | 'auto';
  acceptTimeoutMin: number;
  fulfilment: { pickup: boolean; delivery: boolean };
  payments: { online: boolean; cod: boolean };
}
export interface OnlineInput extends OnlineOptions { enabled: boolean; channels: Channels }
export interface OnlineConfig extends OnlineInput { mode: 'online' | 'offline' }

const ENABLED = 'online_orders_enabled';
const CHANNELS_KEY = 'online_channels';
const OPTIONS_KEY = 'online_options';
const none = (): Channels => ({ app: false, website: false, swiggy: false, zomato: false });
export const DEFAULT_OPTIONS: OnlineOptions = { acceptMode: 'manual', acceptTimeoutMin: 5, fulfilment: { pickup: true, delivery: true }, payments: { online: true, cod: true } };
const bool = (v: unknown) => typeof v === 'boolean';

export function readOnlineConfig(host: HostApi): OnlineConfig {
  const channels = none();
  try {
    const saved = JSON.parse(host.getSetting(CHANNELS_KEY) || '{}') as Record<string, unknown>;
    for (const c of CHANNELS) channels[c] = saved[c] === true;
  } catch { /* unreadable: all off */ }
  let options: OnlineOptions = DEFAULT_OPTIONS;
  try { const o = JSON.parse(host.getSetting(OPTIONS_KEY) || 'null') as OnlineOptions | null; if (o) options = { ...DEFAULT_OPTIONS, ...o }; } catch { /* defaults */ }
  const enabled = host.getSetting(ENABLED) === '1' && CHANNELS.some((c) => channels[c]);
  return { enabled, channels, mode: enabled ? 'online' : 'offline', ...options };
}

export const isOnlineMode = (host: HostApi) => readOnlineConfig(host).enabled;

export function saveOnlineConfig(host: HostApi, actor: Actor, requestId: string, input: OnlineInput): OnlineConfig {
  const { AppError } = host;
  return host.runCommand(host.ctx, requestId, 'online.config', actor, () => {
    host.assertPerm(actor, 'settings.write');
    if (!input || typeof input !== 'object') throw new AppError('VALIDATION', 'Send the online orders settings.');
    const unknown = Object.keys(input.channels ?? {}).filter((k) => !(CHANNELS as readonly string[]).includes(k));
    if (unknown.length) throw new AppError('VALIDATION', `Unknown sales channel: ${unknown.join(', ')}. Choose from app, website, Swiggy and Zomato.`);
    if (!bool(input.enabled)) throw new AppError('VALIDATION', 'Online orders are on or off.');
    const channels = none();
    for (const c of CHANNELS) {
      const v = input.channels?.[c];
      if (v !== undefined && !bool(v)) throw new AppError('VALIDATION', 'Each sales channel is on or off.');
      channels[c] = v === true;
    }
    if (input.acceptMode !== 'manual' && input.acceptMode !== 'auto') throw new AppError('VALIDATION', 'Choose manual or automatic accepting.');
    if (!Number.isInteger(input.acceptTimeoutMin) || input.acceptTimeoutMin < 2 || input.acceptTimeoutMin > 15) throw new AppError('VALIDATION', 'The time to accept an order must be 2 to 15 minutes.');
    const f = input.fulfilment, p = input.payments;
    if (!f || !bool(f.pickup) || !bool(f.delivery) || !p || !bool(p.online) || !bool(p.cod)) throw new AppError('VALIDATION', 'Order types and payments are each on or off.');
    if (input.enabled && !CHANNELS.some((c) => channels[c])) throw new AppError('VALIDATION', 'Turn on at least one sales channel to take online orders.');
    if (input.enabled && !f.pickup && !f.delivery) throw new AppError('VALIDATION', 'Turn on pickup, delivery or both.');
    if (input.enabled && !p.online && !p.cod) throw new AppError('VALIDATION', 'Turn on online payment, cash on delivery or both.');
    const before = readOnlineConfig(host);
    const options: OnlineOptions = { acceptMode: input.acceptMode, acceptTimeoutMin: input.acceptTimeoutMin, fulfilment: { pickup: f.pickup, delivery: f.delivery }, payments: { online: p.online, cod: p.cod } };
    host.setSetting(ENABLED, input.enabled ? '1' : '0');
    host.setSetting(CHANNELS_KEY, JSON.stringify(channels));
    host.setSetting(OPTIONS_KEY, JSON.stringify(options));
    const after = readOnlineConfig(host);
    host.audit(host.ctx, actor.userId, 'online.config', 'settings', ENABLED, { before, after });
    return after;
  });
}
