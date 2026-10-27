# POS backend: offline-first QSR billing (Windows desktop target)

A zero-dependency TypeScript backend for a quick-service-restaurant POS in India. It runs **on the shop's own PC**
with no server, no cloud and no internet. GST billing, split payments, shifts, credit notes, thermal-printer
ticketing, backups and crash recovery are all here and tested. A local HTTP API is exposed on `127.0.0.1` for the
React UI (or an Electron host can call the service layer directly).

* **Runtime dependencies: none.** Node.js built-ins only (`node:sqlite`, `node:http`, `node:crypto`, `node:net`, `node:zlib`).
* **Node 22.18+** (runs `.ts` files directly; Node 24 LTS also works). `node:sqlite` is still flagged experimental by Node, so pin the Node version you ship.
* Dev dependencies: `typescript`, `@types/node` (type checking only).

## Quick start

```bash
npm install            # dev dependencies only (typecheck)
npm run seed           # demo data: Owner 9000000001/1234, Manager 9000000002/2345, Cashier 9000000003/1111 (mobile/PIN)  (DEVELOPMENT ONLY)
npm start              # http://127.0.0.1:4800   (POS_DATA_DIR, POS_PORT to override)
npm test               # 224 tests (1 opt-in), about 60 seconds on Windows
npm run receipt -- <file.tiffinreceipt> [--width 58]   # check a shop's bill design and show it on sample paper
npm run restore        # list backups; `npm run restore -- <file>` restores one (POS stopped)
npm run typecheck      # strict TypeScript
node scripts/bench.ts 100000   # performance measurements
```

The billing UI lives in `ui/`. Install it once with `cd ui && npm install`. Then `npm run dev` in the repo root (or `npm start` in `ui/`) starts the backend and the UI together; open http://127.0.0.1:5173 and press Ctrl+C to stop both.

The Windows desktop app (installer, one window, no Node.js needed on the shop PC) lives in `desktop/`: see `desktop/README.md`. `npm run dist` there builds `TiffinPOS-Setup-<version>.exe`.

For a real shop, do not run the seed. `POST /api/setup` creates the outlet, counter and owner on first run.

## Layout

```
src/core/       pure logic, no I/O: money, GST tax, discounts, numbering, UUIDv7  (the part a CA must validate)
src/store/      SQLite schema, migrations (checksummed), transactions
src/services/   commands: auth, catalog, orders, invoices, shifts, reports, journal, backup, health, stock (inventory)
  printing/     ESC/POS builder, receipt/KOT templates, virtual printer, persistent queue, transports (USB via Windows spooler RAW, Wi-Fi/LAN TCP 9100, Bluetooth/COM serial, file, memory), printer discovery
src/http/       local API: routing, strict validation, security checks
src/app.ts      startBackend(): used by `npm start` (src/main.ts) and the desktop app
src/startup.ts  integrity check, queue recovery, journal repair/compaction, backup schedule
test/           224 tests, including child-process kill tests and multi-process concurrency
scripts/bench.ts
addons/         separately installed signed modules (docs/ADDONS.md): ods (online orders, serviceability, live ODS)
hub/            the online order hub (hub/README.md)
desktop/        Windows desktop app (Electron host, installer, auto-update): see desktop/README.md
ui/             React billing UI (see ui/README.md): talks to the local API, never calculates money
docs/           API.md, DECISIONS.md, HARDWARE_TEST_PLAN.md, RECEIPT_TEMPLATES.md (bill design files)
templates/receipt/  example bill designs (.tiffinreceipt)
```

## What is guaranteed, and how it is proven

| Guarantee | Mechanism | Test |
|---|---|---|
| A bill is whole or absent, never partial | One `BEGIN IMMEDIATE` transaction: invoice, lines, payments, number, summary, audit, outbox, print jobs | `SIGKILL` at 5 points inside finalize; state checked after restart |
| Committed bills survive a kill or power cut | WAL with `synchronous=FULL` | kill after commit; reopen |
| Invoice numbers are gapless and unique | Allocated inside the same transaction; unique indexes | 4 OS processes billing at once: 100 unique contiguous numbers |
| A network/UI retry never double-bills | Every change carries a `requestId`; replay returns the original result | same id twice; different id on a billed order |
| Finalized documents cannot be edited | Database triggers on invoice, lines, payments | direct SQL attempts are rejected |
| Money never drifts | Integer paise, BigInt intermediates, largest-remainder discounts, exact remainders on partial returns | 5,000 random invoices; credit notes 99.01 + 99.01 + 98.98 = 297.00 |
| Lost database is recoverable | Verified online backups + fsynced daily journal outside the DB; `npm run restore` keeps the old database aside, restores, and replays the journal | restore backup, replay journal: identical invoices, totals, numbering continues; the restore command run as a child process |
| Backups leave the device | Every backup is also copied (and checked again) to a USB drive or folder the owner chooses, and/or uploaded to the Tiffin backup server (gzipped, SHA-256 checked, photos included). Settings > Backups restores from any of them with the owner's PIN: the POS restarts itself, keeps the current data aside and replays later bills | copy with a pulled-out drive; upload, wrong code, damaged upload, retention; restore from this device and from online (photos come back) through the API with the in-place restart; another shop's backup does not mix journals |
| Menu photos are backed up and restored | Photos stay files (never in the database). Each backup copies the photos it uses into `backups/images` (only new ones; checked against their SHA-256 name); restore copies them back | backup, prune, restore and the restore command with photos |
| Printing never blocks or loses a receipt | Persistent queue, strict order per printer, backoff 1s/3s/10s, restart recovery | simulated offline printer; a real TCP printer socket |
| Tampering is detectable | Hash-chained audit log | edited row detected |
| Stock is never lost or silently wrong | Append-only stock ledger (triggers) in the same transaction as the bill or purchase; balances verified against the ledger; stock journaled and replayed | recovery from backup + journal gives identical balances; tampered balance detected |

## Security (local API)

Binds to `127.0.0.1` only. Bearer-token sessions that never end by time (only sign-out, deactivation or the lock button; the lock survives restarts). PINs hashed with scrypt, lockout with backoff
(failed manager-approval PINs count even when the command rolls back). Role permissions plus manager approval
for discounts above the limit, cancellations, credit notes and reprints. `Host` header allow-list (DNS rebinding),
`Content-Type: application/json` required for writes (blocks cross-site form posts), unknown JSON fields rejected,
2 MB body limit, no stack traces in responses, CSV export neutralises spreadsheet formulas.

## Measured performance (this sandbox, NOT the target hardware)

| Measure | Target | Result |
|---|---|---|
| Item search, 20,000 items | p95 < 50 ms | 4 to 10 ms |
| Add item to a 1,000-line cart | p95 < 50 ms | 12 to 22 ms |
| Finalize a typical bill, 600,000 invoices in the DB | p95 < 150 ms | 4 ms |
| Finalize a 1,000-line bill (about Rs 17 crore) | completes | 120 to 170 ms, no overflow |
| History screen, 600,000 invoices | < 1 s | about 3 ms |
| Online backup + verify, 513 MB | n/a | 2.5 s |
| Database size | n/a | 0.9 KB per (2-line) invoice, so about 2.4 GB for 2.7 M bills |
| Journal size | n/a | 2.5 KB per bill raw, about 130 bytes gzipped (old days are compressed automatically) |

These ran on a server-class CPU. A Celeron-class PC with a hard disk can be several times slower:
re-run `scripts/bench.ts` on it before promising numbers. A 1,000,000-invoice run ended abnormally after the insert
step in this sandbox and was not investigated, so the largest verified volume is 600,000 invoices.

## Known gaps (not done, or not verifiable here)

* **No encryption at rest.** `node:sqlite` has no SQLCipher. Plan: SQLCipher-compatible build in the Electron host plus a recovery key.
* **Plug and play USB.** Plug a USB receipt printer in and the billing screen offers it ("Use for bills"); one tap sets it up as the receipt printer and prints a test page. Printers without a Windows driver are written to directly through Windows' built-in USB printer driver (usbprint.sys), found by vendor:product id so any USB port works. Verified on this PC: the device scan (checked against real USB devices) and the "not connected" path; no USB receipt printer has printed yet.
* **Printers: USB, Wi-Fi and Bluetooth.** USB printers with a driver print RAW through the Windows spooler, Wi-Fi/LAN printers over TCP port 9100, Bluetooth printers through their outgoing COM port. The Printers screen lists installed Windows printers and COM ports and scans the PC's own network for printers. Verified here: TCP printing end to end (a test page and a receipt reached a network printer socket), and the Windows error paths (unknown printer, unknown COM port). Not verified: any physical USB, Wi-Fi or Bluetooth receipt printer (see `docs/HARDWARE_TEST_PLAN.md`).
* **No real printer or Electron testing.** ESC/POS output is verified byte-by-byte with a virtual printer and over TCP. The test suite passes on one Windows 11 developer PC (Node 24.21), including the kill and multi-process tests; the target low-end machines are untested. The Windows spooler (RAW) transport is built, and on Windows its failure path (unknown printer) is tested against the real spooler. A successful RAW job has not been sent to any printer yet: run the opt-in test with `POS_TEST_SPOOLER_PRINTER` set. Each printer model needs the checks in `docs/HARDWARE_TEST_PLAN.md`. Bluetooth/COM is not built.
* **Hindi and other scripts, and the rupee sign, print as `?`/`Rs` in text mode.** The host must render raster bitmaps (the raster command and printer flag exist).
* **UPI payments are recorded, not confirmed** (cashier confirms). Card machines: reference entry only. No payment gateway.
* **GST rules are configuration and my understanding, not legal advice.** A CA must validate rates, rounding (odd paisa to CGST), discount treatment, invoice numbering (16-character limit) and mandatory receipt content.
* Not built yet: Swiggy/Zomato relay, LAN multi-device, cloud sync (the outbox table is written but nothing reads it), licensing, auto-update, installer.
* Inventory: no unit conversion (a recipe uses the material's own unit), no recipes for modifiers, no supplier master or purchase GST input credit, value shown at last purchase cost (not FIFO/average).
* The cart API returns the whole cart on each change (about 300 KB at 1,000 lines). Fine on localhost; add a delta response if the UI needs it.
* Sessions are in memory (a restart signs everyone out; bills are safe).
* No Windows 7/8 verification; `node:sqlite` needs a supported Node runtime.
