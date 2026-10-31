// The country the car is in (region.js) and the Auto settings that follow it (regional.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as data from '../../borders_data.js';
import { prepare, countryAt, Region, countryInfo } from '../../region.js';
import { setCountry, leftTraffic, cameraSignUnit, signStyle, cameraSignValue } from '../../regional.js';

const list = prepare(data);

describe('region', () => {
  test('finds the country under a point', () => {
    const at = (lat, lon) => countryAt(list, lat, lon)?.name ?? null;
    assert.equal(at(51.5033, -0.1276), 'United Kingdom');   // Whitehall
    assert.equal(at(52.15, -1.5), 'United Kingdom');        // Kineton
    assert.equal(at(54.597, -5.930), 'United Kingdom');     // Belfast
    assert.equal(at(53.349, -6.260), 'Ireland');            // Dublin
    assert.equal(at(48.857, 2.352), 'France');
    assert.equal(at(39.74, -104.99), 'United States of America');
    assert.equal(at(45.5, -73.57), 'Canada');
    assert.equal(at(-33.87, 151.21), 'Australia');
    assert.equal(at(50.5, -3.0), null);                      // the Channel
  });

  test('what the country settles', () => {
    const uk = countryAt(list, 51.5, -0.12), ie = countryAt(list, 53.35, -6.26), us = countryAt(list, 39.74, -104.99);
    assert.deepEqual([uk.left, uk.mph, uk.usSign, uk.gb], [true, true, false, true]);
    assert.deepEqual([ie.left, ie.mph, ie.usSign, ie.gb], [true, false, false, false]);
    assert.deepEqual([us.left, us.mph, us.usSign], [false, true, true]);
    const fr = countryAt(list, 48.86, 2.35);
    assert.deepEqual([fr.left, fr.mph, fr.usSign], [false, false, false]);
    assert.equal(countryAt(list, 35.2, 33.6)?.left, true);  // Northern Cyprus, which has no ISO code
  });

  test('a new country is taken after a while in it; the sea and a stray fix change nothing; it is remembered', () => {
    const seen = [];
    const r = new Region((c) => seen.push(c.name), null);
    assert.equal(r.update(54.6, -5.93, 0, list).name, 'United Kingdom');    // the first, straight away
    assert.equal(r.update(53.35, -6.26, 1, list).name, 'United Kingdom');   // into Ireland...
    assert.equal(r.update(54.6, -5.93, 2, list).name, 'United Kingdom');    // ...a stray fix, back
    r.update(53.35, -6.26, 10, list);
    assert.equal(r.update(53.35, -6.26, 39, list).name, 'United Kingdom');
    assert.equal(r.update(53.35, -6.26, 41, list).name, 'Ireland');         // 31 s in Ireland
    assert.equal(r.update(53.5, -5.0, 100, list).name, 'Ireland');          // the Irish Sea
    assert.deepEqual(seen, ['United Kingdom', 'Ireland']);
    const again = new Region(() => {}, { code: 372, name: 'Ireland' });
    assert.equal(again.country.name, 'Ireland');
    assert.equal(again.country.mph, false);
  });

  test('the Auto settings follow the country, the overrides still win', () => {
    const tsr = { speedLimit: 30, unit: 'kmh' }, f = { road: { trafficSide: 'Right_Hand_Traffic' } };
    try {
      setCountry(countryInfo(826, 'United Kingdom'));
      assert.equal(leftTraffic({}, f), true);
      assert.equal(cameraSignUnit({}, tsr), 'mph');
      assert.equal(cameraSignValue({}, tsr, 'mph'), 30);   // the UK's 30 stays 30 (it read as 19)
      assert.equal(signStyle({}, 'mph', f), 'eu');
      assert.equal(leftTraffic({ trafficSide: 'right' }, f), false);
      assert.equal(cameraSignUnit({ cameraSignUnits: 'kmh' }, tsr), 'kmh');
      setCountry(countryInfo(840, 'United States of America'));
      assert.equal(leftTraffic({}, { road: { trafficSide: 'Left_Hand_Traffic' } }), false);
      assert.equal(signStyle({}, 'kmh'), 'us');
      setCountry(countryInfo(250, 'France'));
      assert.equal(cameraSignUnit({}, { unit: 'mph' }), 'kmh');
    } finally { setCountry(null); }
  });
});
