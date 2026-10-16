# POS UI (billing counter)

React + Vite + Tailwind UI for the backend in the parent folder. The look and the five screens come from the Lovable
"Tiffin POS" prototype (https://pos111.lovable.app). Only its compiled site was available, so this is a rebuild that
matches its design and is wired to the backend instead of browser storage.

## Run it (development)

```bash
# once
npm run seed                   # repo root: demo data (Owner/1234, Manager/2345, Cashier/1111)
cd ui && npm install

# every day: one command starts the backend and the UI; Ctrl+C stops both
npm start                      # in ui/   (or `npm run dev` in the repo root)
```

Open http://127.0.0.1:5173. `npm run dev` inside `ui/` starts only the UI (the backend must already run).
`POS_PORT` and `UI_PORT` change the ports. If a port is busy, the launcher says which one and stops.

## Commands

`npm run dev`, `npm run build` (output in `dist/`, relative paths so it also loads from `file://`), `npm test`
(API client against a real in-process backend, plus money formatting), `npm run typecheck`.

## Rules this UI follows

- **No money maths.** Totals, GST, discounts, round-off and change all come from the backend. The UI only formats paise
  and parses what the cashier types (string digits, no floats). See `src/lib/money.ts`.
- **Every change has an idempotency key**, one per user action, reused on network retries and after a manager approval.
  The Charge button keeps its key until the bill succeeds, so a double click or a lost response cannot bill twice.
- **The server is the source of truth for the open bill.** A reload or crash restores the cart from the backend.
- **Manager approval** opens automatically when the backend answers `APPROVAL_REQUIRED` (discount above the limit, reprint).
- **Works offline.** Fonts are bundled; nothing loads from the internet.

## Screens

| Screen | Status |
|---|---|
| Sign in (PIN pad), first-run setup | Built |
| Billing: categories, search and barcode scan, modifiers, quantities, bill discount, Cash/UPI/Card, open and close shift, failed-print alerts | Built |
| Menu creation, Items tab: add and edit items with veg / non-veg / not food, GST, unit, HSN, barcode; search and filters | Built |
| Item photos: choose or drop a photo, resized to 640 px in the browser, shown on the menu table and billing tiles | Built |
| Menu creation, Categories tab: add, rename, kitchen station, reorder, delete when empty | Built |
| Menu creation, Bulk upload tab: template, CSV file or paste, row-by-row check, all-or-nothing import | Built |
| Orders: today's bills, bill detail with print status, print on screen, reprint, cancel bill, refund items | Built |
| Billing: split payment, hold / resume with held-bills list, customer phone and note, after-payment panel with change and live print status | Built |
| Settings, Printer setup: plugged-in USB printers (scan, one-tap "Use for bills"), add/edit in steps (USB, Wi-Fi scan or IP, Bluetooth COM port, screen only; paper width, bills, cash drawer, kitchen stations, data speed, on/off); test page, sample bill, open drawer, retry failed, remove | Built |
| Settings, Receipt: footer text (owner), live sample preview at 58/80 mm, print a sample | Built |
| Reports (manager, owner): 16 reports grouped Sales / Items / Tax / Controls / Inventory, date presets and custom dates, on-screen summary and table with totals, Download CSV, Print / PDF | Built |
| Stock: materials, low-stock filter, wastage / count / correction, movement history | Built |
| Purchase: multi-line purchases with backend-computed amounts, void | Built |
| Recipes (on Menu creation): ingredients per item, deducted on every bill | Built |

What was verified: the flows above were driven in headless Chrome on Windows 11 against a real backend (sign in, open
shift, modifiers, 25% discount with manager approval, cash payment with change, orders, bill detail, add a menu item,
close shift with the unfinished-bill check). Not verified: Electron, touch screens, low-end PCs, screen sizes below 1280 px.
