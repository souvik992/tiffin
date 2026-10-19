// The default bill design (used when the shop has not uploaded one). Same content as templates/receipt/classic.tiffinreceipt;
// test/receipt_template.test.ts checks they match. Modelled on a classic Indian restaurant bill.
import type { ReceiptTemplate } from './receiptTemplate.ts';

export const DEFAULT_TEMPLATE: ReceiptTemplate = {
  "format": "tiffin-receipt",
  "version": 1,
  "name": "Classic",
  "description": "The POS's default bill: logo, store details, a Bill No / Cashier / Token / Date / Time row, Item / Price / Qty / Total columns, GST per rate and Net Amount.",
  "blocks": [
    {
      "type": "logo"
    },
    {
      "type": "text",
      "text": "{{outlet.name}}",
      "align": "center",
      "bold": true
    },
    {
      "type": "text",
      "text": "{{outlet.address}}",
      "align": "center"
    },
    {
      "type": "text",
      "text": "PH: {{outlet.phone}}",
      "align": "center"
    },
    {
      "type": "text",
      "text": "GSTIN: {{outlet.gstin}}",
      "align": "center"
    },
    {
      "type": "text",
      "text": "FSSAI: {{outlet.fssai}}",
      "align": "center"
    },
    {
      "type": "doc-title"
    },
    {
      "type": "rule"
    },
    {
      "type": "info-table",
      "columns": [
        {
          "label": "Bill No",
          "value": "{{invoice.no}}"
        },
        {
          "label": "Cashier",
          "value": "{{cashier.name}}"
        },
        {
          "label": "Token",
          "value": "{{invoice.token}}"
        },
        {
          "label": "Date",
          "value": "{{invoice.date-only}}"
        },
        {
          "label": "Time",
          "value": "{{invoice.time}}"
        }
      ]
    },
    {
      "type": "field",
      "label": "Against bill",
      "value": "{{invoice.against}}"
    },
    {
      "type": "field",
      "label": "Buyer GSTIN",
      "value": "{{invoice.buyer-gstin}}"
    },
    {
      "type": "field",
      "label": "Customer",
      "value": "{{customer.name}}"
    },
    {
      "type": "field",
      "label": "Phone",
      "value": "{{customer.phone}}"
    },
    {
      "type": "field",
      "label": "Order from",
      "value": "{{order.channel}}"
    },
    {
      "type": "rule"
    },
    {
      "type": "items",
      "columns": [
        {
          "field": "name",
          "label": "Item",
          "width": "*"
        },
        {
          "field": "rate",
          "label": "Price"
        },
        {
          "field": "qty",
          "label": "Qty",
          "decimals": 3
        },
        {
          "field": "amount",
          "label": "Total Rs"
        }
      ]
    },
    {
      "type": "rule"
    },
    {
      "type": "totals",
      "rows": [
        {
          "row": "total-qty",
          "label": "Total Quantity"
        },
        {
          "row": "subtotal",
          "label": "Gross Total"
        },
        "discount",
        "gst",
        "cess",
        "roundoff"
      ]
    },
    {
      "type": "grand-total",
      "label": "Net Amount",
      "refundLabel": "Refund Amount",
      "size": "normal",
      "bold": true
    },
    {
      "type": "payments"
    },
    {
      "type": "footer"
    },
    {
      "type": "rule"
    }
  ]
};
