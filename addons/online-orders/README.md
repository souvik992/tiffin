# Online Orders add-on

A separately installed module for Tiffin POS (0.2.0 or newer). It adds:

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
* **ODS** (order display screen) in the side menu, only while online orders are on, plus an online/offline dot. It receives orders once the order hub is built (`docs/ONLINE_ORDERS_PLAN.md`).

Install: `TiffinPOS-OnlineOrders-Setup-<version>.exe`, after the POS. It is per user and needs no admin. A running POS offers to restart. Uninstall it from Windows Settings > Apps; its settings stay in the POS data.

## The map

* **Map:** OpenStreetMap tiles. **Address search:** Nominatim, limited to India.
* **How they load:** the POS fetches them (never the page) only while online orders are on. Tiles are cached in `<POS data>\addons\online-orders\tiles` and keep working offline.
* **Usage policy:** light use with caching and an identifying User-Agent is within these services' policies. For many stores, move to a paid tile provider: change `TILE_URL` in `backend/maps.ts`.
* **Distances** are straight lines from the store. Road distance can be about 30% more.

## Development

See `docs/ADDONS.md` (rules, signing, build). The add-on's own commands:

| Command | What it does |
|---|---|
| `npm test` | Backend logic, plus the built package loaded in a real POS |
| `npm run typecheck` | Type-checks the add-on |
| `npm run build` | Builds the signed package in `../dist/online-orders` |
| `npm run installer` | Builds the signed package, then the installer in `../dist/installers` |

The serviceability rules (zones, quotes, opening hours) live in `contract/src/serviceability.ts`, so the order hub uses exactly the same ones.
