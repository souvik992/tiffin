# Add-ons (separately installed modules)

The POS can load **signed add-ons**: modules that ship and install separately from the POS, such as ODS. Without them the POS stays a plain offline POS. Code: `src/addons/` (loading), `ui/src/addonHost.ts` + `ui/src/lib/addons.ts` (screens), `addons/<name>/` (each add-on).

## How it fits together

```
TiffinPOS-Setup-0.3.0.exe            -> %LOCALAPPDATA%\Programs\TiffinPOS        (the POS)
TiffinPOS-ODS-Setup-1.0.1.exe -> %LOCALAPPDATA%\TiffinPOS\addons\ods\
                                          manifest.json  backend.cjs  ui.js  uninstall.exe
```

The steps, in order:

1. **On start**, the POS backend reads each `addons/<folder>/manifest.json` (`src/addons/host.ts`), then:
   1. checks the **Ed25519 signature** against the keys in `src/addons/trust.ts`;
   2. checks that the folder name equals the add-on's id;
   3. checks `minPosVersion` against this POS version (`app.getVersion()`; `-dev` builds accept any version);
   4. refuses a version **older** than one this POS already ran (setting `addon_version:<id>`), so an old package with a known fault cannot be put back;
   5. checks the **SHA-256 of every file** and uses only those checked bytes;
   6. runs `backend.cjs` with `register(host)`. It may `require` Node built-in modules only, so everything else must be bundled.
2. **Database steps.** The add-on's database steps (`host.migrations`) run once, in order, with checksums, in `addon_migrations`. This is POS migration 6, a separate track from the POS's own migrations. Each step is checked first (`sqlProblem`): it may only create or change tables named `<id>_...`, and ATTACH, PRAGMA, VACUUM and REINDEX are refused.
3. **Routes** live under `/api/addons/<id>/...` and use the POS's sign-in, permissions, `runCommand` (request IDs) and audit.
4. **Screens.** After sign-in, the screens load `ui.js` from `/api/addons/<id>/ui.js`. It calls `window.__POS__.register({ nav, routes, settings, railFooter })`.
5. **When anything fails** (signature, changed file, POS too old, code or database step), that add-on is **switched off with a reason** (`GET /api/addons`). Billing always starts.
6. **The desktop app watches the add-ons folder.** After an install or update it offers "Restart now / Later"; it never restarts on its own, because a bill may be open.

## Rules for writing an add-on

* **Backend:** import only `contract/` (pure code) and **types** from `src/`. Everything else comes from the `HostApi` passed to `register()`:
  * `db`, `runCommand`, `audit`, `assertPerm`, `getSetting`/`setSetting`, `route`, `migrations`, `dataDir`, `onStop`, `AppError`.
  * `billing` (POS 0.3.0): `bill` (an online order becomes a normal GST bill + KOT, with delivery/packaging fee lines), `cancel`, `shiftActor`, `menu`.
* **Screens** may use `host.stream(path, onEvent, onStatus)` (POS 0.3.0) for a live feed; check it exists first.
  * Importing POS code directly would create a second copy of it inside the add-on: `instanceof AppError` would fail and state would split.
* **Screens:** write normal React. The build maps `react` and `react/jsx-runtime` to the POS's copy (`window.__POS__`). Use `host.useSession()` for `api`, `user` and `notify`, `host.PageShell`/`host.Modal` for layout, and `host.money` to format and parse rupees. The UI never calculates money.
* **Styles:** the POS's Tailwind only contains classes used by the POS itself. Each add-on builds **its own** style sheet from its own source, with the POS theme copied from `ui/src/styles.css` (see `addons/ods/scripts/build.mjs`), and injects it.
* **Offline first:** anything that connects to the internet must check the add-on's own switch first (ODS: `isOnlineMode`).
* **Secrets:** name a setting `<id>_..._key` for anything secret (API keys, device keys). The POS never lists such settings to the screens; keep them out of responses and audit details too.
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

## Building and testing (ODS)

```bash
cd addons/ods
npm install          # once
npm test             # backend logic on a real POS database + the signed package loaded in a real POS
npm run typecheck
npm run build        # -> addons/dist/packages/ods (signed)
npm run installer    # -> addons/dist/installers/TiffinPOS-ODS-Setup-<version>.exe
```

* The add-on installer needs the POS installer to have been built once in `desktop/`, for the icon and the NSIS tool.
* **Android:** `npm run build` also writes `addons/dist/installers/TiffinPOS-ODS-<version>.tiffinaddon` (the three signed
  files, zipped). In the Android app: Settings > This device > Add-ons > Install from file (owner). The app only unpacks
  it into its `pos-addons` folder and restarts the POS; the loader checks signature, fingerprints and version as on Windows.
* `npm run dev` in the repo root loads add-ons from `addons/dist/packages`.
* Loader tests: `test/addons.test.ts` (signature, changed files, versions, failures, database steps).

## Security review of the loader

An add-on runs **inside the POS backend with full access**: the database, files and network. The signature is the real
protection. Whoever holds the signing key can ship code to every shop. What the loader does on top:

| Risk | What stops it | Test |
|---|---|---|
| A package that was not made by us | Ed25519 signature against keys built into the POS | `test/addons.test.ts` |
| A file changed after signing | SHA-256 per file; only the checked bytes are run | same |
| Putting back an older, faulty version | Anti-rollback: `addon_version:<id>` | same |
| A package copied into another add-on's folder | Folder name must equal the id | same |
| An add-on database step that changes bills, payments or users | `sqlProblem`: only `<id>_` tables; no ATTACH/PRAGMA/VACUUM/REINDEX | same |
| A broken add-on stopping billing | Each failure switches that add-on off with a reason; the POS starts anyway | same |
| Add-on routes without sign-in | Routes are signed-in by default; `auth: false` only for map tiles | add-on tests |
| An add-on connecting out in offline mode | Each outgoing call checks `isOnlineMode` | add-on tests |

**Known limits.** These need a person to judge them; the code review by Claude does not replace a human review.

* `sqlProblem` reads the SQL text. It is a safety net against mistakes, not a sandbox. The backend code itself can still run any SQL through `host.db`.
* There is no sandbox (no separate process or permissions per add-on). A signed add-on is fully trusted.
* The signing key sits on the developer PC (`%USERPROFILE%.tiffinposaddon-signing`). A leak means a POS update with a new key. A hardware key or a separate signing PC would be safer.
* Anti-rollback is kept in the POS database. Restoring an old backup also restores the old "highest version seen".

**For the human reviewer:** `src/addons/host.ts` (`loadAddons`, `makeHost`, `applyAddonMigrations`, `sqlProblem`), `src/addons/manifest.ts`, `src/addons/trust.ts`, `desktop/src/main.ts` (folder watch, `/api` forwarding) and `src/services/onlineBilling.ts` (bills made for add-ons).
