import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { EMPTY_ADDONS } from '../addons/host.ts';
import type { LoadedAddons } from '../addons/host.ts';
import { AppError } from '../store/db.ts';
import type { Actor, Ctx } from '../services/ctx.ts';
import { assertPerm } from '../services/permissions.ts';
import { authenticate, changePin, createUser, deactivateUser, listLoginUsers, listUsers, login, loginByMobile, logout, reactivateUser, setupFirstRun, updateUser } from '../services/auth.ts';
import { getCatalog, importItemsCsv, itemByBarcode, previewItemsCsv, searchItems, createItem, updateItem, deleteItem, createCategory, updateCategory, deleteCategory, reorderCategories, createTaxGroup, createModifierGroup, setItemModifierGroups } from '../services/catalog.ts';
import { addLine, applyBillDiscount, applyCoupon, removeCoupon, cancelOrder, createOrder, getCart, holdOrder, listOpenOrders, removeLine, resumeOrder, updateLine, updateOrder } from '../services/orders.ts';
import { cancelInvoice, checkPayments, createCreditNote, creditNoteOptions, finalizeInvoice, getInvoice, listInvoices, previewCreditNote, reprintInvoice } from '../services/invoices.ts';
import { closeShift, currentShift, openShift, zReport } from '../services/shifts.ts';
import { dailySummary, invoiceRegisterCsv, itemSales, taxSummary } from '../services/reports.ts';
import { REPORTS, reportCsv, runReport } from '../services/reportCatalog.ts';
import { clearStoreLogo, getStore, logoPng, setStoreLogo, updateStore } from '../services/store.ts';
import { clearReceiptDesign, getReceiptDesign, previewReceiptDesign, setReceiptDesign } from '../services/printing/receiptDesign.ts';
import { createPrinter, deletePrinter, invoicePrints, listPrinters, printSample, receiptPreview, sampleReceipt, testDrawer, testPrint, updatePrinter } from '../services/printing/jobs.ts';
import { discoverNetworkPrinters, listSerialPorts, listWindowsPrinters } from '../services/printing/devices.ts';
import { detectPrinters, dismissDetected, listUsbDevices, quickAddPrinter } from '../services/printing/detect.ts';
import { listJobs, queueCounts, retryFailed } from '../services/printing/queue.ts';
import type { PrintQueue } from '../services/printing/queue.ts';
import { listBackups, runBackup, backupStatus } from '../services/backup.ts';
import { getHealth } from '../services/health.ts';
import { listAudit, verifyAuditChain } from '../services/audit.ts';
import { allSettings, setSetting, SETTING_KEYS } from '../services/settings.ts';
import { audit } from '../services/audit.ts';
import { repairJournal } from '../services/journal.ts';
import { readImage, removeItemImage, setItemImage } from '../services/images.ts';
import { adjustStock, createPurchase, createStockItem, deleteStockItem, getPurchase, getRecipe, listMovements, listPurchases, listRecipes, listStockItems, previewPurchase, setRecipe, updateStockItem, voidPurchase, UNITS } from '../services/stock.ts';
import { istDay } from '../core/numbering.ts';
import { arr, bool, discount, int, nullable, obj, oneOf, opt, override, payment, str } from './validate.ts';
import { createCoupon, listCoupons, updateCoupon } from '../services/coupons.ts';
import type { V } from './validate.ts';

interface RC {
  ctx: Ctx; actor: Actor; params: Record<string, string>; query: URLSearchParams; body: unknown; requestId: string; token: string | undefined;
  req: IncomingMessage; res: ServerResponse;
}
type Handler = (c: RC) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; keys: string[]; auth: boolean; idem: boolean; handler: Handler; format?: 'json' | 'csv' | 'sse' }

const MAX_BODY = 2_000_000;

export interface ServerOptions { port?: number; host?: string; queue?: PrintQueue | null; /** Desktop app: required in X-POS-Secret on every request. */ secret?: string; /** Signed add-ons loaded at startup (src/addons/host.ts). */ addons?: LoadedAddons }

export function buildRoutes(opts: { queue?: PrintQueue | null; addons?: LoadedAddons }): Route[] {
  const routes: Route[] = [];
  const add = (method: string, path: string, o: { auth?: boolean; idem?: boolean; format?: Route['format'] }, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, auth: o.auth !== false, idem: o.idem ?? method !== 'GET', handler, format: o.format });
  };
  const body = <T>(c: RC, v: V<T>): T => v(c.body, '');
  const rid = (c: RC) => c.requestId;
  const num = (q: URLSearchParams, k: string): number | undefined => { const v = q.get(k); if (v === null || v === '') return undefined; const n = Number(v); if (!Number.isSafeInteger(n)) throw new AppError('VALIDATION', `${k} must be a whole number`); return n; };
  const dayBounds = (c: RC) => {
    const from = c.query.get('from'), to = c.query.get('to');
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new AppError('VALIDATION', 'from and to must be YYYY-MM-DD');
    const IST = 330 * 60_000;
    return { from, to, fromMs: Date.parse(`${from}T00:00:00Z`) - IST, toMs: Date.parse(`${to}T00:00:00Z`) - IST + 86_400_000 };
  };

  // ---- public ----
  add('GET', '/api/ping', { auth: false }, () => ({ ok: true }));
  add('GET', '/api/login-users', { auth: false }, (c) => listLoginUsers(c.ctx));
  add('POST', '/api/setup', { auth: false }, (c) => setupFirstRun(c.ctx, rid(c), body(c, obj({
    outlet: obj({ name: str({ min: 1, max: 80 }), gstin: opt(nullable(str({ max: 15 }))), fssaiNo: opt(nullable(str({ max: 14 }))), stateCode: str({ min: 2, max: 2 }), address: opt(nullable(str({ max: 200 }))), phone: opt(nullable(str({ max: 15 }))) }),
    device: obj({ name: str({ min: 1, max: 40 }), seriesPrefix: str({ min: 1, max: 2 }) }),
    owner: obj({ name: str({ min: 1, max: 60 }), pin: str({ min: 4, max: 6 }), mobile: opt(nullable(str({ max: 10 }))) }),
  }))));
  add('POST', '/api/auth/login', { auth: false, idem: false }, (c) => {
    const b = body(c, obj({ userId: opt(str({ min: 1, max: 64 })), mobile: opt(str({ min: 1, max: 10 })), pin: str({ min: 1, max: 12 }) }));
    if (b.mobile) return loginByMobile(c.ctx, b.mobile, b.pin);
    if (b.userId) return login(c.ctx, b.userId, b.pin); // unlocking after inactivity, and staff without a mobile number yet
    throw new AppError('VALIDATION', 'Enter your mobile number.');
  });
  add('POST', '/api/auth/logout', { idem: false }, (c) => { if (c.token) logout(c.ctx, c.token); return { ok: true }; });
  add('GET', '/api/me', {}, (c) => c.actor);

  // ---- catalog ----
  add('GET', '/api/catalog', {}, (c) => getCatalog(c.ctx));
  add('GET', '/api/items/search', {}, (c) => searchItems(c.ctx, c.query.get('q') ?? '', num(c.query, 'limit') ?? 30));
  add('GET', '/api/items/by-barcode/:code', {}, (c) => itemByBarcode(c.ctx, c.params.code!));
  const itemShape = { name: str({ min: 1, max: 120 }), categoryId: opt(nullable(str({ max: 64 }))), shortName: opt(nullable(str({ max: 40 }))), sku: opt(nullable(str({ max: 40 }))), barcode: opt(nullable(str({ max: 40 }))), hsnCode: opt(nullable(str({ max: 8 }))), taxGroupId: str({ min: 1, max: 64 }), price: int({ min: 0 }), unit: opt(str({ max: 10 })), isVeg: opt(nullable(bool)), imageFile: opt(nullable(str({ max: 200 }))) };
  add('POST', '/api/items', {}, (c) => createItem(c.ctx, c.actor, rid(c), body(c, obj(itemShape))));
  add('PATCH', '/api/items/:id', {}, (c) => updateItem(c.ctx, c.actor, rid(c), c.params.id!, body(c, obj({ ...itemShape, name: opt(str({ min: 1, max: 120 })), taxGroupId: opt(str({ min: 1, max: 64 })), price: opt(int({ min: 0 })) }))));
  add('DELETE', '/api/items/:id', {}, (c) => deleteItem(c.ctx, c.actor, rid(c), c.params.id!));
  // Menu photos. Upload as base64 JSON (writes stay JSON-only); served without sign-in so <img> tags work, by exact name only.
  add('PUT', '/api/items/:id/image', {}, (c) => setItemImage(c.ctx, c.actor, rid(c), c.params.id!, body(c, obj({ dataBase64: str({ min: 1, max: 1_400_000 }) })).dataBase64));
  add('DELETE', '/api/items/:id/image', {}, (c) => removeItemImage(c.ctx, c.actor, rid(c), c.params.id!));
  add('GET', '/api/images/:file', { auth: false }, (c) => {
    const img = readImage(c.ctx, c.params.file!);
    c.res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.bytes.length, 'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    c.res.end(img.bytes);
    return Symbol.for('handled');
  });
  add('PUT', '/api/items/:id/modifier-groups', {}, (c) => setItemModifierGroups(c.ctx, c.actor, rid(c), c.params.id!, body(c, obj({ groupIds: arr(str({ max: 64 })) })).groupIds));
  add('POST', '/api/items/import/preview', { idem: false }, (c) => { assertPerm(c.actor, 'catalog.write'); return previewItemsCsv(c.ctx, body(c, obj({ csv: str({ max: MAX_BODY }) })).csv); });
  add('POST', '/api/items/import', {}, (c) => importItemsCsv(c.ctx, c.actor, rid(c), body(c, obj({ csv: str({ max: MAX_BODY }) })).csv));
  add('POST', '/api/categories', {}, (c) => createCategory(c.ctx, c.actor, rid(c), body(c, obj({ name: str({ min: 1, max: 60 }), sortOrder: opt(int()), kitchenStation: opt(nullable(str({ max: 30 }))) }))));
  add('PATCH', '/api/categories/:id', {}, (c) => updateCategory(c.ctx, c.actor, rid(c), c.params.id!, body(c, obj({ name: opt(str({ min: 1, max: 60 })), sortOrder: opt(int()), kitchenStation: opt(nullable(str({ max: 30 }))) }))));
  add('DELETE', '/api/categories/:id', {}, (c) => deleteCategory(c.ctx, c.actor, rid(c), c.params.id!));
  add('PUT', '/api/categories/order', {}, (c) => reorderCategories(c.ctx, c.actor, rid(c), body(c, obj({ ids: arr(str({ min: 1, max: 64 }), { max: 500 }) })).ids));
  add('POST', '/api/tax-groups', {}, (c) => createTaxGroup(c.ctx, c.actor, rid(c), body(c, obj({ name: str({ min: 1, max: 40 }), rateBp: int({ min: 0, max: 10000 }), cessBp: opt(int({ min: 0, max: 10000 })), priceIncludesTax: opt(bool) }))));
  add('POST', '/api/modifier-groups', {}, (c) => createModifierGroup(c.ctx, c.actor, rid(c), body(c, obj({ name: str({ min: 1, max: 60 }), minSelect: opt(int({ min: 0 })), maxSelect: opt(int({ min: 1 })), modifiers: arr(obj({ name: str({ min: 1, max: 60 }), price: int({ min: 0 }) }), { max: 50 }) }))));

  // ---- orders ----
  add('POST', '/api/orders', {}, (c) => createOrder(c.ctx, c.actor, rid(c), body(c, obj({ channel: opt(str({ max: 10 })), customerPhone: opt(nullable(str({ max: 10 }))), customerName: opt(nullable(str({ max: 80 }))), note: opt(nullable(str({ max: 200 }))) }))));
  add('GET', '/api/orders', {}, (c) => { const st = c.query.get('status'); if (st !== null && st !== 'DRAFT' && st !== 'HELD') throw new AppError('VALIDATION', 'status must be DRAFT or HELD'); return listOpenOrders(c.ctx, { status: st ?? undefined }); });
  add('GET', '/api/orders/:id', {}, (c) => getCart(c.ctx, c.params.id!));
  add('PATCH', '/api/orders/:id', {}, (c) => { const b = body(c, obj({ customerPhone: opt(nullable(str({ max: 10 }))), customerName: opt(nullable(str({ max: 80 }))), note: opt(nullable(str({ max: 200 }))), buyerGstin: opt(nullable(str({ max: 15 }))), placeOfSupply: opt(nullable(str({ max: 2 }))), override: opt(override) })); const { override: ov, ...rest } = b; return updateOrder(c.ctx, c.actor, rid(c), { orderId: c.params.id!, ...rest }, ov); });
  add('POST', '/api/orders/:id/lines', {}, (c) => addLine(c.ctx, c.actor, rid(c), { orderId: c.params.id!, ...body(c, obj({ itemId: str({ min: 1, max: 64 }), qtyMilli: opt(int({ min: 1 })), modifierIds: opt(arr(str({ max: 64 }), { max: 30 })), note: opt(nullable(str({ max: 120 }))) })) }));
  add('PATCH', '/api/lines/:lineId', {}, (c) => updateLine(c.ctx, c.actor, rid(c), { lineId: c.params.lineId!, ...body(c, obj({ qtyMilli: opt(int({ min: 1 })), discount: opt(nullable(discount)), note: opt(nullable(str({ max: 120 }))), override: opt(override) })) }));
  add('DELETE', '/api/lines/:lineId', {}, (c) => removeLine(c.ctx, c.actor, rid(c), c.params.lineId!, body(c, obj({ override: opt(override) })).override));
  add('POST', '/api/orders/:id/coupon', {}, (c) => applyCoupon(c.ctx, c.actor, rid(c), { orderId: c.params.id!, ...body(c, obj({ code: str({ min: 1, max: 20 }) })) }));
  add('DELETE', '/api/orders/:id/coupon', {}, (c) => removeCoupon(c.ctx, c.actor, rid(c), c.params.id!));
  const couponShape = { code: str({ min: 1, max: 20 }), description: opt(nullable(str({ max: 80 }))), type: oneOf('amount', 'percent'), value: int({ min: 1 }), maxDiscount: opt(nullable(int({ min: 1 }))),
    minBill: opt(nullable(int({ min: 0 }))), validFrom: opt(nullable(str({ max: 10 }))), validTo: opt(nullable(str({ max: 10 }))), maxUses: opt(nullable(int({ min: 1 }))), active: opt(bool) };
  add('GET', '/api/coupons', {}, (c) => listCoupons(c.ctx, c.actor));
  add('POST', '/api/coupons', {}, (c) => createCoupon(c.ctx, c.actor, rid(c), body(c, obj(couponShape))));
  add('PUT', '/api/coupons/:id', {}, (c) => updateCoupon(c.ctx, c.actor, rid(c), c.params.id!, body(c, obj(couponShape))));
  add('POST', '/api/orders/:id/discount', {}, (c) => applyBillDiscount(c.ctx, c.actor, rid(c), { orderId: c.params.id!, ...body(c, obj({ discount: nullable(discount), override: opt(override) })) }));
  add('POST', '/api/orders/:id/hold', {}, (c) => holdOrder(c.ctx, c.actor, rid(c), c.params.id!));
  add('POST', '/api/orders/:id/resume', {}, (c) => resumeOrder(c.ctx, c.actor, rid(c), c.params.id!));
  add('POST', '/api/orders/:id/cancel', {}, (c) => cancelOrder(c.ctx, c.actor, rid(c), c.params.id!));
  // Read-only check of a payment split: what is left and the change (the UI never adds up money itself).
  add('POST', '/api/orders/:id/payment-check', { idem: false }, (c) => { assertPerm(c.actor, 'invoice.finalize'); return checkPayments(c.ctx, c.params.id!, body(c, obj({ payments: arr(obj({ mode: str({ max: 10 }), amount: int({ min: 0 }), tendered: opt(nullable(int({ min: 0 }))), reference: opt(nullable(str({ max: 60 }))) }), { max: 6 }) })).payments); });
  add('POST', '/api/orders/:id/finalize', {}, (c) => finalizeInvoice(c.ctx, c.actor, rid(c), { orderId: c.params.id!, ...body(c, obj({ payments: arr(payment, { max: 6 }), override: opt(override) })) }));

  // ---- invoices ----
  add('GET', '/api/invoices', {}, (c) => { assertPerm(c.actor, 'invoice.read'); return listInvoices(c.ctx, { fromMs: num(c.query, 'fromMs'), toMs: num(c.query, 'toMs'), status: c.query.get('status') ?? undefined, docType: c.query.get('docType') ?? undefined, q: c.query.get('q') ?? undefined, limit: num(c.query, 'limit'), offset: num(c.query, 'offset') }); });
  add('GET', '/api/invoices/:id', {}, (c) => { assertPerm(c.actor, 'invoice.read'); return getInvoice(c.ctx, c.params.id!); });
  add('POST', '/api/invoices/:id/cancel', {}, (c) => cancelInvoice(c.ctx, c.actor, rid(c), { invoiceId: c.params.id!, ...body(c, obj({ reason: str({ min: 1, max: 200 }), override: opt(override) })) }));
  add('GET', '/api/invoices/:id/credit-note', {}, (c) => { assertPerm(c.actor, 'invoice.read'); return creditNoteOptions(c.ctx, c.params.id!); });
  add('POST', '/api/invoices/:id/credit-note/preview', { idem: false }, (c) => { assertPerm(c.actor, 'invoice.read'); return previewCreditNote(c.ctx, c.params.id!, body(c, obj({ lines: arr(obj({ invoiceLineId: str({ min: 1, max: 64 }), qtyMilli: int({ min: 1 }) }), { max: 1000 }) })).lines); });
  add('POST', '/api/invoices/:id/credit-note', {}, (c) => createCreditNote(c.ctx, c.actor, rid(c), { invoiceId: c.params.id!, ...body(c, obj({ lines: arr(obj({ invoiceLineId: str({ min: 1, max: 64 }), qtyMilli: int({ min: 1 }) }), { max: 1000 }), reason: str({ min: 1, max: 200 }), refunds: arr(payment, { max: 6 }), override: opt(override) })) }));
  add('GET', '/api/invoices/:id/receipt', {}, (c) => { assertPerm(c.actor, 'invoice.read'); return receiptPreview(c.ctx, c.params.id!, num(c.query, 'width') ?? 80); });
  add('GET', '/api/invoices/:id/prints', {}, (c) => { assertPerm(c.actor, 'invoice.read'); return invoicePrints(c.ctx, c.params.id!); });
  add('POST', '/api/invoices/:id/reprint', {}, (c) => reprintInvoice(c.ctx, c.actor, rid(c), { invoiceId: c.params.id!, ...body(c, obj({ override: opt(override) })) }));

  // ---- shifts ----
  add('GET', '/api/shifts/current', {}, (c) => currentShift(c.ctx));
  add('POST', '/api/shifts/open', {}, (c) => openShift(c.ctx, c.actor, rid(c), body(c, obj({ openingCash: int({ min: 0 }) }))));
  add('POST', '/api/shifts/close', {}, (c) => closeShift(c.ctx, c.actor, rid(c), body(c, obj({ countedCash: int({ min: 0 }), discardOpenOrders: opt(bool) }))));
  add('GET', '/api/shifts/:id/report', {}, (c) => { assertPerm(c.actor, 'shift.report'); return zReport(c.ctx, c.params.id!); });

  // ---- reports ----
  add('GET', '/api/reports/daily', {}, (c) => { assertPerm(c.actor, 'report.read'); const b = dayBounds(c); return dailySummary(c.ctx, b.from, b.to); });
  add('GET', '/api/reports/tax', {}, (c) => { assertPerm(c.actor, 'report.read'); const b = dayBounds(c); return taxSummary(c.ctx, b.fromMs, b.toMs); });
  add('GET', '/api/reports/items', {}, (c) => { assertPerm(c.actor, 'report.read'); const b = dayBounds(c); return itemSales(c.ctx, b.fromMs, b.toMs); });
  add('GET', '/api/reports/catalog', {}, (c) => { assertPerm(c.actor, 'report.read'); return REPORTS; });
  add('GET', '/api/reports/view/:key', {}, (c) => runReport(c.ctx, c.actor, c.params.key!, { from: c.query.get('from') ?? '', to: c.query.get('to') ?? '' }));
  add('GET', '/api/reports/csv/:key', { format: 'csv' }, (c) => {
    const { filename, csv } = reportCsv(c.ctx, c.actor, c.params.key!, { from: c.query.get('from') ?? '', to: c.query.get('to') ?? '' });
    c.res.setHeader('Content-Disposition', `attachment; filename="${filename}"`); // the filename is built from the report key and checked dates only
    return csv;
  });
  add('GET', '/api/reports/invoice-register.csv', { format: 'csv' }, (c) => { assertPerm(c.actor, 'report.read'); const b = dayBounds(c); return invoiceRegisterCsv(c.ctx, b.fromMs, b.toMs); });

  // ---- printing ----
  add('GET', '/api/printers', {}, (c) => { assertPerm(c.actor, 'print.read'); return listPrinters(c.ctx); });
  const printerShape = { name: str({ min: 1, max: 60 }), transport: oneOf('memory', 'tcp', 'file', 'spooler', 'serial', 'usb', 'android'), address: opt(nullable(str({ max: 200 }))), widthMm: opt(int()), profile: opt(str({ max: 30 })), isReceipt: opt(bool), drawer: opt(bool), stations: opt(arr(str({ max: 30 }), { max: 20 })), active: opt(bool) };
  add('POST', '/api/printers', {}, (c) => createPrinter(c.ctx, c.actor, rid(c), body(c, obj(printerShape))));
  add('PATCH', '/api/printers/:id', {}, (c) => updatePrinter(c.ctx, c.actor, rid(c), c.params.id!, body(c, obj({ ...printerShape, name: opt(str({ min: 1, max: 60 })), transport: opt(oneOf('memory', 'tcp', 'file', 'spooler', 'serial', 'usb')) }))));
  add('DELETE', '/api/printers/:id', {}, (c) => deletePrinter(c.ctx, c.actor, rid(c), c.params.id!));
  // Finding printers (read only): installed Windows printers (USB), COM ports (Bluetooth), and a scan of this PC's network (Wi-Fi/LAN).
  add('GET', '/api/printers/windows', {}, async (c) => { assertPerm(c.actor, 'printer.manage'); return listWindowsPrinters(); });
  add('GET', '/api/printers/serial-ports', {}, async (c) => { assertPerm(c.actor, 'printer.manage'); return listSerialPorts(); });
  // Plug and play: USB printers plugged in but not set up; one tap adds one (a cashier needs approval) and prints a test page.
  add('GET', '/api/printers/detected', {}, async (c) => { assertPerm(c.actor, 'print.read'); return detectPrinters(c.ctx); });
  add('POST', '/api/printers/detected/dismiss', {}, (c) => dismissDetected(c.ctx, c.actor, rid(c), body(c, obj({ key: str({ min: 1, max: 300 }) })).key));
  add('POST', '/api/printers/quick-add', {}, (c) => quickAddPrinter(c.ctx, c.actor, rid(c), body(c, obj({ key: str({ min: 1, max: 300 }), override: opt(override) }))));
  // Printer setup screen: every plugged-in USB printer, a sample receipt, and setup tests.
  add('GET', '/api/printers/usb-devices', {}, async (c) => { assertPerm(c.actor, 'printer.manage'); return listUsbDevices(c.ctx, { refresh: c.query.get('refresh') === '1' }); });
  // store details and bill logo (Settings > Store)
  add('GET', '/api/store', {}, (c) => getStore(c.ctx, c.actor));
  add('PUT', '/api/store', {}, (c) => updateStore(c.ctx, c.actor, rid(c), body(c, obj({ name: str({ min: 1, max: 60 }), address: nullable(str({ max: 300 })), phone: nullable(str({ max: 30 })), gstin: nullable(str({ max: 20 })), fssaiNo: nullable(str({ max: 20 })) }))));
  add('PUT', '/api/store/logo', {}, (c) => setStoreLogo(c.ctx, c.actor, rid(c), body(c, obj({ width: int({ min: 8, max: 384 }), height: int({ min: 8, max: 240 }), bitsBase64: str({ min: 4, max: 20_000 }) }))));
  add('DELETE', '/api/store/logo', {}, (c) => clearStoreLogo(c.ctx, c.actor, rid(c)));
  // the logo as the printer prints it (black and white PNG). No sign-in: <img> cannot send a token; it is not secret (like menu photos)
  add('GET', '/api/store/logo.png', { auth: false }, (c) => {
    const png = logoPng(c.ctx);
    if (!png) throw new AppError('NOT_FOUND', 'No logo.', 404);
    c.res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    c.res.end(png);
    return Symbol.for('handled');
  });
  // receipt design (.tiffinreceipt): see docs/RECEIPT_TEMPLATES.md
  const designFile = obj({ fileName: str({ min: 1, max: 200 }), content: str({ min: 1, max: 200_000 }) });
  add('GET', '/api/receipt-design', {}, (c) => getReceiptDesign(c.ctx, c.actor));
  add('POST', '/api/receipt-design/preview', { idem: false }, (c) => { const b = body(c, obj({ fileName: str({ min: 1, max: 200 }), content: str({ min: 1, max: 200_000 }), widthMm: int({ min: 58, max: 80 }) })); return previewReceiptDesign(c.ctx, c.actor, b); });
  add('PUT', '/api/receipt-design', {}, (c) => setReceiptDesign(c.ctx, c.actor, rid(c), body(c, designFile)));
  add('DELETE', '/api/receipt-design', {}, (c) => clearReceiptDesign(c.ctx, c.actor, rid(c)));
  add('GET', '/api/printers/sample-receipt', {}, (c) => { assertPerm(c.actor, 'printer.manage'); return sampleReceipt(c.ctx, num(c.query, 'width') ?? 80); });
  add('POST', '/api/printers/:id/sample', {}, (c) => printSample(c.ctx, c.actor, rid(c), c.params.id!));
  add('POST', '/api/printers/:id/drawer', {}, (c) => testDrawer(c.ctx, c.actor, rid(c), c.params.id!));
  add('POST', '/api/printers/:id/retry-failed', { idem: false }, (c) => retryFailed(c.ctx, c.actor, c.params.id!));
  add('POST', '/api/printers/discover', { idem: false }, async (c) => { assertPerm(c.actor, 'printer.manage'); const b = body(c, obj({ port: opt(int({ min: 1, max: 65535 })) })); return discoverNetworkPrinters({ port: b.port }); });
  add('POST', '/api/printers/:id/test', {}, (c) => testPrint(c.ctx, c.actor, rid(c), c.params.id!));
  add('GET', '/api/print/jobs', {}, (c) => { assertPerm(c.actor, 'print.read'); return { counts: queueCounts(c.ctx), jobs: listJobs(c.ctx, c.query.get('status') ?? undefined) }; });
  add('POST', '/api/print/jobs/:id/retry', { idem: false }, (c) => { assertPerm(c.actor, 'print.read'); if (!opts.queue) throw new AppError('NO_QUEUE', 'Print queue is not running.', 503); opts.queue.retry(c.params.id!); return { ok: true }; });

  // ---- inventory: quantities in thousandths of the unit, costs in paise per whole unit ----
  const qty = int({ min: -1_000_000_000_000, max: 1_000_000_000_000 });
  const purchaseLines = arr(obj({ stockItemId: str({ min: 1, max: 64 }), qtyMilli: int({ min: 1 }), unitCost: int({ min: 0 }) }), { max: 200 });
  add('GET', '/api/stock/items', {}, (c) => { assertPerm(c.actor, 'stock.read'); return listStockItems(c.ctx, { lowOnly: c.query.get('low') === '1' }); });
  add('POST', '/api/stock/items', {}, (c) => createStockItem(c.ctx, c.actor, rid(c), body(c, obj({ name: str({ min: 1, max: 60 }), unit: oneOf(...UNITS), reorderLevelMilli: opt(int({ min: 0 })), openingQtyMilli: opt(int({ min: 0 })), openingUnitCost: opt(nullable(int({ min: 0 }))) }))));
  add('PATCH', '/api/stock/items/:id', {}, (c) => updateStockItem(c.ctx, c.actor, rid(c), c.params.id!, body(c, obj({ name: opt(str({ min: 1, max: 60 })), reorderLevelMilli: opt(int({ min: 0 })) }))));
  add('DELETE', '/api/stock/items/:id', {}, (c) => deleteStockItem(c.ctx, c.actor, rid(c), c.params.id!));
  add('POST', '/api/stock/items/:id/adjust', {}, (c) => adjustStock(c.ctx, c.actor, rid(c), { stockItemId: c.params.id!, ...body(c, obj({ kind: oneOf('WASTAGE', 'COUNT', 'ADJUST'), qtyMilli: qty, reason: opt(nullable(str({ max: 200 }))) })) }));
  add('GET', '/api/stock/items/:id/movements', {}, (c) => { assertPerm(c.actor, 'stock.read'); return listMovements(c.ctx, c.params.id!, num(c.query, 'limit') ?? 100); });
  add('POST', '/api/purchases/preview', { idem: false }, (c) => { assertPerm(c.actor, 'stock.read'); return previewPurchase(c.ctx, body(c, obj({ lines: purchaseLines })).lines); });
  add('GET', '/api/purchases', {}, (c) => { assertPerm(c.actor, 'stock.read'); return listPurchases(c.ctx, { limit: num(c.query, 'limit'), offset: num(c.query, 'offset') }); });
  add('POST', '/api/purchases', {}, (c) => createPurchase(c.ctx, c.actor, rid(c), body(c, obj({ supplierName: str({ min: 1, max: 80 }), supplierGstin: opt(nullable(str({ max: 15 }))), billNo: opt(nullable(str({ max: 40 }))), billDate: opt(nullable(str({ max: 10 }))), note: opt(nullable(str({ max: 200 }))), lines: purchaseLines }))));
  add('GET', '/api/purchases/:id', {}, (c) => { assertPerm(c.actor, 'stock.read'); return getPurchase(c.ctx, c.params.id!); });
  add('POST', '/api/purchases/:id/void', {}, (c) => voidPurchase(c.ctx, c.actor, rid(c), { purchaseId: c.params.id!, ...body(c, obj({ reason: str({ min: 1, max: 200 }) })) }));
  add('GET', '/api/recipes', {}, (c) => { assertPerm(c.actor, 'stock.read'); return listRecipes(c.ctx); });
  add('GET', '/api/recipes/:itemId', {}, (c) => { assertPerm(c.actor, 'stock.read'); return getRecipe(c.ctx, c.params.itemId!); });
  add('PUT', '/api/recipes/:itemId', {}, (c) => setRecipe(c.ctx, c.actor, rid(c), c.params.itemId!, body(c, obj({ lines: arr(obj({ stockItemId: str({ min: 1, max: 64 }), qtyMilli: int({ min: 1 }) }), { max: 50 }) })).lines));

  // ---- users, settings, admin ----
  add('POST', '/api/users', {}, (c) => createUser(c.ctx, c.actor, rid(c), body(c, obj({ name: str({ min: 1, max: 60 }), role: oneOf('owner', 'manager', 'cashier'), pin: str({ min: 4, max: 6 }), mobile: opt(nullable(str({ max: 10 }))) }))));
  add('POST', '/api/users/:id/pin', {}, (c) => changePin(c.ctx, c.actor, rid(c), { userId: c.params.id!, ...body(c, obj({ newPin: str({ min: 4, max: 6 }), currentPin: opt(str({ max: 6 })) })) }));
  add('POST', '/api/users/:id/deactivate', {}, (c) => deactivateUser(c.ctx, c.actor, rid(c), c.params.id!));
  add('GET', '/api/users', {}, (c) => listUsers(c.ctx, c.actor));
  add('PATCH', '/api/users/:id', {}, (c) => updateUser(c.ctx, c.actor, rid(c), { userId: c.params.id!, ...body(c, obj({ name: str({ min: 1, max: 60 }), role: oneOf('owner', 'manager', 'cashier'), mobile: opt(nullable(str({ max: 10 }))) })) }));
  add('POST', '/api/users/:id/reactivate', {}, (c) => reactivateUser(c.ctx, c.actor, rid(c), c.params.id!));
  add('GET', '/api/settings', {}, (c) => { assertPerm(c.actor, 'settings.write'); return allSettings(c.ctx); });
  add('PUT', '/api/settings', {}, (c) => {
    assertPerm(c.actor, 'settings.write');
    const b = body(c, obj(Object.fromEntries(SETTING_KEYS.map((k) => [k, opt(str({ max: 200 }))])) as Record<string, V<string | undefined>>));
    for (const [k, v] of Object.entries(b)) if (v !== undefined) setSetting(c.ctx, k, v);
    audit(c.ctx, c.actor.userId, 'settings.update', 'settings', undefined, Object.keys(b));
    return allSettings(c.ctx);
  });
  add('GET', '/api/health', {}, (c) => { assertPerm(c.actor, 'health.read'); return getHealth(c.ctx, { deep: c.query.get('deep') === '1' }); });
  add('POST', '/api/backup', { idem: false }, async (c) => { assertPerm(c.actor, 'backup.run'); return runBackup(c.ctx, 'manual'); });
  add('GET', '/api/backups', {}, (c) => { assertPerm(c.actor, 'backup.run'); return { status: backupStatus(c.ctx), files: listBackups(c.ctx.backupDir) }; });
  add('POST', '/api/journal/repair', { idem: false }, (c) => { assertPerm(c.actor, 'backup.run'); return { repaired: repairJournal(c.ctx) }; });
  add('GET', '/api/audit', {}, (c) => { assertPerm(c.actor, 'audit.read'); return listAudit(c.ctx, num(c.query, 'limit') ?? 100, num(c.query, 'offset') ?? 0); });
  add('GET', '/api/audit/verify', {}, (c) => { assertPerm(c.actor, 'audit.read'); return verifyAuditChain(c.ctx.db); });
  add('GET', '/api/today', {}, (c) => ({ day: istDay(c.ctx.clock.now()) }));

  // ---- live events (Server-Sent Events). Auth via Authorization header (use fetch streaming). ----
  add('GET', '/api/events', { format: 'sse' }, (c) => {
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    c.res.write(': connected\n\n');
    const send = (name: string) => (data: unknown) => c.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    const onPrint = send('print'), onInvoice = send('invoice');
    c.ctx.events.on('print', onPrint); c.ctx.events.on('invoice', onInvoice);
    c.req.on('close', () => { c.ctx.events.off('print', onPrint); c.ctx.events.off('invoice', onInvoice); });
    return Symbol.for('handled');
  });
  // ---- add-ons ----
  const addons = opts.addons ?? EMPTY_ADDONS;
  add('GET', '/api/addons', {}, () => addons.list.map((a) => ({ ...a, ui: a.status === 'active' && a.hasUi ? `/api/addons/${a.id}/ui.js?v=${encodeURIComponent(a.version)}` : null })));
  // the screens of an add-on (checked bytes from its signed package). No sign-in: a <script> tag cannot send the token; the code is not secret
  add('GET', '/api/addons/:id/ui.js', { auth: false }, (c) => {
    const code = addons.ui.get(c.params.id!);
    if (code === undefined) throw new AppError('NOT_FOUND', 'No such add-on.', 404);
    c.res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': Buffer.byteLength(code), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    c.res.end(code);
    return Symbol.for('handled');
  });
  for (const r of addons.routes) add(r.method, r.path, { auth: r.opts.auth, idem: r.opts.idem, format: r.opts.format === 'sse' ? 'sse' : undefined }, (c) => r.handler(c));
  return routes;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []; let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY) { reject(new AppError('PAYLOAD_TOO_LARGE', 'Request is too large.', 413)); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { reject(new AppError('BAD_JSON', 'Request body is not valid JSON.', 400)); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown, type = 'application/json; charset=utf-8'): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(text);
}

/** Constant-time comparison, so the secret cannot be guessed byte by byte from response times. */
function sameSecret(got: string | string[] | undefined, want: Buffer): boolean {
  if (typeof got !== 'string') return false;
  const g = Buffer.from(got);
  return g.length === want.length && timingSafeEqual(g, want);
}

export function createServer(ctx: Ctx, opts: ServerOptions = {}): http.Server {
  const routes = buildRoutes({ queue: opts.queue ?? null, addons: opts.addons });
  const secret = opts.secret ? Buffer.from(opts.secret) : null;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // DNS-rebinding defence: only accept loopback Host headers.
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new AppError('BAD_HOST', 'Unexpected Host header.', 403);
      if (secret && !sameSecret(req.headers['x-pos-secret'], secret)) throw new AppError('BAD_LAUNCH_SECRET', 'Open the POS from its desktop app.', 403);
      let route: Route | undefined; let params: Record<string, string> = {};
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        route = r; params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        break;
      }
      if (!route) throw new AppError(pathMatched ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', pathMatched ? 'Method not allowed.' : 'No such endpoint.', pathMatched ? 405 : 404);
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      // Forces a CORS preflight for cross-site pages, which this server never approves.
      if (mutating && req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415);
      }
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const actor = route.auth ? authenticate(ctx, bearer) : (null as unknown as Actor);
      const rawBody = mutating ? await readBody(req) : {};
      let requestId = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : '';
      let bodyObj = rawBody;
      if (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) && 'requestId' in (rawBody as object)) {
        const { requestId: rb, ...rest } = rawBody as Record<string, unknown>;
        if (typeof rb === 'string') requestId = rb;
        bodyObj = rest;
      }
      if (route.idem && !requestId) throw new AppError('REQUEST_ID_REQUIRED', 'Send an Idempotency-Key header (or requestId in the body) with every change.', 400);
      const out = await route.handler({ ctx, actor, params, query: url.searchParams, body: bodyObj, requestId, token: bearer, req, res });
      if (out === Symbol.for('handled')) return;
      if (route.format === 'csv') return send(res, 200, out as string, 'text/csv; charset=utf-8');
      send(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
      if (e instanceof RangeError) return send(res, 422, { error: { code: 'INVALID_AMOUNT', message: e.message } });
      ctx.logger.error('unhandled error', { message: String((e as Error).message), stack: (e as Error).stack });
      send(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong. The bill data is safe; please try again.' } });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

export function listen(server: http.Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as { port: number }).port));
  });
}
