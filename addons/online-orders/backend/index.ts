import type { HostApi } from '../../../src/addons/host.ts';
import { readOnlineConfig, saveOnlineConfig } from './onlineConfig.ts';
import type { OnlineInput } from './onlineConfig.ts';
import { readServiceability, saveServiceability } from './serviceability.ts';
import { makeMaps } from './maps.ts';
import type { Fetcher } from './maps.ts';

/** Online Orders add-on: routes under /api/addons/online-orders. Loaded by the POS from the signed package. */
export function register(host: HostApi, opts: { fetcher?: Fetcher } = {}): void {
  const maps = makeMaps(host, opts.fetcher);

  host.route('GET', '/config', {}, () => readOnlineConfig(host)); // everyone signed in: the side menu shows ODS only when on
  host.route('PUT', '/config', {}, (c) => saveOnlineConfig(host, c.actor, c.requestId, c.body as OnlineInput));

  host.route('GET', '/serviceability', {}, (c) => { host.assertPerm(c.actor, 'printer.manage'); return readServiceability(host); });
  host.route('PUT', '/serviceability', {}, (c) => saveServiceability(host, c.actor, c.requestId, c.body));

  // map tiles for <img> tags: no sign-in possible; they are public map pictures
  host.route('GET', '/tiles/:z/:x/:y', { auth: false }, async (c) => {
    const png = await maps.tile(Number(c.params.z), Number(c.params.x), Number(String(c.params.y).replace(/\.png$/, '')));
    c.res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
    c.res.end(png);
    return Symbol.for('handled');
  });
  host.route('GET', '/geocode', {}, (c) => { host.assertPerm(c.actor, 'settings.write'); return maps.search(c.query.get('q') ?? ''); });
}
