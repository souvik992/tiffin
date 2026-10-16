import { powershellPath, runPowerShell } from './powershell.ts';
import type { PrinterRow, Transport } from './transports.ts';

/**
 * Windows spooler transport (USB and driver-installed printers).
 *
 * Sends ESC/POS bytes as a RAW job through winspool.drv (OpenPrinter, StartDocPrinter "RAW",
 * WritePrinter), so the driver passes them through unchanged. Zero dependencies: a short-lived
 * Windows PowerShell 5.1 process calls winspool through P/Invoke. Works the same in plain Node
 * and in an Electron main process.
 *
 * Safety: the script is a constant. The printer name goes in an environment variable and the
 * bytes go through stdin (base64), so nothing from the database is ever part of a command line.
 * A failed write aborts the job (AbortPrinter) instead of printing half a receipt that a retry
 * would then duplicate.
 *
 * "Success" means the spooler accepted the whole job. It does not prove paper came out:
 * paper-out and cover-open are handled by the driver/printer, not here (see HARDWARE_TEST_PLAN).
 */

export interface SpoolRequest { printerName: string; docName: string; bytes: Uint8Array }
export interface SpoolResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean }
export type SpoolRunner = (r: SpoolRequest) => Promise<SpoolResult>;

export function spoolerScript(): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PosRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool AbortPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, IntPtr buf, int count, out int written);

  public static string Send(string printer, byte[] data, string docName) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "ERR open " + Marshal.GetLastWin32Error();
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = docName;
      di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) return "ERR startdoc " + Marshal.GetLastWin32Error();
      if (!StartPagePrinter(h)) { int e0 = Marshal.GetLastWin32Error(); AbortPrinter(h); return "ERR startpage " + e0; }
      IntPtr p = Marshal.AllocCoTaskMem(Math.Max(1, data.Length));
      int off = 0;
      try {
        Marshal.Copy(data, 0, p, data.Length);
        while (off < data.Length) {
          int w;
          if (!WritePrinter(h, IntPtr.Add(p, off), data.Length - off, out w)) { int e1 = Marshal.GetLastWin32Error(); AbortPrinter(h); return "ERR write " + e1; }
          if (w <= 0) { AbortPrinter(h); return "ERR write 0"; }
          off += w;
        }
      } finally { Marshal.FreeCoTaskMem(p); }
      if (!EndPagePrinter(h)) { int e2 = Marshal.GetLastWin32Error(); AbortPrinter(h); return "ERR endpage " + e2; }
      if (!EndDocPrinter(h)) return "ERR enddoc " + Marshal.GetLastWin32Error();
      return "OK " + off;
    } finally { ClosePrinter(h); }
  }
}
'@
$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
[Console]::Out.Write([PosRawPrint]::Send($env:POS_SPOOL_PRINTER, $data, $env:POS_SPOOL_DOC))
`;
}

export { powershellPath };

/** Runs the spooler script in Windows PowerShell 5.1 (see powershell.ts for the safety rules). */
export function powershellRunner(timeoutMs = 30_000): SpoolRunner {
  const script = spoolerScript();
  return (r) => runPowerShell({ script, env: { POS_SPOOL_PRINTER: r.printerName, POS_SPOOL_DOC: r.docName }, stdin: Buffer.from(r.bytes).toString('base64'), timeoutMs });
}

const WIN32_HINTS: Record<number, string> = {
  5: 'cannot be used: Windows denied permission',
  1801: 'was not found in Windows. Check the printer name in Settings, Printers',
  1804: 'does not accept RAW data. Use a "Generic / Text Only" or ESC/POS driver for it',
  1722: 'is unavailable because the Windows print spooler is not running',
  1726: 'is unavailable because the Windows print spooler is not running',
};

export class SpoolerTransport implements Transport {
  private platform: string;
  private run: SpoolRunner | null;
  private timeoutMs: number;
  constructor(o: { platform?: string; run?: SpoolRunner; timeoutMs?: number } = {}) {
    this.platform = o.platform ?? process.platform;
    this.run = o.run ?? null;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  async send(p: PrinterRow, bytes: Uint8Array): Promise<void> {
    if (this.platform !== 'win32') throw new Error('The Windows printer (spooler) connection is only available on Windows.');
    const name = (p.address ?? '').trim();
    if (!name) throw new Error('This printer needs the Windows printer name as its address.');
    this.run ??= powershellRunner(this.timeoutMs);
    const res = await this.run({ printerName: name, docName: `POS ${p.name}`.slice(0, 60), bytes });
    if (res.timedOut) throw new Error(`Printer "${name}" timed out. Check that it is on and its queue is not paused.`);
    const out = res.stdout.trim();
    const okMatch = /^OK (\d+)$/.exec(out);
    if (okMatch && res.code === 0) {
      const n = Number(okMatch[1]);
      if (n !== bytes.length) throw new Error(`Printer "${name}" accepted ${n} of ${bytes.length} bytes. The job will be retried.`);
      return;
    }
    const err = /^ERR (\w+) (\d+)$/.exec(out);
    if (err) {
      const stage = err[1]!; const code = Number(err[2]);
      const hint = WIN32_HINTS[code];
      if (hint) throw new Error(`Printer "${name}" ${hint}.`);
      if (stage === 'write') throw new Error(`Printer "${name}" stopped while sending (Windows error ${code}). Check the cable and power.`);
      throw new Error(`Printer "${name}" could not start a print job (Windows error ${code} at ${stage}).`);
    }
    // PowerShell itself failed (blocked by policy or antivirus, or missing). Never show its raw text.
    throw new Error('The app could not start the Windows print helper. Check that antivirus is not blocking PowerShell.');
  }
}
