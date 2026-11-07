# Build checklist

Last updated: 2026-10-18 (hub admin page, order hub, live ODS, fee GST, road distance, map provider, add-on loader hardening). Keep this file current when a feature lands or a gap is found.

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
- [x] PIN login, scrypt hashing, lockout with backoff; no idle lock (owner's choice): a lock button instead
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
- [x] Sign-in with mobile number and PIN (on-screen keypad); after sign-out both are asked; first-run shop setup asks for the owner's mobile number
- [ ] Existing staff without a mobile number still pick their name on the sign-in screen until the owner adds one in Settings > Users
- [x] Billing: categories, search, barcode scan, modifiers, quantities, bill discount, Cash/UPI/Card, change from the backend
- [x] Manager approval dialog (discount over limit, reprint)
- [x] Open and close shift with Z-report summary; unfinished bills block closing
- [x] Menu creation with three tabs: Items, Categories, Bulk upload (manager/owner; cashiers can view)
- [x] Items: add and edit with veg / non-veg / not food, category, price, GST, unit, short name, HSN, barcode; search and filters
- [x] Categories: add, rename, kitchen station, reorder, delete when empty, item counts
- [x] Bulk upload: template download, CSV file or paste, row-by-row check, all-or-nothing import; categories already on the menu are reused (capitals and extra spaces ignored), missing ones created once, and the preview marks which categories are new
- [x] Item photos: upload, change and remove (drag and drop or choose), resized in the browser, shown on the menu table and billing tiles
- [x] Menu creation > Bulk photos: choose or drop up to 300 photos; matched by file name (item name, short name, SKU or barcode; exact only, no guessing), pick the item for the rest, option to keep existing photos, saved one by one with progress. Pictures pasted inside Excel are not read (CSV holds text only)
- [ ] Bulk photos screen seen in the desktop app with a real folder of shop photos
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
- [x] Rupee sign, Hindi and other Indian scripts on bills and kitchen tickets: such lines print as pictures drawn with the system's fonts (Windows: GDI+ / Nirmala UI in a constant PowerShell script; Android: the app's Canvas), drawn by the print queue outside the bill transaction; plain text ("Rs", "?") when drawing is not possible. The screen preview shows the real text. Tested with real Windows fonts on the dev PC; not yet on a real printer or Android device
- [x] Backup and restore screen for the owner (Settings > Backups): back up now, list, restore with the PIN (the POS restarts itself), copies to a USB drive or folder (Windows folder picker), online backups to the Tiffin backup server; restore from this device, a folder or online. Tested end to end in the browser and in the desktop app (dev build)
- [x] Menu photo compression for single and bulk uploads: 1024 px, high-quality resize, WebP 90% (measured: no visible difference, ~95% smaller); the screens show the size before and after
- [x] Never signed out by the POS (POS 0.3.10): the sign-in survives closing the app, a crash and a restart (the screen keeps the token in localStorage; app_session keeps only a SHA-256 of it); no inactivity lock and no expiry; only sign-out and deactivating the user end it. Lock button at the top of billing (before Held): the lock screen shows only the PIN pad for the same person (wrong PINs count toward the PIN lockout), keeps the open bill, offers sign-out; the lock is kept in app_session (migration 13), so closing or crashing while locked stays locked. Tested in the browser and the desktop end-to-end test; closing and reopening the installed Windows and Android apps not yet tried

### Then: distribution
- [x] USB printers on the WinUSB driver (e.g. after the Zadig tool): listed in Printer setup and printed to through winusb.dll (bulk OUT endpoint), no admin needed. Found and opened a Posiflex PP8800 on the dev PC; a real print from this path is not tested yet
- [x] Windows installer (NSIS) that runs as a standard user: installed, run and uninstalled on the dev PC without admin; shortcuts; uninstall keeps the data folder; the installer waits up to 30 s for a POS that is still closing (closing backup) before saying it is open (desktop/build/installer.nsh; tested on the dev PC with a separately named copy)
- [x] Faster installs on low-end PCs: zip package, English-only Chromium strings, no WebGPU shader compilers (silent install on one CPU core ~22 s instead of ~47 s; tested with a separately named copy, and the trimmed app passes the desktop e2e test with and without a graphics card)
- [x] Auto-update (electron-updater): background download, installs when the POS is closed, checks the publisher signature; on when built with POS_UPDATE_URL
- [x] Tiffin Data Manager, a separate Windows app and installer (`desktop/src/manager`, `src/manager`, `ui/src/manager`): works with or without the POS installed (POS data folder, another folder, or a backup file); owner-only sign-in; dashboard (KPIs, net sales by day, busy hours, payment modes, best sellers, categories, channels, from the backend's reports); the POS's own Bills (view only), Reports, Menu, Stock, Purchases, Store/staff/coupons screens; All data (every table, search, CSV; secrets hidden); backup now (+ copy to a USB drive) and restore with the PIN. View only while the POS is open, for data from an older POS (never upgraded in place) and for backup files. Tested: 6 backend tests and an end-to-end test of the dev build on the dev PC with temporary data
- [ ] Tiffin Data Manager: install the built installer on a clean PC (with and without the POS), open real data of an older POS (view only), restore on a shop PC; a "POS open" check that is not by program name (today: TiffinPOS.exe in the task list)
- [ ] Code-signing certificate (the installer is unsigned: SmartScreen warns) and an update server (any static HTTPS host)
- [ ] Licensing

### Then: integrations and scale
- [x] Swiggy / Zomato through UrbanPiper (hub `src/urbanpiper.ts`, ODS 1.0.9): one UrbanPiper account in Hub settings (test or live, API username, API key never shown again, Biz ID; Test connection, Set up order links: 9 webhooks for all stores, secret header, spaced for 5 calls a minute) and per store on its page (store ID, city, address, phone, platforms, packaging, on/off; Send store details, Send menu with the platforms' menu rules checked; activity list). Orders in (S-/Z- numbers, priced at the channel price, platform order number, OTP, totals, charges, discounts, notes; repeats ignored; unknown store or platform refused), status back (Acknowledged + Zomato prep time, Food Ready, Dispatched + rider, Completed, Cancelled + reason code, Swiggy direct cancellation), platform cancellations, rider and delivery in; menu changes, sold-out items and store off/on follow by themselves after the first menu send; outbox with retries. ODS: channel logo on every order card (Swiggy, Zomato, website, app; drawn marks in the channel colours, not the official artwork) and a coloured card edge per channel (ODS 1.0.13), platform details, rider, "paid through Swiggy" (bill payment mode OTHER), no rider buttons when the platform delivers; Swiggy items out of stock on an order (customer asked to change it, masked number and PIN back, or cancel), Zomato customer's number, extra rider (bulk orders), rider check; platform answers and refusals as notices on the order. Packaging charge for the platforms (per item or % of item price, item-level), cess inside the item price, tax codes CGST_P/SGST_P (also with several GST rates: one pair per rate, titled CGST 2.5%). Opening times past midnight are split at midnight for UrbanPiper (it refuses a slot that ends before it starts); a refusal shows all the details UrbanPiper sends (e.g. the menu report), and an unknown store reference says to send the store details first. Menu versions: a POS whose count is behind the hub (restored backup, paired again) is no longer ignored (hub keeps a lower version unless it arrives within a minute of a newer one; ODS 1.0.13 catches up and sends again when the hub says stale). Tested with a stand-in UrbanPiper only
- [ ] UrbanPiper: run against the real test account (pos-int) with Atlas Developer Tools test orders, then certification (UrbanPiper refused CGST_2.5_P style codes; now every rate uses CGST_P/SGST_P with the rate in the title: check that UrbanPiper accepts two pairs with the same code); category timing groups; CA review of GST on Swiggy/Zomato bills (the platforms pay the 5% GST on food under section 9(5)) and of store-funded platform discounts (not on the POS bill)
- [ ] LAN multi-device (several counters on one shop network)
- [ ] Opt-in cloud sync that reads the outbox table

### Smaller gaps found in the backend
- [x] `npm run seed` works on Windows (it silently did nothing before)
- [ ] Cart change returns only what changed (today the whole cart, about 300 KB at 1,000 lines)
- [x] Payment machines as a separately installed add-on (addons/edc, POS 0.3.8 toolbox: billing.order/finalize/paymentGuard, requireApproval, powershell; screen slots checkout and invoicePanels) (docs/PAYMENT_MACHINES.md): Paytm and Pine Labs, wireless (internet) and wired (Paytm USB library on Windows, Pine Labs PAD Controller); Settings > Payment machines (owner) with Test; counter sends Card/UPI to the machine and saves the bill only on approval; cancel, check again, reverse (void); Settings > Payment machines > Daily match. Tested with simulated servers and controller only
- [ ] Payment machines on real hardware and the companies' test accounts; PhonePe and Razorpay POS connectors; Pine Labs UPI by cable
- [ ] UPI payment confirmation without a machine (bank or UPI app merchant notifications)
- [ ] Inventory follow-ups: unit conversion (buy in kg, use in g), recipes for modifiers (extra cheese), supplier list, purchase GST input credit, stock reports (consumption, wastage, variance), FIFO or average cost valuation, purchase CSV import
- [ ] Owner to confirm: credit notes do not restock (returned food is discarded)
- [ ] Yearly archive files (not needed until a shop's database grows large)

### UI screens still missing
- [x] Coupon codes: Settings > Coupons (owner only: create, edit, switch off; managers and cashiers do not see it): % or Rs off, % cap, minimum bill, valid dates, number of uses, on/off; Billing % button > Coupon code; checked when applied and again at payment; a coupon needs no manager PIN; a manual discount replaces it; cancelling a bill frees its use
- [ ] Coupon follow-ups: coupon code printed on the bill (receipt content: needs review), coupons in the Discounts report, one use per customer mobile, coupons for online orders
- [x] Line-level discounts and notes (tap a bill line: exact quantity, kitchen note, % or ₹ off this item; above the limit a manager approves)
- [x] Reports screen (sidebar): 16 reports in 5 groups. Sales: summary, payment modes, by hour, channels, by cashier, discounts. Items: item sales, category sales. Tax: GST by rate, HSN summary, bill register. Controls: cancellations and refunds, shifts and cash. Inventory: stock on hand, stock movement, purchases
- [x] Reports show on screen (summary cards, table, totals row), date presets (today, yesterday, last 7 days, this month, last month, custom), Download CSV for Excel, Print / PDF (A4 landscape)
- [ ] Reports follow-ups: GSTR-1 B2B/B2CS JSON export, XLSX download, profit report (needs recipe costing), scheduled email of the daily report, reports for a single shift (X-report)
- [x] Settings screen for backups (Settings > Backups, owner only)
- [ ] Backups follow-ups: restore from a USB stick or SD card inside the Android app (today: online or this device's backups; the USB copy works), hosting the backup server, optional encryption of online backups, an admin view of stores' online backups
- [x] Settings > Online orders: master switch (off = offline mode, the default) and sales channels App, Website, Swiggy, Zomato; ODS appears in the side menu only when on; online/offline dot at the bottom of the side menu
- [x] Add-ons: POS 0.2.0+ loads signed add-ons (Ed25519, file fingerprints, minimum POS version, own database steps, own routes, failures switch the add-on off with a reason); screens plug into the side menu, routes and Settings; desktop offers a restart when an add-on is installed
- [x] ODS add-on (separate installer TiffinPOS-ODS-Setup): online orders settings and ODS moved out of the POS core; Serviceability: store location on a map (search, draggable pin), up to 6 distance bands with delivery fee / minimum order / free above / delivery time, packaging fee, pickup minimum and time, opening hours (2 a day, past midnight)
- [x] Online orders settings: order types (pickup, delivery with own riders), payments (online, COD), accepting (manual with 2-15 min limit, or automatic)
- [x] Phase 0 contract written: contract/ (order life cycle, data shapes, order checks, OpenAPI v1, event catalogue); waiting for owner sign-off
- [x] Order hub (hub/): stores, POS pairing (one-use code, device key kept as a hash, revoke), menu and status from the POS, customer quote / OTP / place / track / cancel, live POS event stream (SSE, resumes after a drop), auto-reject when not accepted in time, idempotent orders, demo ordering page; see hub/README.md
- [x] Hub admin page (`/admin`, admin key): orders of all stores or one (Open/Delivered/Cancelled/Failed/All; channel badge, date, time, status Placed/Accepted/Preparing/In transit/Delivered/Cancelled by store/Cancelled by customer/Failed with the reason, payment mode; details: items, charges, customer with masked mobile, address, bill, rider); failed order attempts that never became orders (offline store, changed price, technical errors with code) kept 30 days; stores (POS online / shift open / what customers see, open and 24 h orders) and each store's published settings (read-only: accepting, channels, pickup/delivery, payments, charges, fee GST, location, delivery bands, hours, menu by category); adding a store gives a connection link (`/connect/<code>`, one use) that the POS pastes instead of an address and a code (ODS 1.0.7); pause/resume a store's online orders from the hub, revoke POS devices, hub settings saved in the hub database (routing server, offline after, pairing code validity, request limits); dev OTP and online payments stay environment-only. Tested on macOS with Node 24 (API tests, a manual run with a stand-in POS); the page itself not yet clicked through in a browser, and the ODS 1.0.7 Order hub card not yet tried in the real POS
- [x] Website builder (the ordering website's `/admin`, separate repo; hub side `hub/src/site.ts`): per-store editor password (admin page or `npm run admin -- site-password`), 30-day sign-ins, draft / publish / discard, photo uploads; theme with ready-made looks, logo and SEO, contact and social, menu display, announcement bar, home page sections (hero, featured dishes, menu, about, gallery, reviews, hours, contact and map, FAQ, text) added, reordered, hidden and edited beside a live preview; published design sent as `site` with `GET /v1/stores/<slug>`. API tests; clicked through in headless Chrome (sign in, edit, upload, undo, publish, customer site on computer and phone); not yet tried by a shop owner
- [ ] Hub admin gaps: errors inside the POS (e.g. a bill that failed to print after accepting) are not visible on the hub; requests refused by the per-minute limits are not listed as failed attempts (to keep floods out of the table); the POS is not told when the hub pauses its store; one shared admin key (no per-person logins, no audit log)
- [x] POS connection (ODS add-on): pairs with the hub, publishes menu, serviceability and "accepting" (= a shift is open), receives orders live, sends answers through an outbox that survives restarts and internet drops
- [x] Menu sync per sales channel (Settings > Online orders > Menu sync on each channel): all items, all except (search), only (search); prices same as the POS or different (+/- % to the nearest rupee, or an item's own price); Save and sync now. The hub shows each channel only its items at its prices and refuses others; online bills use the channel price (POS works it out itself; screens cannot send a price). Swiggy/Zomato choices are saved for when those connections exist
- [x] Item descriptions (database step 11): Menu creation, bulk upload column `description`, sent to the hub with photos and prices
- [x] Sales channel badges (Swiggy, Zomato, Website, App) on ODS tiles, the finished list and the channel row; globe icon in the side menu: number of new orders waiting, else a green/red dot
- [ ] Official Swiggy/Zomato logo files (their partner programmes provide them)
- [x] Online-order buzzer on every screen (ODS 1.0.2): rings loudly and repeats while an order waits to be accepted, with a "New online order" banner (Silence, Open ODS); stops on accept/reject; the ODS Sound switch controls it; the desktop app lets it ring without a tap first
- [x] Buzzer in the automatic accept mode (ODS 1.0.9): an order accepted automatically never waits, so it used to make no sound; now a new order rings twice and a banner shows it for 20 seconds on every screen ("Accepted automatically: the bill and kitchen ticket are printing"); orders already there when the POS starts do not ring. Tested in a browser with a test POS and hub (tones counted); not yet heard on the shop PC or an Android device
- [x] Menu photos sent to the hub (only missing ones, checked against their content name; removed with the item's photo); `image` on published menu items
- [x] Live ODS screen: New / Preparing / Ready / On the way, sound on new orders, accept countdown, accept with preparation time (bill + KOT print at once), reject with reason, rider name and phone, delivered / collected, cancel with manager approval (cancels the bill)
- [x] Online order bills: a normal GST bill per order (channel App / Website, order number kept), idempotent; price changed since ordering is flagged ("Accept at POS price"); a customer cancel that beats the accept is flagged with "Cancel bill"
- [x] GST on delivery and packaging fees: billed as fee lines with the GST rate chosen in Serviceability; the hub's price equals the POS bill (same GST code). **Needs CA confirmation of the rate**
- [x] Road distance: measured by a road-routing server on the hub (HUB_ROUTING_URL, OSRM) or straight line x road factor (default 1.30, set per store)
- [x] Google Maps (ODS 1.0.1; map choice in ODS 1.0.8): Settings > Serviceability > Map: the owner chooses the free map (OpenStreetMap + Photon search, the default, also with a key) or, with a Google key (entered in the same card; no separate API keys section any more), Google Maps, Google satellite or satellite with roads (Map Tiles API, one session per map) with Google place search (Places API (New), Essentials fields); Test key explains what to switch on; the key never reaches screens, settings lists, the audit log or the hub
- [x] Place search with suggestions while typing: near the shop, fewer-words retry, pasted Google Maps coordinates or links
- [ ] Google map pictures and place search seen working with the owner's key (2026-10-16: the key was accepted, but Places API (New) and Map Tiles API were not yet switched on in its project)
- [ ] Google Maps logo on the map (Google's display rules); now only the text credit "Map data ©Google"
- [x] Add-on loader hardening: folder must equal the id, no going back to an older version, add-on database steps limited to their own tables (no ATTACH/PRAGMA/VACUUM); review notes in docs/ADDONS.md
- [ ] Human security review of the add-on loader and online billing (docs/ADDONS.md "Security review")
- [ ] Online orders, still to build: SMS for OTP, payment gateway (online payment, refunds), hosting the hub, store apps (Android/iOS/website; the demo page stands in), customer notifications (SMS/WhatsApp)
- [ ] Hosting the hub: setup kit for a free Oracle Cloud VM written (`hub/deploy/`: cloud-init with Node 24, Caddy HTTPS on `<ip>.sslip.io`, service, daily database copy), not yet tried on a real Oracle VM; off-VM copies of the hub database still manual
- [ ] Online orders: not yet tried on a real Windows install with a real printer (docs/HARDWARE_TEST_PLAN.md)
- [x] PINs are exactly 4 digits in the UI (sign-in and approval keypads, setup, users); the backend still accepts 4 to 6 so an older longer PIN keeps working until the owner resets it
- [x] Settings > Users (owner only): add a user with name, role and PIN (typed twice); edit name and role; reset a PIN (also unlocks); change own PIN with the current one; deactivate and reactivate. Unique names among active users; no self-deactivation or own role change; the last owner is protected
- [x] Settings > Store settings (bill logo first, then store details, bill design, footer and a sample, one shared preview): name, address (multi-line), phone, GSTIN (check digit and state checked), FSSAI; owner edits, manager views. Every change is versioned: a bill and its reprints keep the details valid when it was issued
- [x] Bill logo: picture converted to printer dots in the browser (size, darkness, photo mode, live print preview), printed centred at the top of bills (ESC/POS raster), shown in every on-screen receipt
- [x] Default bill design "Classic" (logo, store details, Bill No / Cashier / Token / Date / Time row, Item / Price / Qty / Total, Total Quantity, Gross Total, GST per rate, Net Amount)
- [x] Bill design files (.tiffinreceipt): the owner uploads a design in Settings > Store settings, sees a 58/80 mm preview first, and every bill, reprint, screen receipt and sample uses it; back to standard in one tap. GST bill parts are required; safety marks always print
- [x] Designer kit: format guide (docs/RECEIPT_TEMPLATES.md), three examples (templates/receipt), `npm run receipt` preview with --width/--credit/--duplicate/--upi
- [ ] Bill design follow-ups: table number on the bill (not in the data yet), KOT designs, a CA review of the GST bill check (rupee sign, Hindi and the customer's name and phone are done)
- [ ] Receipt wording for an outlet without GSTIN ("TAX INVOICE" is always printed) and place of supply on IGST bills: needs CA decision
- [x] KOT reprint (marked REPRINT, manager approval), manual cash drawer open (reason, manager approval, audited), X-report (screen and printer, shift stays open), changing the payment mode after billing (an immutable payment_correction; payments are never edited; open shift only; journaled; reports, Z/X cash and daily totals use the corrected mode). Payment corrections need a human and CA review
- [x] Line notes and line discounts in the UI
- [x] Add-on (modifier) groups: Menu creation > Add-on groups (create, edit options and prices, how many to choose, remove) and choosing them per item in the item editor; removed options are switched off, never deleted, so bills keep theirs
- [x] Sold out today: Billing > user menu > Sold out today (cashiers too); greyed out on billing, refused on new bills, hidden from online orders, back by itself the next day
- [ ] Excel (.xlsx) upload directly (today: save as CSV UTF-8)
- [ ] Update prices of existing items in bulk (the upload only adds new items)
- [ ] Live updates through the events stream (the UI polls print failures every 20 s)
- [x] Customer name and phone, buyer GSTIN (entered in Customer and note) and the order channel (App, Website, Swiggy, Zomato) on the bill (classic design; placeholders customer.name, customer.phone, order.channel). Receipt content: needs a human and CA review
- [x] Layout below 1280 px: billing shows the bill as a full screen from a "View bill" bar on phones and handheld POS machines (below 768 px), narrower bill panel on tablets, smaller page margins, wide tables scroll sideways, no tap delay or double-tap zoom. Checked at 1024x768, 800x1280 and 390x844 in Edge with touch emulation
- [ ] Touch and small-screen check on a real handheld POS and a touch-screen PC
- [x] The Electron host loading the built UI (app://pos)

## Android (standalone)
- [x] Same backend as Windows on Node 24 for Android (Termux nodejs-lts 24.18, pinned with SHA-256); node:sqlite, ICU (Indian number format) and scrypt checked on the emulator
- [x] The full POS test suite on the Android emulator: 177 of 184 pass; 5 Windows-only tests skipped; 2 timing tests fail only because the emulator is slow (four processes writing at once; 1,000-line cart speed)
- [x] Android app (Java, no libraries): unpacks the POS once per version, starts it, gatekeeper with a private cookie, file picker (single and multiple), screen kept on; APKs for arm64-v8a, armeabi-v7a, x86_64 (33-38 MB)
- [x] Started on the emulator: backend start-up checks pass, the Set up this shop screen appears and takes input
- [x] Every push builds the Windows installer and the Android APKs on GitHub after all tests pass
- [x] Android printers: Bluetooth (paired) including the built-in printer of Sunmi-type machines ("InnerPrinter"), USB printers through Android's USB host API (asks once to allow), shown in Printer setup and plug-and-play; LAN printers as on Windows (database step 10, transport `android`)
- [x] Android: downloads saved to the Download folder; Print / PDF through Android's print screen; backup copies to a USB stick or SD card (Settings > This device); foreground service keeps the POS running in the background
- [x] Android release signing key (outside the repo) and signed release APKs; GitHub builds signed releases once the key secrets are added
- [x] Android add-ons: the ODS build also makes a `.tiffinaddon` file; Settings > This device > Add-ons > Install from file / Remove (owner); the POS checks signature and fingerprints as on Windows
- [x] GitHub signed Android builds: `android/scripts/github-secrets.ts` prepares the four secrets (outside the repo)
- [ ] Android: printers that need a vendor SDK (PAX, some iMin)
- [ ] Android: printing on a real Bluetooth / USB / Sunmi built-in printer, and the backup copy to a real USB stick (emulator: the print reached the app's printer service, which answered correctly; folder picker needs a person)
- [ ] Android: tried on a real POS machine (speed, printer, power cut during a bill)

## Kitchen tickets (KOT), POS 0.3.11 / ODS 1.0.9
- [x] Prep stations (Menu creation > Prep stations): create, rename, remove; a station gets categories and single items (the item's own station wins); printers list station ids or All stations (old free-text kitchen stations became stations in migration 14)
- [x] KOT split by prep station; only what the kitchen has not had (kot_line per order): ADD-ON KOT n, CANCEL lines, a cleared cart after a KOT prints a cancel ticket; no prices, no delivery/packaging charges
- [x] Settings > Store settings > Kitchen tickets: on prep station printers (default), with the bill (receipt printer, one per station), or off
- [x] Three KOT designs (.tiffinkot): customer KOT (standard = the shop's sample ticket), prep station KOT, online order KOT; upload, preview at 58/80 mm, back to standard (docs/KOT_TEMPLATES.md, templates/kot/)
- [x] Cart KOT button (count of items not sent): send now, or print all again (REPRINT, manager approves); Orders: reprint kitchen ticket
- [x] Online orders: "When an order is accepted, print" the bill and/or the KOT (manual or automatic accept); ODS Bill and KOT buttons (first print free, then a reprint with approval); online KOT shows channel, online number, delivery/pickup, customer
- [ ] KOT on a real kitchen printer (and with the bill on a real receipt printer); table numbers / dine-in on the KOT (the POS has no tables)

