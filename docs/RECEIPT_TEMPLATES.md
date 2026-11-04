# Receipt design files (.tiffinreceipt)

A design file makes a shop's bills print the way the shop wants, for example like the bills they used before.

## The workflow

1. **The shop sends you a sample.** This is a photo or PDF of the bill they want, plus their paper width (58 or 80 mm).
2. **You write the design file.** Copy the closest example from `templates/receipt/` and edit it to match the photo:
   * `classic.tiffinreceipt`: the default bill (logo, store details, a Bill No / Cashier / Token / Date / Time row, Item / Price / Qty / Total columns, Net Amount).
   * `standard.tiffinreceipt`: the earlier built-in layout.
   * `restaurant-gst-table.tiffinreceipt`: serial numbers and HSN on items, a GST table, a big token number and a UPI QR code.
   * `compact-58mm.tiffinreceipt`: a short bill for narrow paper.
3. **You check it.** From the repo root:
   ```bash
   npm run receipt -- path/to/shop.tiffinreceipt --width 80
   npm run receipt -- path/to/shop.tiffinreceipt --width 58
   npm run receipt -- path/to/shop.tiffinreceipt --credit        # how a refund (credit note) looks
   npm run receipt -- path/to/shop.tiffinreceipt --duplicate     # a reprint
   npm run receipt -- path/to/shop.tiffinreceipt --upi shop@okicici   # with the UPI QR code
   ```
   * **Valid file:** it prints the bill as it will look on paper. Double-width text shows as `D o u b l e`, and a QR code shows as `[QR code]`.
   * **Invalid file:** it lists every problem and exits with code 1.
4. **You send the file to the shop.** Keep the `.tiffinreceipt` ending; the POS only accepts that. The file is plain text, so it travels fine by WhatsApp or email.
5. **The owner uploads it** in **Settings → Store settings → Bill design → Upload design file**.
   * The POS checks the file and shows a preview at 58 and 80 mm. The owner presses **Use this design**.
   * From then on, every new bill, reprint, on-screen receipt and sample uses it.
   * **Back to standard design** undoes it.
   * Only the owner can change the design; managers can see which one is in use.

The design is stored in the shop's database, so it is included in backups and restores.

## What a design can and cannot do

**It can:** arrange, label, align, embolden and resize the information the POS already has. It can also hide optional parts: a line whose placeholders are all empty is left out automatically.

**Rupee sign and Hindi:** `"money": { "symbol": "₹" }` and item names in Hindi or other Indian scripts print as small pictures drawn with the system's fonts (Windows and Android). Where that is not possible they print as `Rs` and `?`.

**It cannot:**
* run code or calculate anything. Every amount is the backend's own figure, formatted for print.
* remove the safety marks. `doc-title` always prints `TAX INVOICE` or `CREDIT NOTE`, `SAMPLE - NOT A BILL` on samples, and `*** CANCELLED ***` and `*** DUPLICATE ***` when they apply.
* skip the paper feed, cut and cash-drawer kick; the POS adds those itself.
* change the kitchen ticket (KOT). Kitchen tickets have their own designs (.tiffinkot): see docs/KOT_TEMPLATES.md.

**A design must include everything a GST bill needs, or the upload is refused:**
* a `doc-title` block
* `{{invoice.no}}`
* `{{invoice.date}}` or `{{invoice.date-only}}`
* `{{outlet.gstin}}` (left out automatically when the shop has no GSTIN)
* an `items` block
* the GST amounts, as a `tax-table` block or `"gst"` in a `totals` block
* a `grand-total` block

Exactly what a bill must show (HSN for the shop's turnover, FSSAI, place of supply) is the shop's CA's call. This check only stops the obvious mistakes.

## File format (version 1)

```json
{
  "format": "tiffin-receipt",
  "version": 1,
  "name": "Sharma Sweets",
  "description": "Optional, up to 300 characters",
  "money": { "symbol": "Rs" },
  "blocks": [ ... ]
}
```

| Key | Required | Meaning |
|---|---|---|
| `format` | yes | Always `"tiffin-receipt"`. |
| `version` | yes | Always `1`. |
| `name` | yes | 1 to 60 characters. The owner sees this name. |
| `description` | no | Up to 300 characters. |
| `money.symbol` | no | The text before amounts: `""` (default), `"Rs"`, `"Rs."`, `"INR"` or `"₹"` (printed as a picture). |
| `blocks` | yes | 1 to 150 blocks, printed top to bottom. |

Rules for the file as a whole:
* At most 64 KB.
* Misspelt keys are refused (for example `"allign"`) rather than silently ignored.
* Paper is 32 characters wide at 58 mm and 48 at 80 mm. Double-width text (`wide`, `big`) fits half as many characters.

### Styles

These work on `text`, `field`, `doc-title`, `grand-total` and `footer`.

| Key | Values |
|---|---|
| `align` | `left` (default), `center`, `right` |
| `bold` | `true` / `false` |
| `size` | `normal`, `tall` (double height), `wide` (double width), `big` (both) |
| `if` | A placeholder name. The block prints only when that value is not empty, for example `"if": "invoice.token"`. |

### Blocks

| `type` | Settings | Prints |
|---|---|---|
| `text` | `text` (up to 300 characters, placeholders allowed) + styles | A line, wrapped to the paper width. |
| `field` | `label`, `value` + styles | The label on the left and the value on the right. Left out when the value is empty. |
| `rule` | `char`: one of `- = * _ . ~ #` | A full-width line. |
| `blank` | `lines`: 1 to 5 | Empty lines. |
| `doc-title` | styles (default: centred, bold) | The bill title and the safety marks. |
| `items` | `columns` (see below); `header` (default true); `modifiers` (default true: add-ons under the item); `notes` (default true) | The item table. |
| `totals` | `rows`: list of row names, or `{ "row": ..., "label": ... }` | Total lines (see below). |
| `grand-total` | `label` (default `TOTAL`), `refundLabel` (default `REFUND`, used on credit notes) + styles (default: tall, bold) | The bill total. |
| `tax-table` | none | A GST summary per rate: rate, taxable value and CGST/SGST (or IGST). On narrow paper it becomes one small block per rate. |
| `payments` | `change` (default true: tendered and change for cash) | Each payment mode and its amount. |
| `qr` | `data`: `"upi"` or text with placeholders; `size` 3 to 8; `align`; `if` | A QR code. `"upi"` makes a UPI payment code for the bill total, using the UPI id in settings. It is left out when there is no UPI id, and on refunds and cancelled bills. |
| `footer` | styles (default: centred) | The footer text from Settings → Store settings. |
| `logo` | none | The logo from Settings → Store settings, centred, in black and white. Left out when there is no logo. |
| `info-table` | `columns`: 2 to 6 of `{ "label": ..., "value": ... }`; `rule` (default true) | Labels on one line and values under them, like "Bill No  Waiter  Date  Time". When it does not fit the paper, it prints one "label  value" line each. |

**`items` columns** (1 to 7). Each column is `{ "field": ..., "label": ..., "width": ..., "align": ... }`.
* **Fields:**
  * `sno`: serial number
  * `name`: item name
  * `qty`: quantity
  * `rate`: unit price
  * `amount`: line total
  * `hsn`: HSN/SAC code
  * `gst`: GST rate
* **Required:** `name` and `amount`.
* **Width:** a number from 2 to 30. A fixed column grows if a value is longer, so numbers are never cut.
  * Give the name `"width": "*"` so it takes the remaining space. Long names wrap inside their column.
  * If the name would get fewer than 12 characters (many columns on 58 mm paper), each item prints on two lines: the name, then the numbers.
* **Decimals:** the `qty` column can have `"decimals"` (0 to 3); `3` prints `1.000` like many restaurant bills.
* **Align:** numbers are right-aligned; `name` and `hsn` are left-aligned. Use `"align"` to change this.

**`totals` rows.** Rows whose amount is zero are left out where noted.

| Row | Prints |
|---|---|
| `subtotal` | The item total before discount. |
| `discount` | The bill discount. Left out when zero. |
| `taxable` | The taxable value. |
| `gst` | CGST and SGST (or IGST) per rate. Its labels cannot be changed. |
| `cess` | Cess. Left out when zero. |
| `roundoff` | The round-off. Left out when zero. |
| `tax-total` | Total GST. |
| `total-qty` | The total quantity, with the qty column's decimals. |

### Placeholders

Write placeholders as `{{name}}` inside `text`, `field` labels and values, and `qr` data. An unknown name is refused.

| Placeholder | Value |
|---|---|
| `{{outlet.name}}`, `{{outlet.address}}`, `{{outlet.phone}}` | From Settings → Store settings. A multi-line address prints line by line. |
| `{{outlet.gstin}}`, `{{outlet.fssai}}` | GSTIN, FSSAI licence number. |
| `{{invoice.no}}` | Bill number, for example `A1/26-27/000123`. |
| `{{invoice.date}}` | `15-10-2026 19:43` (Indian time). |
| `{{invoice.date-only}}`, `{{invoice.time}}` | `15-10-2026`, `19:43` |
| `{{invoice.token}}` | Token number. Empty on credit notes. |
| `{{invoice.against}}` | The original bill number on a credit note. Empty otherwise. |
| `{{invoice.buyer-gstin}}` | The customer's GSTIN (B2B bills). |
| `{{invoice.total}}` | Bill total, formatted. |
| `{{invoice.items}}` | Number of item lines. |
| `{{cashier.name}}` | Who made the bill. |
| `{{customer.name}}`, `{{customer.phone}}` | Typed on the bill under Customer and note. Empty when not given. |
| `{{order.channel}}` | Where the order came from: App, Website, Swiggy or Zomato. Empty for counter bills. |

## Tips for copying a shop's bill

* Start from the photo's top and add one block per printed line.
* Shop name: `"size": "big"` is very large on 58 mm (16 characters per line). `"tall"` is often closer to old bills.
* Do they print "Bill No" and "Date" on one line? Use one `text` block, for example `"{{invoice.no}}  {{invoice.date}}"`.
* Check both paper widths and a credit note before sending.
* If the shop's old bill shows something the POS does not have (a table number, a customer name), it cannot be added with a design file. Note it as a feature request.

## For developers

* **Parser and renderer:** `src/services/printing/receiptTemplate.ts`, with tests in `test/receipt_template.test.ts`. Storage and endpoints: `src/services/printing/receiptDesign.ts`.
* **Endpoints:**
  * `GET /api/receipt-design` (managers and owner)
  * `POST /api/receipt-design/preview` (owner; nothing is saved)
  * `PUT` and `DELETE /api/receipt-design` (owner; audited)
* **Changing the format:** keep version 1 files working. If version 1 cannot express something, add version 2 and keep reading version 1. A stored design that stops parsing never blocks billing: bills print in the standard layout and a warning is logged.
