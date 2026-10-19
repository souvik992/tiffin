import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { BadgePercent, Banknote, Bell, CircleAlert, ClipboardList, CreditCard, Inbox, LogOut, PackageX, PauseCircle, Plus, RotateCw, Search, Smartphone, Split, Ticket, Trash2, UserRound, Wallet, X } from 'lucide-react';
import { ApiError, newKey } from '../lib/api.ts';
import type { Cart, CartLine, Catalog, Discount, FinalizeResult, Item, PayMode, PrintJob, Shift, StockItem, ZReport } from '../lib/api.ts';
import { formatPaise, formatPrice, formatQty, formatRateBp, formatStockQty, parsePercentBp, parseRupees } from '../lib/money.ts';
import { useSession } from '../lib/session.tsx';
import { Modal, Rail, VegMark } from '../components/ui.tsx';
import { AfterPayment, AvailabilityDialog, ConfirmDialog, CustomerDialog, DrawerDialog, HeldBillsDialog, LineDialog, SplitPaymentDialog, XReportDialog } from './BillingExtras.tsx';
import { PlugAndPlay } from '../components/plugAndPlay.tsx';

const PAY_MODES: Array<{ mode: PayMode; label: string; icon: typeof Banknote }> = [
  { mode: 'CASH', label: 'Cash', icon: Banknote },
  { mode: 'UPI', label: 'UPI', icon: Smartphone },
  { mode: 'CARD', label: 'Card', icon: CreditCard },
];
const STALE_ORDER = new Set(['ORDER_NOT_OPEN', 'ORDER_ALREADY_INVOICED', 'NOT_FOUND']);

export function Billing() {
  const { api, fail, notify, withApproval } = useSession();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [shift, setShift] = useState<Shift | null | undefined>(undefined);
  const [cart, setCart] = useState<Cart | null>(null);
  const cartRef = useRef<Cart | null>(null);
  cartRef.current = cart;
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(0);
  const [modifierItem, setModifierItem] = useState<Item | null>(null);
  const [showClose, setShowClose] = useState(false);
  const [lastBill, setLastBill] = useState<FinalizeResult | null>(null);
  const [showHeld, setShowHeld] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  const [showCustomer, setShowCustomer] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [editLine, setEditLine] = useState<CartLine | null>(null);
  const [panel, setPanel] = useState<'x' | 'drawer' | 'availability' | null>(null);
  const [backOn, setBackOn] = useState<Item | null>(null);
  const [cartOpen, setCartOpen] = useState(false); // small screens: the bill is shown over the menu
  const refreshHeld = useCallback(() => { api.openOrders('HELD').then((l) => setHeldCount(l.length)).catch(() => { /* badge only */ }); }, [api]);
  useEffect(refreshHeld, [refreshHeld]);

  const load = useCallback(async () => {
    try {
      const [cat, sh, open] = await Promise.all([api.catalog(), api.currentShift(), api.openOrders()]);
      setCatalog(cat); setShift(sh);
      const draft = open.find((o) => o.status === 'DRAFT');
      setCart(draft ? await api.getOrder(draft.id) : null); // the server is the source of truth: a reload restores the bill
    } catch (e) { fail(e); }
  }, [api, fail]);
  useEffect(() => { void load(); }, [load]);

  // Cart changes run one after another, in tap order. Each response carries the whole cart with backend totals.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const mutate = useCallback((fn: (c: Cart | null) => Promise<Cart | null>) => {
    setPending((n) => n + 1);
    chain.current = chain.current.then(async () => {
      try { setCart(await fn(cartRef.current)); } catch (e) {
        if (e instanceof ApiError && STALE_ORDER.has(e.code)) { notify('info', 'That bill was already closed elsewhere. Showing the current state.'); await load(); } else fail(e);
      } finally { setPending((n) => n - 1); }
    });
    return chain.current;
  }, [fail, load, notify]);

  const ensureOrder = async (c: Cart | null): Promise<Cart> => c ?? api.createOrder();
  const addItem = (item: Item, modifierIds: string[] = []) => mutate(async (c) => {
    setLastBill(null);
    const order = await ensureOrder(c);
    return api.addLine(order.order.id, item.id, modifierIds);
  });
  const tapItem = (item: Item) => (item.availableToday === false ? setBackOn(item) : item.modifierGroupIds.length ? setModifierItem(item) : void addItem(item));
  const setAvailable = async (item: Item, available: boolean) => {
    try { await api.setAvailability(item.id, available); setCatalog(await api.catalog()); notify('success', available ? `${item.name} is available again.` : `${item.name} is marked "not available today".`); } catch (e) { fail(e); }
  };
  const changeQty = (lineId: string, delta: 1 | -1) => mutate(async (c) => {
    const line = c?.lines.find((l) => l.id === lineId);
    if (!line) return c;
    const next = line.qtyMilli + delta * 1000;
    const key = newKey();
    const r = await withApproval(next <= 0 ? 'Removing this item' : 'Changing the quantity', (o) => (next <= 0 ? api.removeLine(lineId, o, key) : api.setLineQty(lineId, next, key, o)));
    return r ?? c;
  });
  const clearBill = () => { setConfirmClear(false); return mutate(async (c) => { if (c) await api.cancelOrder(c.order.id); return null; }); };
  const holdBill = () => mutate(async (c) => {
    if (!c || c.lines.length === 0) return c;
    await api.holdOrder(c.order.id);
    notify('info', `Bill for token ${c.order.tokenNo} put on hold. Resume it from Held bills.`);
    refreshHeld();
    return null;
  });
  const resumeBill = (id: string) => { setShowHeld(false); return mutate(async (c) => {
    if (c && c.lines.length > 0) await api.holdOrder(c.order.id); // keep the current bill safe on hold
    else if (c) await api.cancelOrder(c.order.id); // an empty draft is just discarded
    setLastBill(null);
    const r = await api.resumeOrder(id);
    refreshHeld();
    return r;
  }); };

  const items = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    return catalog.items.filter((i) => (category === 'all' || i.categoryId === category) && (!q || i.name.toLowerCase().includes(q) || i.barcode === q || i.sku?.toLowerCase() === q));
  }, [catalog, category, query]);

  // Barcode scanners type the code and press Enter.
  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || !catalog) return;
    const code = query.trim();
    const hit = catalog.items.find((i) => i.barcode === code) ?? (items.length === 1 ? items[0] : undefined);
    if (hit) { tapItem(hit); setQuery(''); }
  };

  if (shift === undefined || !catalog) {
    return <div className="flex h-screen"><Rail route="billing" /><div className="flex flex-1 items-center justify-center text-muted-foreground">Loading…</div></div>;
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Rail route="billing" />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input className="h-9 w-full rounded-full border border-border bg-card pl-11 pr-4 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="Search menu or scan barcode…" aria-label="Search menu or scan barcode" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            {shift && (
              <button className="btn-ghost h-10 rounded-full" onClick={() => setShowHeld(true)} aria-label={`Held bills: ${heldCount}`}>
                <PauseCircle className="h-4 w-4" /><span className="hidden sm:inline">Held</span>{heldCount > 0 && <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{heldCount}</span>}
              </button>
            )}
            <PrintAlerts />
            <UserMenu shiftOpen={!!shift} onCloseShift={() => setShowClose(true)} onPanel={setPanel} />
          </div>
        </header>
        <PlugAndPlay compact />

        {!shift ? <OpenShift onOpened={(s) => { setShift(s); notify('success', 'Shift opened. Ready to bill.'); }} /> : (
          <>
            <div className="px-3 sm:px-4">
              <h2 className="hidden font-display text-sm font-semibold sm:block">Categories</h2>
              <div className="mt-1 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Menu categories">
                {[{ id: 'all', name: 'All' }, ...catalog.categories].map((c) => (
                  <button key={c.id} role="tab" aria-selected={category === c.id} className={`cat-chip ${category === c.id ? 'cat-chip-active' : ''}`} onClick={() => setCategory(c.id)}>{c.name}</button>
                ))}
              </div>
            </div>
            <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto px-3 pb-4 pt-2 sm:gap-3 sm:px-4 lg:grid-cols-3 xl:grid-cols-4">
              {items.length === 0 && <p className="col-span-full py-10 text-center text-sm text-muted-foreground">{catalog.items.length === 0 ? 'No menu items yet. Add them under Menu creation.' : 'No items match.'}</p>}
              {items.map((i) => (
                <button key={i.id} className={`item-card relative text-left ${i.availableToday === false ? 'opacity-50 grayscale' : ''}`} onClick={() => tapItem(i)} aria-label={i.availableToday === false ? `${i.name}: not available today` : undefined}>
                  <TilePhoto item={i} />
                  {i.availableToday === false && <span className="absolute left-3 top-3 rounded-full bg-destructive px-2 py-0.5 text-[11px] font-semibold text-destructive-foreground">Not available today</span>}
                  <div className="mt-3 flex items-center gap-2"><VegMark veg={i.isVeg} /><span className="truncate text-sm font-semibold">{i.name}</span></div>
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="font-semibold text-primary">{formatPrice(i.price)}</span>
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden><Plus className="h-4 w-4" /></span>
                  </div>
                </button>
              ))}
            </div>
            {(cart?.lines.length || lastBill) ? (
              <div className="border-t border-border bg-card p-2 md:hidden">
                <button className="btn-primary h-12 w-full justify-between px-4 text-base" onClick={() => setCartOpen(true)}>
                  <span>{lastBill && !cart ? 'Last bill' : `View bill · ${cart?.totals.itemCount ?? 0} item${cart?.totals.itemCount === 1 ? '' : 's'}`}</span>
                  <span>{cart ? formatPaise(cart.totals.grandTotal) : ''}</span>
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {shift && <CartPanel mobileOpen={cartOpen} onCloseMobile={() => setCartOpen(false)} cart={cart} busy={pending > 0} onQty={changeQty} onLine={setEditLine} onClear={() => setConfirmClear(true)} onHold={() => void holdBill()} onCustomer={() => setShowCustomer(true)}
        lastBill={lastBill} onNewBill={() => { setLastBill(null); setCartOpen(false); }}
        onDiscount={async (d) => {
          const c = cartRef.current; if (!c) return;
          const key = newKey();
          await mutate(async () => (await withApproval('A discount above your limit', (o) => api.billDiscount(c.order.id, d, o, key))) ?? cartRef.current);
        }}
        onCoupon={async (code) => {
          let problem: string | null = null;
          const key = newKey();
          await mutate(async (c) => {
            if (!c) return c;
            if (code === null) return api.removeCoupon(c.order.id, key);
            try { return await api.applyCoupon(c.order.id, code, key); } catch (e) {
              if (e instanceof ApiError && (e.code === 'COUPON_INVALID' || e.code === 'EMPTY_CART')) { problem = e.message; return c; }
              throw e;
            }
          });
          return problem;
        }}
        onPaid={(r) => { setCart(null); setLastBill(r); }} />}

      {modifierItem && catalog && <ModifierDialog item={modifierItem} catalog={catalog} onClose={() => setModifierItem(null)} onAdd={(ids) => { void addItem(modifierItem, ids); setModifierItem(null); }} />}
      {showClose && <CloseShift onClose={() => setShowClose(false)} onClosed={() => { setShift(null); setCart(null); setLastBill(null); }} />}
      {showHeld && <HeldBillsDialog onClose={() => setShowHeld(false)} onResume={(id) => void resumeBill(id)} />}
      {showCustomer && cart && <CustomerDialog cart={cart} onClose={() => setShowCustomer(false)} onSaved={(c) => { setCart(c); setShowCustomer(false); }} />}
      {editLine && <LineDialog line={editLine} onClose={() => setEditLine(null)} onSave={async (input) => {
        let ok = false;
        const key = newKey();
        await mutate(async (c) => { const r = await withApproval('A discount above your limit', (o) => api.updateLine(editLine.id, input, o, key)); ok = r !== null; return r ?? c; });
        return ok;
      }} />}
      {panel === 'x' && <XReportDialog onClose={() => setPanel(null)} />}
      {panel === 'drawer' && <DrawerDialog onClose={() => setPanel(null)} />}
      {panel === 'availability' && catalog && <AvailabilityDialog items={catalog.items} onToggle={(it, a) => setAvailable(it, a)} onClose={() => setPanel(null)} />}
      {backOn && <ConfirmDialog title="Not available today" text={`${backOn.name} is marked "not available today". Make it available again?`} confirm="Make available" onConfirm={() => { void setAvailable(backOn, true); setBackOn(null); }} onClose={() => setBackOn(null)} />}
      {confirmClear && cart && <ConfirmDialog title="Clear this bill?" text={`All ${cart.lines.length} item(s) on token ${cart.order.tokenNo} will be removed. Use Hold instead to keep it for later.`} confirm="Clear bill" onConfirm={() => void clearBill()} onClose={() => setConfirmClear(false)} />}
    </div>
  );
}

function CartPanel({ mobileOpen, onCloseMobile, cart, busy, onQty, onLine, onClear, onHold, onCustomer, onDiscount, onCoupon, onPaid, lastBill, onNewBill }: {
  mobileOpen: boolean; onCloseMobile: () => void;
  cart: Cart | null; busy: boolean; onQty: (lineId: string, d: 1 | -1) => void; onLine: (l: CartLine) => void; onClear: () => void; onHold: () => void; onCustomer: () => void;
  onDiscount: (d: Discount | null) => Promise<void>; onCoupon: (code: string | null) => Promise<string | null>; onPaid: (r: FinalizeResult) => void; lastBill: FinalizeResult | null; onNewBill: () => void;
}) {
  const { api, notify, fail } = useSession();
  const [mode, setMode] = useState<PayMode>('CASH');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [showDiscount, setShowDiscount] = useState(false);
  const [discType, setDiscType] = useState<Discount['type']>('percent');
  const [discValue, setDiscValue] = useState('');
  const [discError, setDiscError] = useState('');
  const [discMode, setDiscMode] = useState<'coupon' | 'discount'>('coupon');
  const [couponCode, setCouponCode] = useState('');
  const coupon = cart?.order.coupon ?? null;
  const [paying, setPaying] = useState(false);
  const [splitting, setSplitting] = useState(false);
  // One key per bill until it succeeds: a double click or a retry after a lost response returns the same invoice.
  const payKey = useRef<{ orderId: string; key: string } | null>(null);

  const t = cart?.totals;
  const lines = cart?.lines ?? [];
  const empty = lines.length === 0;
  const rates = new Set(lines.filter((l) => l.rateBp > 0).map((l) => l.rateBp));
  const single = rates.size === 1 ? [...rates][0]! : null;
  const half = single !== null && single % 2 === 0 ? ` ${formatRateBp(single / 2)}` : '';

  const applyDiscount = async () => {
    const value = discType === 'percent' ? parsePercentBp(discValue) : parseRupees(discValue);
    if (value === null || value <= 0) return setDiscError(discType === 'percent' ? 'Enter a percentage between 0 and 100.' : 'Enter an amount in rupees, like 50 or 49.50.');
    setDiscError('');
    await onDiscount({ type: discType, value });
    setDiscValue(''); setShowDiscount(false);
  };
  const applyCouponCode = async () => {
    const code = couponCode.trim().toUpperCase();
    if (code.length < 3) return setDiscError('Type the coupon code.');
    setDiscError('');
    const problem = await onCoupon(code);
    if (problem) return setDiscError(problem);
    setCouponCode(''); setShowDiscount(false);
  };

  const pay = async () => {
    if (!cart || !t || empty || busy || paying) return;
    let tenderedPaise: number | null = null;
    if (mode === 'CASH' && tendered.trim()) {
      tenderedPaise = parseRupees(tendered);
      if (tenderedPaise === null) return notify('error', 'Cash received must be an amount in rupees, like 500.');
    }
    if (!payKey.current || payKey.current.orderId !== cart.order.id) payKey.current = { orderId: cart.order.id, key: newKey() };
    setPaying(true);
    try {
      const payments = t.grandTotal === 0 ? [] : [{ mode, amount: t.grandTotal, tendered: tenderedPaise, reference: mode === 'CASH' ? null : reference.trim() || null }];
      const r = await api.finalize(cart.order.id, payments, payKey.current.key);
      payKey.current = null;
      setTendered(''); setReference(''); setMode('CASH');
      onPaid(r);
    } catch (e) {
      // A changed cart needs a new key; keep the key only for network failures, where the bill may already exist.
      if (!(e instanceof ApiError && e.code === 'NETWORK')) payKey.current = null;
      fail(e);
    } finally { setPaying(false); }
  };

  if (lastBill && !cart) {
    return (
      <aside className={`${mobileOpen ? 'fixed inset-0 z-40 flex w-full md:static md:z-auto' : 'hidden md:flex'} md:w-[320px] lg:w-[360px] h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-border bg-card`} aria-label="Last bill">
        <AfterPayment result={lastBill} onDone={onNewBill} />
      </aside>
    );
  }

  return (
    <aside className={`${mobileOpen ? 'fixed inset-0 z-40 flex w-full md:static md:z-auto' : 'hidden md:flex'} md:w-[320px] lg:w-[360px] h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-border bg-card`} aria-label="Current bill">
      <div className="flex items-center gap-1 px-4 pb-1 pt-3">
        {mobileOpen && <button className="-ml-2 flex h-10 w-10 shrink-0 items-center justify-center text-muted-foreground md:hidden" aria-label="Back to the menu" onClick={onCloseMobile}><X className="h-5 w-5" /></button>}
        <h2 className="min-w-0 flex-1 truncate font-display text-base font-semibold leading-none">
          {cart ? `Bill · Token ${cart.order.tokenNo}` : 'New bill'}
          {(cart?.order.customerName || cart?.order.customerPhone || cart?.order.note) && <span className="mt-0.5 block truncate font-sans text-[11px] font-normal text-muted-foreground">{[cart.order.customerName, cart.order.customerPhone, cart.order.note].filter(Boolean).join(' · ')}</span>}
        </h2>
        <button className="flex h-10 w-10 shrink-0 items-center justify-center text-muted-foreground hover:text-primary disabled:opacity-40" aria-label="Customer and note" title="Customer and note" disabled={!cart || busy} onClick={onCustomer}>
          <UserRound className="h-5 w-5" />
        </button>
        <button className="flex h-10 w-10 shrink-0 items-center justify-center text-muted-foreground hover:text-primary disabled:opacity-40" aria-label="Hold bill" title="Hold bill (park it and start another)" disabled={empty || busy} onClick={onHold}>
          <PauseCircle className="h-5 w-5" />
        </button>
        <button className="flex h-11 w-11 shrink-0 items-center justify-center text-primary disabled:opacity-40" aria-label="Coupon or discount" disabled={empty} onClick={() => setShowDiscount((v) => !v)}>
          <BadgePercent className="h-7 w-7" />
        </button>
        <button className="flex h-10 w-10 shrink-0 items-center justify-center text-muted-foreground hover:text-destructive disabled:opacity-40" aria-label="Clear bill" disabled={!cart || busy} onClick={onClear}>
          <Trash2 className="h-6 w-6" />
        </button>
      </div>

      {showDiscount && !empty && (
        <div className="space-y-2 border-y border-border bg-secondary/60 px-4 py-2">
          <div className="flex gap-1.5" role="tablist" aria-label="Coupon or discount">
            {(['coupon', 'discount'] as const).map((m) => (
              <button key={m} role="tab" aria-selected={discMode === m} className={`pay-btn h-9 flex-1 text-sm ${discMode === m ? 'pay-btn-active' : ''}`} onClick={() => { setDiscMode(m); setDiscError(''); }}>
                {m === 'coupon' ? 'Coupon code' : 'Discount'}
              </button>
            ))}
          </div>
          {discMode === 'coupon' ? (
            <div className="flex gap-2">
              <input className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-sm uppercase outline-none focus:border-primary" aria-label="Coupon code" autoFocus
                placeholder="e.g. SAVE10" maxLength={20} value={couponCode} onChange={(e) => setCouponCode(e.target.value.replace(/[^A-Za-z0-9-]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') void applyCouponCode(); }} />
              <button className="btn-primary h-11 shrink-0 px-5" onClick={() => void applyCouponCode()} disabled={busy}>Apply</button>
            </div>
          ) : (
          <div className="flex gap-2">
            <div className="flex shrink-0 gap-1.5" role="group" aria-label="Discount type">
              <button className={`pay-btn h-11 w-11 text-base ${discType === 'percent' ? 'pay-btn-active' : ''}`} aria-label="Percentage discount" onClick={() => setDiscType('percent')}>%</button>
              <button className={`pay-btn h-11 w-11 text-base ${discType === 'amount' ? 'pay-btn-active' : ''}`} aria-label="Fixed amount discount" onClick={() => setDiscType('amount')}>₹</button>
            </div>
            <input className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary" aria-label="Discount value"
              inputMode="decimal" placeholder={discType === 'percent' ? 'e.g. 10' : 'e.g. 50'} value={discValue} onChange={(e) => setDiscValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void applyDiscount(); }} />
            <button className="btn-primary h-11 shrink-0 px-5" onClick={() => void applyDiscount()} disabled={busy}>Apply</button>
          </div>
          )}
          {discError && <p className="text-xs text-destructive">{discError}</p>}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 pb-1 pt-1">
        {empty && <p className="py-8 text-center text-sm text-muted-foreground">Tap an item to start a bill</p>}
        {lines.map((l) => (
          <div key={l.id} className="flex items-center gap-1.5 rounded-xl border border-border bg-background px-1.5 py-0.5">
            <button className="min-w-0 flex-1 py-1 pl-1 text-left" onClick={() => onLine(l)} aria-label={`Change ${l.name}: quantity, note or discount`} title="Quantity, note or discount">
              <span className="block truncate text-sm">{l.name}</span>
              {l.modifiers.length > 0 && <span className="block truncate text-[11px] text-muted-foreground">+ {l.modifiers.map((m) => m.name).join(', ')}</span>}
              {l.note && <span className="block truncate text-[11px] italic text-muted-foreground">“{l.note}”</span>}
              {l.discount && <span className="block truncate text-[11px] text-primary">{l.discount.type === 'percent' ? formatRateBp(l.discount.value) : formatPaise(l.discount.value)} off this item</span>}
            </button>
            <div className="flex shrink-0 items-center gap-1">
              <button className="qty-btn" aria-label={`Remove one ${l.name}`} onClick={() => onQty(l.id, -1)}>−</button>
              <span className="w-8 text-center text-sm font-semibold tabular-nums">{formatQty(l.qtyMilli)}</span>
              <button className="qty-btn" aria-label={`Add one ${l.name}`} onClick={() => onQty(l.id, 1)}>+</button>
            </div>
            <div className="w-[74px] shrink-0 text-right leading-tight">
              <span className="block text-sm font-semibold tabular-nums">{formatPaise(l.lineTotal)}</span>
              <span className="block text-[10px] tabular-nums text-muted-foreground">{formatPaise(l.unitPrice)} each</span>
            </div>
          </div>
        ))}
      </div>

      {t && !empty && (
        <div className="space-y-0.5 border-t border-border px-4 py-1.5 text-xs tabular-nums">
          <Row label={`Subtotal (${t.itemCount} item${t.itemCount === 1 ? '' : 's'})`} value={formatPaise(t.grossTotal)} />
          {coupon && (
            <div className={`flex items-center justify-between ${coupon.problem ? 'text-destructive' : 'text-primary'}`}>
              <span className="flex min-w-0 items-center gap-1.5"><Ticket className="h-4 w-4" /><span className="truncate">Coupon {coupon.code}</span></span>
              <span className="flex shrink-0 items-center gap-1.5">{coupon.problem ? 'not applied' : `−${formatPaise(t.discountTotal)}`}
                <button className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-destructive" aria-label="Remove coupon" onClick={() => void onCoupon(null)}><X className="h-4 w-4" /></button>
              </span>
            </div>
          )}
          {coupon?.problem && <p role="alert" className="flex gap-1 text-[11px] text-destructive"><CircleAlert className="h-3.5 w-3.5 shrink-0" />{coupon.problem} Remove it or change the bill to pay.</p>}
          {t.discountTotal > 0 && !coupon && (
            <div className="flex items-center justify-between text-primary">
              <span className="flex min-w-0 items-center gap-1.5"><BadgePercent className="h-4 w-4" /><span className="truncate">Discount{cart?.order.billDiscount?.type === 'percent' ? ` ${formatRateBp(cart.order.billDiscount.value)}` : ''}</span></span>
              <span className="flex shrink-0 items-center gap-1.5">−{formatPaise(t.discountTotal)}
                {cart?.order.billDiscount && <button className="flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-destructive" aria-label="Remove discount" onClick={() => void onDiscount(null)}><X className="h-4 w-4" /></button>}
              </span>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">Prices include GST</p>
          {t.cgst > 0 && <Row label={`CGST${half}`} value={formatPaise(t.cgst)} />}
          {t.sgst > 0 && <Row label={`SGST${half}`} value={formatPaise(t.sgst)} />}
          {t.igst > 0 && <Row label={`IGST${single !== null ? ` ${formatRateBp(single)}` : ''}`} value={formatPaise(t.igst)} />}
          {t.cess > 0 && <Row label="Cess" value={formatPaise(t.cess)} />}
          {t.roundOff !== 0 && <Row label="Round off" value={formatPaise(t.roundOff)} />}
          <div className="flex items-center justify-between pt-1 text-base font-bold"><span>Total</span><span className="text-primary">{formatPaise(t.grandTotal)}</span></div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 px-4 pt-1.5" role="radiogroup" aria-label="Payment mode">
        {PAY_MODES.map(({ mode: m, label, icon: Icon }) => (
          <button key={m} role="radio" aria-checked={mode === m} className={`pay-btn ${mode === m ? 'pay-btn-active' : ''}`} onClick={() => setMode(m)}>
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
      </div>
      <div className="px-4 pt-2">
        {mode === 'CASH'
          ? <input className="field h-10 w-full" inputMode="decimal" placeholder="Cash received (optional)" aria-label="Cash received" value={tendered} onChange={(e) => setTendered(e.target.value)} />
          : <input className="field h-10 w-full" placeholder={mode === 'UPI' ? 'UPI reference (optional)' : 'Card slip / last 4 digits (optional)'} aria-label="Payment reference" maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} />}
      </div>
      <div className="px-4 pb-3 pt-2">
        <div className="flex gap-2">
          <button className="btn-ghost h-12 shrink-0 px-3" aria-label="Split payment" title="Split payment (part UPI, part cash…)" disabled={empty || busy || paying || !t || t.grandTotal === 0} onClick={() => setSplitting(true)}>
            <Split className="h-4 w-4" />Split
          </button>
          <button className="btn-primary h-12 min-w-0 flex-1 text-base" disabled={empty || busy || paying} onClick={() => void pay()}>
            {paying ? 'Saving bill…' : busy ? 'Updating…' : t && !empty ? `Charge ${formatPaise(t.grandTotal)}` : 'Charge'}
          </button>
        </div>
      </div>
      {splitting && cart && <SplitPaymentDialog cart={cart} payKey={payKey} onClose={() => setSplitting(false)} onPaid={(r) => { setSplitting(false); onPaid(r); }} />}
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-muted-foreground"><span>{label}</span><span className="text-foreground">{value}</span></div>;
}

function ModifierDialog({ item, catalog, onClose, onAdd }: { item: Item; catalog: Catalog; onClose: () => void; onAdd: (ids: string[]) => void }) {
  const groups = catalog.modifierGroups.filter((g) => item.modifierGroupIds.includes(g.id));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (groupId: string, id: string) => setPicked((p) => {
    const g = groups.find((x) => x.id === groupId)!;
    const next = new Set(p);
    if (next.has(id)) { next.delete(id); return next; }
    const inGroup = g.modifiers.filter((m) => next.has(m.id));
    if (g.maxSelect === 1) for (const m of inGroup) next.delete(m.id);
    else if (inGroup.length >= g.maxSelect) return p;
    next.add(id);
    return next;
  });
  const missing = groups.find((g) => g.modifiers.filter((m) => picked.has(m.id)).length < g.minSelect);
  return (
    <Modal title={item.name} onClose={onClose}>
      <div className="space-y-4">
        {groups.map((g) => (
          <fieldset key={g.id}>
            <legend className="mb-2 text-sm font-semibold">{g.name} <span className="font-normal text-muted-foreground">{g.minSelect > 0 ? `choose at least ${g.minSelect}` : 'optional'}{g.maxSelect > 1 ? `, up to ${g.maxSelect}` : ''}</span></legend>
            <div className="flex flex-wrap gap-2">
              {g.modifiers.map((m) => (
                <button key={m.id} type="button" aria-pressed={picked.has(m.id)} className={`chip ${picked.has(m.id) ? 'chip-active' : ''}`} onClick={() => toggle(g.id, m.id)}>
                  {m.name}{m.price > 0 && <span className="ml-1.5 opacity-80">+{formatPrice(m.price)}</span>}
                </button>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="mt-6 flex gap-2">
        <button className="btn-ghost flex-1" onClick={() => onAdd([])} disabled={!!groups.find((g) => g.minSelect > 0)}>Add plain</button>
        <button className="btn-primary flex-1" disabled={!!missing} onClick={() => onAdd([...picked])}>Add to bill</button>
      </div>
    </Modal>
  );
}

function OpenShift({ onOpened }: { onOpened: (s: Shift) => void }) {
  const { api, fail } = useSession();
  const [cash, setCash] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const open = async () => {
    const paise = cash.trim() === '' ? 0 : parseRupees(cash);
    if (paise === null) return setError('Enter the cash in the drawer in rupees, like 2000.');
    setBusy(true); setError('');
    try { onOpened(await api.openShift(paise, key.current)); } catch (e) {
      if (e instanceof ApiError && e.code === 'SHIFT_ALREADY_OPEN') { const s = await api.currentShift(); if (s) return onOpened(s); }
      fail(e);
    } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center shadow-sm">
        <h2 className="font-display text-2xl">Open shift</h2>
        <p className="mb-4 mt-1 text-sm text-muted-foreground">Count the cash in the drawer before the first bill.</p>
        <input className="field w-full text-center text-lg" inputMode="decimal" placeholder="Opening cash ₹" aria-label="Opening cash in rupees" value={cash} onChange={(e) => setCash(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void open(); }} autoFocus />
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        <button className="btn-primary mt-4 w-full" disabled={busy} onClick={() => void open()}>{busy ? 'Opening…' : 'Open shift'}</button>
      </div>
    </div>
  );
}

function CloseShift({ onClose, onClosed }: { onClose: () => void; onClosed: () => void }) {
  const { api, fail, user } = useSession();
  const [cash, setCash] = useState('');
  const [error, setError] = useState('');
  const [openBills, setOpenBills] = useState<number | null>(null);
  const [report, setReport] = useState<ZReport | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const submit = async (discard: boolean) => {
    const counted = parseRupees(cash);
    if (counted === null) return setError('Enter the counted cash in rupees, like 5230.');
    setBusy(true); setError('');
    try {
      if (discard) key.current = newKey();
      setReport(await api.closeShift(counted, discard, key.current));
      onClosed();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OPEN_ORDERS_EXIST') { setOpenBills((e.details as { count?: number } | undefined)?.count ?? 1); key.current = newKey(); } else fail(e);
    } finally { setBusy(false); }
  };
  if (report) {
    const diff = report.cash.difference ?? 0;
    return (
      <Modal title="Shift closed" onClose={onClose}>
        <p className="mb-3 text-sm text-muted-foreground">The Z-report is queued for the receipt printer.</p>
        <div className="space-y-1 text-sm tabular-nums">
          <Row label="Bills" value={String(report.invoices)} />
          <Row label="Sales" value={formatPaise(report.sales)} />
          {Object.entries(report.byMode).map(([m, a]) => <Row key={m} label={m} value={formatPaise(a)} />)}
          <Row label="Expected cash" value={formatPaise(report.cash.expected)} />
          <Row label="Counted cash" value={formatPaise(report.cash.counted ?? 0)} />
          <div className={`flex justify-between font-semibold ${diff === 0 ? 'text-success' : 'text-destructive'}`}><span>Difference</span><span>{formatPaise(diff)}</span></div>
        </div>
        <button className="btn-primary mt-5 w-full" onClick={onClose}>Done</button>
      </Modal>
    );
  }
  return (
    <Modal title="Close shift" onClose={onClose}>
      <p className="mb-3 text-sm text-muted-foreground">Count the cash in the drawer. The difference against the expected amount is recorded.</p>
      <input className="field w-full text-lg" inputMode="decimal" placeholder="Counted cash ₹" aria-label="Counted cash in rupees" value={cash} onChange={(e) => setCash(e.target.value)} autoFocus />
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      {openBills !== null && (
        <div className="mt-3 rounded-lg border border-destructive/30 p-3 text-sm">
          {openBills} unfinished bill{openBills === 1 ? '' : 's'} on this counter. Finish {openBills === 1 ? 'it' : 'them'} first{user?.role === 'cashier' ? ', or ask a manager to discard them.' : ', or discard and close.'}
          {user?.role !== 'cashier' && <button className="btn-ghost mt-2 w-full text-destructive" disabled={busy} onClick={() => void submit(true)}>Discard unfinished bills and close</button>}
        </div>
      )}
      <button className="btn-primary mt-4 w-full" disabled={busy} onClick={() => void submit(false)}>{busy ? 'Closing…' : 'Close shift'}</button>
    </Modal>
  );
}

function PrintAlerts() {
  const { api } = useSession();
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [low, setLow] = useState<StockItem[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = useCallback(() => {
    api.failedPrintJobs().then((r) => setJobs(r.jobs)).catch(() => { /* shown elsewhere */ });
    api.stockItems(true).then(setLow).catch(() => { /* stock is optional */ });
  }, [api]);
  const count = jobs.length + low.length;
  useEffect(() => { refresh(); const t = setInterval(refresh, 20_000); return () => clearInterval(t); }, [refresh]);
  const retry = async (id: string) => { try { await api.retryPrintJob(id); } finally { refresh(); } };
  return (
    <div className="relative">
      <button className="relative flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card text-muted-foreground" aria-label={count ? `${count} notifications` : 'Notifications'} onClick={() => { setOpen((v) => !v); refresh(); }}>
        <Bell className="h-4 w-4" />
        {count > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">{count}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-40 w-80 rounded-xl border border-border bg-card p-3 text-sm shadow-xl">
          {low.length > 0 && (
            <div className="mb-2 border-b border-border pb-2">
              <p className="mb-1 font-medium">Stock needs attention</p>
              <ul className="space-y-0.5">
                {low.slice(0, 6).map((s) => <li key={s.id} className="flex justify-between gap-2 text-xs"><span className="truncate">{s.name}</span><span className="shrink-0 tabular-nums text-destructive">{formatStockQty(s.onHandMilli, s.unit)}</span></li>)}
              </ul>
              <a href="#/stock" className="mt-1 inline-block text-xs font-semibold text-primary">Open stock{low.length > 6 ? ` (${low.length - 6} more)` : ''}</a>
            </div>
          )}
          {jobs.length === 0 ? <p className="text-muted-foreground">All printing is up to date.</p> : (
            <ul className="space-y-2">
              {jobs.map((j) => (
                <li key={j.id} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1"><p className="font-medium">{j.kind === 'KOT' ? 'Kitchen ticket' : j.kind === 'RECEIPT' ? 'Receipt' : j.kind === 'TEST' ? 'Test page' : 'Report'}{j.invoiceNo ? ` for ${j.invoiceNo}` : ''}{j.tokenNo ? ` (token ${j.tokenNo})` : ''} did not print on {j.printerName}</p><p className="truncate text-xs text-muted-foreground" title={j.lastError ?? ''}>{j.lastError}</p></div>
                  <button className="btn-ghost h-8 px-2" onClick={() => void retry(j.id)} aria-label="Retry printing"><RotateCw className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function UserMenu({ shiftOpen, onCloseShift, onPanel }: { shiftOpen: boolean; onCloseShift: () => void; onPanel: (p: 'x' | 'drawer' | 'availability') => void }) {
  const { user, signOut } = useSession();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  const initials = user.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="relative">
      <button className="flex items-center gap-3" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <span className="hidden shrink-0 text-right sm:block"><span className="block text-sm font-semibold">{user.name}</span><span className="block text-xs capitalize text-muted-foreground">{user.role}</span></span>
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent font-semibold text-accent-foreground">{initials}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-40 w-60 rounded-xl border border-border bg-card p-1.5 text-sm shadow-xl" role="menu">
          {shiftOpen && <>
            <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left hover:bg-secondary" onClick={() => { setOpen(false); onPanel('availability'); }}><PackageX className="h-4 w-4" />Sold out today</button>
            <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left hover:bg-secondary" onClick={() => { setOpen(false); onPanel('x'); }}><ClipboardList className="h-4 w-4" />Shift report (X)</button>
            <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left hover:bg-secondary" onClick={() => { setOpen(false); onPanel('drawer'); }}><Inbox className="h-4 w-4" />Open cash drawer</button>
            <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left hover:bg-secondary" onClick={() => { setOpen(false); onCloseShift(); }}><Wallet className="h-4 w-4" />Close shift</button>
          </>}
          <button role="menuitem" className="flex w-full items-center gap-2 rounded-lg px-3 py-3 text-left hover:bg-secondary" onClick={() => void signOut()}><LogOut className="h-4 w-4" />Sign out</button>
        </div>
      )}
    </div>
  );
}


/** Menu tile picture: the item's photo, or its first letter (the prototype's fallback). */
function TilePhoto({ item }: { item: Item }) {
  const { api } = useSession();
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl bg-muted font-display text-4xl text-muted-foreground">
      {item.imageFile && !broken
        ? <img src={api.imageUrl(item.imageFile)} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="h-full w-full object-cover" />
        : item.name.charAt(0)}
    </div>
  );
}
