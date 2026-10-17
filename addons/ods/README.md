# ODS add-on

A separately installed module for Tiffin POS (0.3.4 or newer). It adds:

* **Settings > Online orders:**
  * the master switch (off = offline mode)
  * sales channels: App, Website, Swiggy, Zomato
  * order types: pickup, and delivery by your own riders
  * payments: online, and COD with an OTP-verified mobile
  * accepting: manual with a 2-15 minute limit, or automatic
* **Settings > Serviceability:**
  * the store location on a map (address search, draggable pin)
  * up to 6 delivery areas by distance, each with delivery fee, minimum order, free-delivery amount and delivery time
  * packaging fee, pickup minimum and ready time
  * opening hours per weekday (up to 2 times a day, past midnight allowed)
* **Order hub connection** (Settings > Online orders > Order hub): pair once with the hub address and a pairing code. Orders then arrive live. See `hub/README.md`.
* **ODS** (order display screen) in the side menu, only while online orders are on:
  * columns New / Preparing / Ready / On the way, a sound on new orders, and the time left to accept;
  * **Accept** with a preparation time: a normal GST bill and the kitchen ticket print at once;
  * Reject with a reason; rider name and phone; Delivered / Collected;
  * Cancel needs a manager and cancels the bill too;
  * warnings when the price changed since the customer ordered, or when the customer cancelled first ("Cancel bill").
* **Menu sync per channel** (Settings > Online orders > Menu sync): which items each channel lists (all, all except, only; searchable) and its prices (same as the POS, or +/- % and per-item prices). Save and sync now sends it to the hub.
* **Buzzer on every screen** (`ui/buzzer.ts`): while an online order waits to be accepted, the POS rings (loud, repeating) and shows a "New online order" banner on any screen, with Silence and Open ODS. The ODS screen's Sound switch turns it on or off.
* **Menu photos** go to the hub with the menu (only the missing ones).
* **GST on delivery and packaging fees:** billed as fee lines at the GST rate chosen in Serviceability (your CA should confirm it).
* Online orders cannot be switched off while an order is still open.

Install: `TiffinPOS-ODS-Setup-<version>.exe`, after the POS. It is per user and needs no admin. A running POS offers to restart. Uninstall it from Windows Settings > Apps; its settings stay in the POS data.

## The map

* **Google Maps** when the owner saved a Google key in **Settings > API keys** (owner only):
  * map pictures from the **Map Tiles API** (one tile session reused; tiles are not saved on disk, as Google's terms ask);
  * place search from **Places API (New)**: Autocomplete + Place Details with Essentials fields only (location, address), one session per search.
  * **Test key** checks both and says in plain words what to switch on in the Google Cloud console.
  * The key stays in the POS backend: screens, settings lists, the audit log and the order hub never see it (settings named `..._key` are secret).
* **Without a key:** OpenStreetMap tiles (saved in `<POS data>\addons\ods\tiles`, they keep working offline) and Photon search (India only, near the shop pin, fewer-words retry, Nominatim on Enter).
* **Suggestions while typing** (no Search button needed); **paste coordinates** or a Google Maps link and choose "Use this point".
* **How they load:** the POS fetches them (never the page) only while online orders are on.
* **Distances** are road distances. The hub measures them on a road map when `HUB_ROUTING_URL` (OSRM) is set; otherwise it uses the straight line × the store's **road factor** (default 1.30).

## Development

See `docs/ADDONS.md` (rules, signing, build). The add-on's own commands:

| Command | What it does |
|---|---|
| `npm test` | Backend logic, plus the built package loaded in a real POS |
| `npm run typecheck` | Type-checks the add-on |
| `npm run build` | Builds the signed package in `../dist/packages/ods` |
| `npm run installer` | Builds the signed package, then the installer in `../dist/installers` |

The serviceability rules (zones, quotes, opening hours) live in `contract/src/serviceability.ts`, so the order hub uses exactly the same ones.
