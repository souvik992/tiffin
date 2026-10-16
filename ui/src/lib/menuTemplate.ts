/** The CSV template offered on the Bulk upload tab. Columns match previewItemsCsv in the backend. */
export const TEMPLATE = [
  'name,category,price,tax_percent,hsn,barcode,unit,veg',
  'Paneer Tikka,Starters,249,5,,,pcs,veg',
  'Chicken 65,Starters,269,5,,,pcs,non-veg',
  '"Masala Dosa, Ghee Roast",South Indian,120,5,,,plate,veg',
  'Mineral Water 1L,Beverages,20,18,2201,8901234500001,pcs,',
].join('\r\n') + '\r\n';
