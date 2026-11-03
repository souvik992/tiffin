# Project: Tiffin POS, an offline-first QSR billing system for India (Windows desktop)

Read `RULES.md` first: those rules are non-negotiable. Then `README.md` (guarantees, known gaps), `docs/DECISIONS.md` (why things are the way they are) and `docs/CHECKLIST.md` (what is built, what is not).

## What is where
| Folder | What |
|---|---|
| `src/` | Backend. Zero runtime dependencies, Node 24 type stripping, `node:sqlite`, local HTTP API on 127.0.0.1.<br>Key parts: `core/` (money, GST, GSTIN), `store/schema.ts` (migrations; latest is 14, `kitchen_tickets`: prep_station, category/item.prep_station_id, kot_line, sale_order.kot_count and fulfilment; 13 `session_lock`: app_session.locked_at for the lock button; 12 `counter_extras`: item.unavailable_on, payment_correction + view payment_effective, app_session), `services/` (commands, invoices, shifts, stock, reports, store) and `services/printing/` (ESC/POS, queue, transports, receipt designs). |
| `ui/` | React 19 + Vite + Tailwind billing UI. Hash routes; sidebar: Billing, Menu creation (items, categories, bulk upload, bulk photos), Stock, Purchase, Orders, Reports, Settings (Store settings incl. kitchen tickets, Printer setup, Backups, Coupons, Users for the owner), Menu creation > Prep stations; with the ODS add-on also ODS, Settings > Online orders and Serviceability. |
| `desktop/` | Electron 44 Windows app. The backend runs in a utility process; the UI is on `app://pos`; `/api` is forwarded with a per-launch `X-POS-Secret`. NSIS per-user installer goes to `desktop/release/`. See `desktop/README.md`. |
| `android/` | Standalone Android app (`android/README.md`): the same backend on Node 24 for Android (Termux nodejs-lts, pinned in `node-runtime.json`, renamed to lib*.so by `scripts/prepare.ts`), a gatekeeper (`backend/front.ts`, private cookie) and a Java WebView shell (`app/src/main/java/com/tiffinpos/pos/`: `PosBackend` starts Node, `PrinterBridge` USB/Bluetooth printers incl. Sunmi "InnerPrinter", `BackupCopier` USB/SD backup copies, `AddonInstaller` .tiffinaddon files, `PosService` foreground service; `window.PosAndroid` for downloads, print, backups, add-ons, used via `ui/src/lib/android.ts`). APKs per ABI: arm64-v8a, armeabi-v7a, x86_64. |
| `addons/` | Separately installed, signed modules (`docs/ADDONS.md`). `addons/ods`: Online orders settings, Serviceability (map choice: free OpenStreetMap by default, Google road/satellite/hybrid with the owner's key entered in the same Map card; distance bands, fees with GST, road factor, hours), order hub pairing + connector (outbox, SSE) and the live ODS; own package, tests, build (`npm run build` -> `addons/dist/packages`, plus `addons/dist/installers/TiffinPOS-ODS-<ver>.tiffinaddon` for Android) and installer (`npm run installer`). `addons/edc`: payment machines (Paytm, Pine Labs; wireless or wired; docs/PAYMENT_MACHINES.md), same scripts, needs POS 0.3.8. |
| `hub/` | Online order hub: Node + node:sqlite, SSE to the POS, customer API, demo page `/order/<slug>`, admin page `/admin` (`public/admin.html`: orders of all stores, Swiggy & Zomato (UrbanPiper) per store (`src/urbanpiper.ts`: webhooks `/v1/urbanpiper/<bizId>`, status back, menu/store/items out, outbox), stores with their published settings, connection links `/connect/<code>` that the POS pastes, pause, devices, hub settings in `src/settings.ts`, saved in table `setting`); also the Tiffin backup server (`src/backups.ts`, files on disk per store). DinePOS outlets: sales sync up and licence renewals down (`src/sync.ts`, tables sync_stream, sync_event, store_licence). `hub/README.md`. |
| `contract/` | Online order contract v1 (life cycle `src/order.ts`, shapes, checks, `openapi.yaml`). Hub, POS connector and apps must follow it; see `docs/ONLINE_ORDERS_PLAN.md`. |
| `templates/kot/` | Kitchen ticket designs (`.tiffinkot`): `customer`, `station`, `online`; they must equal `src/services/printing/defaultKotTemplates.ts` (a test checks this). docs/KOT_TEMPLATES.md |
| `templates/receipt/` | Bill designs (`.tiffinreceipt`, JSON). `classic` is the default bill and must equal `src/services/printing/defaultTemplate.ts` (a test checks this). |
| `docs/` | PAYMENT_MACHINES.md (card machines: what each company needs), API.md, DECISIONS.md, CHECKLIST.md, HARDWARE_TEST_PLAN.md, RECEIPT_TEMPLATES.md (bill design format and the shop workflow), ONLINE_ORDERS_PLAN.md (online orders: contract, failure cases, phases; follow it). |

## Commands
| Where | Commands |
|---|---|
| Root | `npm test` (218 tests, 1 opt-in), `npm run typecheck`, `npm start`, `npm run seed` (demo data, mobile/PIN: Owner 9000000001/1234, Manager 9000000002/2345, Cashier 9000000003/1111), `npm run dev` (backend + UI), `npm run restore`, `npm run receipt -- <file.tiffinreceipt> [--width 58] [--credit] [--upi id]`, `node scripts/bench.ts 100000`. |
| `ui/` | `npm run dev`, `npm test`, `npm run typecheck`, `npm run build`. |
| `hub/` | `npm run dev` (local hub + demo store, prints a POS connection link and the admin page key), `npm start`, `npm run admin -- create-store|pairing-code|list|revoke-device`, `npm test`. |
| `addons/ods/` | `npm test`, `npm run typecheck`, `npm run build` (signed package), `npm run installer`. Raise its `version` for each release. |
| `android/` | `node android/scripts/prepare.ts` (after `cd ui && npm run build`), then in `android/`: `gradlew.bat assembleDebug` (or `assembleRelease`, signed with the key in `%USERPROFILE%\.tiffinpos\android-signing`) with `JAVA_HOME` = Android Studio's `jbr`. `node android/scripts/github-secrets.ts` writes the 4 GitHub secrets for signed CI builds into a file next to the key. Emulator AVD `Pixel_10_Pro_XL` (x86_64); start it with `-memory 4096 -cores 4` (2 GB freezes its System UI). |
| CI | `.github/workflows/build.yml`: every push runs all tests, then builds the Windows installer and the Android APKs (artifacts). |
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
- **Rupee sign and Indian scripts** never go to a printer as text: `EscPos` writes a marker (ESC ~ U + JSON, `printing/textPicture.ts`) and the print queue draws it (`printing/textRender.ts`) or falls back to "Rs"/"?". Never send a payload to a transport without `expandPictures`.
- **Payment machines (add-on `edc`):** a machine payment is saved only through `completeCharge` (host `billing.finalize` with the approval as reference); unclear answers are `UNKNOWN`, never `FAILED`. Tests swap connectors with `setConnectorFactory`.
- **Payment modes** are read from the view `payment_effective` (corrections after billing); never `GROUP BY` the `payment` table's mode directly.
- **Text previews** come from `parseEscPos`:
  - `widen` shows double-width text as `D o u b l e`.
  - `[QR code]` and `[LOGO]` mark where those print; `ReceiptLines` in the UI draws the real logo.
- **Every receipt build passes `...designOptions(ctx)`**: the active design, the UPI id and the logo.
- **Bills show the store details valid at issue time** (`storeAt`, `outlet_version` is append-only). Never read the live outlet row for a bill.
- **Restore never swaps the database under a running POS:** it is staged (`src/services/restore.ts`) and `startBackend` restarts itself in place and applies it before opening the database. Online backups (`src/services/cloudBackup.ts`) stay off until the owner pairs and switches them on.
- **Offline mode is the default.** Online orders live in the add-on; anything there that connects out must check `isOnlineMode(host)` (addons/ods/backend/onlineConfig.ts) first.
- **Add-ons:** backend code may import only `contract/` and *types* from `src/` (everything else via `HostApi`); screens use `window.__POS__`; each add-on ships its own Tailwind CSS (the POS CSS only has classes the POS uses), with every utility selector wrapped in `:where()` by its build (`weaken-css.mjs`) so it can never override POS layouts. Signing key: `%USERPROFILE%\.tiffinpos\addon-signing\private.pem`, never in the repo. Android release key: `%USERPROFILE%\.tiffinpos\android-signing\` (release.jks + release.properties), never in the repo.
- **This PC has a real POS install (0.1.1) with real bills.** Never install, upgrade or uninstall the POS here, and never touch `%LOCALAPPDATA%\TiffinPOS`; test with `POS_HOME` temp folders and installers with `/D=<temp>`.
- **Never print test jobs** to the dev PC's personal Windows printers.
- **Android:** only files named lib*.so in the app's native library folder may be run, so Node and its libraries are renamed and their ELF names rewritten (`android/scripts/elf.ts`). Git's `tar` on Windows reads `C:\...` as a remote host: run it with relative paths. Every Android build follows `desktop/package.json`'s version.
- **Android end-to-end tests** drive the debug app's window through WebView DevTools (`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`, then `Runtime.evaluate`): the window's own `fetch` carries the gatekeeper cookie. Grant `BLUETOOTH_CONNECT` and `POST_NOTIFICATIONS` with `pm grant` first, or permission dialogs cover the screen. Files pushed with `adb push` do not show under Recent in the file picker: open the menu, Downloads.
- **Speed tests fail while the emulator or Gradle is running** (they share the CPU). Stop them (`adb emu kill`, `gradlew --stop`) before `npm test`.

## Next planned work (in order)
1. Real-printer checks from `docs/HARDWARE_TEST_PLAN.md` (Posiflex PP8800: logo, drawer, out of paper).
2. Code-signing certificate, update server, licensing (needs the owner's decisions; installer and auto-update are built).
3. Encryption at rest (SQLCipher native module or BitLocker: undecided).
4. Raster text for ₹ and Hindi.
5. Online orders phase 2+ (docs/ONLINE_ORDERS_PLAN.md): customer web app, SMS OTP, payment gateway, hosting the hub; human review of the add-on loader. Swiggy/Zomato through UrbanPiper is built (on main since 0.3.12): test against the pos-int account, then certification.
6. LAN multi-device.
7. Opt-in cloud sync (the outbox table is already written).
