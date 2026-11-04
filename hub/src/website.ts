/**
 * Each store's website settings: the words, photo, contact details and colour its ordering website shows. Set on the
 * hub admin page, saved on the store (column `website_json`), and sent to the website with the store page
 * (GET /v1/stores/<slug>), so a change shows on the next page load without redeploying the website.
 * The hub address and the store name stay in the website's own js/config.js: the website needs them to reach the hub.
 */

export interface WebsiteSettings {
  heroTitle: string;
  heroSubtitle: string;
  /** A wide photo for the top of the home page (https://); empty: the first dish photo. */
  heroImage: string;
  about: string;
  phone: string;
  address: string;
  /** A short message shown above the header on every page (offers, holiday hours); empty: none. */
  announcement: string;
  /** The website's main colour, #rrggbb; empty: the website's own. */
  brandColor: string;
}

export const WEBSITE_DEFAULTS: WebsiteSettings = { heroTitle: '', heroSubtitle: '', heroImage: '', about: '', phone: '', address: '', announcement: '', brandColor: '' };

const TEXT: Record<Exclude<keyof WebsiteSettings, 'heroImage' | 'phone' | 'brandColor'>, [number, string]> = {
  heroTitle: [80, 'Keep the title under 80 characters.'],
  heroSubtitle: [200, 'Keep the subtitle under 200 characters.'],
  about: [300, 'Keep the "about" text under 300 characters.'],
  address: [200, 'Keep the address under 200 characters.'],
  announcement: [200, 'Keep the announcement under 200 characters.'],
};

/** Checks a partial update. Unknown fields are refused so a typo is never silently ignored. */
export function checkWebsite(input: unknown): { ok: true; value: Partial<WebsiteSettings> } | { ok: false; errors: Record<string, string> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: { _: 'Send the website settings to change.' } };
  const errors: Record<string, string> = {};
  const value: Partial<WebsiteSettings> = {};
  for (const [k, raw] of Object.entries(input)) {
    if (!(k in WEBSITE_DEFAULTS)) { errors[k] = 'Unknown setting.'; continue; }
    if (typeof raw !== 'string') { errors[k] = 'Send text.'; continue; }
    const v = raw.trim().replace(/\s+/g, ' ');
    if (k === 'heroImage') {
      if (v && (v.length > 500 || !/^https:\/\/[^\s/]+\.[^\s/]+\/\S*$/.test(v))) errors[k] = 'The photo must be an https:// address of an image, or empty.';
      else value.heroImage = v;
    } else if (k === 'phone') {
      if (v && !/^\+?[0-9][0-9 -]{5,18}[0-9]$/.test(v)) errors[k] = 'Enter a phone number with digits, spaces or dashes, e.g. +91 98765 43210.';
      else value.phone = v;
    } else if (k === 'brandColor') {
      if (v && !/^#[0-9a-fA-F]{6}$/.test(v)) errors[k] = 'The colour must look like #ea580c, or be empty.';
      else value.brandColor = v.toLowerCase();
    } else {
      const [max, msg] = TEXT[k as keyof typeof TEXT];
      if (v.length > max) errors[k] = msg;
      else value[k as keyof typeof TEXT] = v;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** A saved value read back: always every field, unknown or broken ones dropped. */
export function readWebsite(json: string | null): WebsiteSettings {
  let saved: Record<string, unknown> = {};
  try { saved = json ? JSON.parse(json) : {}; } catch { /* broken: defaults */ }
  return Object.fromEntries(Object.keys(WEBSITE_DEFAULTS).map((k) => [k, typeof saved[k] === 'string' ? saved[k] : ''])) as unknown as WebsiteSettings;
}
