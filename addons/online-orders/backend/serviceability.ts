import type { Actor } from '../../../src/services/ctx.ts';
import type { HostApi } from '../../../src/addons/host.ts';
import { DEFAULT_SERVICEABILITY, checkServiceability } from '../../../contract/src/serviceability.ts';
import type { ServiceabilityConfig } from '../../../contract/src/serviceability.ts';

/** Settings > Serviceability: store location, distance bands with fees and minimum orders, packaging fee, pickup, hours. */

const KEY = 'online_serviceability';

export function readServiceability(host: HostApi): ServiceabilityConfig & { updatedAt: number | null } {
  const raw = host.getSetting(KEY);
  if (!raw) return { ...structuredClone(DEFAULT_SERVICEABILITY), updatedAt: null };
  try {
    const saved = JSON.parse(raw) as ServiceabilityConfig & { updatedAt: number };
    const r = checkServiceability(saved);
    if (r.ok) return { ...r.value, updatedAt: saved.updatedAt ?? null };
    host.log.warn('stored serviceability is not valid; showing defaults', { errors: Object.keys(r.errors) });
  } catch { /* unreadable */ }
  return { ...structuredClone(DEFAULT_SERVICEABILITY), updatedAt: null };
}

export function saveServiceability(host: HostApi, actor: Actor, requestId: string, input: unknown) {
  return host.runCommand(host.ctx, requestId, 'online.serviceability', actor, () => {
    host.assertPerm(actor, 'settings.write');
    const r = checkServiceability(input);
    if (!r.ok) throw new host.AppError('VALIDATION', Object.values(r.errors)[0]!, 400, { fields: r.errors });
    const before = readServiceability(host);
    const updatedAt = host.ctx.clock.now();
    host.setSetting(KEY, JSON.stringify({ ...r.value, updatedAt }));
    host.audit(host.ctx, actor.userId, 'online.serviceability', 'settings', KEY, {
      location: r.value.location ? 'set' : 'none', zones: r.value.zones.map((z) => [z.upToKm, z.deliveryFee, z.minOrder]),
      changedLocation: JSON.stringify(before.location) !== JSON.stringify(r.value.location),
    });
    return { ...r.value, updatedAt };
  });
}
