# quickPOS for iPhone and iPad (standalone)

The full POS runs on the iPhone or iPad, like the Android app: the **same backend code as Windows** (`src/`) and the
**same screens** (`ui/`), with the SQLite database and backups in the app's own storage. No PC needed.

```
TiffinPOS.app
├── Frameworks/NodeMobile.framework   Node.js 24 for iOS (a library: iOS lets an app run no other programs)
└── pos/main.cjs                      the backend + gatekeeper, bundled into one plain JavaScript file
    pos/ui/                           the React screens (ui/dist)
```

* `PosBackend.swift` starts Node on its own thread with `ios/backend/main.ts` (bundled): the POS backend (random launch
  secret) plus the **gatekeeper** shared with Android (`android/backend/front.ts`) on a loopback port. The port comes
  back in a file, as on Android.
* The window (`PosViewController.swift`, a web view) loads `http://127.0.0.1:<port>/` with the app's private cookie;
  everything else is refused, web links open in Safari. It sits inside the safe area (clear of the notch and home bar),
  and the page does not zoom when a text box is tapped.
* **No JIT on iOS.** Apple allows no JIT in apps, so Node for iOS runs V8 as an interpreter. That is why the backend is
  pre-bundled to plain JavaScript (no TypeScript stripping on the phone). `ios/scripts/smoke.ts` runs the bundle with
  `node --jitless` on any computer and bills an order: about 1 second to start on a PC.
* **Node for iOS** (`NodeMobile.xcframework`) is pinned with SHA-256 in `node-runtime.json`. The official nodejs-mobile
  project stops at Node 18 (no built-in SQLite), so this uses the Node 24 build of github.com/fogtape/nodejs-mobile:
  official Node.js source plus mobile patches, published as a **pre-release by one person**. Before a store release,
  build it from that recipe ourselves (or review its patches) and replace the pin. See docs/HARDWARE_TEST_PLAN.md.

## What the app does on iOS

| | Android app | iPhone / iPad app |
|---|---|---|
| Wi-Fi / network printers | yes | yes (iOS asks once to allow the local network) |
| Bluetooth printers | classic Bluetooth, paired | **Bluetooth LE** printers, no pairing (`PrinterBridge.swift`, address `ble:<id>`). iOS does not let apps use classic-Bluetooth printers (Apple MFi only) |
| USB printers | yes (OTG) | no (iOS gives apps no USB printers) |
| Built-in printer (Sunmi etc.) | yes | no such iPhones |
| ₹ and Hindi on receipts | drawn with Android fonts | drawn with iOS fonts (`TextPicture` in `PrinterBridge.swift`) |
| Downloads (CSV, menu template) | Download folder | share sheet: Save to Files, WhatsApp, mail |
| Print / PDF of reports and bills | Android print screen | AirPrint screen (with share as PDF) |
| Backup copies | USB stick / SD card | any folder in Files: iCloud Drive, or a USB drive / SD card plugged into the iPhone or iPad (`BackupCopier.swift`) |
| Add-ons (.tiffinaddon) | Settings > This device | Settings > This device: the file is picked in Files, unpacked by `ios/backend/appRoutes.ts` (owner only), then the POS restarts in place |
| Runs in the background | yes (foreground service) | **no**: iOS freezes apps that are not on screen. Bills are saved before they show; a print in progress gets about 30 seconds. Online orders (ODS add-on) arrive only while the app is open |
| Screen stays on while open | yes | yes |

## Build

Needs a Mac with Xcode 16+, Node 24 and XcodeGen (`brew install xcodegen`).

```
cd ui && npm ci && npm run build && cd ..
cd desktop && npm ci --ignore-scripts && cd ..   # esbuild for the bundle
node ios/scripts/prepare.ts      # Node for iOS (downloaded, checksum-checked), backend bundle, screens, version
node ios/scripts/smoke.ts        # optional: the bundle bills an order without a JIT
cd ios && xcodegen generate && open TiffinPOS.xcodeproj
```

The version follows `desktop/package.json` (written into `ios/Version.xcconfig`), as for Android.

**On GitHub** (`.github/workflows/ios.yml`, every push to main or mobile-app): prepare, the no-JIT check, the simulator
build, a test in an iPhone and an iPad simulator (`ios/scripts/simulator-test.ts`: the app starts the POS, a shop is set
up and a bill made through the app itself, screenshots), then the device build. Downloads on the run's page:

* `TiffinPOS-iOS-Simulator`: the app for the iOS simulator.
* `TiffinPOS-iOS-Device`: an `.ipa`. **Unsigned** until the signing secrets are set; iPhones refuse unsigned apps.
* `TiffinPOS-iOS-Test`: simulator screenshots and the POS log.

## Signing (needs the owner: an Apple Developer account, Rs 8,700 / USD 99 a year)

iPhones install only apps signed by Apple's rules. With an Apple Developer account:

1. In developer.apple.com: register the app id `com.tiffinpos.pos`, make an **Apple Distribution** certificate (export it
   with its key as a .p12 from Keychain Access) and a provisioning profile: **Ad Hoc** (up to 100 listed iPhones/iPads,
   install from a link or Apple Configurator) or **App Store** (TestFlight and the App Store).
2. Add GitHub secrets: `POS_IOS_CERT_P12_B64` (base64 of the .p12), `POS_IOS_CERT_PASSWORD`, `POS_IOS_PROFILE_B64`
   (base64 of the .mobileprovision), `POS_IOS_TEAM_ID`, and `POS_IOS_EXPORT_METHOD` (`ad-hoc` or `app-store-connect`).
3. The next push builds a signed `.ipa` (`ios/scripts/build-device.sh`). Keep the certificate and its password offline
   too, next to the Android key.

App Store review notes: the app runs its own bundled JavaScript (allowed); add-ons are downloaded code, which Apple
rules restrict (guideline 2.5.2): for an App Store build, ship add-ons inside the app or keep add-on install for
Ad Hoc / business (Apple Business Manager custom app) builds.

## Not built or not tried yet

* Tried only in the simulator: a real iPhone/iPad, a Bluetooth LE printer, AirPrint, iCloud Drive copies, the app after
  hours in the background (docs/HARDWARE_TEST_PLAN.md).
* Signing, TestFlight and App Store listing (owner decisions above).
* Node for iOS built by us from source (now a pinned third-party pre-release).
