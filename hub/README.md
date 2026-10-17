# Order hub

The internet service between customers and the shop. Customers order on the store's app or website. The hub checks and
prices each order, then sends it **live** (Server-Sent Events, no polling) to the shop's POS, where it appears on the ODS.
The POS answers with accept, reject and status changes, and the customer sees them live.

Zero runtime dependencies: Node 24 and `node:sqlite`, like the POS. It follows the order contract in `../contract/`
(life cycle, shapes, checks, prices). The hub's total always equals the POS bill because both use the same GST code.

## Try it on one PC

```
cd hub
npm run dev
```

This prints a hub address (`http://localhost:4900`), a pairing code and a demo ordering page (`/order/demo`). Then:

1. In the POS, open **Settings > Online orders**, turn online orders on, choose Website, and save.
2. In the **Order hub** card, enter the address and the pairing code.
3. Set the store location and areas in **Settings > Serviceability**, and the GST rate for fees.
4. Open a shift.
5. Order on the demo page. The order appears on the **ODS** with a sound. Press **Accept**, and the GST bill and kitchen ticket print.

OTP codes are shown on the demo page in development. In production an SMS provider sends them (not built yet).

## Run it for real

```
HUB_ADMIN_KEY=<long random secret> HUB_DATA_DIR=/var/lib/tiffin-hub npm start
```

| Variable | Meaning |
|---|---|
| `HUB_PORT` | Port (default 4900). |
| `HUB_HOST` | Listen address (default 0.0.0.0). |
| `HUB_DATA_DIR` | Database folder (default `./hub-data`). Back it up. |
| `HUB_ADMIN_KEY` | Needed for `/v1/admin` (create stores, pairing codes). Not set: admin over HTTP is off. |
| `HUB_DEV_OTP=1` | Puts OTP codes in responses. **Development only.** |
| `HUB_ROUTING_URL` | An OSRM server for real road distances. Not set: straight line × the store's road factor. |
| `HUB_ONLINE_PAYMENTS=1` | Online payment (phase 3; needs a payment gateway). |

Put it behind HTTPS: a reverse proxy such as Caddy or nginx, with response buffering off for `/v1/pos/events` and
`/v1/orders/*/events`. The POS refuses a plain `http://` hub address unless the hub is on the same PC.

### Stores and pairing

```
npm run admin -- create-store kalyan-nagar "Tiffin Kalyan Nagar"   # prints a pairing code
npm run admin -- pairing-code kalyan-nagar                          # a new code (30 minutes, one use)
npm run admin -- list
npm run admin -- revoke-device <deviceId>                           # a lost or stolen PC
```

A pairing code gives the POS a device key that the hub keeps only as a hash. A revoked device is refused at once.

## Menu photos

The POS sends each menu item's photo once (`GET /v1/pos/images` lists what the hub has; `PUT /v1/pos/images/<sha256>.<ext>`
with `{ dataBase64 }`). The hub refuses a photo whose bytes do not match its name or are not JPG/PNG/WebP, and deletes
photos that are no longer on the menu. Customers' pages load them from `/v1/stores/<slug>/images/<name>`.

## What the hub already handles

- Orders placed while the shop's internet is down wait on the hub. The POS collects them when it reconnects.
- An order that was not accepted in time is rejected automatically and the customer is told.
- The same order cannot be sent twice (idempotency keys).
- Cash on delivery needs a verified mobile (OTP).
- A changed price is refused before the order is placed.
- A store that is closed, offline or not accepting (no shift open) gets no orders.
- When a customer cancels just as the shop accepts, the POS flags the bill for cancelling.

See `docs/ONLINE_ORDERS_PLAN.md` for the failure cases (F1 to F13).

## Not built yet

- SMS for OTP.
- The payment gateway (online payment).
- Hosting and backups of the hub database.
- The store apps (the demo page stands in for them).
- Swiggy/Zomato.
- More than one hub process: one process per database for now.

Tests: `npm test` (from `hub/`) or `node --test --test-concurrency=1 hub/test/*.test.ts` from the repo root.
