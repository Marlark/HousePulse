'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const EnergyLedger = require('../lib/EnergyLedger');

const getTimezone = () => 'Europe/Stockholm';
const T = (iso) => Date.parse(iso);
const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg || ''} ${actual} ≠ ${expected}`);

test('pickMeters falls back to common capability names', () => {
  assert.deepStrictEqual(EnergyLedger.pickMeters(['measure_power', 'meter_power', 'meter_power.exported']),
    { in: 'meter_power', out: 'meter_power.exported' });
  assert.deepStrictEqual(EnergyLedger.pickMeters(['measure_power', 'meter_power', 'meter_power.imported', 'meter_power.exported']),
    { in: 'meter_power.imported', out: 'meter_power.exported' });
  assert.deepStrictEqual(EnergyLedger.pickMeters(['meter_power.charged', 'meter_power.discharged']),
    { in: 'meter_power.charged', out: 'meter_power.discharged' });
  assert.deepStrictEqual(EnergyLedger.pickMeters(['measure_power']), { in: null, out: null });
});

test('meter: counts from the first reading and handles meter resets', () => {
  const ledger = new EnergyLedger({ getTimezone });
  ledger.configure('grid', { in: 'meter_power', out: 'meter_power.exported' });
  ledger.onMeter('grid', 'meter_power', 21000, T('2026-11-08T10:00:00+01:00'));
  ledger.onMeter('grid', 'meter_power', 21003.5, T('2026-11-08T12:00:00+01:00'));
  close(ledger.get('grid').inKwh, 3.5);
  ledger.onMeter('grid', 'meter_power', 2, T('2026-11-08T13:00:00+01:00'));
  close(ledger.get('grid').inKwh, 0, 'meter reset starts over');
  ledger.onMeter('grid', 'meter_power', 3, T('2026-11-08T14:00:00+01:00'));
  close(ledger.get('grid').inKwh, 1);
});

test('meter: resets at midnight and interpolates the midnight reading', () => {
  const ledger = new EnergyLedger({ getTimezone });
  ledger.configure('grid', { in: 'meter_power', out: null });
  ledger.onMeter('grid', 'meter_power', 100, T('2026-11-08T23:50:00+01:00'));
  ledger.tick(T('2026-11-09T00:00:30+01:00'));
  close(ledger.get('grid').inKwh, 0, 'reset at midnight');
  // 1 kWh between 23:50 and 00:10 → half of it belongs to the new day
  ledger.onMeter('grid', 'meter_power', 101, T('2026-11-09T00:10:00+01:00'));
  close(ledger.get('grid').inKwh, 0.5);
  assert.strictEqual(ledger.get('grid').date, '2026-11-09');
});

test('meter: app off over midnight does not count yesterday’s energy as today’s', () => {
  const ledger = new EnergyLedger({ getTimezone });
  ledger.configure('grid', { in: 'meter_power', out: null });
  ledger.onMeter('grid', 'meter_power', 100, T('2026-11-08T22:00:00+01:00'));
  const saved = JSON.parse(JSON.stringify(ledger.toJSON()));

  // Restart at 02:00: 8 kWh used 22:00–02:00 at a steady rate → 4 kWh since midnight
  const restarted = new EnergyLedger({ getTimezone, data: saved });
  restarted.configure('grid', { in: 'meter_power', out: null });
  restarted.onMeter('grid', 'meter_power', 108, T('2026-11-09T02:00:00+01:00'));
  close(restarted.get('grid').inKwh, 4);
});

test('meter: data saved without timestamps (older version) still rolls over', () => {
  const ledger = new EnergyLedger({
    getTimezone,
    data: {
      grid: {
        date: '2026-11-08',
        meters: { in: 'meter_power', out: null },
        in: { kwh: 5, baseline: 95, last: 100 },
        out: { kwh: 0, baseline: null, last: null },
      },
    },
  });
  ledger.onMeter('grid', 'meter_power', 102, T('2026-11-09T08:00:00+01:00'));
  close(ledger.get('grid').inKwh, 2);
});

test('integration: holds power between reports, skips long gaps', () => {
  const ledger = new EnergyLedger({ getTimezone });
  ledger.configure('ev', { in: null, out: null });
  const start = T('2026-11-08T10:00:00+01:00');
  ledger.onPower('ev', 2000, start);
  for (let m = 1; m <= 30; m++) ledger.tick(start + m * 60000);
  close(ledger.get('ev').inKwh, 1, '2 kW for 30 min');

  ledger.onPower('ev', -1000, T('2026-11-08T10:30:00+01:00'));
  ledger.onPower('ev', 0, T('2026-11-08T10:36:00+01:00'));
  close(ledger.get('ev').outKwh, 0.1, '-1 kW for 6 min');

  ledger.onPower('ev', 5000, T('2026-11-08T11:00:00+01:00'));
  ledger.onPower('ev', 0, T('2026-11-08T12:00:00+01:00'));
  close(ledger.get('ev').inKwh, 1, 'a 60 min gap is not integrated');
  assert.strictEqual(ledger.get('ev').inSource, 'integrated');
});

test('persistence round trip', () => {
  const ledger = new EnergyLedger({ getTimezone });
  ledger.configure('a', { in: 'meter_power', out: null });
  ledger.onMeter('a', 'meter_power', 10, T('2026-11-08T10:00:00+01:00'));
  ledger.onMeter('a', 'meter_power', 12.5, T('2026-11-08T11:00:00+01:00'));
  const copy = new EnergyLedger({ getTimezone, data: JSON.parse(JSON.stringify(ledger.toJSON())) });
  close(copy.get('a').inKwh, 2.5);
});
