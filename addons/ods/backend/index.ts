import type { HostApi } from '../../../src/addons/host.ts';
import type { OrderState } from '../../../contract/src/order.ts';
import { REJECT_REASONS } from '../../../contract/src/types.ts';
import type { PlatformAction, RejectReason } from '../../../contract/src/types.ts';
import { readOnlineConfig, saveOnlineConfig } from './onlineConfig.ts';
import type { OnlineInput } from './onlineConfig.ts';
import { readServiceability, saveServiceability } from './serviceability.ts';
import { makeMaps, mapAttribution } from './maps.ts';
import { makePlaces } from './places.ts';
import type { Fetcher } from './maps.ts';
import { Connector } from './connector.ts';
import type { ConnectorOptions } from './connector.ts';
import { readPrintOnAccept, savePrintOnAccept } from './store.ts';
import { MIGRATIONS, apiKeysView, mapView, readFeeTaxGroup, saveMapStyle, readMenuSync, readPublishedAt, saveFeeTaxGroup, saveGoogleKey, saveMenuSync } from './store.ts';

/** ODS add-on: routes under /api/addons/ods. Loaded by the POS from the signed package. */
export function register(host: HostApi, opts: { fetcher?: Fetcher; connector?: ConnectorOptions } = {}): Connector {
  host.migrations(MIGRATIONS);
  const maps = makeMaps(host, opts.fetcher);
  const places = makePlaces(host, opts.fetcher ?? (fetch as unknown as Fetcher));
  const conn = new Connector(host, opts.connector);
  // start after the POS has finished loading (database steps applied)
  const boot = setTimeout(() => { try { conn.refresh(); } catch (e) { host.log.warn('order hub start failed', String(e)); } }, 0);
  host.onStop(async () => { clearTimeout(boot); await conn.stop(); });
  const OPEN_STATES: string[] = ['SENT_TO_STORE', 'RECEIVED', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'];
  const body = (c: { body: unknown }) => (c.body ?? {}) as Record<string, unknown>;

  // ---- settings
  host.route('GET', '/config', {}, () => readOnlineConfig(host)); // everyone signed in: the side menu shows ODS only when on
  host.route('PUT', '/config', {}, (c) => {
    // F15: online orders cannot be switched off while customers still wait for orders
    const open = (c.body as { enabled?: unknown } | null)?.enabled === false ? conn.orders().filter((o) => OPEN_STATES.includes(o.state)) : [];
    if (open.length && readOnlineConfig(host).enabled) throw new host.AppError('ONLINE_ORDERS_OPEN', `${open.length} online order${open.length > 1 ? 's are' : ' is'} still open (${open.slice(0, 5).map((o) => o.number).join(', ')}). Finish or reject ${open.length > 1 ? 'them' : 'it'} on the ODS first.`, 409);
    const r = saveOnlineConfig(host, c.actor, c.requestId, c.body as OnlineInput); conn.refresh(); return r;
  });
  host.route('GET', '/serviceability', {}, (c) => { host.assertPerm(c.actor, 'printer.manage'); return { ...readServiceability(host), feeTaxGroupId: readFeeTaxGroup(host), maps: mapAttribution(host) }; });
  host.route('PUT', '/serviceability', {}, (c) => {
    const b = body(c);
    const { feeTaxGroupId, maps: _maps, ...svc } = b as Record<string, unknown> & { feeTaxGroupId?: string | null };
    host.assertPerm(c.actor, 'settings.write');
    const saved = host.db.tx(() => {
      if (feeTaxGroupId !== undefined) saveFeeTaxGroup(host, feeTaxGroupId);
      return saveServiceability(host, c.actor, c.requestId, svc);
    });
    conn.refresh();
    return { ...saved, feeTaxGroupId: readFeeTaxGroup(host), maps: mapAttribution(host) };
  });
  // ---- menu sync per sales channel
  host.route('GET', '/menu-sync', {}, (c) => { host.assertPerm(c.actor, 'printer.manage'); return { channels: readMenuSync(host), publishedAt: readPublishedAt(host), hub: conn.link().paired }; });
  host.route('PUT', '/menu-sync', {}, (c) => { const b = body(c); const r = saveMenuSync(host, c.actor, b.channel, b); conn.refresh(); return { channels: r, publishedAt: readPublishedAt(host), hub: conn.link().paired }; });
  host.route('POST', '/menu-sync/now', {}, async (c) => {
    host.assertPerm(c.actor, 'settings.write');
    if (!conn.link().paired) throw new host.AppError('NOT_CONNECTED', 'Connect this POS to the order hub first (Order hub, above).', 409);
    try { await conn.publish(true); } catch (e) { throw new host.AppError('SYNC_FAILED', `The menu could not be sent: ${(e as Error).message}. Check the internet connection.`, 503); }
    return { publishedAt: readPublishedAt(host) };
  });

  // ---- which map Serviceability shows (everyone who sees Serviceability; the owner chooses)
  host.route('GET', '/map', {}, (c) => { host.assertPerm(c.actor, 'printer.manage'); return { ...mapView(host), maps: mapAttribution(host) }; });
  host.route('PUT', '/map', {}, (c) => { saveMapStyle(host, c.actor, body(c).style); return { ...mapView(host), maps: mapAttribution(host) }; });

  // ---- API keys (owner only, in Serviceability > Map; the keys never leave the POS backend)
  host.route('GET', '/api-keys', {}, (c) => { host.assertPerm(c.actor, 'settings.write'); return apiKeysView(host); });
  host.route('PUT', '/api-keys', {}, (c) => { const b = body(c); if ('google' in b) saveGoogleKey(host, c.actor, b.google); return apiKeysView(host); });
  host.route('POST', '/api-keys/test', {}, async (c) => {
    host.assertPerm(c.actor, 'settings.write');
    if (!readOnlineConfig(host).enabled) throw new host.AppError('OFFLINE_MODE', 'Turn on online orders first: in offline mode the POS makes no internet connection.', 409);
    const [search, map] = await Promise.all([places.testSearch(), maps.testTiles()]);
    return { search, map };
  });
  host.route('GET', '/tax-groups', {}, () => host.billing.menu(host.ctx).taxGroups);
  // printing: on accepting, and the ODS's Bill and KOT buttons
  host.route('GET', '/print-options', {}, (c) => { host.assertPerm(c.actor, 'printer.manage'); return { ...readPrintOnAccept(host), buttons: Boolean(host.printing) }; });
  host.route('PUT', '/print-options', {}, (c) => ({ ...savePrintOnAccept(host, c.actor, body(c)), buttons: Boolean(host.printing) }));
  for (const what of ['bill', 'kot'] as const) {
    host.route('POST', `/orders/:id/print-${what}`, {}, (c) => conn.print(c.actor, c.params.id!, what, c.requestId, body(c).override as { userId: string; pin: string } | undefined));
  }

  // ---- order hub
  host.route('GET', '/hub', {}, () => conn.link());
  host.route('POST', '/hub/pair', {}, (c) => conn.pair(c.actor, String(body(c).hubUrl ?? ''), String(body(c).code ?? '')));
  host.route('DELETE', '/hub', {}, (c) => conn.unpair(c.actor));

  // ---- ODS
  const view = () => ({ link: conn.link(), orders: conn.orders().map((o) => ({ ...o, posPrice: ['SENT_TO_STORE', 'RECEIVED'].includes(o.state) && !o.billInvoiceId ? conn.posPrice(o.order) : null })) });
  host.route('GET', '/orders', {}, () => view());
  host.route('GET', '/events', { format: 'sse' }, (c) => {
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = () => c.res.write(`event: ods\ndata: ${JSON.stringify(view())}\n\n`);
    send();
    let pending: NodeJS.Timeout | null = null;
    const onChange = () => { if (!pending) pending = setTimeout(() => { pending = null; send(); }, 100); };
    conn.bus.on('change', onChange);
    const beat = setInterval(() => c.res.write(': ping\n\n'), 15_000);
    c.req.on('close', () => { conn.bus.off('change', onChange); clearInterval(beat); if (pending) clearTimeout(pending); });
    return Symbol.for('handled');
  });
  host.route('POST', '/orders/:id/accept', {}, (c) => {
    host.assertPerm(c.actor, 'invoice.finalize');
    const b = body(c);
    return conn.accept(c.actor, c.params.id!, b.prepMinutes === undefined || b.prepMinutes === null ? null : Number(b.prepMinutes), c.requestId, b.acceptPriceChange === true);
  });
  host.route('POST', '/orders/:id/reject', {}, (c) => {
    const b = body(c);
    const reason = String(b.reason ?? '') as RejectReason;
    if (!(REJECT_REASONS as readonly string[]).includes(reason)) throw new host.AppError('VALIDATION', 'Choose a reason.');
    return conn.reject(c.actor, c.params.id!, reason, typeof b.reasonText === 'string' && b.reasonText.trim() ? b.reasonText.trim().slice(0, 200) : null);
  });
  host.route('POST', '/orders/:id/step', {}, (c) => {
    const b = body(c);
    const to = String(b.to ?? '') as OrderState;
    if (!['PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PICKED_UP', 'CANCELLED'].includes(to)) throw new host.AppError('VALIDATION', 'Unknown order step.');
    const rider = b.rider && typeof b.rider === 'object' ? { name: String((b.rider as Record<string, unknown>).name ?? '').trim().slice(0, 60), phone: String((b.rider as Record<string, unknown>).phone ?? '').trim().slice(0, 15) || null } : undefined;
    return conn.step(c.actor, c.params.id!, to, { rider, reasonText: typeof b.reasonText === 'string' ? b.reasonText.slice(0, 200) : undefined, override: b.override as { userId: string; pin: string } | undefined });
  });
  // Swiggy / Zomato: items out of stock, the customer's number, another rider, rider check
  host.route('POST', '/orders/:id/platform-action', {}, (c) => conn.platformAction(c.actor, c.params.id!, body(c) as unknown as PlatformAction, c.requestId));

  // ---- map
  host.route('GET', '/tiles/:z/:x/:y', { auth: false }, async (c) => { // <img> tags cannot sign in; these are public map pictures
    const img = await maps.tile(Number(c.params.z), Number(c.params.x), Number(String(c.params.y).replace(/\.(png|jpg)$/, '')));
    c.res.writeHead(200, { 'Content-Type': img[0] === 0xff ? 'image/jpeg' : 'image/png', 'Content-Length': img.length, 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
    c.res.end(img);
    return Symbol.for('handled');
  });
  host.route('GET', '/geocode', {}, (c) => { // suggestions while typing; near = the shop pin, to rank nearby places first
    host.assertPerm(c.actor, 'settings.write');
    const near = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(c.query.get('near') ?? '');
    return places.suggest(c.query.get('q') ?? '', { near: near ? { lat: Number(near[1]), lng: Number(near[2]) } : null, full: c.query.get('full') === '1', session: (c.query.get('session') ?? '').slice(0, 64) });
  });
  host.route('GET', '/geocode/place', {}, (c) => { host.assertPerm(c.actor, 'settings.write'); return places.place(c.query.get('id') ?? '', (c.query.get('session') ?? '').slice(0, 64)); });
  return conn;
}
