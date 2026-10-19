// Minimal ESC/POS byte builder. Plain ASCII prints as text; a line with the rupee sign or an Indian script is written
// as a marker that the print queue turns into a picture (textPicture.ts), or into "Rs" and "?" when it cannot draw.
import { composeLine, encodeMarker, needsPicture, sanitize, visibleLength } from './textPicture.ts';
import type { Seg } from './textPicture.ts';
export { sanitize, needsPicture };
const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

/** Typographic dashes and quotes become plain ones; other characters are kept (they print as a picture). */
const tidy = (s: string) => s.replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');

export function wrapText(s: string, width: number): string[] {
  const pic = needsPicture(s);
  const len = pic ? visibleLength : (x: string) => x.length;
  const cut = (x: string, n: number) => (pic ? [...x].slice(0, n).join('') : x.slice(0, n));
  const rest = (x: string, n: number) => (pic ? [...x].slice(n).join('') : x.slice(n));
  const out: string[] = [];
  let cur = '';
  for (const word of (pic ? tidy(s) : sanitize(s)).split(/\s+/).filter(Boolean)) {
    let w = word;
    while (len(w) > width) {
      if (cur) { out.push(cur); cur = ''; }
      out.push(cut(w, width));
      w = rest(w, width);
    }
    if (!cur) cur = w;
    else if (len(cur) + 1 + len(w) <= width) cur += ' ' + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

export class EscPos {
  private buf: number[] = [];
  private wMul = 1;
  private hMul = 1;
  private isBold = false;
  readonly cols: number;
  constructor(cols: number) { this.cols = cols; }

  raw(...b: number[]): this { for (const x of b) this.buf.push(x & 0xff); return this; }
  init(): this { return this.raw(ESC, 0x40); }
  codepage(n: number): this { return this.raw(ESC, 0x74, n); }
  bold(on: boolean): this { this.isBold = on; return this.raw(ESC, 0x45, on ? 1 : 0); }
  size(w: number, h: number): this { this.wMul = w; this.hMul = h; return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1)); }
  private effCols(): number { return Math.max(1, Math.floor(this.cols / this.wMul)); }
  /** Characters per line at the current text size. */
  width(): number { return this.effCols(); }
  text(s: string): this { for (const ch of sanitize(s)) this.buf.push(ch.charCodeAt(0)); return this; }
  line(s = ''): this {
    if (needsPicture(s)) return this.segments([{ t: tidy(s), col: 0, width: this.effCols(), align: 'l' }]);
    this.text(s); return this.raw(LF);
  }
  /** A line made of pieces placed in columns; printed as a picture when any piece needs it (see textPicture.ts). */
  segments(segs: Seg[]): this {
    if (segs.some((g) => needsPicture(g.t))) return this.raw(...encodeMarker({ s: segs, w: this.wMul, h: this.hMul, b: this.isBold, c: this.effCols() }));
    this.text(composeLine(segs, this.effCols(), sanitize));
    return this.raw(LF);
  }
  center(s: string): this {
    const w = this.effCols();
    for (const part of wrapText(s, w)) {
      if (needsPicture(part)) this.segments([{ t: part, col: 0, width: w, align: 'c' }]);
      else this.line(' '.repeat(Math.max(0, Math.floor((w - part.length) / 2))) + part);
    }
    return this;
  }
  right(s: string): this {
    const w = this.effCols();
    for (const part of wrapText(s, w)) {
      if (needsPicture(part)) this.segments([{ t: part, col: 0, width: w, align: 'r' }]);
      else this.line(' '.repeat(Math.max(0, w - part.length)) + part);
    }
    return this;
  }
  twoCol(left: string, right: string): this {
    const w = this.effCols();
    if (needsPicture(left) || needsPicture(right)) {
      const r = Math.min(visibleLength(tidy(right)), w);
      return this.segments([{ t: tidy(left), col: 0, width: Math.max(0, w - r - 1), align: 'l' }, { t: tidy(right), col: w - r, width: r, align: 'r' }]);
    }
    const R = sanitize(right);
    let L = sanitize(left);
    if (L.length + R.length + 1 > w) L = L.slice(0, Math.max(0, w - R.length - 1));
    return this.line(L + ' '.repeat(w - L.length - R.length) + R);
  }
  wrapped(s: string, indent = 0): this {
    for (const part of wrapText(s, this.effCols() - indent)) {
      if (needsPicture(part)) this.segments([{ t: part, col: indent, width: this.effCols() - indent, align: 'l' }]);
      else this.line(' '.repeat(indent) + part);
    }
    return this;
  }
  rule(ch = '-'): this { return this.line(ch.repeat(this.effCols())); }
  feed(n: number): this { return this.raw(ESC, 0x64, n); }
  cut(): this { return this.raw(GS, 0x56, 66, 3); }
  drawerKick(): this { return this.raw(ESC, 0x70, 0, 25, 250); }
  /** Native QR code (model 2). */
  qr(data: string, size = 6, ec: 'L' | 'M' | 'Q' | 'H' = 'M'): this {
    const d = sanitize(data);
    if (d.length === 0 || d.length > 400) throw new RangeError('QR data must be 1-400 characters');
    const lvl = { L: 48, M: 49, Q: 50, H: 51 }[ec];
    this.raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0);
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, size);
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, lvl);
    const len = d.length + 3;
    this.raw(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30);
    for (const ch of d) this.buf.push(ch.charCodeAt(0));
    return this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);
  }
  /** Raster bit image (GS v 0). data = widthBytes * height bytes, 1 bit per pixel, MSB first. */
  raster(widthBytes: number, height: number, data: Uint8Array): this {
    if (data.length !== widthBytes * height) throw new RangeError('raster data size mismatch');
    this.raw(GS, 0x76, 0x30, 0, widthBytes & 0xff, widthBytes >> 8, height & 0xff, height >> 8);
    for (const b of data) this.buf.push(b);
    return this;
  }
  /** A 1-bit logo (1 = black, rows of width/8 bytes), centred on the paper: font A is 12 dots wide, so the paper is cols x 12 dots. */
  logo(width: number, height: number, data: Uint8Array): this {
    const paper = Math.floor((this.cols * 12) / 8), own = width / 8;
    if (own > paper) throw new RangeError('logo wider than the paper');
    const left = Math.floor((paper - own) / 2), rowBytes = left + own;
    const out = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) out.set(data.subarray(y * own, (y + 1) * own), y * rowBytes + left);
    return this.raster(rowBytes, height, out);
  }
  bytes(): Uint8Array { return Uint8Array.from(this.buf); }
}
