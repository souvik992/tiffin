import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allSettings, getSetting, setSetting } from '../src/services/settings.ts';
import { makeEnv } from './helpers.ts';

test('settings named "..._key" (API keys, device keys) are secrets: never listed with the plain settings', () => {
  const env = makeEnv(); try {
    setSetting(env.ctx, 'ods_google_maps_key', 'AIzaSECRET');
    setSetting(env.ctx, 'ods_hub_key', 'tpk_SECRET');
    setSetting(env.ctx, 'ods_hub_url', 'https://orders.example.in');
    setSetting(env.ctx, 'monkey', 'not a secret: no underscore before "key"');
    const listed = allSettings(env.ctx);
    assert.ok(!('ods_google_maps_key' in listed) && !('ods_hub_key' in listed));
    assert.ok(!JSON.stringify(listed).includes('SECRET'));
    assert.equal(listed.ods_hub_url, 'https://orders.example.in');
    assert.equal(listed.monkey, 'not a secret: no underscore before "key"');
    assert.equal(getSetting(env.ctx, 'ods_google_maps_key'), 'AIzaSECRET', 'the backend itself still reads it');
  } finally { env.cleanup(); }
});
