# Build checklist

Last updated: 2026-10-16 (order hub, live ODS, fee GST, road distance, map provider, add-on loader hardening). Keep this file current when a feature lands or a gap is found.

Legend: `[x]` built and tested here. `[~]` built, but needs a check this PC cannot do (see `HARDWARE_TEST_PLAN.md`). `[ ]` not built.

## 1. Already built (backend)

### Billing core (`src/core`)
- [x] Money in integer paise, quantity in thousandths, rates in basis points, BigInt rounding
- [x] GST: CGST/SGST and IGST, inclusive and exclusive prices, odd paisa to CGST, round-off
- [x] Discounts before tax, split across lines by largest remainder
- [x] Invoice numbering per device and financial year (`A1/26-27/000001`), 16-character limit
- [x] UUIDv7 ids

### Catalog
- [x] Categories, tax groups, items (HSN, barcode, SKU, veg flag, unit)
- [x] Modifier groups with rules, priced on the server
- [x] Fast item search (prefix, multi-word) and barcode lookup
- [x] CSV import with row-by-row preview, all or nothing
- [x] Menu edits never change past invoices (snapshots)

### Orders and payments
- [x] Cart stored on the server: add, edit and remove lines; identical lines merge
- [x] Hold, resume, cancel a draft; open bills survive a restart
- [x] Bill discount with cashier limit and manager approval
- [x] Channels recorded: Counter, Swiggy, Zomato, ONDC, Other
- [x] Split payments (cash, UPI, card); tendered and change
- [x] Daily token numbers per counter
- [x] Buyer GSTIN from another state switches the bill to IGST

### Invoices and corrections
- [x] Finalize in one transaction; same request id never bills twice
- [x] Finalized invoices locked by database triggers
- [x] Cancel (same day, shift still open, manager approval)
- [x] Credit notes with partial returns and no paisa drift
- [x] Reprint with manager approval

### Shifts and reports
- [x] Open and close shift; close refused while bills are unfinished
- [x] Z-report: cash, UPI, cancellations, refunds, expected cash and difference
- [x] Daily, tax and item reports; incremental daily summary with a repair tool
- [x] Invoice register CSV, safe against spreadsheet formula injection

### Users and security
- [x] First-run setup (outlet, counter, owner)
- [x] PIN login, scrypt hashing, lockout with backoff, idle lock
- [x] Roles (owner, manager, cashier) checked in the service layer
- [x] Manager approval (override); failed approval PINs count toward lockout
- [x] Local API on `127.0.0.1` only, Host allow-list, JSON-only writes, strict field validation, 2 MB body limit
- [x] Hash-chained audit log with a verify check

### Printing
- [x] ESC/POS builder; 58 mm (32 columns) and 80 mm (48 columns)
- [x] Receipt and kitchen ticket (KOT) templates, UPI QR, cash drawer, auto-cut
- [x] Persistent print queue: strict order per printer, retry at 1 s / 3 s / 10 s, recovery after restart
- [x] Virtual printer and file transport
- [x] LAN printer over TCP port 9100 (tested with a local socket)
- [~] Windows spooler RAW transport for USB printers. The failure path is tested on the real spooler; no real printer has printed through it yet
- [x] Raster image command exists in the builder (the host must render the images)
- [~] Bluetooth printers through their COM port (serial transport). The not-found path is tested on real Windows; no Bluetooth printer has printed yet
- [x] Printer discovery: installed Windows printers (USB), COM ports (Bluetooth), Wi-Fi/LAN scan for port 9100
- [~] Plug and play USB: detection banner, one-tap setup with test page, driverless printing through usbprint.sys. Device scan verified on real Windows USB devices; no USB receipt printer has printed yet
- [x] Printer settings: add, edit, test print, turn off, remove (kept if it has history); live status per printer
- [x] Bills report what was queued to print and warn when no receipt or kitchen printer matches
- [x] Receipt preview as text and browser printing (any printer or PDF)

### Data safety and recovery
- [x] SQLite WAL with `synchronous=FULL`; checksummed migrations
- [x] Hard kill at 5 points inside finalize: bill whole or absent (passes on Linux and Windows 11)
- [x] 4 processes billing at once: gapless, unique numbers
- [x] Online backups (hourly, daily, on close, manual) with verification and retention
- [x] Daily journal outside the database: fsynced, torn-line safe, gzipped after 2 days, repaired at startup
- [x] Restore and journal replay functions (tested: identical invoices after recovery)
- [x] `npm run restore`: lists backups, keeps the current database aside, restores database and photos, replays the journal
- [x] Menu photos in every backup (incremental, fingerprint-checked) and restored with it; never stored in the database
- [x] Startup integrity check; refuses to bill on a damaged database
- [x] Health check, disk-space warning, live events stream

### Billing UI (`ui/`, rebuilt from the Lovable "Tiffin POS" design)
- [x] Sign-in with mobile number and PIN (on-screen keypad); after an inactivity lock the PIN alone unlocks; after sign-out both are asked; first-run shop setup asks for the owner's mobile number
- [ ] Existing staff without a mobile number still pick their name on the sign-in screen until the owner adds one in Settings > Users
- [x] Billing: categories, search, barcode scan, modifiers, quantities, bill discount, Cash/UPI/Card, change from the backend
- [x] Manager approval dialog (discount over limit, reprint)
- [x] Open and close shift with Z-report summary; unfinished bills block closing
- [x] Menu creation with three tabs: Items, Categories, Bulk upload (manager/owner; cashiers can view)
- [x] Items: add and edit with veg / non-veg / not food, category, price, GST, unit, short name, HSN, barcode; search and filters
- [x] Categories: add, rename, kitchen station, reorder, delete when empty, item counts
- [x] Bulk upload: template download, CSV file or paste, row-by-row check, all-or-nothing import
- [x] Item photos: upload, change and remove (drag and drop or choose), resized in the browser, shown on the menu table and billing tiles
- [x] Orders: today's bills, bill detail, reprint
- [x] Failed-print alerts with retry, showing the bill number and printer
- [x] Split payment (up to 6 modes) checked by the backend; hold and resume with a held-bills list; customer name (optional), phone and note
- [x] After-payment panel: change to give, live print status per job, print on screen, reprint
- [x] Orders: cancel a bill and refund items (credit note) with manager approval; print on screen
- [x] Settings (sidebar) with sections: Printer setup and Receipt
- [x] Printer setup: always-visible list of plugged-in USB printers (scan again, use for bills, set up with options), step-by-step add/edit (connection, device, name, paper width, bills, cash drawer, kitchen stations, data speed, on/off)
- [x] Printer tests: test page, sample bill (marked "SAMPLE - NOT A BILL"), open cash drawer, retry failed jobs; live status per printer
- [x] Receipt: footer text (owner) with a live sample preview at 58 and 80 mm, print a sample on any printer
- [x] Never calculates money; idempotency key per action; open bill restored from the server after a reload
- [x] Driven end to end in headless Chrome on Windows 11 (not in Electron or on a touch screen)

### Inventory (stock)
- [x] Materials with unit (kg, g, L, ml, pcs), reorder level, opening stock and cost; low and negative flags
- [x] Purchases with supplier, bill number, date, GSTIN and lines; amounts in paise from the backend; void reverses stock
- [x] Wastage, physical count and correction, each with a reason
- [x] Recipes per menu item; bills deduct ingredients in the same transaction; cancel restores them
- [x] Append-only stock ledger with history per material; balances verified in the deep health check
- [x] Journaled and replayed: restore + replay gives identical stock and purchases
- [x] UI: Stock and Purchase screens, recipe editor on Menu creation, low stock in the bell; driven in Chrome on Windows 11

### Platform
- [x] Full test suite passes on a Windows 11 developer PC (Node 24.21)
- [x] Cloud sync outbox table is written on every bill (nothing reads it yet)

## 2. Built, still to verify on real hardware
- [ ] Each printer model you sell: USB through the spooler, LAN, long bills, cut, drawer, QR scan
- [ ] Low-end Windows 10 PC (Celeron, 4 GB, hard disk): cold start, benchmark numbers, 8-hour memory
- [ ] Hard power cut mid-bill, ten times
- [ ] Antivirus (Defender and one third-party) with the PowerShell print helper
- [ ] Printer paused or offline in Windows: decide whether "accepted by the spooler" is good enough to mark a receipt printed
- [ ] Database above 600,000 invoices (a 1,000,000-invoice run failed in the sandbox and was not investigated)
- [ ] CA sign-off on GST rates, rounding, discounts, numbering, credit notes and receipt content

## 3. Still to build

Order follows the project plan in `CLAUDE.md`.

### Next: Electron host
- [x] Electron 44 app in `desktop/`: one window, backend in a utility process (same code as `npm start`, Node 24.21 inside Electron), UI on the app://pos scheme
- [x] Secure bridge: sandboxed page with no Node; its only route to the backend is app://pos/api, forwarded by the main process with a per-launch secret (`X-POS-Secret`); random loopback port
- [x] Lockdown: no navigation away, no pop-ups, all permissions refused, Content-Security-Policy, no menu, dev tools off when installed
- [x] Single copy only; backend crash restarts (3 tries) and reloads the window; window crash reloads; clean close with closing backup; Windows sign-out asks the backend to close
- [x] Data in %LOCALAPPDATA%\TiffinPOS\data (local, not roaming), log in ...\logs with rotation; start-up failure dialog with "Open data folder"
- [x] End-to-end test of the real app (dev build, packaged build and installed build): bill with live print status, reports, lockdown, crash restart, single copy, closing backup
- [ ] Encryption at rest: SQLCipher-compatible build plus a recovery key
- [ ] Raster printing for Hindi and other scripts, and the rupee sign
- [ ] Backup and restore screen for the owner (today: automatic backups plus the `npm run restore` command)
- [ ] Sessions that survive an app restart (today a restart signs everyone out; bills are safe)

### Then: distribution
- [x] USB printers on the WinUSB driver (e.g. after the Zadig tool): listed in Printer setup and printed to through winusb.dll (bulk OUT endpoint), no admin needed. Found and opened a Posiflex PP8800 on the dev PC; a real print from this path is not tested yet
- [x] Windows installer (NSIS) that runs as a standard user: installed, run and uninstalled on the dev PC without admin; shortcuts; uninstall keeps the data folder
- [x] Auto-update (electron-updater): background download, installs when the POS is closed, checks the publisher signature; on when built with POS_UPDATE_URL
- [ ] Code-signing certificate (the installer is unsigned: SmartScreen warns) and an update server (any static HTTPS host)
- [ ] Licensing

### Then: integrations and scale
- [ ] Swiggy / Zomato relay client
- [ ] LAN multi-device (several counters on one shop network)
- [ ] Opt-in cloud sync that reads the outbox table

### Smaller gaps found in the backend
- [x] `npm run seed` works on Windows (it silently did nothing before)
- [ ] Cart change returns only what changed (today the whole cart, about 300 KB at 1,000 lines)
- [ ] UPI payment confirmation (today the cashier confirms by hand); card machine integration
- [ ] Inventory follow-ups: unit conversion (buy in kg, use in g), recipes for modifiers (extra cheese), supplier list, purchase GST input credit, stock reports (consumption, wastage, variance), FIFO or average cost valuation, purchase CSV import
- [ ] Owner to confirm: credit notes do not restock (returned food is discarded)
- [ ] Yearly archive files (not needed until a shop's database grows large)

### UI screens still missing
- [ ] Coupon codes (the prototype had a field; the backend has no coupons)
- [ ] Line-level discounts and notes (backend done)
- [x] Reports screen (sidebar): 16 reports in 5 groups. Sales: summary, payment modes, by hour, channels, by cashier, discounts. Items: item sales, category sales. Tax: GST by rate, HSN summary, bill register. Controls: cancellations and refunds, shifts and cash. Inventory: stock on hand, stock movement, purchases
- [x] Reports show on screen (summary cards, table, totals row), date presets (today, yesterday, last 7 days, this month, last month, custom), Download CSV for Excel, Print / PDF (A4 landscape)
- [ ] Reports follow-ups: GSTR-1 B2B/B2CS JSON export, XLSX download, profit report (needs recipe costing), scheduled email of the daily report, reports for a single shift (X-report)
- [ ] Settings screen for backups (store, users, printers, receipt footer and bill design done)
- [x] Settings > Online orders: master switch (off = offline mode, the default) and sales channels App, Website, Swiggy, Zomato; ODS appears in the side menu only when on; online/offline dot at the bottom of the side menu
- [x] Add-ons: POS 0.2.0+ loads signed add-ons (Ed25519, file fingerprints, minimum POS version, own database steps, own routes, failures switch the add-on off with a reason); screens plug into the side menu, routes and Settings; desktop offers a restart when an add-on is installed
- [x] ODS add-on (separate installer TiffinPOS-ODS-Setup): online orders settings and ODS moved out of the POS core; Serviceability: store location on a map (search, draggable pin), up to 6 distance bands with delivery fee / minimum order / free above / delivery time, packaging fee, pickup minimum and time, opening hours (2 a day, past midnight)
- [x] Online orders settings: order types (pickup, delivery with own riders), payments (online, COD), accepting (manual with 2-15 min limit, or automatic)
- [x] Phase 0 contract written: contract/ (order life cycle, data shapes, order checks, OpenAPI v1, event catalogue); waiting for owner sign-off
- [x] Order hub (hub/): stores, POS pairing (one-use code, device key kept as a hash, revoke), menu and status from the POS, customer quote / OTP / place / track / cancel, live POS event stream (SSE, resumes after a drop), auto-reject when not accepted in time, idempotent orders, demo ordering page; see hub/README.md
- [x] POS connection (ODS add-on): pairs with the hub, publishes menu, serviceability and "accepting" (= a shift is open), receives orders live, sends answers through an outbox that survives restarts and internet drops
- [x] Live ODS screen: New / Preparing / Ready / On the way, sound on new orders, accept countdown, accept with preparation time (bill + KOT print at once), reject with reason, rider name and phone, delivered / collected, cancel with manager approval (cancels the bill)
- [x] Online order bills: a normal GST bill per order (channel App / Website, order number kept), idempotent; price changed since ordering is flagged ("Accept at POS price"); a customer cancel that beats the accept is flagged with "Cancel bill"
- [x] GST on delivery and packaging fees: billed as fee lines with the GST rate chosen in Serviceability; the hub's price equals the POS bill (same GST code). **Needs CA confirmation of the rate**
- [x] Road distance: measured by a road-routing server on the hub (HUB_ROUTING_URL, OSRM) or straight line x road factor (default 1.30, set per store)
- [x] Google Maps (ODS 1.0.1): Settings > API keys (owner only) holds the Google key; the map (Map Tiles API) and place search (Places API (New), Essentials fields) use Google when it is set, OpenStreetMap + Photon when not; Test key explains what to switch on; the key never reaches screens, settings lists, the audit log or the hub
- [x] Place search with suggestions while typing: near the shop, fewer-words retry, pasted Google Maps coordinates or links
- [ ] Google map pictures and place search seen working with the owner's key (2026-10-16: the key was accepted, but Places API (New) and Map Tiles API were not yet switched on in its project)
- [ ] Google Maps logo on the map (Google's display rules); now only the text credit "Map data ©Google"
- [x] Add-on loader hardening: folder must equal the id, no going back to an older version, add-on database steps limited to their own tables (no ATTACH/PRAGMA/VACUUM); review notes in docs/ADDONS.md
- [ ] Human security review of the add-on loader and online billing (docs/ADDONS.md "Security review")
- [ ] Online orders, still to build: SMS for OTP, payment gateway (online payment, refunds), hosting the hub, store apps (Android/iOS/website; the demo page stands in), Swiggy/Zomato relay, customer notifications (SMS/WhatsApp)
- [ ] Online orders: not yet tried on a real Windows install with a real printer (docs/HARDWARE_TEST_PLAN.md)
- [x] PINs are exactly 4 digits in the UI (sign-in and approval keypads, setup, users); the backend still accepts 4 to 6 so an older longer PIN keeps working until the owner resets it
- [x] Settings > Users (owner only): add a user with name, role and PIN (typed twice); edit name and role; reset a PIN (also unlocks); change own PIN with the current one; deactivate and reactivate. Unique names among active users; no self-deactivation or own role change; the last owner is protected
- [x] Settings > Store: name, address (multi-line), phone, GSTIN (check digit and state checked), FSSAI; owner edits, manager views. Every change is versioned: a bill and its reprints keep the details valid when it was issued
- [x] Bill logo: picture converted to printer dots in the browser (size, darkness, photo mode, live print preview), printed centred at the top of bills (ESC/POS raster), shown in every on-screen receipt
- [x] Default bill design "Classic" (logo, store details, Bill No / Cashier / Token / Date / Time row, Item / Price / Qty / Total, Total Quantity, Gross Total, GST per rate, Net Amount)
- [x] Bill design files (.tiffinreceipt): the owner uploads a design in Settings > Receipt, sees a 58/80 mm preview first, and every bill, reprint, screen receipt and sample uses it; back to standard in one tap. GST bill parts are required; safety marks always print
- [x] Designer kit: format guide (docs/RECEIPT_TEMPLATES.md), three examples (templates/receipt), `npm run receipt` preview with --width/--credit/--duplicate/--upi
- [ ] Bill design follow-ups: rupee sign and Hindi (needs text-as-image printing), table number and customer name on the bill (not in the data yet), KOT designs, a CA review of the GST bill check
- [ ] Receipt wording for an outlet without GSTIN ("TAX INVOICE" is always printed) and place of supply on IGST bills: needs CA decision
- [ ] KOT reprint, manual cash drawer open, X-report; changing the payment mode after billing
- [ ] Line notes and line discounts in the UI (backend done)
- [ ] Modifier (add-on) group editing in the UI (backend can create groups and attach them)
- [ ] Mark an item unavailable for the day without deleting it
- [ ] Excel (.xlsx) upload directly (today: save as CSV UTF-8)
- [ ] Update prices of existing items in bulk (the upload only adds new items)
- [ ] Live updates through the events stream (the UI polls print failures every 20 s)
- [ ] Customer name and phone, buyer GSTIN and order channel (Swiggy/Zomato) on the bill
- [ ] Layout for screens narrower than 1280 px and touch-first testing
- [x] The Electron host loading the built UI (app://pos)
