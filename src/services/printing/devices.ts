import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { runPowerShell } from './powershell.ts';
import type { PsRunner } from './powershell.ts';

/**
 * Finding printers so the shop never has to type a printer name, COM port or IP address:
 *  - installed Windows printers (USB thermal printers, and Bluetooth/network ones with a driver) -> spooler transport
 *  - COM ports, including Bluetooth "Serial over Bluetooth link" ports -> serial transport
 *  - network (Wi-Fi / LAN) printers answering on port 9100 in the PC's own /24 -> tcp transport
 * All read only. The PowerShell scripts are constants and take no input.
 */

export type Connection = 'usb' | 'serial' | 'bluetooth' | 'network' | 'virtual' | 'other';
export interface WindowsPrinter { name: string; port: string; driver: string; offline: boolean; connection: Connection }
export interface SerialPortInfo { port: string; name: string; bluetooth: boolean }
interface Opts { platform?: string; run?: PsRunner }

export function classifyPort(portName: string): Connection {
  const p = portName.trim();
  if (/^(nul:|PORTPROMPT:|FILE:|XPSPort:|SHRFAX:|ONENOTE)/i.test(p) || /^[A-Z]:\\/i.test(p) || /\.(pdf|xps|oxps|prn)$/i.test(p)) return 'virtual';
  if (/^USB\d+/i.test(p)) return 'usb';
  if (/^BTH/i.test(p) || /bluetooth/i.test(p)) return 'bluetooth';
  if (/^COM\d+:?$/i.test(p)) return 'serial';
  if (/^(IP_)?\d{1,3}(\.\d{1,3}){3}(_\d+)?$/.test(p) || /^WSD-/i.test(p) || /^TCPIP/i.test(p) || /^\\\\/.test(p)) return 'network';
  return 'other';
}

const PRINTERS_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$list = @(Get-CimInstance -ClassName Win32_Printer | ForEach-Object { [pscustomobject]@{ Name = [string]$_.Name; PortName = [string]$_.PortName; DriverName = [string]$_.DriverName; WorkOffline = [bool]$_.WorkOffline } })
[Console]::Out.Write((ConvertTo-Json -InputObject $list -Compress))
`;

const PORTS_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$out = @()
foreach ($d in @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "Name LIKE '%(COM%)'")) { $out += [pscustomobject]@{ Name = [string]$d.Name; Id = [string]$d.PNPDeviceID; Port = '' } }
foreach ($n in [System.IO.Ports.SerialPort]::GetPortNames()) { $out += [pscustomobject]@{ Name = ''; Id = ''; Port = [string]$n } }
[Console]::Out.Write((ConvertTo-Json -InputObject $out -Compress))
`;

function parseJsonList(stdout: string): Array<Record<string, unknown>> {
  const t = stdout.trim();
  if (!t) return [];
  const v = JSON.parse(t) as unknown;
  return (Array.isArray(v) ? v : [v]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
}

export async function listWindowsPrinters(o: Opts = {}): Promise<WindowsPrinter[]> {
  if ((o.platform ?? process.platform) !== 'win32') return [];
  const res = await (o.run ?? runPowerShell)({ script: PRINTERS_SCRIPT, timeoutMs: 20_000, maxOutput: 256 * 1024 });
  if (res.code !== 0 || res.timedOut) throw new Error('Windows could not list the installed printers. Try again, or type the printer name.');
  return parseJsonList(res.stdout).map((r) => {
    const port = String(r.PortName ?? '');
    return { name: String(r.Name ?? ''), port, driver: String(r.DriverName ?? ''), offline: r.WorkOffline === true, connection: classifyPort(port) };
  }).filter((p) => p.name).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSerialPorts(o: Opts = {}): Promise<SerialPortInfo[]> {
  if ((o.platform ?? process.platform) !== 'win32') return [];
  const res = await (o.run ?? runPowerShell)({ script: PORTS_SCRIPT, timeoutMs: 20_000, maxOutput: 128 * 1024 });
  if (res.code !== 0 || res.timedOut) throw new Error('Windows could not list the COM ports. Try again, or type the COM port.');
  const byPort = new Map<string, SerialPortInfo>();
  for (const r of parseJsonList(res.stdout)) {
    const name = String(r.Name ?? '');
    const fromName = /\((COM\d+)\)/i.exec(name)?.[1]?.toUpperCase();
    const port = fromName ?? String(r.Port ?? '').toUpperCase();
    if (!/^COM\d+$/.test(port)) continue;
    const bluetooth = /^BTHENUM\\/i.test(String(r.Id ?? '')) || /bluetooth/i.test(name);
    const prev = byPort.get(port);
    if (!prev || (!prev.bluetooth && bluetooth) || prev.name === prev.port) byPort.set(port, { port, name: name || port, bluetooth: bluetooth || !!prev?.bluetooth });
  }
  return [...byPort.values()].sort((a, b) => Number(a.port.slice(3)) - Number(b.port.slice(3)));
}

// ---------- network scan ----------

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Hosts to probe: the /24 around each private IPv4 address of this PC (at most 254 per network), never public ranges. */
export function candidateHosts(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out = new Set<string>();
  const own = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !isPrivate(i.address)) continue;
      own.add(i.address);
      const base = i.address.split('.').slice(0, 3).join('.');
      for (let h = 1; h <= 254; h++) out.add(`${base}.${h}`);
    }
  }
  for (const o of own) out.delete(o);
  return [...out];
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const ipKey = (ip: string) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);

/** Connects (without sending anything) to each host's printer port; returns the hosts that answered. */
export async function scanHosts(hosts: string[], port = 9100, timeoutMs = 400, concurrency = 64): Promise<string[]> {
  const found: string[] = [];
  let next = 0;
  const worker = async () => { while (next < hosts.length) { const h = hosts[next++]!; if (await probe(h, port, timeoutMs)) found.push(h); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found.sort((a, b) => ipKey(a) - ipKey(b));
}

export async function discoverNetworkPrinters(o: { port?: number; ifaces?: ReturnType<typeof networkInterfaces> } = {}) {
  const port = o.port ?? 9100;
  const hosts = candidateHosts(o.ifaces).slice(0, 2048);
  const found = await scanHosts(hosts, port);
  return { scanned: hosts.length, port, found: found.map((host) => ({ host, address: `${host}:${port}` })) };
}
