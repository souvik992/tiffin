// Browser-side photo compression for menu photos (single upload and bulk photos): shrink to at most 1024 px and
// re-encode as WebP, so a 3-5 MB phone photo becomes about 20-80 KB and the backend needs no image library.
// Quality was measured on real photos (docs/DECISIONS.md): the high-quality resize matches a careful step-by-step
// resize, and WebP at 90% stays at a visually identical level (PSNR about 38-46 dB). 1024 px keeps photos sharp on
// customers' phones (online ordering), not only on the small billing tiles. Re-encoding also drops camera metadata
// such as the GPS location.

export const PHOTO_MAX_SIDE = 1024;
export const PHOTO_QUALITY = 0.9;
const MAX_INPUT_BYTES = 15_000_000; // a phone photo; anything bigger is probably not a photo
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export interface PreparedPhoto { dataBase64: string; previewUrl: string; bytes: number; originalBytes: number }

/** Largest size that fits inside max x max, keeping the aspect ratio and never enlarging. */
export function fitWithin(w: number, h: number, max = PHOTO_MAX_SIDE): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** "47 KB", "3.2 MB". */
export function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!ACCEPTED.includes(file.type)) throw new Error('Use a JPG, PNG or WebP photo. (iPhone HEIC photos: export as JPG first.)');
  if (file.size > MAX_INPUT_BYTES) throw new Error('That file is too large. Use a photo under 15 MB.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('That photo could not be opened. Try another one.'); }
  const { w, h } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('This browser cannot prepare photos.');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); // transparent PNGs get a white background
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high'; // the default ("low") visibly softens and roughens a large photo when shrinking it
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await toBlob(canvas, 'image/webp', PHOTO_QUALITY) ?? await toBlob(canvas, 'image/jpeg', PHOTO_QUALITY);
  if (!blob) throw new Error('This browser cannot prepare photos.');
  const buf = new Uint8Array(await blob.arrayBuffer());
  return { dataBase64: toBase64(buf), previewUrl: URL.createObjectURL(blob), bytes: buf.length, originalBytes: file.size };
}

function toBlob(c: HTMLCanvasElement, type: string, q: number): Promise<Blob | null> {
  return new Promise((resolve) => c.toBlob((b) => resolve(b && b.type === type ? b : null), type, q));
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
