// Tiffin POS licence (fine-dine ADR-0007, P8-10). A key from DinePOS Cloud (or the vendor's keygen) bound to this PC
// and labelled for Tiffin POS (product "tiffin_qsr"). Without a usable licence the POS stops at its lock screen:
// every API call except the licence routes is refused (LICENCE_REQUIRED). The lock screen offers: sign in with the
// portal account (30-day trial, or the key the account has), renew (the portal's plans page), or paste a key.
// Installs that already had bills when licensing arrived get 30 days to activate. Not enforced in development runs.
import { AppError } from '../store/db.ts';
import type { Ctx } from '../services/ctx.ts';
import { audit } from '../services/audit.ts';
import { verifyKey, type TrustedKey, type Verified } from './key.ts';
import { licenceStatus } from './status.ts';
import { publicKeyFromBase64 } from './signing.ts';

export const PRODUCT = 'tiffin_qsr';
export const INSTALL_GRACE_DAYS = 30;
export const DEFAULT_CLOUD_URL = 'https://portal.posinext.com';
/** The portal: plans and payment (Renew), and the account. */
export const PORTAL_URL = 'https://portal.posinext.com';
const DAY = 86_400_000;

/** The public keys this app trusts (the same as DinePOS): the vendor's offline master key and DinePOS Cloud's key. */
export const TRUSTED_KEYS: TrustedKey[] = [
  { id: 'master', publicKey: publicKeyFromBase64('MCowBQYDK2VwAyEAopGT8UHDwerHs5P/WX78hWGdke5+r9pA/d4Qg611Ujc=') },
  { id: 'cloud', publicKey: publicKeyFromBase64('MCowBQYDK2VwAyEAavKaSo70TYmFgYVeHHaqrNsT9+Jqd0cCyxGQv/2V/38='), maxDays: 400 },
];

export interface LicenceConfig {
  /** Off in development runs and tests: nothing is locked. */
  enforced: boolean;
  hardwareId: string;
  cloudUrl: string;
  trusted: readonly TrustedKey[];
  fetch?: typeof fetch;
}

export type LicenceState = 'off' | 'none' | 'invalid' | 'ok' | 'expiring' | 'grace' | 'expired' | 'activate';

export interface LicenceInfo {
  enforced: boolean;
  /** May the POS be used? False: the lock screen. */
  usable: boolean;
  state: LicenceState;
  message: string;
  hardwareId: string;
  trial: boolean;
  licensee: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  /** Last day of the grace after the end, or of the 30 days an existing install has to activate. */
  graceEndsAt: string | null;
  /** Linked to DinePOS Cloud: renewals arrive by themselves. */
  linked: boolean;
  renewUrl: string;
  portalUrl: string;
}

interface Row { key_text: string | null; installed_at: number | null; grace_until: number | null; last_seen_at: number; cloud_url: string | null; device_key: string | null }

const dateText = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** The licence row; made the first time. An install that already has bills gets 30 days to activate. */
function row(ctx: Ctx): Row {
  const r = ctx.db.prepare('SELECT key_text, installed_at, grace_until, last_seen_at, cloud_url, device_key FROM licence WHERE id = 1').get() as Row | undefined;
  if (r) return r;
  const now = ctx.clock.now();
  const hadBills = Boolean(ctx.db.prepare('SELECT 1 FROM invoice LIMIT 1').get());
  ctx.db.prepare('INSERT OR IGNORE INTO licence (id, grace_until, last_seen_at, created_at) VALUES (1, ?, ?, ?)').run(hadBills ? now + INSTALL_GRACE_DAYS * DAY : null, now, now);
  return row(ctx);
}

/** Now, never earlier than a time this POS has already seen (turning the PC clock back does not extend a licence). */
function now(ctx: Ctx): number {
  const r = row(ctx);
  const t = ctx.clock.now();
  if (t > r.last_seen_at + 60_000) ctx.db.prepare('UPDATE licence SET last_seen_at = ? WHERE id = 1').run(t); // at most once a minute
  return Math.max(t, r.last_seen_at);
}

const verify = (cfg: LicenceConfig, key: string): Verified => verifyKey(key, cfg.trusted, cfg.hardwareId, { product: PRODUCT, requireProduct: true });

export function licenceInfo(ctx: Ctx, cfg: LicenceConfig): LicenceInfo {
  const r = row(ctx);
  const base = { enforced: cfg.enforced, hardwareId: cfg.hardwareId, linked: Boolean(r.device_key), renewUrl: `${PORTAL_URL}/app/plans`, portalUrl: PORTAL_URL };
  const empty = { trial: false, licensee: null, expiresAt: null, daysLeft: null, graceEndsAt: null };
  if (!cfg.enforced) return { ...base, ...empty, usable: true, state: 'off', message: 'Licences are not checked in this development run.' };
  const t = now(ctx);
  const v = r.key_text ? verify(cfg, r.key_text) : null;
  const s = licenceStatus(v, new Date(t));
  const info: LicenceInfo = {
    ...base, usable: s.usable, state: s.state, trial: s.trial, licensee: s.licensee ?? null, expiresAt: s.expiresAt ?? null,
    daysLeft: s.daysLeft ?? null, graceEndsAt: s.graceEndsAt ?? null, message: '',
  };
  const left = (n: number) => `${n} day${n === 1 ? '' : 's'} left`;
  switch (s.state) {
    case 'ok': info.message = s.trial ? `Free trial until ${dateText(s.expiresAt!)} (${left(s.daysLeft!)}).` : `Licensed to ${s.licensee} until ${dateText(s.expiresAt!)}.`; break;
    case 'expiring': info.message = s.trial ? `The free trial ends on ${dateText(s.expiresAt!)} (${left(s.daysLeft!)}). Renew to keep billing.` : `The licence ends on ${dateText(s.expiresAt!)} (${left(s.daysLeft!)}). Renew it in time.`; break;
    case 'grace': info.message = `The licence ended on ${dateText(s.expiresAt!)}. Tiffin POS stops on ${dateText(s.graceEndsAt!)} unless it is renewed.`; break;
    case 'expired': info.message = `The licence ended on ${dateText(s.expiresAt!)}. Renew it, or enter a new key, to use Tiffin POS.`; break;
    case 'invalid': info.message = s.reason ?? 'The licence key is not valid for this PC.'; break;
    case 'none': info.message = 'Tiffin POS needs a licence. Sign in with your account to start a 30-day free trial, or enter a licence key.'; break;
  }
  // an install that had bills before licensing: 30 days to activate
  if (!s.usable && r.grace_until !== null && t < r.grace_until) {
    const days = Math.ceil((r.grace_until - t) / DAY);
    return { ...info, usable: true, state: 'activate', daysLeft: days, graceEndsAt: new Date(r.grace_until).toISOString(),
      message: `Tiffin POS now needs a licence. Sign in with your account by ${dateText(new Date(r.grace_until).toISOString())} (${left(days)}) to keep billing.` };
  }
  return info;
}

/** Installs a key for this PC (pasted, or from DinePOS Cloud). A renewal never replaces a key that ends later. */
export function installKey(ctx: Ctx, cfg: LicenceConfig, key: string, o: { userId: string | null; source: 'pasted' | 'cloud' | 'renewal' }): LicenceInfo {
  const clean = key.replace(/\s+/g, '');
  const v = verify(cfg, clean);
  if (!v.ok) throw new AppError('LICENCE_INVALID', v.reason, 400, { reason: v.code });
  const cur = row(ctx).key_text;
  if (o.source === 'renewal' && cur) {
    const was = verify(cfg, cur);
    if (was.ok && Date.parse(was.payload.expiresAt) >= Date.parse(v.payload.expiresAt)) return licenceInfo(ctx, cfg);
  }
  ctx.db.prepare('UPDATE licence SET key_text = ?, installed_at = ? WHERE id = 1').run(clean, ctx.clock.now());
  audit(ctx, o.userId, 'licence.install', 'licence', '1', { source: o.source, licensee: v.payload.licensee, expiresAt: v.payload.expiresAt, kid: v.kid });
  return licenceInfo(ctx, cfg);
}

interface CloudAnswer { key?: string; deviceKey?: string | null; store?: { slug: string; name: string }; error?: { code?: string; message?: string } }

/**
 * Signs in to DinePOS Cloud with the portal account: "trial" starts the 30-day trial on this PC, "signin" gets the
 * key the account already has for it. The password is passed through only: never stored or logged.
 */
export async function activate(ctx: Ctx, cfg: LicenceConfig, input: { mode: 'trial' | 'signin'; email: string; password: string; outletName?: string | null }, userId: string | null): Promise<LicenceInfo> {
  const r = row(ctx);
  const cloud = (r.cloud_url ?? cfg.cloudUrl).replace(/\/+$/, '');
  const outlet = ctx.db.prepare('SELECT name FROM outlet LIMIT 1').get() as { name: string } | undefined;
  let res: Response;
  try {
    res = await (cfg.fetch ?? fetch)(`${cloud}/v1/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: input.mode, email: input.email, password: input.password, hardwareId: cfg.hardwareId, outletName: input.outletName || outlet?.name || 'Tiffin POS outlet', link: !r.device_key, product: PRODUCT }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AppError('CLOUD_UNREACHABLE', 'The licence server could not be reached. Connect this PC to the internet, or enter a licence key.', 503);
  }
  const j = (await res.json().catch(() => null)) as CloudAnswer | null;
  if (!res.ok || !j?.key) throw new AppError(j?.error?.code ?? 'CLOUD_ERROR', j?.error?.message ?? 'The licence server could not activate this PC. Please try again.', res.status >= 400 && res.status < 500 ? 400 : 502);
  const info = installKey(ctx, cfg, j.key, { userId, source: 'cloud' });
  if (j.deviceKey) ctx.db.prepare('UPDATE licence SET device_key = ?, cloud_url = ? WHERE id = 1').run(j.deviceKey, cloud);
  audit(ctx, userId, 'licence.activate', 'licence', '1', { mode: input.mode, email: input.email.trim().toLowerCase(), linked: Boolean(j.deviceKey || r.device_key) });
  return { ...info, linked: Boolean(j.deviceKey || r.device_key) };
}

/** Asks DinePOS Cloud for a newer key (a renewal or a paid plan). Quiet when offline or not linked. */
export async function renew(ctx: Ctx, cfg: LicenceConfig): Promise<boolean> {
  const r = row(ctx);
  if (!cfg.enforced || !r.device_key || !r.cloud_url) return false;
  try {
    const res = await (cfg.fetch ?? fetch)(`${r.cloud_url}/v1/pos/licence`, { headers: { authorization: `Bearer ${r.device_key}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return false;
    const j = (await res.json()) as { key?: string | null };
    if (!j.key) return false;
    const before = row(ctx).key_text;
    installKey(ctx, cfg, j.key, { userId: null, source: 'renewal' });
    return row(ctx).key_text !== before;
  } catch (e) {
    ctx.logger.warn('licence renewal failed', String((e as Error).message ?? e));
    return false;
  }
}
