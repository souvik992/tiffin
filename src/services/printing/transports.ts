import net from 'node:net';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface PrinterRow {
  id: string; name: string; transport: 'memory' | 'tcp' | 'file' | 'spooler' | 'serial' | 'usb'; address: string | null; width_mm: number;
  profile: string; raster: number; is_receipt: number; drawer: number; stations: string; active: number;
}
export interface Transport { send(printer: PrinterRow, bytes: Uint8Array): Promise<void> }

/** Per-model quirks. Add measured values here as real printers are tested (see docs). */
export const PROFILES: Record<string, { chunk: number }> = {
  generic: { chunk: 1024 },
  slow_buffer: { chunk: 256 },
};
export const colsFor = (widthMm: number) => (widthMm === 58 ? 32 : 48);

export function chunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, Math.min(bytes.length, i + size)));
  return out;
}

/** Captures bytes in memory. Used for tests and as the default virtual printer. */
export class MemoryTransport implements Transport {
  sent: Array<{ printerId: string; bytes: Uint8Array }> = [];
  failures = 0;
  async send(p: PrinterRow, bytes: Uint8Array): Promise<void> {
    if (this.failures > 0) { this.failures--; throw new Error('simulated printer offline'); }
    this.sent.push({ printerId: p.id, bytes: Uint8Array.from(bytes) });
  }
}

/** Appends receipts to a file inside one folder (testing and archiving). The address is a plain file name, never a path. */
export class FileTransport implements Transport {
  private dir: string;
  constructor(dir: string) { this.dir = dir; }
  async send(p: PrinterRow, bytes: Uint8Array): Promise<void> {
    const name = p.address ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || name.includes('..')) throw new Error('A file printer needs a plain file name.');
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, name), bytes);
  }
}

/** Raw TCP, port 9100 by default (LAN printers). */
export class TcpTransport implements Transport {
  private timeoutMs: number;
  constructor(timeoutMs = 5000) { this.timeoutMs = timeoutMs; }
  send(p: PrinterRow, bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const [host, portStr] = (p.address ?? '').split(':');
      if (!host) return reject(new Error('tcp transport needs an address host[:port]'));
      const port = portStr ? Number(portStr) : 9100;
      const size = PROFILES[p.profile]?.chunk ?? PROFILES.generic!.chunk;
      const socket = net.createConnection({ host, port });
      let settled = false;
      const done = (err?: Error) => { if (settled) return; settled = true; socket.destroy(); err ? reject(err) : resolve(); };
      socket.setTimeout(this.timeoutMs, () => done(new Error('printer connection timed out')));
      socket.on('error', (e) => done(e));
      socket.on('connect', () => {
        for (const c of chunks(bytes, size)) socket.write(c);
        socket.end(() => done());
      });
    });
  }
}


// Windows spooler (RAW) lives in spooler.ts.
