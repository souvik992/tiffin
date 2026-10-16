import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIN_LENGTH, isMobile, isPin, mobileDigits, pinDigits } from '../src/lib/pin.ts';

test('PINs are exactly 4 digits: extra digits and letters are dropped while typing or pasting', () => {
  assert.equal(PIN_LENGTH, 4);
  assert.equal(pinDigits('123456'), '1234');
  assert.equal(pinDigits('12a3 4'), '1234');
  assert.equal(pinDigits('٣'), ''); // only 0-9
  assert.ok(isPin('0000'));
  for (const bad of ['123', '12345', '12a4', '']) assert.equal(isPin(bad), false, bad);
});

test('mobile numbers for sign-in: 10 digits starting with 6-9; spaces are dropped while typing', () => {
  assert.equal(mobileDigits('98123 45678'), '9812345678');
  assert.equal(mobileDigits('98123456789'), '9812345678');
  assert.ok(isMobile('9812345678'));
  for (const bad of ['1234567890', '981234567', '', '98123a5678']) assert.equal(isMobile(bad), false, bad);
});
