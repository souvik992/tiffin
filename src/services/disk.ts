import { statfsSync } from 'node:fs';
import { AppError } from '../store/db.ts';
import type { Ctx } from './ctx.ts';
import { loadSettings } from './settings.ts';

const cache = new WeakMap<Ctx, { at: number; freeMb: number }>();

export function freeDiskMb(ctx: Ctx): number {
  const s = statfsSync(ctx.dbPath === ':memory:' ? '.' : ctx.dataDir);
  return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1_000_000);
}

/** Blocks new bills when free space is below the hard floor. Checked at most every 30 s. */
export function assertDiskOk(ctx: Ctx): void {
  const now = ctx.clock.now();
  let c = cache.get(ctx);
  if (!c || now - c.at > 30_000 || now < c.at) { c = { at: now, freeMb: freeDiskMb(ctx) }; cache.set(ctx, c); }
  const floor = loadSettings(ctx).minFreeDiskMb;
  if (c.freeMb < floor) throw new AppError('DISK_LOW', `Disk space is critically low (${c.freeMb} MB free). Free up space before billing.`, 507, { freeMb: c.freeMb, floorMb: floor });
}
