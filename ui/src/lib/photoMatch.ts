// Bulk photo upload: which menu item each photo file belongs to, from its file name. Exact matches only (name, short
// name, SKU or barcode, ignoring case, spaces and punctuation); anything unclear is left for the person to choose.

export interface MatchableItem { id: string; name: string; shortName: string | null; sku: string | null; barcode: string | null }
export interface PhotoMatch {
  file: string;
  itemId: string | null;
  /** How it matched, or why not: 'duplicate' = an earlier photo in this batch already took that item. */
  how: 'name' | 'sku' | 'barcode' | 'none' | 'duplicate';
  duplicateOf?: string;
}

/** "Cheese_Burger (1).JPG" -> "cheese burger". */
export function photoKey(fileName: string): string {
  return fileName
    .replace(/\.[a-z0-9]{2,5}$/i, '') // extension
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, '') // "(1)" copies
    .replace(/\s+copy$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
const squash = (s: string) => s.replace(/ /g, '');

export function matchPhotos(files: string[], items: MatchableItem[]): PhotoMatch[] {
  const byName = new Map<string, string[]>();
  const add = (k: string, id: string) => { if (!k) return; const l = byName.get(k) ?? []; if (!l.includes(id)) l.push(id); byName.set(k, l); };
  for (const i of items) {
    for (const n of [i.name, i.shortName]) if (n) { const k = photoKey(n); add(k, i.id); add(squash(k), i.id); }
  }
  const bySku = new Map(items.filter((i) => i.sku).map((i) => [photoKey(i.sku!), i.id]));
  const byBarcode = new Map(items.filter((i) => i.barcode).map((i) => [i.barcode!.trim(), i.id]));
  const taken = new Map<string, string>(); // itemId -> first file

  return files.map((file) => {
    const k = photoKey(file);
    let itemId: string | null = null, how: PhotoMatch['how'] = 'none';
    const named = byName.get(k) ?? byName.get(squash(k));
    if (named?.length === 1) { itemId = named[0]!; how = 'name'; }
    else if (!named && bySku.has(k)) { itemId = bySku.get(k)!; how = 'sku'; }
    else if (!named && byBarcode.has(k)) { itemId = byBarcode.get(k)!; how = 'barcode'; }
    if (itemId && taken.has(itemId)) return { file, itemId: null, how: 'duplicate', duplicateOf: taken.get(itemId)! };
    if (itemId) taken.set(itemId, file);
    return { file, itemId, how };
  });
}
