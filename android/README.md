# Tiffin POS for Android (standalone)

The full POS runs on the Android device: the **same backend code as Windows** (`src/`), on Node.js 24 for Android, with
its SQLite database and backups in the app's private storage. No PC needed.

```
APK
├── lib/<abi>/libposnode.so + libraries   Node 24 for Android (Termux nodejs-lts, renamed to lib*.so)
├── assets/pos/app/                        src, contract, templates, android/backend (unpacked once per version)
└── assets/pos/ui/                         the React screens (ui/dist)
```

* `MainActivity` (Java, no libraries) starts `PosBackend`, which runs Node with `android/backend/main.ts`:
  the POS backend (random launch secret) plus a **gatekeeper** (`android/backend/front.ts`) on another loopback port.
* The window loads `http://127.0.0.1:<port>/`. Other apps on the device can reach loopback ports too, so the
  gatekeeper answers only requests carrying the app's private cookie (random per start, in the app's own WebView
  cookie jar). It serves the screens and forwards `/api` with the secret, like the desktop app's `app://` protocol.
* One APK per processor type: `arm64-v8a` (most POS machines), `armeabi-v7a` (older 32-bit ones such as Sunmi V2),
  `x86_64` (emulator). About 33-38 MB each.
* Node and its libraries are pinned with SHA-256 in `node-runtime.json` (`node android/scripts/prepare.ts --lock`
  refreshes it; review the diff before committing).

## Build

Needs Node 24, the Android SDK (Android Studio) and Java 17+ (Android Studio's own works).

```
cd ui && npm run build && cd ..
node android/scripts/prepare.ts            # Node runtime (downloaded, checked) + backend + screens
cd android
gradlew.bat assembleDebug                  # Windows (set JAVA_HOME to Android Studio's jbr); ./gradlew on Linux
```

APKs: `android/app/build/outputs/apk/debug/TiffinPOS-<version>-<abi>-debug.apk`. The version follows
`desktop/package.json`, so Windows and Android builds of one commit carry the same number.

Every push to GitHub builds both (`.github/workflows/build.yml`): tests, the Windows installer and the APKs, as downloads
on the run's page.

## What the app adds on Android

* **Printers** (`PrinterBridge.java`, backend side `src/services/printing/android.ts`, transport `android`, database step 10):
  * Bluetooth printers paired with the device, and the **built-in printer of Sunmi-type POS machines** (a paired
    device named "InnerPrinter", shown as "Built-in printer"). Needs the Nearby devices permission (asked at start).
  * USB printers (USB printer class) through Android's USB host API; the first print asks to allow the printer.
  * LAN (Wi-Fi) printers on port 9100 work as on Windows. The backend reaches the bridge on a loopback port with a token.
  * Not covered: brands whose printer has no Bluetooth or USB side (PAX, some iMin models need their own SDK).
* **Downloads** (CSV reports, the menu template) go to the device's Download folder; **Print / PDF** (reports, bill
  copies) opens Android's print screen, which includes Save as PDF. Screens use `ui/src/lib/android.ts`.
* **Backup copies** on a USB stick or SD card: Settings > This device > Choose folder (`BackupCopier.java`); new
  backup files are copied every 15 minutes while the app runs, and on "Copy now".
* **Keeps running in the background** (`PosService.java`, a foreground service with a notification).
* **Release signing**: the key is in `%USERPROFILE%\.tiffinpos\android-signing` (release.jks + release.properties,
  never in the repository). `gradlew assembleRelease` signs with it. On GitHub, add the secrets
  `POS_ANDROID_KEYSTORE_B64` (base64 of release.jks), `POS_ANDROID_KEYSTORE_PASSWORD`, `POS_ANDROID_KEY_ALIAS`,
  `POS_ANDROID_KEY_PASSWORD` and every push builds signed release APKs. **Back the key up offline**: Android only
  accepts updates signed with the same key.

## Not built yet

* The ODS add-on on Android (its installer is Windows-only).
* Vendor SDK printers (PAX, some iMin models).
* Tried on a real POS machine (see docs/HARDWARE_TEST_PLAN.md).
