// A virtual ESC/POS printer: decodes the byte stream the app emits back into text and commands.
// Used by tests and by the on-screen receipt preview.
import { composeLine } from './textPicture.ts';
import type { PictureSpec } from './textPicture.ts';

export interface Parsed {
  lines: string[];
  /** Lines printed as pictures (rupee sign, Indian scripts); their real text is in lines. */
  pictures: number;
  text: string;
  inits: number;
  cuts: number;
  drawerKicks: number;
  qrs: string[];
  rasters: Array<{ widthBytes: number; height: number }>;
}

/** widen: show double-width text as it looks on paper (each character followed by a space), for on-screen previews. */
export function parseEscPos(b: Uint8Array, o: { widen?: boolean } = {}): Parsed {
  const out: Parsed = { lines: [], text: '', inits: 0, cuts: 0, drawerKicks: 0, qrs: [], rasters: [], pictures: 0 };
  let cur = '';
  let i = 0;
  let wide = false;
  const need = (n: number) => { if (i + n > b.length) throw new Error(`truncated command at byte ${i}`); };
  while (i < b.length) {
    const c = b[i]!;
    if (c === 0x0a) { out.lines.push(cur); cur = ''; i++; continue; }
    if (c === 0x1b) {
      need(2);
      switch (b[i + 1]) {
        case 0x40: out.inits++; i += 2; break;
        case 0x74: case 0x61: case 0x45: need(3); i += 3; break;
        case 0x64: need(3); for (let k = 0; k < b[i + 2]!; k++) out.lines.push(''); i += 3; break;
        case 0x70: need(5); out.drawerKicks++; i += 5; break;
        case 0x7e: {
          need(5);
          if (b[i + 2] !== 0x55) throw new Error(`unknown ESC ~ command at byte ${i}`);
          const len = b[i + 3]! + b[i + 4]! * 256;
          need(5 + len);
          const spec = JSON.parse(Buffer.from(b.subarray(i + 5, i + 5 + len)).toString('utf8')) as PictureSpec;
          if (cur) { out.lines.push(cur); cur = ''; }
          out.lines.push(composeLine(spec.s, spec.c));
          out.pictures++;
          i += 5 + len;
          break;
        }
        default: throw new Error(`unknown ESC command 0x${b[i + 1]!.toString(16)} at byte ${i}`);
      }
      continue;
    }
    if (c === 0x1d) {
      need(2);
      switch (b[i + 1]) {
        case 0x21: need(3); wide = ((b[i + 2]! >> 4) & 0x7) > 0; i += 3; break;
        case 0x56: { need(3); const m = b[i + 2]!; if (m === 65 || m === 66) { need(4); i += 4; } else i += 3; out.cuts++; break; }
        case 0x28: {
          need(7);
          if (b[i + 2] !== 0x6b) throw new Error(`unsupported GS ( command at byte ${i}`);
          const len = b[i + 3]! + b[i + 4]! * 256;
          need(5 + len);
          if (b[i + 5] === 0x31 && b[i + 6] === 0x50) out.qrs.push(String.fromCharCode(...b.slice(i + 8, i + 5 + len)));
          if (b[i + 5] === 0x31 && b[i + 6] === 0x51) { if (cur) { out.lines.push(cur); cur = ''; } out.lines.push('[QR code]'); } // where it prints, for text previews
          i += 5 + len;
          break;
        }
        case 0x76: {
          need(8);
          const widthBytes = b[i + 4]! + b[i + 5]! * 256;
          const height = b[i + 6]! + b[i + 7]! * 256;
          need(8 + widthBytes * height);
          if (cur) { out.lines.push(cur); cur = ''; }
          out.lines.push('[LOGO]'); // where it prints, for text previews
          out.rasters.push({ widthBytes, height });
          i += 8 + widthBytes * height;
          break;
        }
        default: throw new Error(`unknown GS command 0x${b[i + 1]!.toString(16)} at byte ${i}`);
      }
      continue;
    }
    cur += o.widen && wide ? String.fromCharCode(c) + ' ' : String.fromCharCode(c);
    i++;
  }
  if (cur) out.lines.push(cur);
  out.text = out.lines.join('\n');
  return out;
}
