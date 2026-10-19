// Draws marked receipt lines (textPicture.ts) with the system's own fonts:
//  - Windows: GDI+ in a constant PowerShell script (Nirmala UI covers Hindi, the other Indian scripts and the rupee
//    sign; GDI+ joins Hindi letters correctly). The lines travel base64-encoded on stdin, never on the command line.
//  - Android: the app's printer service draws them with Android's fonts (op "render", PrinterBridge.java).
// Anything else (tests, Linux): no renderer, so those lines print as text ("Rs", "?"), as before.
import { runPowerShell } from './powershell.ts';
import type { PsRunner } from './powershell.ts';
import { bridgeConfig, bridgeRender } from './android.ts';
import type { Picture, PictureSpec, TextRenderer } from './textPicture.ts';

// Font A is 12 x 24 dots; a line at size w x h is (cols x 12w) dots wide and 24h dots high.
const RENDER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))
$specs = ConvertFrom-Json $json  # an array: foreach walks its items (wrapping it in @() would nest it)
$family = 'Nirmala UI'
$probe = New-Object System.Drawing.Font($family, 12)
if ($probe.Name -ne $family) { $family = 'Mangal' }
$probe.Dispose()
foreach ($s in $specs) {
  try {
    $cellW = 12 * [int]$s.w; $height = 24 * [int]$s.h
    $width = [int]([Math]::Ceiling(([int]$s.c * $cellW) / 8.0) * 8)
    $bmp = New-Object System.Drawing.Bitmap $width, $height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $style = [System.Drawing.FontStyle]::Regular
    if ($s.b) { $style = [System.Drawing.FontStyle]::Bold }
    $font = New-Object System.Drawing.Font($family, [single](17 * [int]$s.h), $style, [System.Drawing.GraphicsUnit]::Pixel)
    foreach ($seg in @($s.s)) {
      $fmt = New-Object System.Drawing.StringFormat
      if ($seg.align -eq 'c') { $fmt.Alignment = [System.Drawing.StringAlignment]::Center } elseif ($seg.align -eq 'r') { $fmt.Alignment = [System.Drawing.StringAlignment]::Far } else { $fmt.Alignment = [System.Drawing.StringAlignment]::Near }
      $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
      $fmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
      $fmt.Trimming = [System.Drawing.StringTrimming]::None
      $rect = New-Object System.Drawing.RectangleF ([single]([int]$seg.col * $cellW)), ([single]0), ([single]([int]$seg.width * $cellW)), ([single]$height)
      $g.DrawString([string]$seg.t, $font, [System.Drawing.Brushes]::Black, $rect, $fmt)
      $fmt.Dispose()
    }
    $g.Dispose(); $font.Dispose()
    $all = New-Object System.Drawing.Rectangle 0, 0, $width, $height
    $mono = $bmp.Clone($all, [System.Drawing.Imaging.PixelFormat]::Format1bppIndexed)
    $bits = $mono.LockBits($all, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format1bppIndexed)
    $stride = $bits.Stride
    $raw = New-Object byte[] ($stride * $height)
    [System.Runtime.InteropServices.Marshal]::Copy($bits.Scan0, $raw, 0, $raw.Length)
    $mono.UnlockBits($bits); $mono.Dispose(); $bmp.Dispose()
    $wb = $width / 8
    $out = New-Object byte[] ($wb * $height)
    for ($y = 0; $y -lt $height; $y++) { for ($x = 0; $x -lt $wb; $x++) { $out[$y * $wb + $x] = (-bnot $raw[$y * $stride + $x]) -band 0xFF } }
    [Console]::Out.WriteLine("$wb $height " + [Convert]::ToBase64String($out))
  } catch { [Console]::Out.WriteLine('-') }
}
`;

/** One line of output per spec: "<widthBytes> <height> <base64>", or "-" when that line could not be drawn. */
export function parseRendered(stdout: string, count: number): Array<Picture | null> {
  const rows = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  return Array.from({ length: count }, (_, i) => {
    const m = /^(\d{1,4}) (\d{1,4}) ([A-Za-z0-9+/=]+)$/.exec(rows[i]?.trim() ?? '');
    if (!m) return null;
    const widthBytes = Number(m[1]), height = Number(m[2]), data = new Uint8Array(Buffer.from(m[3]!, 'base64'));
    return data.length === widthBytes * height ? { widthBytes, height, data } : null;
  });
}

export function windowsTextRenderer(run: PsRunner = runPowerShell): TextRenderer {
  return async (specs: PictureSpec[]) => {
    const r = await run({ script: RENDER_SCRIPT, stdin: Buffer.from(JSON.stringify(specs), 'utf8').toString('base64'), timeoutMs: 20_000, maxOutput: 4_000_000 });
    if (r.code !== 0) return specs.map(() => null);
    return parseRendered(r.stdout, specs.length);
  };
}

export function androidTextRenderer(): TextRenderer | null {
  const cfg = bridgeConfig();
  if (!cfg) return null;
  return async (specs: PictureSpec[]) => parseRendered(await bridgeRender(cfg, specs), specs.length);
}

/** The renderer for this machine, or null (lines then print as text). */
export function platformTextRenderer(): TextRenderer | null {
  if (bridgeConfig()) return androidTextRenderer();
  if (process.platform === 'win32') return windowsTextRenderer();
  return null;
}
