// Typed client for the backend's local API (docs/API.md).
// Every change carries an Idempotency-Key. One key is made per user action and reused for network
// retries and for the re-send after a manager approval, so a retry can never bill twice (RULES.md rule 3).

export type Role = 'owner' | 'manager' | 'cashier';
export interface LoginUser { id: string; name: string; role: Role; hasMobile: boolean }
/** Who is signing in: by mobile number, or by user id (unlocking after inactivity, or staff without a mobile number yet). */
export type LoginWith = { mobile: string } | { userId: string };
export interface Me { userId: string; role: Role; name: string }
/** Settings > Users (owner only). */
export interface Coupon {
  id: string; code: string; description: string | null; type: 'percent' | 'amount'; value: number; maxDiscount: number | null; minBill: number;
  validFrom: string | null; validTo: string | null; maxUses: number | null; active: boolean; uses: number;
  status: 'active' | 'off' | 'not_started' | 'expired' | 'used_up';
}
export type CouponInput = Omit<Coupon, 'id' | 'uses' | 'status'>;
export interface StaffUser { id: string; name: string; role: Role; mobile: string | null; active: boolean; locked: boolean; createdAt: number; you: boolean }
export interface Category { id: string; name: string; sortOrder: number; kitchenStation: string | null; itemCount: number }
export interface ImportPreview {
  rows: number;
  errors: Array<{ row: number; message: string }>;
  items: Array<{ name: string; category: string; newCategory: boolean; price: number; taxPercent: number; hsn: string | null; barcode: string | null; unit: string; isVeg: boolean | null }>;
  newCategories: string[];
}
export interface TaxGroup { id: string; name: string; rateBp: number; cessBp: number; priceIncludesTax: number }
export interface Item {
  id: string; categoryId: string | null; name: string; shortName: string | null; sku: string | null; barcode: string | null;
  hsnCode: string | null; taxGroupId: string; price: number; unit: string; isVeg: number | null; imageFile: string | null; description: string | null; modifierGroupIds: string[];
}
export interface Modifier { id: string; name: string; price: number }
export interface ModifierGroup { id: string; name: string; minSelect: number; maxSelect: number; modifiers: Modifier[] }
export interface Catalog { categories: Category[]; taxGroups: TaxGroup[]; items: Item[]; modifierGroups: ModifierGroup[] }
export interface Shift { id: string; openedAt: number; openingCash: number }
export type Discount = { type: 'percent' | 'amount'; value: number };
export interface Totals {
  grossTotal: number; discountTotal: number; taxableTotal: number; cgst: number; sgst: number; igst: number; cess: number;
  roundOff: number; grandTotal: number; itemCount: number;
}
export interface CartLine {
  id: string; itemId: string; name: string; unit: string; qtyMilli: number; unitPrice: number; discount: Discount | null;
  modifiers: Modifier[]; note: string | null; gross: number; discountApplied: number; taxable: number; rateBp: number;
  cgst: number; sgst: number; igst: number; cess: number; lineTotal: number;
}
export interface Order {
  id: string; status: 'DRAFT' | 'HELD' | 'INVOICED' | 'CANCELLED'; channel: string; tokenNo: number; customerPhone: string | null; customerName: string | null; note: string | null;
  placeOfSupply: string; buyerGstin: string | null; shiftId: string; createdAt: number; updatedAt: number; billDiscount: Discount | null; discountApproved: boolean;
  /** The coupon on this bill; problem = why it does not apply right now. */
  coupon: { code: string; description: string | null; problem: string | null } | null;
}
export interface Cart { order: Order; lines: CartLine[]; totals: Totals }
export interface OpenOrder {
  id: string; status: 'DRAFT' | 'HELD'; tokenNo: number; channel: string; updatedAt: number; createdAt: number; lineCount: number;
  customerPhone: string | null; customerName: string | null; note: string | null; createdByName: string | null; grandTotal: number;
}
export type PayMode = 'CASH' | 'UPI' | 'CARD' | 'WALLET' | 'CREDIT' | 'OTHER';
export interface PaymentIn { mode: PayMode; amount: number; tendered?: number | null; reference?: string | null }
export interface InvoiceSummary {
  id: string; invoiceNo: string; docType: 'TAX_INVOICE' | 'CREDIT_NOTE'; status: 'ISSUED' | 'CANCELLED'; issuedAt: number;
  grandTotal: number; tokenNo: number | null; originalInvoiceId: string | null; cashierName: string;
}
export interface InvoiceLine { id: string; lineNo: number; name: string; qtyMilli: number; unit: string; unitPrice: number; gross: number; discount: number; rateBp: number; lineTotal: number; modifiers: Modifier[] }
export interface Payment { id: string; mode: PayMode; amount: number; tendered: number | null; reference: string | null }
export interface Invoice extends InvoiceSummary {
  grossTotal: number; discountTotal: number; taxableTotal: number; cgst: number; sgst: number; igst: number; cess: number; roundOff: number;
  buyerGstin: string | null; placeOfSupply: string; cancelReason: string | null;
}
export interface InvoiceDetail { invoice: Invoice; lines: InvoiceLine[]; payments: Payment[] }
export type PrintWarning = 'NO_RECEIPT_PRINTER' | 'NO_KITCHEN_PRINTER';
export interface PrintSummary { receipts: number; kitchenTickets: number; warnings: PrintWarning[] }
export interface FinalizeResult extends InvoiceDetail { changeDue: number; print: PrintSummary }
export interface ZReport {
  shiftId: string; openedAt: number; closedAt: number | null; invoices: number; sales: number; discounts: number; cancelled: number;
  cancelledAmount: number; creditNotes: number; refunds: number; byMode: Record<string, number>;
  cash: { opening: number; net: number; expected: number; counted: number | null; difference: number | null };
}
/** The shop's uploaded bill design (Settings > Receipt). */
export interface ReceiptDesign { name: string; description: string | null; fileName: string; uploadedAt: number; uploadedBy: string }
export interface ReceiptDesignPreview { name: string; description: string | null; widthMm: number; cols: number; lines: string[] }
/** Settings > Store: the details printed on bills (from the database), and the bill logo. */
export interface StoreInfo { name: string; address: string | null; phone: string | null; gstin: string | null; fssaiNo: string | null; stateCode: string; logo: { width: number; height: number; updatedAt: number } | null }
export interface StoreInput { name: string; address: string | null; phone: string | null; gstin: string | null; fssaiNo: string | null }
/** Installed add-ons (GET /api/addons). `ui` is the script with their screens, when active. */
export interface AddonInfo { id: string; name: string; version: string; status: 'active' | 'off'; reason: string | null; hasUi: boolean; ui: string | null }
export interface ReportInfo { key: string; title: string; group: string; description: string; usesDates: boolean }
export type ReportColType = 'text' | 'money' | 'int' | 'qty' | 'date' | 'datetime';
export type ReportRow = Record<string, string | number | null>;
/** A report as the backend computed it (money in paise). The screen and the CSV show the same numbers. */
export interface ReportTable {
  key: string; title: string; description: string; from: string; to: string; generatedAt: number;
  columns: Array<{ key: string; label: string; type: ReportColType }>; rows: ReportRow[]; totals: ReportRow | null;
  summary: Array<{ label: string; value: number | string; type: ReportColType }>;
}
export interface PrintJob { id: string; kind: string; refId: string; printerId: string; printerName: string; invoiceNo: string | null; tokenNo: number | null; status: string; attempts: number; lastError: string | null; createdAt: number }
export type Transport = 'memory' | 'tcp' | 'file' | 'spooler' | 'serial' | 'usb' | 'android';
export interface DetectedPrinter { key: string; transport: 'usb' | 'spooler' | 'android'; address: string; name: string; detail: string; widthMm: 58 | 80 }
export interface UsbDevice extends DetectedPrinter { printerId: string | null; printerName: string | null; printerActive: boolean | null; dismissed: boolean }
export interface Printer {
  id: string; name: string; transport: Transport; address: string | null; widthMm: 58 | 80; profile: string; isReceipt: boolean; drawer: boolean; stations: string[]; active: boolean;
  stats: { queued: number; failed: number; lastError: string | null; lastPrintedAt: number | null };
}
export interface PrinterInput { name: string; transport: Transport; address: string | null; widthMm: 58 | 80; isReceipt: boolean; drawer: boolean; stations: string[]; active?: boolean; profile?: string }
export interface WindowsPrinter { name: string; port: string; driver: string; offline: boolean; connection: 'usb' | 'serial' | 'bluetooth' | 'network' | 'virtual' | 'other' }
export interface SerialPortInfo { port: string; name: string; bluetooth: boolean }
export interface InvoicePrintJob { id: string; kind: string; status: 'QUEUED' | 'SENDING' | 'PRINTED' | 'FAILED'; attempts: number; lastError: string | null; printerName: string; createdAt: number; updatedAt: number }
export interface ReceiptPreview { invoiceId: string; widthMm: number; cols: number; lines: string[] }
export interface PaymentCheck { total: number; paid: number; remaining: number; changeDue: number; ok: boolean; message: string | null }
export interface CreditOption { invoiceLineId: string; name: string; unit: string; soldQtyMilli: number; returnedQtyMilli: number; remainingQtyMilli: number; lineTotal: number }
export interface CreditPreview { lines: Array<{ invoiceLineId: string; name: string; qtyMilli: number; amount: number }>; roundOff: number; total: number }
export interface Override { userId: string; pin: string }
export interface BackupFile { file: string; bytes: number; kind: string; at: number }
export interface OnlineBackup { name: string; bytes: number; uploadedAt: number }
export interface CloudBackupStatus { connected: boolean; on: boolean; url: string | null; store: string | null; everyHours: number; lastAt: number | null; lastFile: string | null; error: string | null; busy: boolean }
export interface LastRestore { ok: boolean; at: number; label: string; error?: string; report?: { images: { missing: string[] }; journal: { replayed: number; errors: unknown[]; keptAside: boolean }; stockOk: boolean; aside: string | null } }
export interface BackupOverview {
  status: { lastBackupAt: number | null; ageHours: number | null; warn: boolean };
  files: BackupFile[];
  copy: { dir: string | null; lastAt: number | null; error: string | null; files: BackupFile[] };
  cloud: CloudBackupStatus; everyHoursChoices: number[]; lastRestore: LastRestore | null; canRestartItself: boolean;
}
export type RestoreSource = 'device' | 'folder' | 'online';
export interface ItemInput { name: string; categoryId: string | null; taxGroupId: string; price: number; isVeg: boolean | null; unit?: string; hsnCode?: string | null; shortName?: string | null; barcode?: string | null }
export interface SetupInput {
  outlet: { name: string; gstin: string | null; fssaiNo: string | null; stateCode: string; address: string | null; phone: string | null };
  device: { name: string; seriesPrefix: string };
  owner: { name: string; pin: string; mobile: string };
}

export type StockUnit = 'kg' | 'g' | 'l' | 'ml' | 'pcs';
export interface StockItem {
  id: string; name: string; unit: StockUnit; onHandMilli: number; reorderLevelMilli: number; lastUnitCost: number | null;
  valuePaise: number; low: boolean; negative: boolean; updatedAt: number;
}
export type MovementKind = 'OPENING' | 'PURCHASE' | 'PURCHASE_VOID' | 'SALE' | 'SALE_REVERSAL' | 'WASTAGE' | 'COUNT' | 'ADJUST';
export interface StockMovement { id: string; kind: MovementKind; deltaMilli: number; refType: string | null; refId: string | null; refNo: string | null; reason: string | null; unitCost: number | null; createdAt: number; userName: string | null }
export interface PurchaseLineIn { stockItemId: string; qtyMilli: number; unitCost: number }
export interface PurchasePreview { lines: Array<PurchaseLineIn & { name: string; unit: StockUnit; amount: number }>; total: number }
export interface Purchase {
  id: string; supplierName: string; supplierGstin: string | null; billNo: string | null; billDate: string | null; note: string | null;
  total: number; status: 'POSTED' | 'VOIDED'; createdBy: string; createdAt: number; voidedAt: number | null; voidReason: string | null;
}
export interface PurchaseSummary extends Purchase { lineCount: number; items: string }
export interface PurchaseDetail { purchase: Purchase & { createdByName: string | null }; lines: Array<PurchaseLineIn & { id: string; lineNo: number; amount: number; name: string; unit: StockUnit }> }
export interface RecipeLine { stockItemId: string; name: string; unit: StockUnit; qtyMilli: number }

export class ApiError extends Error {
  code: string; status: number; details: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message); this.code = code; this.status = status; this.details = details;
  }
}

/** Codes that mean the session is gone and the cashier must sign in (or unlock) again. */
export const AUTH_LOST = new Set(['UNAUTHENTICATED', 'SESSION_LOCKED']);

export const newKey = (): string => crypto.randomUUID();

export interface ApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  getToken: () => string | null;
  onAuthLost?: (code: string) => void;
  /** Network retries for changes, each with the same key. */
  retries?: number;
  retryDelayMs?: number;
}

export function createApi(o: ApiOptions) {
  const base = (o.baseUrl ?? '').replace(/\/$/, '');
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const retries = o.retries ?? 2;
  const delay = o.retryDelayMs ?? 400;

  async function request<T>(method: string, path: string, body?: unknown, key?: string): Promise<T> {
    const { text } = await send(method, path, body, key, 'application/json');
    try { return (text ? JSON.parse(text) : null) as T; } catch { return null as T; }
  }

  /** Sends the request (retrying on network failure) and turns an error response into an ApiError. */
  async function send(method: string, path: string, body: unknown, key: string | undefined, accept: string): Promise<{ res: Response; text: string }> {
    const headers: Record<string, string> = { Accept: accept };
    const token = o.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const attempts = method === 'GET' || key ? retries + 1 : 1;
    let res: Response | null = null;
    for (let i = 0; i < attempts && !res; i++) {
      try {
        res = await doFetch(`${base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch {
        if (i + 1 < attempts) await new Promise((r) => setTimeout(r, delay * (i + 1)));
      }
    }
    if (!res) throw new ApiError('NETWORK', 'Cannot reach the billing service. Check that it is running, then try again.', 0);
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON (proxy error page) */ }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      const e = err?.code
        ? new ApiError(err.code, err.message ?? 'Something went wrong.', res.status, err.details)
        : new ApiError('HTTP_' + res.status, res.status >= 500 ? 'The billing service is not responding. Check that it is running.' : 'Something went wrong. Please try again.', res.status);
      if (AUTH_LOST.has(e.code)) o.onAuthLost?.(e.code);
      throw e;
    }
    return { res, text };
  }
  const get = <T>(path: string) => request<T>('GET', path);
  const change = <T>(method: string, path: string, body: unknown = {}, key: string = newKey()) => request<T>(method, path, body, key);
  const enc = encodeURIComponent;

  return {
    request,
    // public
    ping: () => get<{ ok: boolean }>('/ping'),
    loginUsers: () => get<LoginUser[]>('/login-users'),
    setup: (input: SetupInput, key?: string) => change<{ ownerId: string }>('POST', '/setup', input, key),
    login: (who: LoginWith, pin: string) => request<{ token: string; user: Me }>('POST', '/auth/login', { ...who, pin }),
    logout: () => request<{ ok: boolean }>('POST', '/auth/logout', {}),
    me: () => get<Me>('/me'),
    // catalog
    catalog: () => get<Catalog>('/catalog'),
    createItem: (input: ItemInput, key?: string) => change<Item>('POST', '/items', input, key),
    deleteItem: (id: string, key?: string) => change<{ ok: boolean }>('DELETE', `/items/${enc(id)}`, {}, key),
    updateItem: (id: string, input: Partial<ItemInput>, key?: string) => change<{ id: string }>('PATCH', `/items/${enc(id)}`, input, key),
    setItemImage: (id: string, dataBase64: string, key?: string) => change<{ itemId: string; imageFile: string }>('PUT', `/items/${enc(id)}/image`, { dataBase64 }, key),
    removeItemImage: (id: string, key?: string) => change<{ itemId: string; imageFile: null }>('DELETE', `/items/${enc(id)}/image`, {}, key),
    /** URL for an <img>. Photos are served without sign-in, by their stored name only. */
    imageUrl: (file: string) => `${base}/api/images/${enc(file)}`,
    createCategory: (input: { name: string; kitchenStation: string | null }, key?: string) => change<{ id: string }>('POST', '/categories', input, key),
    updateCategory: (id: string, input: { name?: string; kitchenStation?: string | null }, key?: string) => change<{ id: string }>('PATCH', `/categories/${enc(id)}`, input, key),
    deleteCategory: (id: string, key?: string) => change<{ id: string }>('DELETE', `/categories/${enc(id)}`, {}, key),
    reorderCategories: (ids: string[], key?: string) => change<{ ids: string[] }>('PUT', '/categories/order', { ids }, key),
    previewImport: (csv: string) => request<ImportPreview>('POST', '/items/import/preview', { csv }),
    importItems: (csv: string, key?: string) => change<{ imported: number; categoriesCreated: number }>('POST', '/items/import', { csv }, key),
    printers: () => get<Printer[]>('/printers'),
    createPrinter: (input: PrinterInput, key?: string) => change<{ id: string }>('POST', '/printers', input, key),
    updatePrinter: (id: string, input: Partial<PrinterInput>, key?: string) => change<{ id: string; released: number }>('PATCH', `/printers/${enc(id)}`, input, key),
    deletePrinter: (id: string, key?: string) => change<{ id: string; removed: boolean; deactivated: boolean }>('DELETE', `/printers/${enc(id)}`, {}, key),
    testPrint: (id: string, key?: string) => change<{ jobId: string | null }>('POST', `/printers/${enc(id)}/test`, {}, key),
    windowsPrinters: () => get<WindowsPrinter[]>('/printers/windows'),
    detectedPrinters: () => get<DetectedPrinter[]>('/printers/detected'),
    usbDevices: (refresh = false) => get<{ scannedAt: number | null; devices: UsbDevice[] }>(`/printers/usb-devices${refresh ? '?refresh=1' : ''}`),
    sampleReceipt: (widthMm: 58 | 80) => get<{ widthMm: number; cols: number; lines: string[] }>(`/printers/sample-receipt?width=${widthMm}`),
    addons: () => get<AddonInfo[]>('/addons'),
    users: () => get<StaffUser[]>('/users'),
    createUser: (input: { name: string; role: Role; pin: string; mobile: string }, key?: string) => change<{ id: string; name: string; role: Role }>('POST', '/users', input, key),
    updateUser: (id: string, input: { name: string; role: Role; mobile: string }, key?: string) => change<{ id: string; name: string; role: Role }>('PATCH', '/users/' + enc(id), input, key),
    resetPin: (id: string, newPin: string, key?: string) => change<{ ok: boolean }>('POST', '/users/' + enc(id) + '/pin', { newPin }, key),
    changeOwnPin: (id: string, currentPin: string, newPin: string, key?: string) => change<{ ok: boolean }>('POST', '/users/' + enc(id) + '/pin', { newPin, currentPin }, key),
    deactivateUser: (id: string, key?: string) => change<{ ok: boolean }>('POST', '/users/' + enc(id) + '/deactivate', {}, key),
    reactivateUser: (id: string, key?: string) => change<{ ok: boolean }>('POST', '/users/' + enc(id) + '/reactivate', {}, key),
    store: () => get<StoreInfo>('/store'),
    saveStore: (input: StoreInput, key?: string) => change<StoreInput & { changed: string[] }>('PUT', '/store', input, key),
    setLogo: (logo: { width: number; height: number; bitsBase64: string }, key?: string) => change<{ width: number; height: number; updatedAt: number }>('PUT', '/store/logo', logo, key),
    clearLogo: (key?: string) => change<{ logo: null }>('DELETE', '/store/logo', {}, key),
    /** The logo as the printer prints it; no sign-in needed (an <img> cannot send the token). */
    logoUrl: (version?: number) => `${base}/api/store/logo.png${version ? `?v=${version}` : ''}`,
    receiptDesign: () => get<{ active: ReceiptDesign | null; extension: string }>('/receipt-design'),
    previewReceiptDesign: (fileName: string, content: string, widthMm: 58 | 80) => request<ReceiptDesignPreview>('POST', '/receipt-design/preview', { fileName, content, widthMm }),
    setReceiptDesign: (fileName: string, content: string, key?: string) => change<{ active: ReceiptDesign }>('PUT', '/receipt-design', { fileName, content }, key),
    clearReceiptDesign: (key?: string) => change<{ active: null }>('DELETE', '/receipt-design', {}, key),
    printSample: (id: string, key?: string) => change<{ jobId: string | null }>('POST', `/printers/${enc(id)}/sample`, {}, key),
    testDrawer: (id: string, key?: string) => change<{ jobId: string | null }>('POST', `/printers/${enc(id)}/drawer`, {}, key),
    retryFailed: (id: string) => request<{ printerId: string; requeued: number }>('POST', `/printers/${enc(id)}/retry-failed`, {}),
    // Settings > Backups (owner)
    backupOverview: () => get<BackupOverview>('/backup/overview'),
    backupNow: () => request<{ file: string }>('POST', '/backup', {}),
    setBackupCopyFolder: (dir: string | null) => request<BackupOverview>('PUT', '/backup/copy', { dir }),
    copyBackupNow: () => request<BackupOverview>('POST', '/backup/copy/now', {}),
    backupsInFolder: (path: string) => get<{ folder: string; files: BackupFile[] }>(`/backup/folder?path=${enc(path)}`),
    pairCloudBackup: (url: string, code: string) => request<BackupOverview>('POST', '/backup/cloud/pair', { url, code }),
    setCloudBackup: (o: { on?: boolean; everyHours?: number }) => request<BackupOverview>('PATCH', '/backup/cloud', o),
    disconnectCloudBackup: () => request<BackupOverview>('DELETE', '/backup/cloud', {}),
    cloudBackupNow: () => request<BackupOverview>('POST', '/backup/cloud/now', {}),
    onlineBackups: () => get<{ backups: OnlineBackup[] }>('/backup/cloud/list'),
    restoreBackup: (source: RestoreSource, name: string, pin: string, folder?: string) => request<{ restarting: boolean }>('POST', '/restore', { source, name, pin, ...(folder ? { folder } : {}) }),
    dismissRestore: () => request<{ ok: boolean }>('POST', '/restore/dismiss', {}),
    settings: () => get<Record<string, string>>('/settings'),
    saveSettings: (values: Record<string, string>, key?: string) => change<Record<string, string>>('PUT', '/settings', values, key),
    dismissDetected: (key: string) => change<{ key: string }>('POST', '/printers/detected/dismiss', { key }),
    quickAddPrinter: (key: string, override?: Override, idem?: string) => change<{ printerId: string; name: string; isReceipt: boolean; testJobId: string | null }>('POST', '/printers/quick-add', override ? { key, override } : { key }, idem),
    serialPorts: () => get<SerialPortInfo[]>('/printers/serial-ports'),
    discoverPrinters: (port?: number) => request<{ scanned: number; port: number; found: Array<{ host: string; address: string }> }>('POST', '/printers/discover', port ? { port } : {}),
    // shifts
    currentShift: () => get<Shift | null>('/shifts/current'),
    openShift: (openingCash: number, key?: string) => change<Shift>('POST', '/shifts/open', { openingCash }, key),
    closeShift: (countedCash: number, discardOpenOrders: boolean, key?: string) => change<ZReport>('POST', '/shifts/close', { countedCash, discardOpenOrders }, key),
    // orders
    openOrders: (status?: 'DRAFT' | 'HELD') => get<OpenOrder[]>(`/orders${status ? `?status=${status}` : ''}`),
    holdOrder: (orderId: string, key?: string) => change<Cart>('POST', `/orders/${enc(orderId)}/hold`, {}, key),
    resumeOrder: (orderId: string, key?: string) => change<Cart>('POST', `/orders/${enc(orderId)}/resume`, {}, key),
    updateOrder: (orderId: string, input: { customerPhone?: string | null; customerName?: string | null; note?: string | null }, override?: Override, key?: string) => change<Cart>('PATCH', `/orders/${enc(orderId)}`, override ? { ...input, override } : input, key),
    checkPayments: (orderId: string, payments: PaymentIn[]) => request<PaymentCheck>('POST', `/orders/${enc(orderId)}/payment-check`, { payments }),
    createOrder: (key?: string) => change<Cart>('POST', '/orders', {}, key),
    getOrder: (id: string) => get<Cart>(`/orders/${enc(id)}`),
    addLine: (orderId: string, itemId: string, modifierIds: string[] = [], key?: string) =>
      change<Cart>('POST', `/orders/${enc(orderId)}/lines`, modifierIds.length ? { itemId, qtyMilli: 1000, modifierIds } : { itemId, qtyMilli: 1000 }, key),
    setLineQty: (lineId: string, qtyMilli: number, key?: string, override?: Override) => change<Cart>('PATCH', `/lines/${enc(lineId)}`, override ? { qtyMilli, override } : { qtyMilli }, key),
    removeLine: (lineId: string, override?: Override, key?: string) => change<Cart>('DELETE', `/lines/${enc(lineId)}`, override ? { override } : {}, key),
    billDiscount: (orderId: string, discount: Discount | null, override?: Override, key?: string) =>
      change<Cart>('POST', `/orders/${enc(orderId)}/discount`, override ? { discount, override } : { discount }, key),
    applyCoupon: (orderId: string, code: string, key?: string) => change<Cart>('POST', `/orders/${enc(orderId)}/coupon`, { code }, key),
    removeCoupon: (orderId: string, key?: string) => change<Cart>('DELETE', `/orders/${enc(orderId)}/coupon`, {}, key),
    coupons: () => get<Coupon[]>('/coupons'),
    createCoupon: (c: CouponInput, key?: string) => change<Coupon>('POST', '/coupons', c, key),
    updateCoupon: (id: string, c: CouponInput, key?: string) => change<Coupon>('PUT', `/coupons/${enc(id)}`, c, key),
    cancelOrder: (orderId: string, key?: string) => change<Cart>('POST', `/orders/${enc(orderId)}/cancel`, {}, key),
    finalize: (orderId: string, payments: PaymentIn[], key?: string) => change<FinalizeResult>('POST', `/orders/${enc(orderId)}/finalize`, { payments }, key),
    // invoices
    invoices: (q: { fromMs?: number; toMs?: number; limit?: number } = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
      return get<InvoiceSummary[]>(`/invoices${p.size ? `?${p}` : ''}`);
    },
    invoice: (id: string) => get<InvoiceDetail>(`/invoices/${enc(id)}`),
    reprint: (id: string, override?: Override, key?: string) => change<{ queued: number; copyNo: number }>('POST', `/invoices/${enc(id)}/reprint`, override ? { override } : {}, key),
    receiptPreview: (id: string, widthMm: 58 | 80 = 80) => get<ReceiptPreview>(`/invoices/${enc(id)}/receipt?width=${widthMm}`),
    invoicePrints: (id: string) => get<InvoicePrintJob[]>(`/invoices/${enc(id)}/prints`),
    cancelInvoice: (id: string, reason: string, override?: Override, key?: string) => change<{ id: string; status: 'CANCELLED' }>('POST', `/invoices/${enc(id)}/cancel`, override ? { reason, override } : { reason }, key),
    creditOptions: (id: string) => get<{ invoiceId: string; lines: CreditOption[] }>(`/invoices/${enc(id)}/credit-note`),
    previewCredit: (id: string, lines: Array<{ invoiceLineId: string; qtyMilli: number }>) => request<CreditPreview>('POST', `/invoices/${enc(id)}/credit-note/preview`, { lines }),
    createCredit: (id: string, input: { lines: Array<{ invoiceLineId: string; qtyMilli: number }>; reason: string; refunds: PaymentIn[] }, override?: Override, key?: string) =>
      change<FinalizeResult>('POST', `/invoices/${enc(id)}/credit-note`, override ? { ...input, override } : input, key),
    // inventory
    stockItems: (lowOnly = false) => get<StockItem[]>(`/stock/items${lowOnly ? '?low=1' : ''}`),
    createStockItem: (input: { name: string; unit: StockUnit; reorderLevelMilli: number; openingQtyMilli: number; openingUnitCost: number | null }, key?: string) => change<StockItem>('POST', '/stock/items', input, key),
    updateStockItem: (id: string, input: { name?: string; reorderLevelMilli?: number }, key?: string) => change<StockItem>('PATCH', `/stock/items/${enc(id)}`, input, key),
    deleteStockItem: (id: string, key?: string) => change<{ ok: boolean }>('DELETE', `/stock/items/${enc(id)}`, {}, key),
    adjustStock: (id: string, input: { kind: 'WASTAGE' | 'COUNT' | 'ADJUST'; qtyMilli: number; reason: string | null }, key?: string) => change<StockItem>('POST', `/stock/items/${enc(id)}/adjust`, input, key),
    movements: (id: string, limit = 100) => get<StockMovement[]>(`/stock/items/${enc(id)}/movements?limit=${limit}`),
    previewPurchase: (lines: PurchaseLineIn[]) => request<PurchasePreview>('POST', '/purchases/preview', { lines }),
    purchases: (limit = 100) => get<PurchaseSummary[]>(`/purchases?limit=${limit}`),
    purchase: (id: string) => get<PurchaseDetail>(`/purchases/${enc(id)}`),
    createPurchase: (input: { supplierName: string; supplierGstin: string | null; billNo: string | null; billDate: string | null; note: string | null; lines: PurchaseLineIn[] }, key?: string) => change<PurchaseDetail>('POST', '/purchases', input, key),
    voidPurchase: (id: string, reason: string, key?: string) => change<PurchaseDetail>('POST', `/purchases/${enc(id)}/void`, { reason }, key),
    recipes: () => get<Array<{ itemId: string; lines: number }>>('/recipes'),
    recipe: (itemId: string) => get<RecipeLine[]>(`/recipes/${enc(itemId)}`),
    setRecipe: (itemId: string, lines: Array<{ stockItemId: string; qtyMilli: number }>, key?: string) => change<RecipeLine[]>('PUT', `/recipes/${enc(itemId)}`, { lines }, key),
    // reports
    reportCatalog: () => get<ReportInfo[]>('/reports/catalog'),
    report: (key: string, from: string, to: string) => get<ReportTable>(`/reports/view/${enc(key)}?from=${enc(from)}&to=${enc(to)}`),
    /** The report as a CSV file for Excel (named by the backend). */
    reportCsv: async (key: string, from: string, to: string) => {
      const { res, text } = await send('GET', `/reports/csv/${enc(key)}?from=${enc(from)}&to=${enc(to)}`, undefined, undefined, 'text/csv');
      const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${key}_${from}_to_${to}.csv`;
      return { filename, csv: text };
    },
    // printing
    failedPrintJobs: () => get<{ counts: Record<string, number>; jobs: PrintJob[] }>('/print/jobs?status=FAILED'),
    health: () => get<{ ok: boolean; warnings: string[] }>('/health'),
    retryPrintJob: (id: string) => request<{ ok: boolean }>('POST', `/print/jobs/${enc(id)}/retry`, {}),
  };
}

export type Api = ReturnType<typeof createApi>;
