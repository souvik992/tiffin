// Printing the rupee sign and Indian scripts (Hindi, Bengali, Tamil...). Thermal printers only print plain ASCII in
// text mode, so a line with other characters is printed as a picture (a 1-bit raster) drawn with the system's fonts.
//
// Building a bill happens inside the finalize transaction, where no I/O is allowed (RULES.md 4), so the builder only
// writes a *marker* for such a line: ESC ~ U, a 2-byte length, then JSON {s: segments, w, h, b, c}. The print queue
// replaces each marker just before sending (expandPictures): with a picture when a renderer is available (Windows:
// PowerShell + GDI+, Android: the app's Canvas), or with the line in plain text as before ("Rs", "?") when not.
// A marker never reaches a printer. Previews (parseEscPos) show the real text.

/** One piece of a line: text placed in a column range (col, width in characters) and aligned in it. */
export interface Seg { t: string; col: number; width: number; align: 'l' | 'c' | 'r' }
/** A marked line: segments, text size (w x h) and bold; c = characters per line at that size. */
export interface PictureSpec { s: Seg[]; w: number; h: number; b: boolean; c: number }
export interface Picture { widthBytes: number; height: number; data: Uint8Array }
/** Draws marked lines; null for a line it could not draw (that line falls back to text). */
export type TextRenderer = (specs: PictureSpec[]) => Promise<Array<Picture | null>>;

export const MARKER = [0x1b, 0x7e, 0x55]; // ESC ~ U: not an ESC/POS command

/** Characters text mode cannot print (after the usual dash and quote replacements). */
export const needsPicture = (s: string): boolean => /[^\x20-\x7e–—‘’“”]/.test(s);

export function sanitize(s: string): string {
  return s
    .replace(/₹/g, 'Rs')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e]/g, '?');
}

/** Visible length in characters (combining marks such as Hindi vowel signs take no column of their own). */
export const visibleLength = (s: string): number => [...s.replace(/[̀-ͯऀ-ःऺ-ॏ॑-ॗॢॣঁ-ঃ়-ৗਁ-ਃ਼-ੑੰੱੵઁ-ઃ઼-્ଁ-ଃ଼-ୗஂா-்ௗఀ-ఄా-ౖಁ-ಃ಼-ೖഀ-ഃ഻-ൗ‌‍]/g, '')].length;

/**
 * The line as text, each segment placed in its columns (previews with the real text, and the text fallback).
 * A right-aligned piece that is longer than its columns (an amount whose "Rs" is wider than the rupee sign) grows to
 * the left into free space, so an amount never loses a digit; other pieces are cut to their columns.
 */
export function composeLine(segs: Seg[], cols: number, clean: (s: string) => string = (s) => s): string {
  let out = '';
  for (const g of [...segs].sort((a, b) => a.col - b.col)) {
    let text = clean(g.t);
    let len = visibleLength(text);
    if (len > g.width && g.align !== 'r') { text = [...text].slice(0, g.width).join(''); len = visibleLength(text); }
    const end = g.col + g.width;
    let start = len <= g.width ? (g.align === 'r' ? end - len : g.align === 'c' ? g.col + Math.floor((g.width - len) / 2) : g.col) : end - len;
    const used = visibleLength(out);
    start = Math.max(start, used === 0 ? 0 : used + 1);
    out += ' '.repeat(Math.max(0, start - used)) + text;
  }
  out = out.replace(/\s+$/, '');
  return visibleLength(out) > cols ? [...out].slice(0, cols).join('') : out;
}

export function encodeMarker(spec: PictureSpec): number[] {
  const json = Buffer.from(JSON.stringify(spec), 'utf8');
  if (json.length > 0xffff) throw new RangeError('line too long');
  return [...MARKER, json.length & 0xff, json.length >> 8, ...json];
}

/** Where markers are in a payload, found with the same command walk as the preview parser. */
export function findMarkers(b: Uint8Array): Array<{ start: number; end: number; spec: PictureSpec }> {
  const out: Array<{ start: number; end: number; spec: PictureSpec }> = [];
  let i = 0;
  while (i < b.length) {
    const c = b[i]!;
    if (c === 0x1b) {
      const n = b[i + 1];
      if (n === 0x7e && b[i + 2] === 0x55) {
        const len = b[i + 3]! + b[i + 4]! * 256;
        out.push({ start: i, end: i + 5 + len, spec: JSON.parse(Buffer.from(b.subarray(i + 5, i + 5 + len)).toString('utf8')) as PictureSpec });
        i += 5 + len; continue;
      }
      i += n === 0x40 ? 2 : n === 0x70 ? 5 : 3;
      continue;
    }
    if (c === 0x1d) {
      const n = b[i + 1];
      if (n === 0x28) { i += 5 + b[i + 3]! + b[i + 4]! * 256; continue; }
      if (n === 0x76) { i += 8 + (b[i + 4]! + b[i + 5]! * 256) * (b[i + 6]! + b[i + 7]! * 256); continue; }
      if (n === 0x56) { const m = b[i + 2]; i += m === 65 || m === 66 ? 4 : 3; continue; }
      i += 3; continue;
    }
    i++;
  }
  return out;
}

const textBytes = (s: string) => [...s].map((ch) => ch.charCodeAt(0) & 0xff);
/** GS v 0 raster command bytes. */
function rasterBytes(p: Picture): number[] {
  return [0x1d, 0x76, 0x30, 0, p.widthBytes & 0xff, p.widthBytes >> 8, p.height & 0xff, p.height >> 8, ...p.data];
}

const cache = new Map<string, Picture>();
const CACHE_MAX = 300;

/**
 * Replaces every marker: a picture from the renderer, or the line in plain text. Never throws because of the renderer:
 * a renderer that fails or is missing only means the line prints as text, as it did before pictures existed.
 */
export async function expandPictures(payload: Uint8Array, renderer: TextRenderer | null): Promise<Uint8Array> {
  const marks = findMarkers(payload);
  if (marks.length === 0) return payload;
  const keys = marks.map((m) => JSON.stringify(m.spec));
  const todo = [...new Set(keys.filter((k) => !cache.has(k)))];
  if (renderer && todo.length) {
    try {
      const pics = await renderer(todo.map((k) => JSON.parse(k) as PictureSpec));
      todo.forEach((k, n) => {
        const p = pics[n];
        if (p && p.widthBytes > 0 && p.height > 0 && p.data.length === p.widthBytes * p.height) {
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
          cache.set(k, p);
        }
      });
    } catch { /* text fallback below */ }
  }
  const out: number[] = [];
  let at = 0;
  marks.forEach((m, n) => {
    for (let k = at; k < m.start; k++) out.push(payload[k]!);
    const pic = renderer ? cache.get(keys[n]!) : undefined;
    if (pic) out.push(...rasterBytes(pic));
    else out.push(...textBytes(composeLine(m.spec.s, m.spec.c, sanitize)), 0x0a);
    at = m.end;
  });
  for (let k = at; k < payload.length; k++) out.push(payload[k]!);
  return Uint8Array.from(out);
}

/** For tests: forget drawn lines. */
export function clearPictureCache(): void { cache.clear(); }
