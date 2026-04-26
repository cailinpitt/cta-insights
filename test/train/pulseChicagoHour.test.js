const test = require('node:test');
const assert = require('node:assert');
const { chicagoHourNow } = require('../../bin/train/pulse');

test('chicagoHourNow: midnight CT (CDT, UTC-5) returns 0 not 24', () => {
  // 05:30Z in late April = 00:30 CDT
  assert.equal(chicagoHourNow(new Date('2026-04-26T05:30:00Z')), 0);
});

test('chicagoHourNow: midnight CT (CST, UTC-6) returns 0 not 24', () => {
  // 06:30Z in January = 00:30 CST
  assert.equal(chicagoHourNow(new Date('2026-01-15T06:30:00Z')), 0);
});

test('chicagoHourNow: 1am CT returns 1', () => {
  assert.equal(chicagoHourNow(new Date('2026-04-26T06:00:00Z')), 1);
});

test('chicagoHourNow: noon CT returns 12', () => {
  assert.equal(chicagoHourNow(new Date('2026-04-26T17:00:00Z')), 12);
});
