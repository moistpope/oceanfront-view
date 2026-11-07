// The next turn read from a navigation app's notification (static/js/infotainment.js parseNav): Google Maps'
// layout, and the shapes ABRP's may take (its format isn't documented, so the reading is lenient).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseNav } from '../../infotainment.js';

describe('parseNav', () => {
  test('Google Maps: the distance in the title, the turn in the text, the trip in the sub text', () => {
    const p = parseNav({ title: '500 ft', text: 'Turn right onto W Pico Blvd', subText: '7 min · 3.5 mi · 1:39 PM ETA' });
    assert.equal(p.dist.m, 500 * 0.3048);
    assert.equal(p.instruction, 'Turn right onto W Pico Blvd');
    assert.equal(p.street, 'W Pico Blvd');
    assert.deepEqual(p.maneuver, { kind: 'turn', side: 'right' });
    assert.match(p.trip, /7 min/);
  });

  test('the distance after the turn: "Turn right in 300 m"', () => {
    const p = parseNav({ title: 'Turn right in 300 m', text: 'Kungsgatan' });
    assert.equal(p.dist.m, 300);
    assert.equal(p.instruction, 'Turn right');
    assert.deepEqual(p.maneuver, { kind: 'turn', side: 'right' });
  });

  test('the distance first with a comma: "In 1,2 km, keep left onto E4"', () => {
    const p = parseNav({ title: 'In 1,2 km, keep left onto E4', subText: 'Arrive 14:32 with 45%' });
    assert.equal(Math.round(p.dist.m), 1200);
    assert.equal(p.instruction, 'keep left onto E4');
    assert.equal(p.street, 'E4');
    assert.deepEqual(p.maneuver, { kind: 'keep', side: 'left' });
    assert.match(p.trip, /Arrive/);
  });

  test('the turn in an inbox-style notification\'s text lines', () => {
    const p = parseNav({ app: 'A Better Routeplanner', title: 'A Better Routeplanner', text: '', lines: '0.4 mi\nTake the exit toward Fresno' });
    assert.equal(Math.round(p.dist.m), Math.round(0.4 * 1609.344));
    assert.equal(p.maneuver.kind, 'ramp');
  });
});
