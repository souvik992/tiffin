// Browser-side photo preparation: shrink to a menu-tile size and re-encode, so uploads are small (about 30-80 KB)
// and the backend needs no image library. Re-encoding also drops camera metadata such as GPS location.

export const PHOTO_MAX_SIDE = 640;
const MAX_INPUT_BYTES = 15_000_000; // a phone photo; anything bigger is probably not a photo
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export interface PreparedPhoto { dataBase64: string; previewUrl: string; bytes: number }

/** Largest size that fits inside max x max, keeping the aspect ratio and never enlarging. */
export function fitWithin(w: number, h: number, max = PHOTO_MAX_SIDE): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
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
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await toBlob(canvas, 'image/webp', 0.82) ?? await toBlob(canvas, 'image/jpeg', 0.85);
  if (!blob) throw new Error('This browser cannot prepare photos.');
  const buf = new Uint8Array(await blob.arrayBuffer());
  return { dataBase64: toBase64(buf), previewUrl: URL.createObjectURL(blob), bytes: buf.length };
}

function toBlob(c: HTMLCanvasElement, type: string, q: number): Promise<Blob | null> {
  return new Promise((resolve) => c.toBlob((b) => resolve(b && b.type === type ? b : null), type, q));
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
