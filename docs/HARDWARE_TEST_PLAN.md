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
| Low-end shop PC (4 GB RAM, HDD): start-up time, memory, billing speed | |
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

## Online Orders add-on

| Check | Result |
|---|---|
| Add-on installer on a clean shop PC after the POS installer; restart prompt while the POS is open | |
| Add-on installer when the POS is not installed: clear message, nothing installed | |
| Map and address search on a shop internet connection (slow 4G, proxy), and cached tiles with the internet off | |
| POS update (0.2.x) with the add-on installed: add-on keeps working | |

Done on the dev PC (2026-10-16): packaged POS 0.2.0 loads the signed add-on and refuses an altered one; add-on installer installed into a temp folder silently and uninstalled cleanly (the real POS install was not touched).

## Bill designs

| Check | Result |
|---|---|
| Each example design printed on a real 58 mm and 80 mm printer: double-width text, alignment, QR code size and scan (UPI app opens with the right amount) | |
| A shop's own design compared with their old bill | |
| Bill logo on real printers (58 and 80 mm, Posiflex PP8800, a cheap 58 mm): centred, dark enough, print speed, no garbage after the logo | |

## Accounting sign-off (CA)
GST rates and inclusive/exclusive treatment, odd-paisa rule, discount before tax, round-off, invoice numbering
and 16-character limit, credit-note treatment, receipt mandatory fields (GSTIN, FSSAI, HSN thresholds), record retention. Bill designs: which parts a design must keep (today: title, number, date, GSTIN, items, GST, total). Reports: GST by rate and HSN summary match what the CA files in GSTR-1 for a real month.
