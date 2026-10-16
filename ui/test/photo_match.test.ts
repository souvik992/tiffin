import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPhotos, photoKey } from '../src/lib/photoMatch.ts';

const items = [
  { id: 'cb', name: 'Cheese Burger', shortName: 'CB', sku: 'BUR-02', barcode: null },
  { id: 'vb', name: 'Classic Veg Burger', shortName: null, sku: null, barcode: null },
  { id: 'br', name: 'Brownie', shortName: null, sku: null, barcode: null },
  { id: 'wb', name: 'Water Bottle 1L', shortName: null, sku: null, barcode: '8909876543210' },
  { id: 'pp', name: 'Paneer Tikka (Half)', shortName: null, sku: null, barcode: null },
];

test('photo file names are compared without case, extension, dashes, underscores, extra spaces or a "(1)" copy number', () => {
  assert.equal(photoKey('Cheese_Burger.JPG'), 'cheese burger');
  assert.equal(photoKey('cheese-burger (1).png'), 'cheese burger');
  assert.equal(photoKey('  Paneer Tikka (Half) .webp'), 'paneer tikka half');
  assert.equal(photoKey('Brownie copy.jpg'), 'brownie');
});

test('photos match items by name, SKU, barcode or the name without spaces; never by a guess', () => {
  const r = matchPhotos(['Cheese Burger.jpg', 'brownie.PNG', 'BUR-02.jpg', '8909876543210.jpg', 'classicvegburger.webp', 'paneer_tikka_half.jpg', 'burger.jpg', 'Samosa.jpg'], items);
  assert.deepEqual(r.map((m) => [m.file, m.itemId, m.how]), [
    ['Cheese Burger.jpg', 'cb', 'name'],
    ['brownie.PNG', 'br', 'name'],
    ['BUR-02.jpg', null, 'duplicate'], // Cheese Burger already has a photo in this batch
    ['8909876543210.jpg', 'wb', 'barcode'],
    ['classicvegburger.webp', 'vb', 'name'],
    ['paneer_tikka_half.jpg', 'pp', 'name'],
    ['burger.jpg', null, 'none'], // three items contain "burger": no guessing
    ['Samosa.jpg', null, 'none'],
  ]);
  assert.equal(r[2]!.duplicateOf, 'Cheese Burger.jpg');
  assert.equal(matchPhotos(['BUR-02.jpg'], items)[0]!.how, 'sku');
});
