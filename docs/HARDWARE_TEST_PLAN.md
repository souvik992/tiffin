# Hardware and platform test plan (everything this sandbox could NOT prove)

Fill in result/date/tester. A printer model is "supported" only after its row passes.

## Machines
| Check | Win 10 low-end (Celeron, 4 GB, HDD) | Win 10 SSD | Win 11 |
|---|---|---|---|
| Install from a clean image, run as standard user | | | |
| Cold start to billing-ready (target 3 s SSD / 6 s HDD) | | | |
| `node scripts/bench.ts 100000` numbers vs README targets | | | |
| 8-hour idle then bill: memory growth under 100 MB | | | |
| Hard power cut mid-bill (10 times): bill whole or absent, app starts, journal repaired | | | |
| Kill the process mid-bill (Task Manager) | | | |
| Disk full / low space message | | | |
| Restore drill: `npm run restore -- <backup>` on a copy of a real shop, then check bills, stock and photos | | | |
| Backup to a USB drive or second disk (including the `images` folder) | | | |
| Antivirus on (Defender + one third-party) | | | |
| Regional settings (Hindi UI, DD/MM, comma decimal) | | | |
| DPI scaling 125/150 % | | | |

## Printers (repeat per model: Epson TM-T82/T88, TVS, Rongta, Xprinter, others you sell)
| Check | USB (spooler RAW) | LAN :9100 | Bluetooth COM |
|---|---|---|---|
| 58 mm: no line wraps wrongly (32 chars) | | | |
| 80 mm: 48 chars | | | |
| Long bill (100+ lines) prints completely, no dropped data | | | |
| Auto-cut | | | |
| Cash drawer opens on cash only | | | |
| Printer off, then on: queued jobs print in order | | | |
| Paper out / cover open behaviour | | | |
| UPI QR scans from the paper | | | |
| Hindi receipt via raster (host feature) | | | |
| Safe chunk size (set `profile` if the model drops data) | | | |

## Windows spooler (RAW) transport
Address = the printer name exactly as shown in Windows Settings, Printers. Opt-in automated check:
`$env:POS_TEST_SPOOLER_PRINTER = "<name>"; node --test test/spooler.test.ts`

| Check | Result / date / tester |
|---|---|
| Missing printer gives "was not found in Windows" (automated) | Passed 2026-10-15, Windows 11 Pro 26200, Node 24.21, dev PC (not target hardware) |
| A receipt prints completely through a USB printer's Windows driver | |
| Same through a "Generic / Text Only" driver | |
| Driver that rejects RAW (v4/XPS-only) gives the "does not accept RAW data" message | |
| Printer paused / offline in Windows: job waits in the Windows queue; app shows it as printed (spooler accepted it). Decide if that is acceptable | |
| Unplug USB mid-job: no half receipt is printed later | |
| Time per job on the low-end PC (dev PC: about 0.65 s) | |
| Defender and one third-party antivirus allow the PowerShell helper (`-EncodedCommand`) | |
| Standard (non-admin) Windows user can print | |
| Printer name with non-English characters | |

## Plug-and-play USB printers
| Check | Result / date / tester |
|---|---|
| Device scan code (SetupAPI) reads real USB device paths and names | Passed 2026-10-15, Windows 11 dev PC (checked against keyboard/mouse/Bluetooth adapter) |
| Printing to a USB printer that is not plugged in says "not connected" (automated) | Passed 2026-10-15, Windows 11 dev PC |
| Plug in a thermal printer with NO driver: banner appears within ~15 s; "Use for bills" prints the test page | |
| Same printer moved to another USB socket still prints | |
| Printer with a Windows driver installed: offered as a Windows printer; prints | |
| Two identical printers (same vendor:product, no serial): each one prints to the right device | |
| Unplug during a long receipt: clear error, the bill prints again after replugging (retry) | |
| Paper out / cover open during a direct-USB print: the job times out with the paper message | |
| Standard (non-admin) Windows user can print directly over USB | |

## Wi-Fi / LAN and Bluetooth printers
| Check | Result / date / tester |
|---|---|
| TCP printing to a printer socket (automated, fake printer on the same PC) | Passed 2026-10-15, Windows 11 dev PC: test page and receipt bytes received |
| "Find printers" finds a real Wi-Fi printer on the shop network | |
| Wi-Fi printer that changes IP (DHCP): reserve the IP in the router and re-test | |
| Bluetooth: pair a 58 mm printer, pick its Outgoing COM port, test page prints | |
| Bluetooth printer switched off mid-day: job fails with a clear message, prints after it is back on (retry) | |
| Bluetooth: Incoming vs Outgoing COM port chosen by mistake gives a clear error | |
| Unknown COM port gives "was not found" (automated, real Windows) | Passed 2026-10-15, Windows 11 dev PC |
| USB printer appears in the installed-printers list with label USB | |
| Long receipt (100+ lines) over Bluetooth prints completely (chunk size, set `profile` if needed) | |
| Browser printing ("Print on screen") on the thermal printer driver at 58 and 80 mm | |
| Reports: Download CSV opens correctly in Excel on Windows (rupee amounts as numbers, ₹ and Hindi names readable); Download and Print / PDF work inside Electron (tested only in headless Chrome) | |

## Desktop app (Windows)
Done on the dev PC (Windows 11, standard user, no admin): install, run, uninstall; the end-to-end test against the dev, packaged and installed builds. Still to test:

| Check | Result |
|---|---|
| Signed in, close the POS window and open it again (and end the process in Task Manager, then open): still signed in, same bill; press Lock, close, open: still locked until the PIN | |
| Low-end shop PC (4 GB RAM, HDD): start-up time, memory, billing speed | |
| Rupee sign and a Hindi item name on a real receipt printer (Posiflex PP8800 and a 58 mm printer): sharp enough, lines aligned, print speed on a long Hindi bill | |
| Cash drawer opened from Billing > Open cash drawer on the real printer | |
| Handheld POS (Sunmi V2 type) and a touch-screen PC: billing with the View bill bar, dialogs, tap targets | |
| Payment machines (docs/PAYMENT_MACHINES.md): Paytm wireless and USB, Pine Labs wireless and PAD Controller, each on the company's test account and a real machine: card, UPI, decline, cancel, no internet, unplugged cable, reverse; then one small live payment | |
| Settings > Backups in the installed app: Windows folder picker, copies to a real USB drive (pull it out: error shown, billing unaffected), restore from it on a second PC | |
| Online backups against a hosted backup server over https: upload on shop internet, a large database (100 MB+), restore on a new PC | |
| Low-end shop PC: install and update time (zip installer; ~22 s on one core of the dev PC's SSD, HDD and antivirus not measured) | |
| Windows 10 22H2 | |
| A real receipt printer (USB driverless, USB Windows driver, Wi-Fi, Bluetooth) from inside the installed app | |
| Posiflex PP8800 on WinUSB (dev PC): found and opened without admin; printing confirmed working by the owner on 2026-10-15. Still to check: cash drawer, out-of-paper and unplug while printing, long bills | Works (owner report) |
| Signed installer: SmartScreen, and common antivirus with the PowerShell print helper | |
| Auto-update from a real HTTPS folder: download while billing, install on close, signature mismatch refused | |
| Power cut while billing, then start: integrity check, journal, print queue | |
| Sleep/hibernate and resume with the app open | |
| Touch screen: tapping, on-screen keyboard, no zoom | |
| CSV download (save dialog) and Print / PDF (Windows print dialog) from the installed app | |
| Windows sign-out and shutdown with the app open: closing backup taken | |

## ODS add-on

| Check | Result |
|---|---|
| Add-on installer on a clean shop PC after the POS installer; restart prompt while the POS is open | |
| Add-on installer when the POS is not installed: clear message, nothing installed | |
| Map and address search on a shop internet connection (slow 4G, proxy), and cached tiles with the internet off | |
| POS update (0.2.x) with the add-on installed: add-on keeps working | |
| Live online orders on a shop PC: pair with a real hub over https, order from a phone, sound plays, Accept prints the bill and KOT on the shop printer | |
| Internet drop for 2-10 minutes during service: orders placed meanwhile arrive once after it returns; accepts made offline reach the customer | |
| PC restart with an accepted order not yet sent: it reaches the hub after the restart | |
| Settings > Serviceability > Map with the owner's Google key after enabling Places API (New) and Map Tiles API: Test key all green, Google Maps, Google satellite and satellite with roads each show, switching back to the free map shows OpenStreetMap, "empire brookfield" suggests the right place, picking it moves the pin | |
| Place search screen: suggestions appear while typing, arrow keys + Enter, pasted Google Maps coordinates and link | |
| Online-order buzzer through the shop PC's speakers (and the Android machine's): loud enough at the counter, rings on the Billing screen, Silence works | |
| Road distances from a real OSRM server vs Google Maps for 10 shop addresses | |

Done on the dev PC (2026-10-16, ODS 1.0.0): the built signed package in a POS backend (temp folder) with a hub on the same PC: pair, website order, live on the ODS in under 0.2 s, accept = GST bill with 5% GST fee lines, customer sees accepted + bill number, through to delivered; online orders could not be switched off while the order was open. The ODS installer installed into a temp folder, its copy loaded in a POS 0.3.0 and was switched off on POS 0.2.0, and it uninstalled cleanly. No printer was used; the ODS screen itself was not opened in Electron.

Earlier: packaged POS 0.2.0 loads the signed add-on and refuses an altered one; add-on installer installed into a temp folder silently and uninstalled cleanly (the real POS install was not touched).

## Android POS machines

| Check | Result |
|---|---|
| Signed in, swipe the app away and open it again, and after a device restart: still signed in; Lock survives the same | |
| Install the APK for the machine's processor (arm64-v8a or armeabi-v7a) and complete shop setup | |
| A day of billing: speed of adding items and paying (target: under 0.2 s per tap) | |
| Power cut or app killed during a bill: the bill is either complete or not there, numbering has no gap | |
| Sunmi built-in printer (Printer setup > Bluetooth > Built-in printer), a paired Bluetooth printer, a USB printer with an OTG cable (allow it once), a LAN printer on port 9100 | |
| Settings > This device: choose a folder on a USB stick, Copy now, check TiffinPOS-backups on a PC; restore one on Windows | |
| Reports: Download CSV (Download folder) and Print / PDF (Android print screen, Save as PDF) | |
| Install the ODS add-on from a .tiffinaddon file (Settings > This device > Add-ons), turn on online orders, pair with the hub, receive an order with the app in the background | |
| Leave the app in the background for an hour, come back: the POS still answers | |
| Hindi and the rupee sign on the built-in or a Bluetooth printer (the app draws them, op "render" in PrinterBridge) | |

Done on the dev PC (2026-10-17): x86_64 emulator (Android 16 type, 16 KB pages). Node 24 runs; 177/184 backend tests pass (the 2 failures are timing on the slow emulator); the app starts the POS and shows the setup screen.

## Bill designs

| Check | Result |
|---|---|
| Each example design printed on a real 58 mm and 80 mm printer: double-width text, alignment, QR code size and scan (UPI app opens with the right amount) | |
| A shop's own design compared with their old bill | |
| Bill logo on real printers (58 and 80 mm, Posiflex PP8800, a cheap 58 mm): centred, dark enough, print speed, no garbage after the logo | |

## Accounting sign-off (CA)
GST rates and inclusive/exclusive treatment, odd-paisa rule, discount before tax, round-off, invoice numbering
and 16-character limit, credit-note treatment, receipt mandatory fields (GSTIN, FSSAI, HSN thresholds), record retention. Bill designs: which parts a design must keep (today: title, number, date, GSTIN, items, GST, total). Reports: GST by rate and HSN summary match what the CA files in GSTR-1 for a real month.
