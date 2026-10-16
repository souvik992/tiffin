import { runPowerShell } from './powershell.ts';
import type { PsResult, PsRunner } from './powershell.ts';
import { PROFILES } from './transports.ts';
import type { PrinterRow, Transport } from './transports.ts';

/**
 * Bluetooth (and USB-serial) printers. On Windows a paired Bluetooth printer using the Serial Port Profile appears
 * as an outgoing COM port (Settings, Bluetooth, More Bluetooth options, COM Ports). This transport writes the ESC/POS
 * bytes to that port through System.IO.Ports.SerialPort in Windows PowerShell 5.1 (no native module).
 *
 * Safety: constant script; the port name and settings go in environment variables, the bytes on stdin.
 * Address: "COM5", or "COM5:115200" to set the baud rate (Bluetooth links ignore it; wired serial printers need it).
 * Success means Windows accepted every byte; it does not prove paper came out (see HARDWARE_TEST_PLAN).
 */

const BAUDS = [9600, 19200, 38400, 57600, 115200];

export function parseSerialAddress(address: string | null | undefined): { port: string; baud: number } | null {
  const m = /^COM([1-9]\d{0,2})(?::(\d+))?$/i.exec((address ?? '').trim());
  if (!m) return null;
  const baud = m[2] ? Number(m[2]) : 9600;
  if (!BAUDS.includes(baud)) return null;
  return { port: `COM${m[1]}`, baud };
}

export function serialScript(): string {
  return `$ErrorActionPreference = 'Stop'
function Fail($stage, $err) {
  $e = $err.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  [Console]::Out.Write('ERR ' + $stage + ' ' + $e.GetType().Name)
  exit 1
}
$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$chunk = [int]$env:POS_SERIAL_CHUNK
try {
  $p = New-Object System.IO.Ports.SerialPort($env:POS_SERIAL_PORT, [int]$env:POS_SERIAL_BAUD, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
  $p.Handshake = [System.IO.Ports.Handshake]::None
  $p.WriteTimeout = 15000
  $p.Open()
} catch { Fail 'open' $_ }
try {
  for ($i = 0; $i -lt $data.Length; $i += $chunk) {
    $p.Write($data, $i, [Math]::Min($chunk, $data.Length - $i))
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ($p.BytesToWrite -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
  if ($p.BytesToWrite -gt 0) { $p.Close(); [Console]::Out.Write('ERR timeout'); exit 1 }
  Start-Sleep -Milliseconds 300
  $p.Close()
  [Console]::Out.Write('OK ' + $data.Length)
} catch {
  try { $p.Close() } catch { }
  Fail 'write' $_
}
`;
}

const NOT_FOUND = ['IOException', 'ArgumentException', 'ArgumentOutOfRangeException', 'FileNotFoundException', 'InvalidOperationException'];

export class SerialTransport implements Transport {
  private platform: string;
  private run: PsRunner;
  private timeoutMs: number;
  constructor(o: { platform?: string; run?: PsRunner; timeoutMs?: number } = {}) {
    this.platform = o.platform ?? process.platform;
    this.run = o.run ?? runPowerShell;
    this.timeoutMs = o.timeoutMs ?? 45_000;
  }

  async send(p: PrinterRow, bytes: Uint8Array): Promise<void> {
    if (this.platform !== 'win32') throw new Error('Bluetooth and COM port printers are only available on Windows.');
    const a = parseSerialAddress(p.address);
    if (!a) throw new Error('This printer needs a COM port as its address, like COM5 (see Bluetooth settings, COM Ports).');
    const chunk = PROFILES[p.profile]?.chunk ?? PROFILES.generic!.chunk;
    const res = await this.run({
      script: serialScript(), stdin: Buffer.from(bytes).toString('base64'), timeoutMs: this.timeoutMs,
      env: { POS_SERIAL_PORT: a.port, POS_SERIAL_BAUD: String(a.baud), POS_SERIAL_CHUNK: String(chunk) },
    });
    explain(a.port, res, bytes.length);
  }
}

function explain(port: string, res: PsResult, expected: number): void {
  const slow = `Printer on ${port} did not accept the data in time. Check that it is on, paired and within range.`;
  if (res.timedOut) throw new Error(slow);
  const out = res.stdout.trim();
  const ok = /^OK (\d+)$/.exec(out);
  if (ok && res.code === 0) {
    const n = Number(ok[1]);
    if (n !== expected) throw new Error(`Printer on ${port} accepted ${n} of ${expected} bytes. The job will be retried.`);
    return;
  }
  if (out === 'ERR timeout') throw new Error(slow);
  const err = /^ERR (open|write) (\w+)$/.exec(out);
  if (err) {
    const [, stage, type] = err as unknown as [string, string, string];
    if (type === 'TimeoutException') throw new Error(slow);
    if (stage === 'open' && type === 'UnauthorizedAccessException') throw new Error(`${port} is in use by another program (or the Bluetooth link is busy). Close other printing apps and try again.`);
    if (stage === 'open' && NOT_FOUND.includes(type)) throw new Error(`${port} was not found or the printer is off. Check it is paired in Windows Bluetooth settings and use its Outgoing COM port.`);
    if (stage === 'write') throw new Error(`The connection to ${port} dropped while printing (${type}). Check the printer is on and in range.`);
    throw new Error(`${port} could not be opened (${type}).`);
  }
  throw new Error('The app could not start the Windows print helper. Check that antivirus is not blocking PowerShell.');
}
