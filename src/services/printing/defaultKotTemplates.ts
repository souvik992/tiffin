import type { KotTemplate } from './kotTemplate.ts';

/**
 * The standard KOT designs, one per slot. They must equal templates/kot/<slot>.tiffinkot (a test checks this).
 *   customer  printed with the bill on the receipt printer (one per prep station); laid out like the shop's own ticket
 *   station   printed at each prep station's printer
 *   online    online orders (store app, website, Swiggy, Zomato): the channel and online number on top
 */

const common = (title: string): KotTemplate['blocks'] => [
  { type: 'text', text: '{{outlet.name}}', align: 'center', bold: true },
  { type: 'text', text: title, align: 'center', bold: true },
  { type: 'rule' },
  { type: 'kot-title', align: 'center', bold: true },
];
const tail: KotTemplate['blocks'] = [
  { type: 'rule' },
  { type: 'items' },
  { type: 'text', text: 'Order note: {{order.note}}' },
  { type: 'rule' },
  { type: 'field', label: 'Items: {{kot.items}}', value: 'Qty: {{kot.qty}}' },
  { type: 'blank' },
  { type: 'text', text: '** END **', align: 'center', bold: true },
];

export const DEFAULT_KOT_TEMPLATES: Record<'customer' | 'station' | 'online', KotTemplate> = {
  customer: {
    format: 'tiffin-kot', version: 1, name: 'Standard KOT', description: 'Token and prep station in big letters, then the items with their notes.',
    blocks: [
      ...common('KITCHEN ORDER TICKET'),
      { type: 'text', text: 'TOKEN', align: 'center', if: 'kot.token' },
      { type: 'text', text: '{{kot.token-station}}', align: 'center', size: 'big', bold: true },
      { type: 'text', text: '{{order.type}}', align: 'center' },
      { type: 'field', label: 'Order: {{order.no}}', value: '{{kot.date}}' },
      ...tail,
    ],
  },
  station: {
    format: 'tiffin-kot', version: 1, name: 'Standard prep station KOT', description: 'The prep station on top, then the token and the items.',
    blocks: [
      ...common('KITCHEN ORDER TICKET'),
      { type: 'text', text: '{{kot.station}}', align: 'center', size: 'big', bold: true },
      { type: 'text', text: 'TOKEN {{kot.token}}', align: 'center', size: 'tall', bold: true },
      { type: 'text', text: '{{order.type}}', align: 'center' },
      { type: 'field', label: 'Order: {{order.no}}', value: '{{kot.date}}' },
      ...tail,
    ],
  },
  online: {
    format: 'tiffin-kot', version: 1, name: 'Standard online order KOT', description: 'The channel and online order number on top, delivery or pickup, the customer.',
    blocks: [
      ...common('ONLINE ORDER - KOT'),
      { type: 'text', text: '{{order.channel}} {{online.no}}', align: 'center', size: 'big', bold: true },
      { type: 'text', text: '{{order.type}}', align: 'center', bold: true },
      { type: 'text', text: 'TOKEN {{kot.token}}  {{kot.station}}', align: 'center' },
      { type: 'field', label: 'Customer', value: '{{customer.name}}' },
      { type: 'field', label: 'Bill: {{order.no}}', value: '{{kot.date}}' },
      ...tail,
    ],
  },
};
