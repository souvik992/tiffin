# Payment machines (card machines / EDC)

A separately installed add-on (`addons/edc`, id `edc`, needs POS 0.3.8): `TiffinPOS-PaymentMachines-Setup-<version>.exe` on
Windows, `TiffinPOS-PaymentMachines-<version>.tiffinaddon` on Android. Without it the POS takes Card and UPI by hand,
as before. Build: `cd addons/edc && npm run build` (signed) and `npm run installer`.

Settings > Payment machines (owner). At the counter, Card and UPI payments go to the machine; the bill is saved only
when the machine approves, with the approval code, RRN and the card's last 4 digits as the payment reference.

## What is supported

| Company | Wireless (internet) | Wired (cable) |
|---|---|---|
| **Paytm** | Paytm ECR APIs: sale request, status, void; every request signed with the merchant key (Paytm checksum, same as Paytm's `paytmchecksum` library) | USB cable, **Windows only**: Paytm's own library (`PaytmPayments_v*.dll` + `Newtonsoft.Json.dll`) called from a constant PowerShell script. Machines: PAX A910, A50, Ingenico DX8000 (Paytm's list) |
| **Pine Labs** | Pine Labs Cloud Integration: upload, status, cancel (before PIN entry) | Pine Labs **PAD Controller** (their Windows program) on this PC or another PC in the shop; the POS talks to it on TCP port 8082. The controller reaches the machine by USB, serial or LAN cable. Cards only |

Card and UPI both work on the internet connections (the machine shows a QR for UPI). Reversal (void, same day):
Paytm both ways and Pine Labs by cable from the POS; Pine Labs over the internet on the machine itself.

## What the shop needs

**Paytm**
1. Ask Paytm (merchant support or your sales contact) for **ECR / billing integration** to be switched on for the machine.
2. Wireless: the **MID**, the machine's **TID**, the **Channel ID** and the **merchant key** (16 characters), and the
   **live server address** for billing integration. Start with the Test server if Paytm gives test details.
3. Wired: download Paytm's wired library (github.com/paytm/Paytm_EDC, folder `wired/netV4.0`) into a folder such as
   `C:\PaytmEDC`, plug the machine in with its USB cable, then choose its COM port in Settings.

**Pine Labs**
1. Ask Pine Labs for **billing integration** (cloud or wired) for the store.
2. Wireless: **Merchant ID**, **Security token**, **Store ID** and the machine's **Client ID**; Test (UAT) first.
3. Wired: install Pine Labs' **PAD Controller**, connect the machine to it, and enter the PC's address (127.0.0.1 if
   it is this PC) and port 8082.

## How it stays safe

* The amount sent is the POS's own bill total. A bill that changes after approval is not saved ("reverse and charge
  again").
* Nothing unclear is called "failed": no answer within 6 minutes, a cable that stops answering, or the POS
  restarting while waiting all become **"Check the machine"**. The cashier looks at the machine; if it shows
  approved, the bill is paid by hand with the slip's approval code. A customer is never charged twice by the POS.
* Keys and security tokens are stored like other secrets ("_key" settings): never shown again or sent to the screen.
* A payment approved by a machine cannot have its mode changed by hand (Orders > Change), only reversed.
* Settings > Payment machines > Daily match lists every attempt and matches it with bills: "approved, no bill" and "unclear"
  are counted at the top, for the daily check.

## Not verified yet (needs the companies' test access)

* Tested only against simulated Paytm and Pine Labs servers, a simulated PAD Controller and Paytm's real library with
  no machine attached. No real machine, test account or real money yet: see docs/HARDWARE_TEST_PLAN.md.
* Paytm's live server address and the exact `merchantExtendedInfo` value to pre-select card or UPI are not in
  Paytm's public pages; confirm on Paytm's test server.
* Pine Labs' "still waiting" status codes are not published: any non-final answer is treated as still waiting.
* Pine Labs by cable: UPI is not offered (the public document lists card transaction types only).
* Payments: needs a human review (RULES.md 10) before shops use it.
