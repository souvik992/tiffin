// Printers on Android, through the Android app (android/app/.../PrinterBridge.java): USB printers (Android's USB host
// API) and Bluetooth printers, including the built-in printer of Sunmi-type POS machines (a paired Bluetooth device
// named "InnerPrinter"). The app listens on a loopback port with a token it passes in POS_ANDROID_BRIDGE ("port:token").
// Protocol: one JSON line per request ({ token, op, ... }), then for "print" the raw ESC/POS bytes; one JSON line back.
import net from 'node:net';
import type { PrinterRow, Transport } from './transports.ts';

export interface AndroidPrinterInfo { address: string; name: string; detail: string; builtin: boolean }

/** usb:<vid>:<pid>[:serial] or bt:<MAC>. */
export const ANDROID_ADDRESS = /^(usb:[0-9a-f]{4}:[0-9a-f]{4}(:[A-Za-z0-9._-]{1,64})?|bt:([0-9A-F]{2}:){5}[0-9A-F]{2})$/;

export function bridgeConfig(env: NodeJS.ProcessEnv = process.env): { port: number; token: string } | null {
  const m = /^(\d{1,5}):([A-Za-z0-9_-]{20,})$/.exec(env.POS_ANDROID_BRIDGE ?? '');
  return m ? { port: Number(m[1]), token: m[2]! } : null;
}

function call(cfg: { port: number; token: string }, req: Record<string, unknown>, payload: Uint8Array | null, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: cfg.port });
    let buf = '', settled = false;
    const done = (e: Error | null, v?: Record<string, unknown>) => { if (settled) return; settled = true; socket.destroy(); if (e) reject(e); else resolve(v!); };
    socket.setTimeout(timeoutMs, () => done(new Error('The printer did not answer in time.')));
    socket.on('error', () => done(new Error('The Android printer service is not available. Restart the app.')));
    socket.on('connect', () => {
      socket.write(JSON.stringify({ ...req, token: cfg.token, length: payload?.length ?? 0 }) + '\n');
      if (payload) socket.write(payload);
    });
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try { done(null, JSON.parse(buf.slice(0, i)) as Record<string, unknown>); } catch { done(new Error('The Android printer service answered something unexpected.')); }
    });
    socket.on('end', () => done(new Error('The Android printer service closed the connection.')));
  });
}

/** USB and Bluetooth printers Android can see now. Empty when not running inside the Android app. */
export async function listAndroidPrinters(env: NodeJS.ProcessEnv = process.env): Promise<AndroidPrinterInfo[]> {
  const cfg = bridgeConfig(env);
  if (!cfg) return [];
  const r = await call(cfg, { op: 'list' }, null, 8000);
  if (r.ok !== true) throw new Error(String(r.error ?? 'Printers could not be listed.'));
  return (Array.isArray(r.printers) ? r.printers : [])
    .map((p) => p as Record<string, unknown>)
    .filter((p) => typeof p.address === 'string' && ANDROID_ADDRESS.test(p.address))
    .map((p) => ({ address: p.address as string, name: String(p.name ?? 'Printer').slice(0, 60), detail: String(p.detail ?? '').slice(0, 120), builtin: p.builtin === true }));
}

/** Sends the bytes to the printer through the Android app (it chunks and paces them). */
export class AndroidTransport implements Transport {
  private env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv = process.env) { this.env = env; }
  async send(p: PrinterRow, bytes: Uint8Array): Promise<void> {
    const cfg = bridgeConfig(this.env);
    if (!cfg) throw new Error('This printer works only in the Tiffin POS Android app.');
    if (!ANDROID_ADDRESS.test(p.address ?? '')) throw new Error('Unknown Android printer address.');
    const r = await call(cfg, { op: 'print', address: p.address, slow: p.profile === 'slow_buffer' }, bytes, 30_000);
    if (r.ok !== true) throw new Error(String(r.error ?? 'The printer did not print.'));
  }
}
