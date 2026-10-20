export interface Migration {
  version: number; name: string; sql: string;
  /** Table rebuilds: run with foreign keys off, then PRAGMA foreign_key_check must be clean before commit. */
  foreignKeysOff?: boolean;
}

// Conventions: ids are UUIDv7 TEXT, money is INTEGER paise, quantity is INTEGER thousandths,
// rates are basis points, times are epoch milliseconds UTC.
const V1 = `
CREATE TABLE outlet (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, gstin TEXT, fssai_no TEXT,
  state_code TEXT NOT NULL, address TEXT, phone TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE device (
  id TEXT PRIMARY KEY, outlet_id TEXT NOT NULL REFERENCES outlet(id), name TEXT NOT NULL,
  series_prefix TEXT NOT NULL CHECK (length(series_prefix) BETWEEN 1 AND 2),
  created_at INTEGER NOT NULL
);
CREATE TABLE app_user (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
  pin_hash TEXT NOT NULL, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER,
  active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE tax_group (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  rate_bp INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  cess_bp INTEGER NOT NULL DEFAULT 0 CHECK (cess_bp BETWEEN 0 AND 10000),
  price_includes_tax INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE category (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
  kitchen_station TEXT, version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE item (
  id TEXT PRIMARY KEY, category_id TEXT REFERENCES category(id),
  name TEXT NOT NULL, short_name TEXT, sku TEXT, barcode TEXT, hsn_code TEXT,
  tax_group_id TEXT NOT NULL REFERENCES tax_group(id),
  price INTEGER NOT NULL CHECK (price >= 0), unit TEXT NOT NULL DEFAULT 'pcs',
  is_veg INTEGER, image_file TEXT, active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX item_barcode ON item(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX item_category ON item(category_id);
-- Own-content FTS table (not external-content), so VACUUM cannot desynchronise rowids.
CREATE VIRTUAL TABLE item_fts USING fts5(item_id UNINDEXED, name, short_name, sku);
CREATE TRIGGER item_fts_ai AFTER INSERT ON item BEGIN
  INSERT INTO item_fts(item_id, name, short_name, sku) VALUES (new.id, new.name, new.short_name, new.sku);
END;
CREATE TRIGGER item_fts_au AFTER UPDATE OF name, short_name, sku ON item BEGIN
  DELETE FROM item_fts WHERE item_id = old.id;
  INSERT INTO item_fts(item_id, name, short_name, sku) VALUES (new.id, new.name, new.short_name, new.sku);
END;
CREATE TRIGGER item_fts_ad AFTER DELETE ON item BEGIN
  DELETE FROM item_fts WHERE item_id = old.id;
END;

CREATE TABLE modifier_group (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  min_select INTEGER NOT NULL DEFAULT 0, max_select INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE modifier (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES modifier_group(id),
  name TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE item_modifier_group (
  item_id TEXT NOT NULL REFERENCES item(id), group_id TEXT NOT NULL REFERENCES modifier_group(id),
  PRIMARY KEY (item_id, group_id)
);

CREATE TABLE shift (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  user_id TEXT NOT NULL REFERENCES app_user(id),
  opened_at INTEGER NOT NULL, closed_at INTEGER, closed_by TEXT REFERENCES app_user(id),
  opening_cash INTEGER NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  expected_cash INTEGER, counted_cash INTEGER
);
CREATE UNIQUE INDEX shift_one_open_per_device ON shift(device_id) WHERE closed_at IS NULL;

CREATE TABLE sale_order (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  shift_id TEXT REFERENCES shift(id),
  channel TEXT NOT NULL DEFAULT 'COUNTER', external_id TEXT, token_no INTEGER,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','HELD','INVOICED','CANCELLED')),
  customer_phone TEXT, note TEXT, place_of_supply TEXT, buyer_gstin TEXT,
  bill_discount_type TEXT CHECK (bill_discount_type IN ('amount','percent')),
  bill_discount_value INTEGER, discount_approved_by TEXT REFERENCES app_user(id), discount_approved_bp INTEGER,
  created_by TEXT REFERENCES app_user(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX order_external ON sale_order(channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX order_status ON sale_order(status);
CREATE TABLE sale_order_line (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES sale_order(id),
  item_id TEXT NOT NULL REFERENCES item(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
  disc_type TEXT CHECK (disc_type IN ('amount','percent')), disc_value INTEGER,
  modifiers_json TEXT NOT NULL DEFAULT '[]', note TEXT, sort_no INTEGER NOT NULL
);
CREATE INDEX order_line_order ON sale_order_line(order_id);
-- Defence in depth: lines of a finalized or cancelled order can never change.
CREATE TRIGGER sol_guard_ins BEFORE INSERT ON sale_order_line
  WHEN (SELECT status FROM sale_order WHERE id = NEW.order_id) NOT IN ('DRAFT','HELD')
  BEGIN SELECT RAISE(ABORT, 'order is not open'); END;
CREATE TRIGGER sol_guard_upd BEFORE UPDATE ON sale_order_line
  WHEN (SELECT status FROM sale_order WHERE id = OLD.order_id) NOT IN ('DRAFT','HELD')
  BEGIN SELECT RAISE(ABORT, 'order is not open'); END;
CREATE TRIGGER sol_guard_del BEFORE DELETE ON sale_order_line
  WHEN (SELECT status FROM sale_order WHERE id = OLD.order_id) NOT IN ('DRAFT','HELD')
  BEGIN SELECT RAISE(ABORT, 'order is not open'); END;

CREATE TABLE token_counter (
  device_id TEXT NOT NULL REFERENCES device(id), day TEXT NOT NULL, last_no INTEGER NOT NULL,
  PRIMARY KEY (device_id, day)
);

CREATE TABLE invoice_series (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('TAX_INVOICE','CREDIT_NOTE')),
  fy TEXT NOT NULL, prefix TEXT NOT NULL, next_no INTEGER NOT NULL DEFAULT 1 CHECK (next_no >= 1),
  UNIQUE (device_id, doc_type, fy)
);
CREATE TABLE invoice (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES sale_order(id),
  device_id TEXT NOT NULL REFERENCES device(id), shift_id TEXT REFERENCES shift(id),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('TAX_INVOICE','CREDIT_NOTE')),
  series_id TEXT NOT NULL REFERENCES invoice_series(id),
  seq_no INTEGER NOT NULL, invoice_no TEXT NOT NULL, issued_at INTEGER NOT NULL,
  buyer_gstin TEXT, place_of_supply TEXT NOT NULL, token_no INTEGER,
  gross_total INTEGER NOT NULL CHECK (gross_total >= 0),
  discount_total INTEGER NOT NULL CHECK (discount_total >= 0),
  taxable_total INTEGER NOT NULL CHECK (taxable_total >= 0),
  cgst INTEGER NOT NULL CHECK (cgst >= 0), sgst INTEGER NOT NULL CHECK (sgst >= 0),
  igst INTEGER NOT NULL CHECK (igst >= 0), cess INTEGER NOT NULL CHECK (cess >= 0),
  round_off INTEGER NOT NULL, grand_total INTEGER NOT NULL CHECK (grand_total >= 0),
  status TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','CANCELLED')),
  cancel_reason TEXT, cancelled_at INTEGER, cancelled_by TEXT REFERENCES app_user(id),
  original_invoice_id TEXT REFERENCES invoice(id),
  created_by TEXT NOT NULL REFERENCES app_user(id),
  UNIQUE (series_id, seq_no), UNIQUE (invoice_no)
);
CREATE UNIQUE INDEX invoice_one_per_order ON invoice(order_id) WHERE doc_type = 'TAX_INVOICE';
CREATE INDEX invoice_issued ON invoice(issued_at);
CREATE INDEX invoice_original ON invoice(original_invoice_id) WHERE original_invoice_id IS NOT NULL;
CREATE INDEX invoice_shift ON invoice(shift_id);
CREATE TABLE invoice_line (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoice(id),
  line_no INTEGER NOT NULL, item_id TEXT, source_line_id TEXT REFERENCES invoice_line(id),
  name TEXT NOT NULL, hsn_code TEXT, qty_milli INTEGER NOT NULL CHECK (qty_milli > 0), unit TEXT NOT NULL,
  unit_price INTEGER NOT NULL, gross INTEGER NOT NULL, discount INTEGER NOT NULL,
  taxable INTEGER NOT NULL, rate_bp INTEGER NOT NULL,
  cgst INTEGER NOT NULL, sgst INTEGER NOT NULL, igst INTEGER NOT NULL, cess INTEGER NOT NULL,
  line_total INTEGER NOT NULL, modifiers_json TEXT NOT NULL DEFAULT '[]', note TEXT
);
CREATE INDEX invoice_line_invoice ON invoice_line(invoice_id);
CREATE INDEX invoice_line_source ON invoice_line(source_line_id) WHERE source_line_id IS NOT NULL;
CREATE TABLE payment (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoice(id),
  mode TEXT NOT NULL CHECK (mode IN ('CASH','UPI','CARD','WALLET','CREDIT','OTHER')),
  amount INTEGER NOT NULL CHECK (amount > 0), tendered INTEGER, reference TEXT,
  shift_id TEXT REFERENCES shift(id), created_at INTEGER NOT NULL
);
CREATE INDEX payment_invoice ON payment(invoice_id);
CREATE INDEX payment_shift ON payment(shift_id);

-- Finalized documents are immutable. Only status/cancel fields may change, and never back from CANCELLED.
CREATE TRIGGER invoice_immutable BEFORE UPDATE OF
  order_id, device_id, shift_id, doc_type, series_id, seq_no, invoice_no, issued_at, buyer_gstin,
  place_of_supply, token_no, gross_total, discount_total, taxable_total, cgst, sgst, igst, cess,
  round_off, grand_total, original_invoice_id, created_by ON invoice
  BEGIN SELECT RAISE(ABORT, 'invoice is immutable'); END;
CREATE TRIGGER invoice_no_uncancel BEFORE UPDATE OF status ON invoice
  WHEN OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED'
  BEGIN SELECT RAISE(ABORT, 'a cancelled invoice cannot be reinstated'); END;
CREATE TRIGGER invoice_no_delete BEFORE DELETE ON invoice
  BEGIN SELECT RAISE(ABORT, 'invoices cannot be deleted'); END;
CREATE TRIGGER invoice_line_no_update BEFORE UPDATE ON invoice_line
  BEGIN SELECT RAISE(ABORT, 'invoice lines are immutable'); END;
CREATE TRIGGER invoice_line_no_delete BEFORE DELETE ON invoice_line
  BEGIN SELECT RAISE(ABORT, 'invoice lines cannot be deleted'); END;
CREATE TRIGGER payment_no_update BEFORE UPDATE ON payment
  BEGIN SELECT RAISE(ABORT, 'payments are immutable'); END;
CREATE TRIGGER payment_no_delete BEFORE DELETE ON payment
  BEGIN SELECT RAISE(ABORT, 'payments cannot be deleted'); END;

CREATE TABLE printer (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('memory','tcp','file','spooler')),
  address TEXT, width_mm INTEGER NOT NULL DEFAULT 80 CHECK (width_mm IN (58, 80)),
  profile TEXT NOT NULL DEFAULT 'generic', raster INTEGER NOT NULL DEFAULT 0,
  is_receipt INTEGER NOT NULL DEFAULT 0, drawer INTEGER NOT NULL DEFAULT 0,
  stations TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE print_job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('RECEIPT','KOT','REPORT','TEST')),
  ref_id TEXT, printer_id TEXT NOT NULL REFERENCES printer(id), payload BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','SENDING','PRINTED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX print_job_queue ON print_job(printer_id, status, next_attempt_at);

CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  entity TEXT NOT NULL, entity_id TEXT NOT NULL, op TEXT NOT NULL,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER
);
CREATE INDEX outbox_unsent ON outbox(sent_at) WHERE sent_at IS NULL;
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT,
  action TEXT NOT NULL, entity TEXT, entity_id TEXT, detail TEXT,
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE daily_summary (
  day TEXT NOT NULL, device_id TEXT NOT NULL,
  invoices INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0, credit_notes INTEGER NOT NULL DEFAULT 0,
  sales_total INTEGER NOT NULL DEFAULT 0, refund_total INTEGER NOT NULL DEFAULT 0,
  tax_total INTEGER NOT NULL DEFAULT 0, discount_total INTEGER NOT NULL DEFAULT 0,
  cash INTEGER NOT NULL DEFAULT 0, upi INTEGER NOT NULL DEFAULT 0, card INTEGER NOT NULL DEFAULT 0,
  other INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, device_id)
);
CREATE TABLE command_log (
  request_id TEXT PRIMARY KEY, command TEXT NOT NULL, actor_id TEXT,
  result_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

// Inventory (raw materials). Quantities are INTEGER thousandths of the material's unit (1.5 kg = 1500).
// Costs are INTEGER paise per whole unit (per kg, per L, per piece). The ledger (stock_movement) is
// append-only; stock_item.on_hand_milli is a cache of its sum, verified by verifyStock().
const V2 = `
CREATE TABLE stock_item (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('kg','g','l','ml','pcs')),
  on_hand_milli INTEGER NOT NULL DEFAULT 0,
  reorder_level_milli INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level_milli >= 0),
  last_unit_cost INTEGER CHECK (last_unit_cost IS NULL OR last_unit_cost >= 0),
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE UNIQUE INDEX stock_item_name ON stock_item(lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER stock_item_unit_fixed BEFORE UPDATE OF unit ON stock_item WHEN OLD.unit <> NEW.unit
  BEGIN SELECT RAISE(ABORT, 'the unit of a stock item cannot change'); END;

CREATE TABLE stock_movement (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  stock_item_id TEXT NOT NULL REFERENCES stock_item(id),
  delta_milli INTEGER NOT NULL CHECK (delta_milli <> 0),
  kind TEXT NOT NULL CHECK (kind IN ('OPENING','PURCHASE','PURCHASE_VOID','SALE','SALE_REVERSAL','WASTAGE','COUNT','ADJUST')),
  ref_type TEXT, ref_id TEXT, reason TEXT, unit_cost INTEGER,
  created_by TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX stock_movement_item ON stock_movement(stock_item_id, seq);
CREATE INDEX stock_movement_ref ON stock_movement(ref_type, ref_id);
CREATE TRIGGER stock_movement_no_update BEFORE UPDATE ON stock_movement
  BEGIN SELECT RAISE(ABORT, 'stock movements are immutable'); END;
CREATE TRIGGER stock_movement_no_delete BEFORE DELETE ON stock_movement
  BEGIN SELECT RAISE(ABORT, 'stock movements cannot be deleted'); END;

CREATE TABLE purchase (
  id TEXT PRIMARY KEY, supplier_name TEXT NOT NULL, supplier_gstin TEXT, bill_no TEXT, bill_date TEXT,
  note TEXT, total INTEGER NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL CHECK (status IN ('POSTED','VOIDED')),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  voided_at INTEGER, voided_by TEXT, void_reason TEXT
);
CREATE INDEX purchase_created ON purchase(created_at);
CREATE TABLE purchase_line (
  id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchase(id), line_no INTEGER NOT NULL,
  stock_item_id TEXT NOT NULL REFERENCES stock_item(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  unit_cost INTEGER NOT NULL CHECK (unit_cost >= 0),
  amount INTEGER NOT NULL CHECK (amount >= 0)
);
CREATE INDEX purchase_line_purchase ON purchase_line(purchase_id);
-- A posted purchase is a record of what was bought: only the void fields may change, once.
CREATE TRIGGER purchase_immutable BEFORE UPDATE OF supplier_name, supplier_gstin, bill_no, bill_date, note, total, created_by, created_at ON purchase
  BEGIN SELECT RAISE(ABORT, 'purchases are immutable; void and re-enter instead'); END;
CREATE TRIGGER purchase_no_unvoid BEFORE UPDATE OF status ON purchase WHEN OLD.status = 'VOIDED'
  BEGIN SELECT RAISE(ABORT, 'a voided purchase cannot be reinstated'); END;
CREATE TRIGGER purchase_no_delete BEFORE DELETE ON purchase BEGIN SELECT RAISE(ABORT, 'purchases cannot be deleted'); END;
CREATE TRIGGER purchase_line_no_update BEFORE UPDATE ON purchase_line BEGIN SELECT RAISE(ABORT, 'purchase lines are immutable'); END;
CREATE TRIGGER purchase_line_no_delete BEFORE DELETE ON purchase_line BEGIN SELECT RAISE(ABORT, 'purchase lines cannot be deleted'); END;

-- Recipe: how much of each material ONE unit of a menu item uses (thousandths of the material's unit).
CREATE TABLE recipe_line (
  item_id TEXT NOT NULL REFERENCES item(id), stock_item_id TEXT NOT NULL REFERENCES stock_item(id),
  qty_milli INTEGER NOT NULL CHECK (qty_milli > 0),
  PRIMARY KEY (item_id, stock_item_id)
);
CREATE INDEX recipe_line_stock ON recipe_line(stock_item_id);
`;

// Bluetooth printers: a paired Bluetooth (SPP) printer is a COM port on Windows, so printers gain a 'serial' transport.
// SQLite cannot change a CHECK constraint in place, so this rebuilds the table with the documented 12-step
// procedure (https://sqlite.org/lang_altertable.html#otheralter). The runner turns foreign keys off around it and
// runs PRAGMA foreign_key_check before committing (see foreignKeysOff). printer has no indexes, triggers or views.
const V3 = `
CREATE TABLE printer_new (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('memory','tcp','file','spooler','serial')),
  address TEXT, width_mm INTEGER NOT NULL DEFAULT 80 CHECK (width_mm IN (58, 80)),
  profile TEXT NOT NULL DEFAULT 'generic', raster INTEGER NOT NULL DEFAULT 0,
  is_receipt INTEGER NOT NULL DEFAULT 0, drawer INTEGER NOT NULL DEFAULT 0,
  stations TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
INSERT INTO printer_new (id, name, transport, address, width_mm, profile, raster, is_receipt, drawer, stations, active, created_at)
  SELECT id, name, transport, address, width_mm, profile, raster, is_receipt, drawer, stations, active, created_at FROM printer;
DROP TABLE printer;
ALTER TABLE printer_new RENAME TO printer;
`;

// Plug-and-play USB: thermal printers without a Windows driver are reached through the in-box "USB Printing Support"
// class driver (usbprint.sys), so printers gain a 'usb' transport (address = vendor:product[:serial]).
// Same 12-step rebuild as V3; printer still has no indexes, triggers or views.
const V4 = `
CREATE TABLE printer_new (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('memory','tcp','file','spooler','serial','usb')),
  address TEXT, width_mm INTEGER NOT NULL DEFAULT 80 CHECK (width_mm IN (58, 80)),
  profile TEXT NOT NULL DEFAULT 'generic', raster INTEGER NOT NULL DEFAULT 0,
  is_receipt INTEGER NOT NULL DEFAULT 0, drawer INTEGER NOT NULL DEFAULT 0,
  stations TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
INSERT INTO printer_new (id, name, transport, address, width_mm, profile, raster, is_receipt, drawer, stations, active, created_at)
  SELECT id, name, transport, address, width_mm, profile, raster, is_receipt, drawer, stations, active, created_at FROM printer;
DROP TABLE printer;
ALTER TABLE printer_new RENAME TO printer;
`;

// V5: store details editable in Settings > Store. Every change is kept with the time it took effect, so a bill
// (and every reprint of it) shows the name, address, GSTIN and FSSAI that were valid when it was issued.
const V5 = `
CREATE TABLE outlet_version (
  outlet_id TEXT NOT NULL REFERENCES outlet(id), valid_from INTEGER NOT NULL,
  name TEXT NOT NULL, address TEXT, phone TEXT, gstin TEXT, fssai_no TEXT, changed_by TEXT,
  PRIMARY KEY (outlet_id, valid_from)
);
INSERT INTO outlet_version (outlet_id, valid_from, name, address, phone, gstin, fssai_no) SELECT id, 0, name, address, phone, gstin, fssai_no FROM outlet;
CREATE TRIGGER outlet_version_no_update BEFORE UPDATE ON outlet_version BEGIN SELECT RAISE(ABORT, 'outlet_version is append-only'); END;
CREATE TRIGGER outlet_version_no_delete BEFORE DELETE ON outlet_version BEGIN SELECT RAISE(ABORT, 'outlet_version is append-only'); END;
`;

// V6: add-ons (src/addons/host.ts) keep their own numbered database steps here, with checksums like the POS's own.
const V6 = `
CREATE TABLE addon_migrations (
  addon_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL,
  PRIMARY KEY (addon_id, version)
);
`;

// V7: an optional customer name on a bill, next to the phone number.
const V7 = `
ALTER TABLE sale_order ADD COLUMN customer_name TEXT;
`;

// V8: staff sign in with their mobile number and PIN. Older users have none until the owner adds it.
// V11: a short description per menu item (shown on the online menu: website, app, delivery apps).
const V11 = `
ALTER TABLE item ADD COLUMN description TEXT;
`;

// V13: payment machines (card machines / EDC): Paytm and Pine Labs, over the internet or a cable.
//  - payment_terminal: one row per machine; settings that are not secret in config_json. Keys and security tokens
//    are settings named terminal_<id>_key (never listed, like every "_key" setting).
//  - terminal_txn: every amount sent to a machine and what came back. Not a financial record by itself: an approved
//    payment becomes a normal bill payment (mode CARD/UPI, reference with the approval code) when the bill is saved.
const V13 = `
CREATE TABLE payment_terminal (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('paytm','pinelabs')),
  connection TEXT NOT NULL CHECK (connection IN ('cloud','wired')),
  modes TEXT NOT NULL DEFAULT 'CARD,UPI', config_json TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE terminal_txn (
  id TEXT PRIMARY KEY, terminal_id TEXT NOT NULL REFERENCES payment_terminal(id), order_id TEXT NOT NULL REFERENCES sale_order(id),
  kind TEXT NOT NULL CHECK (kind IN ('SALE','VOID')), mode TEXT NOT NULL CHECK (mode IN ('CARD','UPI','ANY')),
  amount INTEGER NOT NULL CHECK (amount > 0), merchant_txn_id TEXT NOT NULL UNIQUE, provider_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','FAILED','CANCELLED','UNKNOWN')),
  result_json TEXT, message TEXT, invoice_id TEXT REFERENCES invoice(id), original_txn_id TEXT REFERENCES terminal_txn(id),
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX terminal_txn_order ON terminal_txn(order_id);
CREATE INDEX terminal_txn_status ON terminal_txn(status);
`;

// V12: counter extras.
//  - item.unavailable_on: "not available today" (an IST day, YYYY-MM-DD); the item is back the next day by itself.
//  - payment_correction: a wrong payment mode fixed after billing (cash entered, customer paid UPI). Payments stay
//    immutable; a correction is its own immutable record and payment_effective shows each payment's mode as corrected.
//  - app_session: sign-ins that survive a restart (only a SHA-256 of the token is stored).
const V12 = `
ALTER TABLE item ADD COLUMN unavailable_on TEXT;

CREATE TABLE payment_correction (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoice(id), payment_id TEXT NOT NULL REFERENCES payment(id),
  from_mode TEXT NOT NULL, to_mode TEXT NOT NULL CHECK (to_mode IN ('CASH','UPI','CARD','WALLET','CREDIT','OTHER')),
  amount INTEGER NOT NULL CHECK (amount > 0), reference TEXT, reason TEXT NOT NULL, shift_id TEXT REFERENCES shift(id),
  created_by TEXT NOT NULL, approved_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX payment_correction_payment ON payment_correction(payment_id, created_at);
CREATE TRIGGER payment_correction_no_update BEFORE UPDATE ON payment_correction
  BEGIN SELECT RAISE(ABORT, 'payment corrections are immutable'); END;
CREATE TRIGGER payment_correction_no_delete BEFORE DELETE ON payment_correction
  BEGIN SELECT RAISE(ABORT, 'payment corrections cannot be deleted'); END;
CREATE VIEW payment_effective AS
  SELECT p.id, p.invoice_id,
    coalesce((SELECT c.to_mode FROM payment_correction c WHERE c.payment_id = p.id ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1), p.mode) AS mode,
    p.mode AS original_mode, p.reference AS original_reference, p.amount, p.tendered,
    coalesce((SELECT c.reference FROM payment_correction c WHERE c.payment_id = p.id ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1), p.reference) AS reference,
    p.shift_id, p.created_at
  FROM payment p;

CREATE TABLE app_session (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_user(id), created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE INDEX app_session_user ON app_session(user_id);
`;

// V10: printers on Android (USB through Android's USB host API, Bluetooth including the built-in printer of Sunmi-type
// POS machines), reached through the Android app: printers gain an 'android' transport (address usb:vid:pid[:serial]
// or bt:MAC). Same 12-step rebuild as V3/V4; printer still has no indexes, triggers or views.
const V10 = `
CREATE TABLE printer_new (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('memory','tcp','file','spooler','serial','usb','android')),
  address TEXT, width_mm INTEGER NOT NULL DEFAULT 80 CHECK (width_mm IN (58, 80)),
  profile TEXT NOT NULL DEFAULT 'generic', raster INTEGER NOT NULL DEFAULT 0,
  is_receipt INTEGER NOT NULL DEFAULT 0, drawer INTEGER NOT NULL DEFAULT 0,
  stations TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
INSERT INTO printer_new (id, name, transport, address, width_mm, profile, raster, is_receipt, drawer, stations, active, created_at)
  SELECT id, name, transport, address, width_mm, profile, raster, is_receipt, drawer, stations, active, created_at FROM printer;
DROP TABLE printer;
ALTER TABLE printer_new RENAME TO printer;
`;

// V9: coupon codes, and the coupon a bill uses (its code is kept on the bill even if the coupon changes later).
const V9 = `
CREATE TABLE coupon (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, description TEXT,
  type TEXT NOT NULL CHECK (type IN ('amount','percent')), value INTEGER NOT NULL CHECK (value > 0),
  max_discount INTEGER CHECK (max_discount IS NULL OR max_discount > 0), min_bill INTEGER NOT NULL DEFAULT 0 CHECK (min_bill >= 0),
  valid_from TEXT, valid_to TEXT, max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
ALTER TABLE sale_order ADD COLUMN coupon_id TEXT REFERENCES coupon(id);
ALTER TABLE sale_order ADD COLUMN coupon_code TEXT;
CREATE INDEX sale_order_coupon ON sale_order(coupon_id) WHERE coupon_id IS NOT NULL;
`;

const V8 = `
ALTER TABLE app_user ADD COLUMN mobile TEXT;
CREATE UNIQUE INDEX app_user_mobile ON app_user(mobile) WHERE mobile IS NOT NULL AND deleted_at IS NULL;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial', sql: V1 },
  { version: 2, name: 'inventory', sql: V2 },
  { version: 3, name: 'printer_serial', sql: V3, foreignKeysOff: true },
  { version: 4, name: 'printer_usb', sql: V4, foreignKeysOff: true },
  { version: 5, name: 'outlet_version', sql: V5 },
  { version: 6, name: 'addon_migrations', sql: V6 },
  { version: 7, name: 'customer_name', sql: V7 },
  { version: 8, name: 'user_mobile', sql: V8 },
  { version: 9, name: 'coupons', sql: V9 },
  { version: 10, name: 'printer_android', sql: V10, foreignKeysOff: true },
  { version: 11, name: 'item_description', sql: V11 },
  { version: 12, name: 'counter_extras', sql: V12 },
  { version: 13, name: 'payment_terminals', sql: V13 },
];
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
