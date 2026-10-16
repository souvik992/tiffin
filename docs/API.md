# Local HTTP API

Base `http://127.0.0.1:4800`. JSON only. Send `Authorization: Bearer <token>` (from `/api/auth/login`).
Every `POST/PUT/PATCH/DELETE` needs an `Idempotency-Key` header (8-128 chars of `A-Za-z0-9_.:-`) or `requestId` in the body.
Retrying with the same key returns the original result and does nothing twice. Money is integer paise; quantity is thousandths.
Errors: `{ "error": { "code", "message", "details?" } }`. Unknown JSON fields are rejected.

Roles: **C**ashier, **M**anager, **O**wner (M includes C, O includes M). "approval" = a cashier may proceed with `override: {userId, pin}` of a manager/owner.

| Method and path | Who | Notes |
|---|---|---|
| GET `/api/ping`, `/api/login-users` | public | active users (id, name, role, hasMobile) for the approval dialog and for staff without a mobile number; numbers are never shown |
| POST `/api/setup` | public, once | creates outlet, counter, owner, GST groups |
| POST `/api/auth/login` `{ mobile, pin }` (sign-in) or `{ userId, pin }` (unlock after inactivity; staff without a mobile number); `/api/auth/logout`; GET `/api/me` | | an unknown number and a wrong PIN get the same answer |
| GET `/api/catalog`, `/api/items/search?q=`, `/api/items/by-barcode/:code` | C | |
| POST/PATCH/DELETE `/api/items`, POST `/api/categories`, `/api/tax-groups`, `/api/modifier-groups`, PUT `/api/items/:id/modifier-groups` | M | |
| PUT `/api/items/:id/image` `{dataBase64}`; DELETE `/api/items/:id/image` | M | JPEG, PNG or WebP only (checked by content), up to 1 MB; the UI resizes to 640 px first |
| GET `/api/images/:file` | public | photo by its stored name (`<sha256>.jpg/png/webp`) so `<img>` works without a token; any other name is 404; cached as immutable |
| DELETE `/api/categories/:id` | M | refused (`IN_USE`) while the category has items |
| PUT `/api/categories/order` | M | `{ids}` listing every category once, in display order |
| POST `/api/items/import/preview`, `/api/items/import` | M | CSV `name,category,price,tax_percent,hsn,barcode,unit,veg`; all-or-nothing; veg is `veg`, `non-veg` or empty; names already on the menu are refused |
| POST `/api/orders`; GET `/api/orders` (open), `/api/orders/:id` (cart with totals) | C | |
| POST `/api/orders/:id/lines`; PATCH/DELETE `/api/lines/:lineId` | C | discount above limit needs approval |
| PATCH `/api/orders/:id` (customer name and phone, note, buyer GSTIN, place of supply) | C | |
| POST `/api/orders/:id/discount`, `/hold`, `/resume`, `/cancel` | C | |
| PATCH `/api/orders/:id` and DELETE `/api/lines/:lineId` accept `override` | C | a change that pushes an approved discount over the limit needs the manager again |
| POST `/api/orders/:id/finalize` | C | `payments:[{mode,amount,tendered?,reference?}]` must equal the total; returns `print: {receipts, kitchenTickets, warnings}` (`NO_RECEIPT_PRINTER`, `NO_KITCHEN_PRINTER`) |
| POST `/api/orders/:id/payment-check` `{payments}` (no key) | C | read only: `{total, paid, remaining, changeDue, ok, message}` for a split payment |
| GET `/api/orders?status=` (DRAFT or HELD) | C | open bills with `grandTotal`, customer phone, note, cashier |
| GET `/api/invoices/:id/credit-note`; POST `/api/invoices/:id/credit-note/preview` `{lines}` (no key) | C | returnable quantity per line; refund amount computed exactly as the credit note will be |
| GET `/api/invoices`, `/api/invoices/:id` | C | |
| POST `/api/invoices/:id/cancel`, `/credit-note`, `/reprint` | M or approval | cancel: same day, open shift |
| GET `/api/shifts/current`, `/api/shifts/:id/report`; POST `/api/shifts/open`, `/close` | C | close: counted cash, Z-report printed |
| GET `/api/reports/daily`, `/tax`, `/items`, `/invoice-register.csv` (`?from=YYYY-MM-DD&to=`) | M | |
| (desktop app) | | when the backend runs inside the desktop app, every request must carry `X-POS-Secret` (made at each launch, known only to the app; added by its app://pos forwarder). Without it: 403 `BAD_LAUNCH_SECRET`. `npm start` does not use a secret |
| GET `/api/users` | O | everyone with an account, also deactivated (`id, name, role, active, locked, createdAt, you`); never PIN hashes |
| POST `/api/users` `{ name, role, pin }`; PATCH `/api/users/:id` `{ name, role }` | O | names are unique among active users (409 `NAME_TAKEN`: the sign-in screen picks people by name). You cannot change your own role (`OWN_ROLE`); the last owner cannot be demoted (`LAST_OWNER`) |
| POST `/api/users/:id/pin` `{ newPin, currentPin? }` | O / self | the owner resets anyone's PIN (also unlocks); changing your own needs `currentPin` |
| POST `/api/users/:id/deactivate`, `/api/users/:id/reactivate` | O | deactivate signs them out and hides them from sign-in; not yourself (`SELF`), not the last owner. Reactivate keeps their old PIN |
| GET `/api/addons` | C | installed add-ons: `id, name, version, status (active/off), reason, ui` (docs/ADDONS.md) |
| GET `/api/addons/:id/ui.js` | none | an active add-on's screens (checked bytes from its signed package) |
| `/api/addons/ods/config` GET (C) / PUT (O) | | ODS add-on: online mode, channels, order types, payments, accept mode |
| `/api/addons/ods/serviceability` GET (M) / PUT (O) | | location, delivery areas, packaging fee, pickup, hours (contract/src/serviceability.ts); errors in `details.fields` |
| GET `/api/addons/ods/tiles/:z/:x/:y.png` (none) | | map tiles through the POS; only in online mode (cached tiles work offline) |
| GET `/api/addons/ods/geocode?q=&near=lat,lng&full=1&session=` (O) | | place suggestions `[{ label, detail, lat, lng, placeId }]`: Google Places with the owner's key, else Photon; `full=1` (Enter) may also ask Nominatim |
| GET `/api/addons/ods/geocode/place?id=&session=` (O) | | the location of a suggestion that came without one (Google) |
| Serviceability `maps` | | GET: `{ provider: google/osm, attribution }` |
| GET `/api/addons/ods/api-keys`; PUT `{ google: key or null }` | O | `{ google: { set, hint } }` (never the key); null removes it |
| POST `/api/addons/ods/api-keys/test` | O | `{ search: { ok, message }, map: { ok, message } }`; 409 in offline mode |
| Serviceability also carries `roadFactor` (1.00-2.00) and `feeTaxGroupId` (GST group for fees) | | |
| GET `/api/addons/ods/tax-groups` | C | GST groups to choose for delivery/packaging fees |
| GET `/api/addons/ods/hub` (C); POST `/hub/pair` `{ hubUrl, code }` (O); DELETE `/hub` (O) | | order hub link: `paired, hubUrl, store, state, lastError, accepting`; https only (http only for a hub on this PC) |
| GET `/api/addons/ods/orders` (C); GET `/events` (C, SSE `event: ods`, data `{ link, orders }`) | | online orders kept on this POS, with `posPrice` for new ones; the ODS screen's live feed |
| POST `/api/addons/ods/orders/:id/accept` `{ prepMinutes, acceptPriceChange? }` | C | GST bill + KOT, then the hub is told (outbox) |
| POST `/api/addons/ods/orders/:id/reject` `{ reason, reasonText? }`; `/step` `{ to, rider?, reasonText?, override? }` | C (cancel: M approval) | PREPARING, READY, OUT_FOR_DELIVERY, DELIVERED, PICKED_UP, CANCELLED (cancels the bill) |
| PUT `/api/addons/ods/config` with `enabled: false` | O | 409 `ONLINE_ORDERS_OPEN` while an online order is open (F15) |
| GET `/api/store` | M | store details printed on bills (name, address, phone, GSTIN, FSSAI, state code) and the logo size |
| PUT `/api/store` `{ name, address, phone, gstin, fssaiNo }` | O | for bills issued from now on (earlier bills keep theirs: `outlet_version`). GSTIN check digit and state are checked; errors in `details.fields` |
| PUT `/api/store/logo` `{ width, height, bitsBase64 }`; DELETE `/api/store/logo` | O | bill logo: 1 bit per dot, 1 = black, rows of width/8 bytes, width 8..384 in steps of 8, height 8..240 |
| GET `/api/store/logo.png` | none | the logo as it prints (black and white PNG), for previews |
| GET `/api/receipt-design` | M | the bill design in use: `{ active: { name, description, fileName, uploadedAt, uploadedBy } | null, extension }` |
| POST `/api/receipt-design/preview` `{ fileName, content, widthMm }` | O | checks a `.tiffinreceipt` file and returns the sample bill it prints (`lines`); nothing is saved. Invalid: 400 `VALIDATION` with `details.errors` (plain sentences) |
| PUT `/api/receipt-design` `{ fileName, content }`; DELETE `/api/receipt-design` | O | use the design for every new bill / back to the standard layout (audited). Format: docs/RECEIPT_TEMPLATES.md |
| GET `/api/reports/catalog` | M | the store reports: key, title, group, description, usesDates |
| GET `/api/reports/view/:key?from=YYYY-MM-DD&to=` | M | one report as a table: columns (with type), rows, totals, summary; money in paise; IST days; at most 3 years |
| GET `/api/reports/csv/:key?from=&to=` | M | the same report as CSV for Excel (UTF-8 BOM, CRLF, rupees as plain numbers, TOTAL row, formula-safe text), with a `Content-Disposition` file name |
| GET/POST `/api/printers`, PATCH/DELETE `/api/printers/:id`, POST `/api/printers/:id/test` | C read, M manage | transport `spooler` (USB, address = Windows printer name), `tcp` (Wi-Fi/LAN, `ip[:port]`), `serial` (Bluetooth/COM, `COM5[:baud]`), `usb` (driverless USB, `vid:pid[:serial]`), `memory` (screen only), `file` (plain file name inside the data folder). DELETE turns a printer with print history off instead of deleting it; turning a printer off moves its waiting jobs to FAILED |
| GET `/api/printers/usb-devices[?refresh=1]` | M | every USB printer plugged in now (driverless and Windows printers), with the printer it is set up as |
| GET `/api/printers/sample-receipt?width=` (58 or 80); POST `/api/printers/:id/sample`, `/api/printers/:id/drawer` | M | sample receipt marked "SAMPLE - NOT A BILL" (text or printed); cash drawer test (no paper). Both refuse a printer that is off |
| POST `/api/printers/:id/retry-failed` | C | puts every failed job of the printer back in the queue |
| GET `/api/printers/detected`; POST `/api/printers/detected/dismiss` `{key}`; POST `/api/printers/quick-add` `{key, override?}` | C (quick-add: M or approval) | plug and play: USB printers plugged in but not set up (scanned at most every 15 s, only when asked); quick-add creates the printer (the first one becomes the receipt printer) and queues a test page |
| GET `/api/printers/windows`, `/api/printers/serial-ports`; POST `/api/printers/discover` `{port?}` | M | installed Windows printers (with USB/network/Bluetooth/virtual label), COM ports (Bluetooth flagged), and a scan of this PC's private /24 for a printer port (default 9100) |
| GET `/api/print/jobs[?status=]`, POST `/api/print/jobs/:id/retry` | C | jobs include `invoiceNo`, `tokenNo`, `printerName`; retry refuses a job whose printer is off |
| GET `/api/invoices/:id/receipt?width=` (58 or 80), `/api/invoices/:id/prints` | C | receipt as text lines, exactly as printed (on-screen / browser print); print jobs of a bill with status |
| GET `/api/stock/items[?low=1]`, `/api/stock/items/:id/movements` | C | quantities in thousandths of the unit (`kg`,`g`,`l`,`ml`,`pcs`); `low` also includes negative balances |
| POST `/api/stock/items`; PATCH/DELETE `/api/stock/items/:id` | M | unit cannot change; delete refused while used in a recipe |
| POST `/api/stock/items/:id/adjust` | M | `{kind, qtyMilli, reason}` with kind WASTAGE, COUNT or ADJUST; COUNT sets the balance; ADJUST is signed |
| POST `/api/purchases/preview` (no key); GET `/api/purchases`, `/api/purchases/:id` | C | preview returns line amounts and total (paise, half up) so the UI never multiplies money |
| POST `/api/purchases`, `/api/purchases/:id/void` | M | `lines:[{stockItemId, qtyMilli, unitCost}]`, unitCost in paise per whole unit; purchases are immutable, void reverses stock |
| GET `/api/recipes`, `/api/recipes/:itemId`; PUT `/api/recipes/:itemId` | C read, M write | ingredients per ONE menu item; bills deduct them |
| GET `/api/events` | C | Server-Sent Events: `invoice`, `print` (use fetch streaming; header auth) |
| POST `/api/users`, `/api/users/:id/pin`, `/deactivate` | O (own PIN: self) | |
| POST `/api/backup` | O | returns `{file, bytes, verified, kind, images: {referenced, copied, missing}}`; photos go to `backups/images` |
| GET/PUT `/api/settings`; GET `/api/health[?deep=1]`; GET `/api/backups`; POST `/api/journal/repair`; GET `/api/audit`, `/api/audit/verify` | O | |
