# Add-ons (separately installed modules)

The POS can load **signed add-ons**: modules that ship and install separately from the POS, such as Online Orders. Without them the POS stays a plain offline POS. Code: `src/addons/` (loading), `ui/src/addonHost.ts` + `ui/src/lib/addons.ts` (screens), `addons/<name>/` (each add-on).

## How it fits together

```
TiffinPOS-Setup-0.2.0.exe            -> %LOCALAPPDATA%\Programs\TiffinPOS        (the POS)
TiffinPOS-OnlineOrders-Setup-1.0.0.exe -> %LOCALAPPDATA%\TiffinPOS\addons\online-orders\
                                          manifest.json  backend.cjs  ui.js  uninstall.exe
```

The steps, in order:

1. **On start**, the POS backend reads each `addons/<folder>/manifest.json` (`src/addons/host.ts`), then:
   1. checks the **Ed25519 signature** against the keys in `src/addons/trust.ts`;
   2. checks `minPosVersion` against this POS version (`app.getVersion()`; `-dev` builds accept any version);
   3. checks the **SHA-256 of every file** and uses only those checked bytes;
   4. runs `backend.cjs` with `register(host)`. It may `require` Node built-in modules only, so everything else must be bundled.
2. **Database steps.** The add-on's database steps (`host.migrations`) run once, in order, with checksums, in `addon_migrations`. This is POS migration 6, a separate track from the POS's own migrations.
3. **Routes** live under `/api/addons/<id>/...` and use the POS's sign-in, permissions, `runCommand` (request IDs) and audit.
4. **Screens.** After sign-in, the screens load `ui.js` from `/api/addons/<id>/ui.js`. It calls `window.__POS__.register({ nav, routes, settings, railFooter })`.
5. **When anything fails** (signature, changed file, POS too old, code or database step), that add-on is **switched off with a reason** (`GET /api/addons`). Billing always starts.
6. **The desktop app watches the add-ons folder.** After an install or update it offers "Restart now / Later"; it never restarts on its own, because a bill may be open.

## Rules for writing an add-on

* **Backend:** import only `contract/` (pure code) and **types** from `src/`. Everything else comes from the `HostApi` passed to `register()`:
  * `db`, `runCommand`, `audit`, `assertPerm`, `getSetting`/`setSetting`, `route`, `migrations`, `dataDir`, `onStop`, `AppError`.
  * Importing POS code directly would create a second copy of it inside the add-on: `instanceof AppError` would fail and state would split.
* **Screens:** write normal React. The build maps `react` and `react/jsx-runtime` to the POS's copy (`window.__POS__`). Use `host.useSession()` for `api`, `user` and `notify`, `host.PageShell`/`host.Modal` for layout, and `host.money` to format and parse rupees. The UI never calculates money.
* **Styles:** the POS's Tailwind only contains classes used by the POS itself. Each add-on builds **its own** style sheet from its own source, with the POS theme copied from `ui/src/styles.css` (see `addons/online-orders/scripts/build.mjs`), and injects it.
* **Offline first:** anything that connects to the internet must check the add-on's own switch first (Online Orders: `isOnlineMode`).
* **Data:**
  * Use your own setting keys or tables, created by your own numbered database steps.
  * Never edit a database step that has already run; add a new one.
  * Uninstalling an add-on keeps its data.
* **Versions:** raise `version` in the add-on's `package.json` for every release. Raise `minPosVersion` when the add-on needs something only a newer POS has. Keep `HostApi` and `window.__POS__` backward compatible.

## Signing

* **Private key:** `%USERPROFILE%\.tiffinpos\addon-signing\private.pem`, created on 2026-10-16. It is **not** in the repository. Back it up offline.
  * If it is **lost**, you cannot ship updates that installed POS copies accept until you release a POS with a new key.
  * If it **leaks**, anyone can make add-ons every POS trusts. Remove the leaked key from `trust.ts` and release a POS update.
* **Public key:** in `src/addons/trust.ts`. Several keys may be listed, which allows a key change.
* **Signing at build:** `npm run build` in the add-on signs automatically. `POS_ADDON_SIGNING_KEY` points to a different key file.

## Building and testing (Online Orders)

```bash
cd addons/online-orders
npm install          # once
npm test             # backend logic on a real POS database + the signed package loaded in a real POS
npm run typecheck
npm run build        # -> addons/dist/packages/online-orders (signed)
npm run installer    # -> addons/dist/installers/TiffinPOS-OnlineOrders-Setup-<version>.exe
```

* The add-on installer needs the POS installer to have been built once in `desktop/`, for the icon and the NSIS tool.
* `npm run dev` in the repo root loads add-ons from `addons/dist/packages`.
* Loader tests: `test/addons.test.ts` (signature, changed files, versions, failures, database steps).
