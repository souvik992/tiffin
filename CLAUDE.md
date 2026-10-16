# Project: Tiffin POS, an offline-first QSR billing system for India (Windows desktop)

Read `RULES.md` first: those rules are non-negotiable. Then `README.md` (guarantees, known gaps), `docs/DECISIONS.md` (why things are the way they are) and `docs/CHECKLIST.md` (what is built, what is not).

## What is where
| Folder | What |
|---|---|
| `src/` | Backend. Zero runtime dependencies, Node 24 type stripping, `node:sqlite`, local HTTP API on 127.0.0.1.<br>Key parts: `core/` (money, GST, GSTIN), `store/schema.ts` (migrations; latest is 9, `coupons`), `services/` (commands, invoices, shifts, stock, reports, store) and `services/printing/` (ESC/POS, queue, transports, receipt designs). |
| `ui/` | React 19 + Vite + Tailwind billing UI. Hash routes; sidebar: Billing, Menu creation, Stock, Purchase, Orders, Reports, Settings (Store, Printer setup, Receipt, Coupons, Users for the owner); with the ODS add-on also ODS, Settings > Online orders and Serviceability. |
| `desktop/` | Electron 44 Windows app. The backend runs in a utility process; the UI is on `app://pos`; `/api` is forwarded with a per-launch `X-POS-Secret`. NSIS per-user installer goes to `desktop/release/`. See `desktop/README.md`. |
| `addons/` | Separately installed, signed modules (`docs/ADDONS.md`). `addons/ods`: Online orders settings, Serviceability (map, distance bands, fees with GST, road factor, hours), Settings > API keys (owner: Google Maps key for map + place search; OpenStreetMap without it), order hub pairing + connector (outbox, SSE) and the live ODS; own package, tests, build (`npm run build` -> `addons/dist/packages`) and installer (`npm run installer`). |
| `hub/` | Online order hub: Node + node:sqlite, SSE to the POS, customer API, demo page `/order/<slug>`. `hub/README.md`. |
| `contract/` | Online order contract v1 (life cycle `src/order.ts`, shapes, checks, `openapi.yaml`). Hub, POS connector and apps must follow it; see `docs/ONLINE_ORDERS_PLAN.md`. |
| `templates/receipt/` | Bill designs (`.tiffinreceipt`, JSON). `classic` is the default bill and must equal `src/services/printing/defaultTemplate.ts` (a test checks this). |
| `docs/` | API.md, DECISIONS.md, CHECKLIST.md, HARDWARE_TEST_PLAN.md, RECEIPT_TEMPLATES.md (bill design format and the shop workflow), ONLINE_ORDERS_PLAN.md (online orders: contract, failure cases, phases; follow it). |

## Commands
| Where | Commands |
|---|---|
| Root | `npm test` (183 tests, 1 opt-in), `npm run typecheck`, `npm start`, `npm run seed` (demo data, mobile/PIN: Owner 9000000001/1234, Manager 9000000002/2345, Cashier 9000000003/1111), `npm run dev` (backend + UI), `npm run restore`, `npm run receipt -- <file.tiffinreceipt> [--width 58] [--credit] [--upi id]`, `node scripts/bench.ts 100000`. |
| `ui/` | `npm run dev`, `npm test`, `npm run typecheck`, `npm run build`. |
| `hub/` | `npm run dev` (local hub + demo store, prints a pairing code), `npm start`, `npm run admin -- create-store|pairing-code|list|revoke-device`, `npm test`. |
| `addons/ods/` | `npm test`, `npm run typecheck`, `npm run build` (signed package), `npm run installer`. Raise its `version` for each release. |
| `desktop/` | `npm start`, `npm test`, `npm run test:e2e`, `npm run typecheck`, `npm run dist` (installer; raise `version` in `desktop/package.json` for each release). |

## Working style
- Small steps. Write the test first, then the code, then run `npm test` and `npm run typecheck` (and the ui/desktop equivalents if touched) before finishing.
- Imports use `.ts` extensions and `import type` for types. No enums, namespaces or parameter properties (Node type stripping).
- The UI never calculates money. Show backend totals; only format paise and parse typed input (`ui/src/lib/money.ts`).
- Human review is needed for anything touching tax, numbering, payments, backup/restore, auth, the print queue, stock deduction in finalize/cancel, store details or receipt content.
- Keep `docs/CHECKLIST.md` current: tick items when they land, add gaps when found. Update test counts in README.md and here.
- Never claim something works on Windows, on a real printer or in Electron unless it was tested there. Record untested items in `docs/HARDWARE_TEST_PLAN.md`.
- Answer the user in plain language. They are the product owner, not a developer.

## Gotchas learned the hard way
- **VS Code terminal sets `ELECTRON_RUN_AS_NODE=1`.** Electron then behaves as plain Node. The desktop scripts clear it; run `env -u ELECTRON_RUN_AS_NODE` for ad-hoc Electron runs.
- **Bash heredocs and `node -e` mangle backticks, `$` and backslashes.** For multi-line edits, write a `.cjs` script into the scratchpad with the Write tool and run it, or use the Edit tool.
- **C# or PowerShell inside a TS template literal needs doubled backslashes** (`\\` for one `\`). A single `\C` silently becomes `C`; this broke the WinUSB registry path once.
- **Printing goes through constant PowerShell scripts** (`-EncodedCommand`); data travels in environment variables and stdin, never on the command line.
- **USB printers on the WinUSB driver** (e.g. after the Zadig tool) are found from the registry and written via winusb.dll. `probeUsbPrinter` opens a printer without printing.
- **Text previews** come from `parseEscPos`:
  - `widen` shows double-width text as `D o u b l e`.
  - `[QR code]` and `[LOGO]` mark where those print; `ReceiptLines` in the UI draws the real logo.
- **Every receipt build passes `...designOptions(ctx)`**: the active design, the UPI id and the logo.
- **Bills show the store details valid at issue time** (`storeAt`, `outlet_version` is append-only). Never read the live outlet row for a bill.
- **Offline mode is the default.** Online orders live in the add-on; anything there that connects out must check `isOnlineMode(host)` (addons/ods/backend/onlineConfig.ts) first.
- **Add-ons:** backend code may import only `contract/` and *types* from `src/` (everything else via `HostApi`); screens use `window.__POS__`; each add-on ships its own Tailwind CSS (the POS CSS only has classes the POS uses). Signing key: `%USERPROFILE%\.tiffinpos\addon-signing\private.pem`, never in the repo.
- **This PC has a real POS install (0.1.1) with real bills.** Never install, upgrade or uninstall the POS here, and never touch `%LOCALAPPDATA%\TiffinPOS`; test with `POS_HOME` temp folders and installers with `/D=<temp>`.
- **Never print test jobs** to the dev PC's personal Windows printers.

## Next planned work (in order)
1. Real-printer checks from `docs/HARDWARE_TEST_PLAN.md` (Posiflex PP8800: logo, drawer, out of paper).
2. Code-signing certificate, update server, licensing (needs the owner's decisions; installer and auto-update are built).
3. Encryption at rest (SQLCipher native module or BitLocker: undecided).
4. Raster text for ₹ and Hindi.
5. Online orders phase 2+ (docs/ONLINE_ORDERS_PLAN.md): customer web app, SMS OTP, payment gateway, hosting the hub; human review of the add-on loader. Then Swiggy/Zomato relay.
6. LAN multi-device.
7. Opt-in cloud sync (the outbox table is already written).
