// The order hub now lives in PosiNext Cloud (repository posinext-cloud, 2026-11-12). Tests that talk to the real hub
// load it from a posinext-cloud checkout next to this repository, or from POSINEXT_CLOUD_DIR, and are skipped without one.
// Loaded at run time (not imported), so the typecheck and CI do not need the other repository.
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLOUD_HUB_SRC = join(process.env.POSINEXT_CLOUD_DIR ?? resolve(import.meta.dirname, '..', '..', 'posinext-cloud'), 'hub', 'src');
/** false when the hub is there, else the reason to skip (node:test's `skip` option takes either). */
export const NO_HUB: false | string = existsSync(join(CLOUD_HUB_SRC, 'hub.ts')) ? false : `needs PosiNext Cloud's hub at ${CLOUD_HUB_SRC} (or set POSINEXT_CLOUD_DIR)`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
export interface CloudHub {
  Hub: new (o: Any) => Any;
  createHubServer: (hub: Any, o?: Any) => Server;
  UrbanPiper: new (hub: Any, o?: Any) => Any;
}

/** The hub's classes, or stand-ins that are never called (every test that needs them is skipped). */
export async function loadCloudHub(): Promise<CloudHub> {
  if (NO_HUB) return {} as CloudHub;
  const load = (f: string) => import(pathToFileURL(join(CLOUD_HUB_SRC, f)).href);
  const [{ Hub }, { createHubServer }, { UrbanPiper }] = await Promise.all([load('hub.ts'), load('http.ts'), load('urbanpiper.ts')]);
  return { Hub, createHubServer, UrbanPiper };
}
