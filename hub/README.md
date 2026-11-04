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

This prints a connection link for the POS (`http://localhost:4900/connect/<code>`), the hub admin page (`/admin`) with
an admin key for this run, and a demo ordering page (`/order/demo`). Then:

1. In the POS, open **Settings > Online orders**, turn online orders on, choose Website, and save.
2. In the **Order hub** card, paste the connection link and press **Connect**.
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
| `HUB_ADMIN_KEY` | Needed for the admin page (`/admin`) and `/v1/admin`. Not set: admin over HTTP is off. |
| `HUB_PUBLIC_URL` | The hub's https address as shops reach it, used in connection links. Not set: taken from the admin page's address. |
| `HUB_DEV_OTP=1` | Puts OTP codes in responses. **Development only.** |
| `HUB_ROUTING_URL` | An OSRM server for real road distances. Not set: straight line × the store's road factor. Only the starting value: the admin page can change it. |
| `HUB_ONLINE_PAYMENTS=1` | Online payment (phase 3; needs a payment gateway). |

Put it behind HTTPS: a reverse proxy such as Caddy or nginx, with response buffering off for `/v1/pos/events` and
`/v1/orders/*/events`. The POS refuses a plain `http://` hub address unless the hub is on the same PC.

### Admin page

Open `https://<hub address>/admin` and enter the admin key (kept only in that browser tab; ten wrong keys a minute
from one address are refused for the rest of the minute).

- **Orders:** the latest 100 of all stores or one store, filtered Open / Delivered / Cancelled / Failed / All. Each row:
  order number, sales channel (Swiggy and Zomato in their colours, Website, App), date and time (India time), status,
  pickup or delivery, payment mode, total. Status is one of Placed, Accepted, Preparing, In transit, Delivered,
  Cancelled by store, Cancelled by customer or Failed, with what happened (reject reason, rider, "did not reach the
  store: its POS was offline", "the store did not accept in time", payment not completed). **Failed** also lists order
  attempts that never became orders (store offline or closed, changed price, outside the area, missing OTP, technical
  errors on the hub, with the error code), kept 30 days (table `order_attempt`). Click a row for its items, charges,
  customer (mobile masked), address and POS bill number.
- **Stores:** each store's state (POS online, shift open, what customers are told, open orders and orders in 24 h).
  Open a store for its POS devices and the **store settings its POS published**: accepting (auto or by staff and the
  time limit), channels, pickup and delivery, payments, pickup minimum and time, packaging charge, GST on charges,
  location, road factor, delivery bands, opening hours and menu by category. They are read-only here: the shop changes
  them in its POS, which sends them with the menu.
- **Website builder password** (on each store's page): the store designs its own ordering website in the website
  builder (the website's `/admin` page). Here you only make its password (shown once; a new one signs every builder
  out), and see when the website was last published. Also `npm run admin -- site-password <slug>`.
- **Add a store** to get a **connection link** (`<hub address>/connect/<code>`, Copy button). The shop pastes only this
  into its POS (Settings > Online orders > Order hub). It works once and for a limited time (Hub settings); make a new
  one from the store's page. Opened in a browser, the link only explains where to paste it.
- **Pause online orders** for a store from the hub, with a message for customers. Its POS cannot undo this; the POS is
  not told yet, so tell the shop. **Resume** reopens it.
- **Revoke** a POS device (lost or stolen PC): refused at once.
- **Hub settings**, saved in the hub database and used at once: road-routing server, how long until a disconnected
  store counts as offline, how long connection links are valid, and the per-minute request limits (OTP, orders, pairing).
  `HUB_DEV_OTP` and `HUB_ONLINE_PAYMENTS` are only shown: they change only by restarting the hub, so the admin key
  alone can never switch on OTP codes on screen.

The admin calls (`X-Admin-Key` header): `GET /v1/admin/overview`, `PUT /v1/admin/settings`, `POST /v1/admin/stores`
and `POST /v1/admin/stores/<slug>/pairing-code` (both return `connectUrl`), `GET /v1/admin/stores/<slug>`,
`GET /v1/admin/orders?store=<slug>&status=open|all&limit=`, `GET /v1/admin/stores/<slug>/orders`,
`PUT /v1/admin/stores/<slug>/pause` (`{ paused, reason }`), `POST /v1/admin/stores/<slug>/site-password` (a new website builder password), `POST /v1/admin/devices/<id>/revoke`.

### Stores and pairing from the command line

```
npm run admin -- create-store kalyan-nagar "Tiffin Kalyan Nagar"   # prints a connection link (uses HUB_PUBLIC_URL)
npm run admin -- pairing-code kalyan-nagar                          # a new link (one use, 30 minutes by default)
npm run admin -- list
npm run admin -- revoke-device <deviceId>                           # a lost or stolen PC
```

A connection link (its pairing code) gives the POS a device key that the hub keeps only as a hash. A revoked device is refused at once.

## Menu photos

The POS sends each menu item's photo once (`GET /v1/pos/images` lists what the hub has; `PUT /v1/pos/images/<sha256>.<ext>`
with `{ dataBase64 }`). The hub refuses a photo whose bytes do not match its name or are not JPG/PNG/WebP, and deletes
photos that are no longer on the menu. Customers' pages load them from `/v1/stores/<slug>/images/<name>`.

## Online backups (the Tiffin backup server)

The same hub stores the POS's online backups (Settings > Backups > Online backup, `src/backups.ts`). A shop that only
wants backups needs a store here too: `npm run admin -- create-store <slug> "<Store name>"` prints a pairing code; the
owner types the hub address and the code into the POS.

| Endpoint (POS device key) | What |
|---|---|
| `GET /v1/pos/backups` | this store's backups, newest first: `{name, bytes, uploadedAt, sha256}` |
| `PUT /v1/pos/backups/<kind>-<time>.db.gz` | raw gzip body with `X-Content-SHA256`; streamed to disk, refused (and not kept) if the hash differs or it is larger than 1 GB |
| `GET /v1/pos/backups/<name>` | the file, with `X-Content-SHA256` |
| `GET /v1/pos/backup-images`, `PUT`/`GET /v1/pos/backup-images/<sha256>.<ext>` | menu photos the backups use, checked against their name |

Files live in `backups/<storeId>/` next to `hub.db` (never in the database); the newest 30 backups per store are kept.
They are not encrypted (the owner's choice, docs/DECISIONS.md), so secure the server and its disk.

## DinePOS outlets: sales sync and licence renewals

A DinePOS outlet connected to this hub (the same pairing as its online orders) sends its sales up and fetches licence
renewals (`src/sync.ts`). Neither side needs the other to work: the outlet bills offline and catches up later.

| Endpoint | What |
|---|---|
| `POST /v1/pos/sync/batches` (device key) | `{streamId, fromSeq, events[]}`: the outlet's outbox (`day.closed`, `bill.printed`, `bill.settled`, `bill.voided`) numbered by its own `seq`. Returns `{ackSeq}`, the highest number held. Resending is harmless; a gap (409 `SYNC_GAP`, with `ackSeq`) makes the outlet resend; a different record under a number already held is 409 `SYNC_CONFLICT` |
| `GET /v1/pos/licence` (device key) | `{key, updatedAt}`: the licence key the vendor put here, or `null` |
| `GET /v1/admin/stores/<slug>/sales?days=14` | business days, newest first: a closed day from its Z report, an open day added up from its bills |
| `GET`/`PUT /v1/admin/stores/<slug>/licence` | `{key}` puts a renewed key here (empty removes it); the hub only reads what the key says about itself, the POS verifies it |

Each outlet database is its own stream (`streamId`), so a reinstalled or restored POS never overwrites what an earlier
one sent; the sales view counts each bill and each business day once. The admin store page shows both.

## Swiggy and Zomato (through UrbanPiper)

Orders from Swiggy and Zomato come through UrbanPiper (`src/urbanpiper.ts`; their guide: https://api-docs.urbanpiper.com/downstream).
One UrbanPiper account serves all stores. On the admin page:

1. **Hub settings > Swiggy & Zomato (UrbanPiper account)**: the test account (pos-int.urbanpiper.com) until UrbanPiper
   certifies the setup, then the live address from their certification email; **API username, API key, Biz ID** from
   UrbanPiper's sandbox email (or the Postman collection's `Authorization: apikey <username>:<key>` and `X-UPR-Biz-Id`
   headers). The key stays on the hub and is never shown again. **Save account**, **Test connection** (lists the
   account's webhooks; changes nothing), **Set up order links** (registers `/v1/urbanpiper/<Biz ID>` for 9 webhook
   events with a secret header, for all stores; UrbanPiper allows 5 calls a minute, so this takes about 2 minutes; refused
   while the hub runs on localhost, which UrbanPiper cannot reach).
2. **Each store** (Stores > the store > Swiggy & Zomato): its own **Store ID at UrbanPiper** (the hub store address by
   default; one per store), city, address, phone, Swiggy and/or Zomato, packaging charge, on/off. **Save store details**,
   **Send store details**, **Send menu**.

`npm run urbanpiper-sample -- <store> [swiggy|zomato] [--self] [--cash]` sends a sample order into a hub on this PC, as
UrbanPiper would (development only).

Then:
- **Orders** arrive like website orders, numbered S-… (Swiggy) and Z-… (Zomato), priced from the published menu at the
  channel price (the POS bill); the platform's order number, OTP, total, charges, discounts and notes travel with it.
  The same order sent twice makes one order. Unknown stores and other platforms are refused with 422 (not retried).
- **Accept / Ready / Out for delivery / Delivered / Reject / Cancel** in the POS go back as order status updates
  (Acknowledged with the preparation time for Zomato, Food Ready, Dispatched with the rider, Completed, Cancelled with a
  reason code). When the platform's rider delivers, only the platform marks the order picked up and delivered.
- **From the platform**: cancellations (also after accepting: the POS asks to cancel the bill), the rider's name, phone
  and progress, and pickup and delivery.
- **After the first "Send menu"**: menu changes from the POS are sent by themselves; items sold out or back on, and the
  store not taking orders (no shift, or paused here), switch them off and on at Swiggy and Zomato.
- **Requests from the ODS about one order**: Swiggy, before the food is ready: **Item out of stock** (Swiggy asks the
  customer to change the order and the store gets the customer's masked number and a PIN, or the order is cancelled).
  Zomato: **Customer's number**, **Ask for another rider** (bulk orders only) and **Rider check** (temperature, mask).
  The platform's answers, and any request UrbanPiper refuses, appear on the order.
- **Packaging charge on Swiggy and Zomato** (in the card): none, rupees per item, or a percentage of the item price; sent
  with the menu as an item-level charge (both platforms take only that). GST on it is set in Atlas (Zomato) or by the
  Swiggy contact. Cess stays inside the item price (UrbanPiper has GST taxes only).
- Calls to UrbanPiper go through an outbox that retries while UrbanPiper cannot be reached or is busy. Everything sent
  and received is listed under **Activity** on the store's page.
- The menu is checked against the platforms' rules first (unique names, Zomato ignoring numbers in names, descriptions,
  meat named in non-veg items, offer and alcohol words, veg marking). Prices that include GST are sent without it, with
  CGST and SGST as taxes, so the customer pays the POS price.

Needs the hub on the internet with an https address (UrbanPiper sends orders to it). Not tested against UrbanPiper's
real test account yet (docs/HARDWARE_TEST_PLAN.md).

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
- Hosting the hub (and backups of the hub database itself, including the shops' online backups).
- The store apps (the demo page stands in for them).
- Swiggy/Zomato: category timing groups (menu sections for certain hours).
- More than one hub process: one process per database for now.
- Telling the POS when the hub admin pauses its store (the ODS still shows "accepting").
- Admin accounts: one shared admin key, no per-person logins or audit log.

Tests: `npm test` (from `hub/`) or `node --test --test-concurrency=1 hub/test/*.test.ts` from the repo root.

## Website builder

The ordering website's `/admin` page is a website builder: the shop signs in with its **website editor password**
(made on the admin page or with `npm run admin -- site-password <slug>`; it works for that store only) and designs the
website beside a live preview: theme (colours, fonts, corners, buttons, header; ready-made looks), logo, tab icon,
Google title and description, share picture, contact and social links, how dishes show (cards or list, photos,
descriptions, veg marks, category buttons), an announcement bar, and the home page as sections it can add, reorder,
hide and edit: hero, featured dishes, menu (always one), about, gallery, reviews, opening hours, contact and map, FAQ,
text. Photos are uploaded to the hub (made smaller in the browser first). Changes are saved as a **draft**; **Publish**
makes them live (customers get the design with the store, `site` in `GET /v1/stores/<slug>`). The menu, prices, item
photos and opening hours still come from the POS.

Every saved design is checked field by field (`src/site.ts`): unknown fields and wrong values are refused, and a broken
saved design falls back to the standard one. Calls (CORS, `X-Site-Token` from the sign-in, 30 days):
`POST /v1/site/<slug>/login` (`{ password }`, 10 per minute per address), `POST /v1/site/<slug>/logout`,
`GET /v1/site/<slug>` (draft, published, unpublished), `PUT /v1/site/<slug>/draft` (`{ site }`),
`POST /v1/site/<slug>/publish`, `POST /v1/site/<slug>/discard`, `PUT /v1/site/<slug>/images/<sha256>.<jpg|png|webp>`
(`{ dataBase64 }`, the same checks as POS menu photos; the design refers to it as `hub:<name>`).
