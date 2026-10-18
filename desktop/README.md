# Tiffin POS for Windows (desktop app)

An Electron app that wraps the POS: one window showing the billing UI, with the backend running inside it.
No Node.js, browser or command line is needed on the shop PC: the shop runs the installer and opens **Tiffin POS** from the desktop.

## Build

Run once:

```bash
cd ui && npm install                 # the UI
cd ../desktop && npm install         # Electron, esbuild, electron-builder
```

Then, in `desktop/`:

| Command | What it does |
|---|---|
| `npm start` | builds, then opens the app (development; dev tools on Ctrl+Shift+I) |
| `npm run dist` | builds the installer: `release/TiffinPOS-Setup-<version>.exe` (about 130 MB; packed for fast installs on low-end PCs, see below) |
| `npm run dist:dir` | builds the unpacked app only: `release/win-unpacked/TiffinPOS.exe` (fast, for testing) |
| `npm test` | unit tests (URL mapping, secret header, navigation rules) |
| `npm run test:e2e` | builds, then drives the real app: sign-in, a bill with live print status, reports, lockdown, crash restart, single copy, clean close |
| `npm run typecheck` | strict TypeScript |
| `npm run icon` | redraws `build/icon.png` (the orange "T") |

To test a packaged or installed build, set `POS_E2E_EXE` to its `TiffinPOS.exe` and run `node --test test/app.e2e.test.ts`.
The test uses a temporary data folder (`POS_HOME`) with virtual printers only.

To ship a new version, raise `version` in `desktop/package.json`, then run `npm run dist`.

## How it works

```
TiffinPOS.exe
├─ main process (src/main.ts)       window, app://pos scheme, starts/stops/restarts the backend, logs, updates
├─ backend utility process          src/backend.ts → ../src/app.ts: the same backend as `npm start`
│    on 127.0.0.1:<random port>, every request must carry a secret made at each launch
└─ window (sandboxed, no Node)      the ui/ build, loaded from app://pos/index.html
```

* **app://pos.** The window's own origin. `app://pos/api/...` is forwarded by the main process to the backend, adding the secret. Everything else is a file from the UI build. The UI is unchanged: it calls `/api/...`, exactly as behind the Vite dev proxy.
* **Lockdown:**
  * context isolation, sandbox and no Node in the page
  * no navigation away from app://pos and no pop-ups (https links open in the normal browser)
  * every permission request is refused
  * a strict Content-Security-Policy and no application menu
  * dev tools are off in installed builds
* **One copy only.** Opening the app again focuses the running window, because two copies on one database are unsafe.
* **Crashes:**
  * If the backend process dies, it restarts (3 tries) and the window reloads. Cashiers sign in again, and saved bills are safe.
  * If the window crashes, it reloads.
* **Closing.** The backend stops cleanly: the print queue stops, a closing backup is taken and the database closes. Then the app exits. If that takes more than 20 s, the app exits anyway; bills were already committed.
* **Start-up failure** (for example, the database fails its integrity check): a message shows where the data and backups are, with an "Open data folder" button.

## Where things are on the shop PC

| What | Where |
|---|---|
| App | `%LOCALAPPDATA%\Programs\TiffinPOS` (per-user install, **no administrator needed**) |
| Bills database, journal, backups, menu photos | `%LOCALAPPDATA%\TiffinPOS\data` (local, not roaming: never synced by a domain profile) |
| Log | `%LOCALAPPDATA%\TiffinPOS\logs\pos.log` (rotates at 5 MB) |
| Shortcuts | Desktop and Start menu: "Tiffin POS" |

**Uninstalling never deletes the data folder.** To move a shop to a new PC, copy `%LOCALAPPDATA%\TiffinPOS\data`.
`POS_DATA_DIR` (data folder) and `POS_HOME` (data, logs and Electron profile) override these locations.

## Code signing (needed before giving it to shops)

The installer is **unsigned** today. Windows SmartScreen shows "Windows protected your PC" until it is signed and has a reputation.

1. Buy a code-signing certificate. An OV certificate is enough with Azure Trusted Signing or a cloud HSM; EV gets SmartScreen reputation fastest.
2. Build with the certificate in the environment:
   ```powershell
   $env:CSC_LINK = "C:\secure\tiffin.pfx"; $env:CSC_KEY_PASSWORD = "..."
   $env:POS_PUBLISHER = "Your Company Pvt Ltd"   # the certificate's CN: updates signed by anyone else are refused
   npm run dist
   ```
3. Check it: `Get-AuthenticodeSignature release\TiffinPOS-Setup-<version>.exe` should print `Valid`.

Never commit the certificate or its password.

## Auto-update

1. Choose an HTTPS folder you control, for example `https://updates.example.in/pos/`.
2. Build with `POS_UPDATE_URL` set to it (and signed, as above):
   ```powershell
   $env:POS_UPDATE_URL = "https://updates.example.in/pos/"; npm run dist
   ```
3. Upload `release/latest.yml` and `TiffinPOS-Setup-<version>.exe` (and its `.blockmap` if one was built) to that folder.
   Updates download the whole installer: it is packed as zip for installs about twice as fast on low-end PCs,
   which rules out downloading only the changed parts (docs/DECISIONS.md).

How shops receive it:
* Installed apps check 1 minute after start, then every 6 hours. Being offline is fine.
* The update downloads in the background and shows a notice.
* It **installs when the POS is closed**, never in the middle of billing.
* electron-updater refuses an update whose signature does not match the installed publisher.

A build without `POS_UPDATE_URL` never checks for updates.

## Not done yet

* **Code-signing certificate:** none yet. This is a purchase plus company identity checks (see above).
* **Update server:** not set up. Any static HTTPS host works.
* **Licensing:** not built. It needs a decision on the model (per outlet or per counter, trial, offline grace period) and a licence server.
* **Encryption at rest (SQLCipher):** not built. `node:sqlite` cannot open an encrypted database. It needs a SQLCipher-capable SQLite build (a native module) plus a recovery key. See `docs/DECISIONS.md`.
* **Tested on one PC only:** one Windows 11 developer PC, without admin rights. Not tested on low-end shop PCs or touch screens. Not tested with a real receipt printer from inside the app. See `docs/HARDWARE_TEST_PLAN.md`.
