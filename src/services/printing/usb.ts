import { runPowerShell } from './powershell.ts';
import type { PsResult, PsRunner } from './powershell.ts';
import { PROFILES } from './transports.ts';
import type { PrinterRow, Transport } from './transports.ts';

/**
 * Plug-and-play USB printing without a printer driver.
 *
 * Windows loads its in-box "USB Printing Support" class driver (usbprint.sys) for every USB printer-class device,
 * even when no printer driver is installed. That driver exposes a device interface
 * (GUID_DEVINTERFACE_USBPRINT) which accepts raw bytes, so ESC/POS can be written straight to the printer.
 * The printer is identified by vendor:product[:serial] (not by USB port), so moving the cable to another port works.
 *
 * Printers on the WinUSB driver are supported too. A USB printer whose driver was replaced by WinUSB (for example with
 * the Zadig tool, or a vendor package built on WinUSB) has no usbprint interface, no Windows printer and no COM port.
 * For printer-class devices (USB class 07) running WinUSB, the bytes go to the bulk OUT endpoint through winusb.dll.
 * Neither path needs administrator rights.
 *
 * Safety: constant script; the ids go in environment variables, the bytes on stdin (see powershell.ts).
 */

export interface UsbPrinterInfo { id: string; vid: string; pid: string; serial: string | null; name: string; vendor: string | null; driver: 'usbprint' | 'winusb' }

const VENDORS: Record<string, string> = {
  '0416': 'Winbond (common in 58/80 mm POS printers)', '04b8': 'Epson', '0519': 'Star Micronics', '0dd4': 'Custom', '1504': 'Bixolon',
  '0483': 'STMicroelectronics (common in POS printers)', '1fc9': 'NXP (common in POS printers)', '28e9': 'GigaDevice (common in POS printers)',
  '0fe6': 'ICS (common in POS printers)', '154f': 'SNBC', '0b00': 'Ingenico', '0525': 'Netchip (common in POS printers)', '2d37': 'Xprinter',
  '6868': 'Xprinter/Rongta', '1a86': 'QinHeng (USB-serial / POS printers)', '0485': 'Nokia/TVS', '0d3a': 'Posiflex',
};

export function parseUsbAddress(address: string | null | undefined): { vid: string; pid: string; serial: string | null } | null {
  const m = /^([0-9a-fA-F]{4}):([0-9a-fA-F]{4})(?::([0-9A-Za-z._-]{1,64}))?$/.exec((address ?? '').trim());
  if (!m) return null;
  return { vid: m[1]!.toLowerCase(), pid: m[2]!.toLowerCase(), serial: m[3] ? m[3].toLowerCase() : null };
}

/** \\?\usb#vid_0416&pid_5011#<instance>#{guid}: the instance is the serial number unless Windows generated it (contains '&').
 * The GUID is usbprint's, or the device's own one for WinUSB. */
export function idFromInterfacePath(path: string): { vid: string; pid: string; serial: string | null } | null {
  const m = /^\\\\\?\\usb#vid_([0-9a-f]{4})&pid_([0-9a-f]{4})(?:&[^#]*)?#([^#]+)#\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.exec(path.trim());
  if (!m) return null;
  const inst = m[3]!;
  const serial = inst.includes('&') || !/^[0-9A-Za-z._-]{1,64}$/.test(inst) ? null : inst.toLowerCase();
  return { vid: m[1]!.toLowerCase(), pid: m[2]!.toLowerCase(), serial };
}

const CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PosUsb {
  [StructLayout(LayoutKind.Sequential)] struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SP_DEVINFO_DATA { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr enumerator, IntPtr hwnd, int flags);
  [DllImport("setupapi.dll", SetLastError = true)] static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr dev, ref Guid g, int index, ref SP_DEVICE_INTERFACE_DATA d);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA d, IntPtr detail, int size, out int required, ref SP_DEVINFO_DATA info);
  [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool SetupDiGetDeviceRegistryProperty(IntPtr set, ref SP_DEVINFO_DATA info, int prop, out int regType, byte[] buf, int size, out int required);
  [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr h, byte[] buf, int n, out int written, IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential, Pack = 1)] struct USB_INTERFACE_DESCRIPTOR { public byte bLength, bDescriptorType, bInterfaceNumber, bAlternateSetting, bNumEndpoints, bInterfaceClass, bInterfaceSubClass, bInterfaceProtocol, iInterface; }
  [StructLayout(LayoutKind.Sequential)] struct WINUSB_PIPE_INFORMATION { public int PipeType; public byte PipeId; public ushort MaximumPacketSize; public byte Interval; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateFile")] static extern Microsoft.Win32.SafeHandles.SafeFileHandle OpenDevice(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
  [DllImport("winusb.dll", SetLastError = true)] static extern bool WinUsb_Initialize(Microsoft.Win32.SafeHandles.SafeFileHandle h, out IntPtr ih);
  [DllImport("winusb.dll", SetLastError = true)] static extern bool WinUsb_Free(IntPtr ih);
  [DllImport("winusb.dll", SetLastError = true)] static extern bool WinUsb_QueryInterfaceSettings(IntPtr ih, byte alt, out USB_INTERFACE_DESCRIPTOR d);
  [DllImport("winusb.dll", SetLastError = true)] static extern bool WinUsb_QueryPipe(IntPtr ih, byte alt, byte index, out WINUSB_PIPE_INFORMATION p);
  [DllImport("winusb.dll", SetLastError = true)] static extern bool WinUsb_SetPipePolicy(IntPtr ih, byte pipe, uint policy, uint len, ref uint value);
  [DllImport("winusb.dll", SetLastError = true)] static extern bool WinUsb_WritePipe(IntPtr ih, byte pipe, byte[] buf, int len, out int written, IntPtr overlapped);

  static Guid USBPRINT = new Guid("28d78fad-5a12-11d1-ae5b-0000f8031c4f");
  const int DIGCF_PRESENT = 0x2, DIGCF_DEVICEINTERFACE = 0x10, SPDRP_DEVICEDESC = 0x0, SPDRP_FRIENDLYNAME = 0xC;

  static string Prop(IntPtr set, ref SP_DEVINFO_DATA info, int prop) {
    int t, req; byte[] b = new byte[1024];
    if (!SetupDiGetDeviceRegistryProperty(set, ref info, prop, out t, b, b.Length, out req) || req < 2) return null;
    return Encoding.Unicode.GetString(b, 0, req - 2).TrimEnd('\\0');
  }

  /** Interface paths of present devices with this interface class. */
  static List<string[]> Interfaces(Guid g) {
    var found = new List<string[]>();
    IntPtr set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (set == new IntPtr(-1)) return found;
    try {
      for (int i = 0; i < 64; i++) {
        var d = new SP_DEVICE_INTERFACE_DATA(); d.cbSize = Marshal.SizeOf(d);
        if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref d)) break;
        var info = new SP_DEVINFO_DATA(); info.cbSize = Marshal.SizeOf(info);
        int req;
        SetupDiGetDeviceInterfaceDetail(set, ref d, IntPtr.Zero, 0, out req, ref info);
        if (req <= 0) continue;
        IntPtr buf = Marshal.AllocHGlobal(req);
        try {
          Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6); // cbSize of SP_DEVICE_INTERFACE_DETAIL_DATA_W
          if (!SetupDiGetDeviceInterfaceDetail(set, ref d, buf, req, out req, ref info)) continue;
          string path = Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + 4));
          string name = Prop(set, ref info, SPDRP_FRIENDLYNAME) ?? Prop(set, ref info, SPDRP_DEVICEDESC) ?? "";
          found.Add(new string[] { path, name });
        } finally { Marshal.FreeHGlobal(buf); }
      }
    } finally { SetupDiDestroyDeviceInfoList(set); }
    return found;
  }

  /** [path, name, kind]: usbprint printers, then printer-class devices (USB class 07) running the WinUSB driver. */
  public static List<string[]> List() {
    var found = new List<string[]>();
    foreach (var p in Interfaces(USBPRINT)) found.Add(new string[] { p[0], p[1], "usbprint" });
    var guids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    try {
      using (var usb = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\\CurrentControlSet\\Enum\\USB")) { // \\ in this template literal is one backslash in C#
        if (usb != null) foreach (var dev in usb.GetSubKeyNames()) {
          using (var dk = usb.OpenSubKey(dev)) { if (dk == null) continue;
            foreach (var inst in dk.GetSubKeyNames()) {
              using (var ik = dk.OpenSubKey(inst)) { if (ik == null) continue;
                var service = ik.GetValue("Service") as string;
                var compat = ik.GetValue("CompatibleIDs") as string[];
                if (service == null || !service.Equals("WinUSB", StringComparison.OrdinalIgnoreCase) || compat == null) continue;
                bool printer = false;
                foreach (var c in compat) if (c.IndexOf("Class_07", StringComparison.OrdinalIgnoreCase) >= 0) printer = true;
                if (!printer) continue;
                using (var pk = ik.OpenSubKey("Device Parameters")) { if (pk == null) continue;
                  var many = pk.GetValue("DeviceInterfaceGUIDs") as string[];
                  if (many != null) foreach (var x in many) guids.Add(x);
                  var one = pk.GetValue("DeviceInterfaceGUID") as string;
                  if (one != null) guids.Add(one);
                }
              }
            }
          }
        }
      }
    } catch (Exception) { /* registry not readable: usbprint printers are still listed */ }
    foreach (var gs in guids) {
      Guid g;
      try { g = new Guid(gs); } catch (Exception) { continue; }
      foreach (var p in Interfaces(g)) found.Add(new string[] { p[0], p[1], "winusb" });
    }
    return found;
  }

  /** Writes through WinUSB to the first bulk OUT endpoint. probeOnly: open and find the endpoint, send nothing. */
  static string SendWinUsb(string path, byte[] data, int chunk, bool probeOnly) {
    using (var h = OpenDevice(path, 0xC0000000, 0x3, IntPtr.Zero, 3, 0x40000000, IntPtr.Zero)) { // read/write, overlapped (WinUSB needs it)
      if (h.IsInvalid) return "ERR open " + Marshal.GetLastWin32Error();
      IntPtr ih;
      if (!WinUsb_Initialize(h, out ih)) return "ERR init " + Marshal.GetLastWin32Error();
      try {
        USB_INTERFACE_DESCRIPTOR d;
        if (!WinUsb_QueryInterfaceSettings(ih, 0, out d)) return "ERR init " + Marshal.GetLastWin32Error();
        byte pipe = 0;
        for (byte i = 0; i < d.bNumEndpoints; i++) {
          WINUSB_PIPE_INFORMATION p;
          if (WinUsb_QueryPipe(ih, 0, i, out p) && p.PipeType == 2 && (p.PipeId & 0x80) == 0) { pipe = p.PipeId; break; } // bulk, host to printer
        }
        if (pipe == 0) return "ERR init 50";
        if (probeOnly) return "OK probe " + pipe;
        uint timeout = 10000;
        WinUsb_SetPipePolicy(ih, pipe, 0x03, 4, ref timeout); // PIPE_TRANSFER_TIMEOUT: a printer out of paper must not hang the queue
        int off = 0;
        while (off < data.Length) {
          int n = Math.Min(chunk, data.Length - off);
          byte[] part = new byte[n];
          Buffer.BlockCopy(data, off, part, 0, n);
          int w;
          if (!WinUsb_WritePipe(ih, pipe, part, n, out w, IntPtr.Zero)) return "ERR write " + Marshal.GetLastWin32Error();
          if (w <= 0) return "ERR write 0";
          off += w;
        }
        return "OK " + off;
      } finally { WinUsb_Free(ih); }
    }
  }

  public static string Send(string vid, string pid, string serial, byte[] data, int chunk, bool probeOnly) {
    string want = "vid_" + vid + "&pid_" + pid;
    string path = null, kind = null;
    foreach (var p in List()) {
      string lp = p[0].ToLowerInvariant();
      if (lp.IndexOf(want, StringComparison.Ordinal) < 0) continue;
      if (!string.IsNullOrEmpty(serial) && lp.IndexOf("#" + serial + "#", StringComparison.Ordinal) < 0) continue;
      path = p[0]; kind = p[2]; break;
    }
    if (path == null) return "ERR notfound";
    if (kind == "winusb") return SendWinUsb(path, data, chunk, probeOnly);
    if (probeOnly) return "OK probe usbprint";
    IntPtr h = CreateFile(path, 0x40000000, 0x3, IntPtr.Zero, 3, 0, IntPtr.Zero); // GENERIC_WRITE, share read/write, OPEN_EXISTING
    if (h == new IntPtr(-1)) return "ERR open " + Marshal.GetLastWin32Error();
    try {
      int off = 0;
      while (off < data.Length) {
        int n = Math.Min(chunk, data.Length - off);
        byte[] part = new byte[n];
        Buffer.BlockCopy(data, off, part, 0, n);
        int w;
        if (!WriteFile(h, part, n, out w, IntPtr.Zero)) return "ERR write " + Marshal.GetLastWin32Error();
        if (w <= 0) return "ERR write 0";
        off += w;
      }
      return "OK " + off;
    } finally { CloseHandle(h); }
  }
}
`;

export function usbScript(): string {
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${CSHARP}
'@
if ($env:POS_USB_MODE -eq 'send') {
  $data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  [Console]::Out.Write([PosUsb]::Send($env:POS_USB_VID, $env:POS_USB_PID, $env:POS_USB_SERIAL, $data, [int]$env:POS_USB_CHUNK, $false))
} elseif ($env:POS_USB_MODE -eq 'probe') {
  [Console]::Out.Write([PosUsb]::Send($env:POS_USB_VID, $env:POS_USB_PID, $env:POS_USB_SERIAL, [byte[]]@(), 1, $true))
} else {
  $out = @()
  foreach ($p in [PosUsb]::List()) { $out += [pscustomobject]@{ Path = [string]$p[0]; Name = [string]$p[1]; Kind = [string]$p[2] } }
  [Console]::Out.Write((ConvertTo-Json -InputObject $out -Compress))
}
`;
}

interface Opts { platform?: string; run?: PsRunner }

/** USB printer-class devices that are plugged in now (with or without a printer driver). */
export async function listUsbPrinters(o: Opts = {}): Promise<UsbPrinterInfo[]> {
  if ((o.platform ?? process.platform) !== 'win32') return [];
  const res = await (o.run ?? runPowerShell)({ script: usbScript(), env: { POS_USB_MODE: 'list' }, timeoutMs: 30_000, maxOutput: 64 * 1024 });
  if (res.code !== 0 || res.timedOut) throw new Error('Windows could not list the USB printers. Try again.');
  const t = res.stdout.trim();
  if (!t) return [];
  const raw = JSON.parse(t) as unknown;
  const out: UsbPrinterInfo[] = [];
  for (const r of (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>) {
    const id = idFromInterfacePath(String(r?.Path ?? ''));
    if (!id) continue;
    out.push({ id: [id.vid, id.pid, id.serial].filter(Boolean).join(':'), vid: id.vid, pid: id.pid, serial: id.serial, name: String(r.Name ?? '').trim() || 'USB printer', vendor: VENDORS[id.vid] ?? null, driver: r.Kind === 'winusb' ? 'winusb' : 'usbprint' });
  }
  return out;
}

/** Opens the printer and finds where receipts go, without sending anything (nothing prints). */
export async function probeUsbPrinter(address: string, o: Opts = {}): Promise<{ ok: boolean; detail: string }> {
  const a = parseUsbAddress(address);
  if (!a || (o.platform ?? process.platform) !== 'win32') return { ok: false, detail: 'not available' };
  const res = await (o.run ?? runPowerShell)({ script: usbScript(), timeoutMs: 30_000, env: { POS_USB_MODE: 'probe', POS_USB_VID: a.vid, POS_USB_PID: a.pid, POS_USB_SERIAL: a.serial ?? '' } });
  const out = res.stdout.trim();
  return { ok: res.code === 0 && out.startsWith('OK probe'), detail: out };
}

export class UsbTransport implements Transport {
  private platform: string;
  private run: PsRunner;
  private timeoutMs: number;
  constructor(o: { platform?: string; run?: PsRunner; timeoutMs?: number } = {}) {
    this.platform = o.platform ?? process.platform;
    this.run = o.run ?? runPowerShell;
    this.timeoutMs = o.timeoutMs ?? 45_000;
  }

  async send(p: PrinterRow, bytes: Uint8Array): Promise<void> {
    if (this.platform !== 'win32') throw new Error('Direct USB printing is only available on Windows.');
    const a = parseUsbAddress(p.address);
    if (!a) throw new Error('This printer needs its USB printer id (vendor:product), set when it was detected.');
    const chunk = PROFILES[p.profile]?.chunk ?? PROFILES.generic!.chunk;
    const res = await this.run({
      script: usbScript(), stdin: Buffer.from(bytes).toString('base64'), timeoutMs: this.timeoutMs,
      env: { POS_USB_MODE: 'send', POS_USB_VID: a.vid, POS_USB_PID: a.pid, POS_USB_SERIAL: a.serial ?? '', POS_USB_CHUNK: String(chunk) },
    });
    explain(p.name, res, bytes.length);
  }
}

function explain(name: string, res: PsResult, expected: number): void {
  if (res.timedOut) throw new Error(`USB printer "${name}" did not take the receipt. Check that it has paper, the cover is closed and it is switched on.`);
  const out = res.stdout.trim();
  const ok = /^OK (\d+)$/.exec(out);
  if (ok && res.code === 0) {
    const n = Number(ok[1]);
    if (n !== expected) throw new Error(`USB printer "${name}" accepted ${n} of ${expected} bytes. The job will be retried.`);
    return;
  }
  if (out === 'ERR notfound') throw new Error(`USB printer "${name}" is not connected. Check the USB cable and that the printer is switched on.`);
  const err = /^ERR (open|write|init) (\d+)$/.exec(out);
  if (err) {
    const stage = err[1]!, code = Number(err[2]);
    if (stage === 'init') throw new Error(`USB printer "${name}" could not be opened (Windows error ${code}). Unplug it, plug it back in and try again.`);
    if (stage === 'write' && code === 121) throw new Error(`USB printer "${name}" did not take the receipt. Check that it has paper, the cover is closed and it is switched on.`);
    if (stage === 'open' && (code === 5 || code === 32)) throw new Error(`USB printer "${name}" is in use by another program or a Windows print job. Wait a moment; it will retry.`);
    if (stage === 'open') throw new Error(`USB printer "${name}" is not connected (Windows error ${code}). Check the USB cable.`);
    if (code === 1167 || code === 22) throw new Error(`USB printer "${name}" was unplugged while printing. Plug it back in; the bill will print again.`);
    throw new Error(`USB printer "${name}" stopped while printing (Windows error ${code}). Check paper and power.`);
  }
  throw new Error('The app could not start the Windows print helper. Check that antivirus is not blocking PowerShell.');
}
