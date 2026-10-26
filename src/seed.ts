// Development seed: a realistic QSR menu, three users and two virtual printers. NOT for production (PINs are public).
import { createCtx } from './services/ctx.ts';
import type { Actor } from './services/ctx.ts';
import { setupFirstRun, createUser } from './services/auth.ts';
import { createCategory, createItem, createModifierGroup, setItemModifierGroups } from './services/catalog.ts';
import { createPrinter } from './services/printing/jobs.ts';
import { createStation } from './services/stations.ts';
import { all } from './store/db.ts';
import { pathToFileURL } from 'node:url';
import type { Ctx } from './services/ctx.ts';

export function seedDemo(ctx: Ctx) {
  let n = 0;
  const rid = () => `seed-${String(++n).padStart(5, '0')}`;
  const { ownerId } = setupFirstRun(ctx, rid(), {
    outlet: { name: 'Demo Burger Hub', gstin: '29ABCDE1234F1Z5', fssaiNo: '11223344556677', stateCode: '29', address: '12 MG Road, Bengaluru', phone: '9876543210' },
    device: { name: 'Counter 1', seriesPrefix: 'A1' },
    owner: { name: 'Owner', pin: '1234', mobile: '9000000001' },
  });
  const owner: Actor = { userId: ownerId, role: 'owner', name: 'Owner' };
  createUser(ctx, owner, rid(), { name: 'Manager', role: 'manager', pin: '2345', mobile: '9000000002' });
  createUser(ctx, owner, rid(), { name: 'Cashier', role: 'cashier', pin: '1111', mobile: '9000000003' });
  const tg = Object.fromEntries(all<{ id: string; rate_bp: number }>(ctx.db, 'SELECT id, rate_bp FROM tax_group').map((t) => [t.rate_bp, t.id]));
  const cats: Record<string, string> = {};
  const kitchen = createStation(ctx, owner, rid(), { name: 'Kitchen' }).id, bar = createStation(ctx, owner, rid(), { name: 'Bar' }).id;
  for (const [name, station] of [['Burgers', kitchen], ['Wraps', kitchen], ['Sides', kitchen], ['Beverages', bar], ['Desserts', bar]] as const) {
    cats[name] = createCategory(ctx, owner, rid(), { name, prepStationId: station }).id;
  }
  const items: Array<[string, string, number, number, string?]> = [
    ['Classic Veg Burger', 'Burgers', 9900, 500], ['Cheese Burger', 'Burgers', 12900, 500], ['Chicken Burger', 'Burgers', 14900, 500], ['Double Patty Burger', 'Burgers', 19900, 500],
    ['Paneer Wrap', 'Wraps', 12900, 500], ['Chicken Wrap', 'Wraps', 14900, 500], ['French Fries', 'Sides', 7900, 500], ['Peri Peri Fries', 'Sides', 9900, 500],
    ['Onion Rings', 'Sides', 8900, 500], ['Cola 300ml', 'Beverages', 4000, 1200, '8901234567890'], ['Cold Coffee', 'Beverages', 11900, 500], ['Masala Chai', 'Beverages', 4900, 500],
    ['Lemon Soda', 'Beverages', 5900, 500], ['Brownie', 'Desserts', 8900, 1800], ['Ice Cream Scoop', 'Desserts', 6900, 1800], ['Water Bottle 1L', 'Beverages', 2000, 0, '8909876543210'],
  ];
  const ids: Record<string, string> = {};
  for (const [name, cat, price, bp, barcode] of items) {
    ids[name] = createItem(ctx, owner, rid(), { name, categoryId: cats[cat]!, price, taxGroupId: tg[bp]!, barcode: barcode ?? null, unit: 'pcs', isVeg: !/Chicken/.test(name) }).id;
  }
  const extras = createModifierGroup(ctx, owner, rid(), { name: 'Add-ons', minSelect: 0, maxSelect: 3, modifiers: [{ name: 'Extra cheese', price: 2000 }, { name: 'Extra patty', price: 4000 }, { name: 'Jalapenos', price: 1000 }] });
  for (const n2 of ['Classic Veg Burger', 'Cheese Burger', 'Chicken Burger', 'Double Patty Burger']) setItemModifierGroups(ctx, owner, rid(), ids[n2]!, [extras.id]);
  createPrinter(ctx, owner, rid(), { name: 'Counter receipt (virtual)', transport: 'memory', widthMm: 80, isReceipt: true, drawer: true });
  createPrinter(ctx, owner, rid(), { name: 'Kitchen (virtual)', transport: 'memory', widthMm: 80, stations: [kitchen, bar] });
  return { owner };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ctx = createCtx({ dataDir: process.env.POS_DATA_DIR ?? './data', scryptCost: 4096 });
  seedDemo(ctx);
  console.log('Seeded demo data. Users: Owner/1234, Manager/2345, Cashier/1111 (development only).');
}
