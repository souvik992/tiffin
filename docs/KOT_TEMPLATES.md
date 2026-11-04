# Kitchen ticket designs (.tiffinkot)

Kitchen order tickets (KOT) print like bills do: from a design. The POS has three design slots, set in
**Settings → Store settings → Kitchen tickets (KOT)**:

| Slot | Used for |
|---|---|
| **Customer KOT** | Counter orders when tickets print **with the bill** (on the receipt printer, one per prep station). |
| **Prep station KOT** | Counter orders when tickets print **on prep station printers**. |
| **Online order KOT** | Online orders (store app, website, Swiggy, Zomato), in either mode. |

Each slot uses its **standard design** until the owner uploads a `.tiffinkot` file. The standard designs are the files in
`templates/kot/` (`customer`, `station`, `online`). The customer KOT looks like the shop's sample: the shop name, KITCHEN
ORDER TICKET, TOKEN, "113 | TANDOOR" in big letters, the order type, the bill number and time, the items with their
notes (">> Less spicy"), Items and Qty, ** END **.

## How tickets work

* **Prep stations** (Menu creation → Prep stations): a category goes to a station, and an item can have its own station,
  which wins over its category's. Printers choose the stations they print in Settings → Printer setup ("All stations"
  also prints items without a station).
* **Split by station:** every ticket holds one station's items.
* **Only what is new:** the POS remembers what went to the kitchen for each order. A ticket prints only items that are
  new or increased since the last one, plus **CANCEL** lines for items removed or reduced. So:
  * the cart's KOT button sends the items now; billing later prints only what was added since;
  * the second and later tickets of an order print **ADD-ON KOT 2**, 3...;
  * clearing a cart after its ticket went out prints a CANCEL ticket.
* **Reprints** (cart, Orders, ODS) print every ticket again marked **\*\*\* REPRINT \*\*\***. A manager approves.
* **Modes:** on prep station printers (default), with the bill (receipt printer), or off.
* **Online orders:** Settings → Online orders → "When an order is accepted, print" chooses the bill and/or the KOT.
  The ODS has Bill and KOT buttons on each accepted order. The first print needs no approval; after that it is a reprint.
* Delivery and packaging charges never go to the kitchen. Kitchen tickets never show prices.

## The workflow

As for bill designs (docs/RECEIPT_TEMPLATES.md): copy the closest file from `templates/kot/`, edit it to match the
shop's photo, upload it in its slot, check the preview at 58 and 80 mm, press **Use this design**. **Standard** goes
back to the standard design. Only the owner can change designs; the preview needs no upload.

## File format (version 1)

```json
{ "format": "tiffin-kot", "version": 1, "name": "Spice Route KOT", "description": "optional", "blocks": [ ... ] }
```

* At most 32 KB; 1 to 80 blocks; misspelt keys are refused.
* Exactly one `items` block is required.

### Blocks

| `type` | Settings | Prints |
|---|---|---|
| `text` | `text` (placeholders allowed) + styles | A line, wrapped. Left out when all its placeholders are empty. |
| `field` | `label`, `value` + styles | Label on the left, value on the right. Left out when the value is empty; the value alone when the label's placeholders are empty. |
| `rule` | `char`: `- = * _ . ~ #` | A full-width line. |
| `blank` | `lines`: 1 to 5 | Empty lines. |
| `kot-title` | styles | The safety marks: `*** REPRINT ***`, `ADD-ON KOT 2`. Without this block they print at the top. |
| `items` | `size`, `bold`, `modifiers` (default true), `notes` (default true) | `4 x Tandoori Roti`, add-ons as `+ ...`, notes as `>> ...`, and `CANCEL 1 x ...` lines. |

**Styles:** `align` (left, center, right), `bold`, `size` (normal, tall, wide, big), `if` (a placeholder: print only
when it has a value).

### Placeholders

| Placeholder | Value |
|---|---|
| `{{outlet.name}}` | Shop name |
| `{{kot.token}}`, `{{kot.station}}`, `{{kot.token-station}}` | Token, prep station, "113 \| TANDOOR" |
| `{{kot.no}}` | Ticket number within the order (1, 2...) |
| `{{kot.date}}`, `{{kot.date-only}}`, `{{kot.time}}` | "11 Oct, 01:20 PM", "11-10-2026", "13:20" |
| `{{kot.items}}`, `{{kot.qty}}` | Number of item lines, total quantity |
| `{{order.no}}` | The bill number; for online orders not yet billed, the online number |
| `{{order.type}}` | COUNTER, or channel and fulfilment such as "SWIGGY - DELIVERY" |
| `{{order.channel}}`, `{{online.no}}` | Counter / App / Website / Swiggy / Zomato; the online order number (W-1042) |
| `{{order.note}}`, `{{customer.name}}`, `{{customer.phone}}`, `{{cashier.name}}` | As typed on the order; who sent the ticket |

The POS has no tables or waiters, so a "DINE-IN - T4" line cannot be printed (see docs/DECISIONS.md).

## For developers

* Parser and renderer: `src/services/printing/kotTemplate.ts` (tests `test/kot_template.test.ts`); standard designs
  `src/services/printing/defaultKotTemplates.ts` (must equal `templates/kot/*.tiffinkot`).
* Engine: `src/services/printing/kot.ts` (what was sent per order in `kot_line`, migration 14; tests `test/kot.test.ts`).
  Prep stations: `src/services/stations.ts`.
* Endpoints: `GET /api/kot`, `PUT /api/kot/mode`, `POST /api/kot/designs/:slot/preview`, `PUT`/`DELETE /api/kot/designs/:slot`,
  `POST /api/orders/:id/kot` (send), `POST /api/orders/:id/kot-reprint`, `POST /api/invoices/:id/kot` and
  `/api/invoices/:id/print` (first print or reprint), `GET/POST/PATCH/DELETE /api/prep-stations`.
