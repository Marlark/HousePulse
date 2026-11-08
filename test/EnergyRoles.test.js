'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/EnergyRoles');
const dev = (id, name, cls, caps, energyObj = {}, values = {}, virtualClass = null) => ({
  id, name, class: cls, virtualClass, capabilities: caps, energyObj,
  capabilitiesObj: Object.fromEntries(caps.map((c) => [c, { value: values[c] ?? null, title: c.replace('measure_power.', 'Power ') }])),
});

test('household A: hybrid inverter with everything in one device', () => {
// --- Household A: hybrid inverter that reports everything in one device (no energy metadata)
const hybrid = dev('h1', 'Hybrid Inverter', 'sensor',
  ['measure_power', 'measure_power.solar', 'measure_power.grid', 'measure_power.battery', 'measure_battery']);
const sugA = R.suggest([hybrid], null);
assert.deepStrictEqual(sugA.solar.map((s) => s.id), ['h1|measure_power.solar']);
assert.deepStrictEqual(sugA.grid.map((s) => s.id), ['h1|measure_power.grid']);
assert.deepStrictEqual(sugA.battery.map((s) => s.id), ['h1|measure_power.battery']);
assert.deepStrictEqual(sugA.ev, []);
// picker for solar ranks the solar sub-capability above the generic entries
const solarEntries = R.pickerEntries(hybrid, 'solar', { zoneName: 'Garage', socOnlyLabel: 'SoC only' });
assert.strictEqual(solarEntries.sort((a, b) => b.score - a.score)[0].id, 'h1|measure_power.solar');
// battery picker offers a "SoC only" entry
assert.ok(R.pickerEntries(hybrid, 'battery', { socOnlyLabel: 'SoC only' }).some((e) => e.id === 'h1|measure_battery'));
// resolving sources
assert.deepStrictEqual(R.resolveSource(hybrid, 'measure_power.solar'), { power: 'measure_power.solar', soc: null });
assert.deepStrictEqual(R.resolveSource(hybrid, 'measure_battery'), { power: null, soc: 'measure_battery' });
assert.deepStrictEqual(R.resolveSource(hybrid, null), { power: 'measure_power', soc: 'measure_battery' });
assert.deepStrictEqual(R.resolveSource(hybrid, 'measure_power.gone'), { power: null, soc: null });
// sub-capabilities never get the device's main kWh meters
assert.deepStrictEqual(R.pickMeters(hybrid, 'measure_power.solar'), { in: null, out: null });

});

test('household B: energy-aware drivers and several cumulative meters', () => {
// --- Household B: Homey-energy-aware drivers, several "cumulative" meters (circuit meters too)
const p1 = dev('p1', 'P1 meter', 'sensor', ['measure_power', 'meter_power.imported', 'meter_power.exported'],
  { cumulative: true, cumulativeImportedCapability: 'meter_power.imported', cumulativeExportedCapability: 'meter_power.exported' },
  { measure_power: 2400 });
const circuit = dev('c1', 'Circuit meter', 'sensor', ['measure_power', 'meter_power', 'meter_power.returned'],
  { cumulative: true, cumulativeImportedCapability: 'meter_power', cumulativeExportedCapability: 'meter_power.returned' },
  { measure_power: 3100 });
const inverter = dev('s1', 'Inverter', 'solarpanel', ['measure_power', 'meter_power'],
  { generator: true, meterPowerExportedCapability: 'meter_power' });
const battery = dev('b1', 'Battery', 'battery', ['measure_power', 'measure_battery', 'meter_power.charged', 'meter_power.discharged'],
  { homeBattery: true, meterPowerImportedCapability: 'meter_power.charged', meterPowerExportedCapability: 'meter_power.discharged' });
const charger = dev('e1', 'Wallbox', 'evcharger', ['measure_power', 'meter_power'], { evCharger: true, meterPowerImportedCapability: 'meter_power' });
const car = dev('car', 'My EV', 'vehicle', ['measure_battery'], { electricCar: true }, {}, 'car');
const thermo = dev('t1', 'Thermostat', 'thermostat', ['measure_battery']);
const all = [thermo, circuit, p1, inverter, battery, charger, car];

// With Homey's live report the main meter is the one matching totalCumulative (not the biggest load)
let sug = R.suggest(all, { totalCumulative: { W: 2400 } });
assert.deepStrictEqual(sug.grid.map((s) => s.id), ['p1']);
// Without it, fall back to largest absolute load
sug = R.suggest(all, null);
assert.deepStrictEqual(sug.grid.map((s) => s.id), ['p1'], 'grid-like meter beats bigger circuit meter');
assert.deepStrictEqual(sug.solar.map((s) => s.id), ['s1']);
assert.deepStrictEqual(sug.battery.map((s) => s.id), ['b1']);
assert.deepStrictEqual(sug.ev.map((s) => s.id), ['e1']);
assert.deepStrictEqual(sug.car.map((s) => s.id), ['car'], 'car found via electricCar / virtualClass');
// meters from energy metadata; generator production comes from the "exported" meter
assert.deepStrictEqual(R.pickMeters(p1, 'measure_power'), { in: 'meter_power.imported', out: 'meter_power.exported' });
assert.deepStrictEqual(R.pickMeters(inverter, 'measure_power'), { in: 'meter_power', out: null });
assert.deepStrictEqual(R.pickMeters(battery, 'measure_power'), { in: 'meter_power.charged', out: 'meter_power.discharged' });
// car picker: the car first, thermostat (also measure_battery) after
const carEntries = [car, thermo].flatMap((d) => R.pickerEntries(d, 'car', {})).sort((a, b) => b.score - a.score);
assert.deepStrictEqual(carEntries.map((e) => e.id), ['car', 't1']);

});

test('household C: no energy metadata', () => {
// --- Household C: no energy metadata at all, plain names → name-based meter fallback still works
const plain = dev('x', 'Old meter', 'other', ['measure_power', 'meter_power.imported', 'meter_power.exported']);
assert.deepStrictEqual(R.pickMeters(plain, 'measure_power'), { in: 'meter_power.imported', out: 'meter_power.exported' });
assert.deepStrictEqual(R.suggest([plain], null).grid, [], 'not auto-picked without metadata');

});

test('source ids', () => {
// source ids
assert.deepStrictEqual(R.parseSourceId('abc|measure_power.solar'), { deviceId: 'abc', capabilityId: 'measure_power.solar' });
assert.deepStrictEqual(R.parseSourceId('abc'), { deviceId: 'abc', capabilityId: null });
});

test('grid: a live report that matches no meter does not override the heuristics', () => {
  const dev = (id, cls, exportedCap, w) => ({
    id, name: id, class: cls, capabilities: ['measure_power', 'meter_power', exportedCap],
    energyObj: { cumulative: true, cumulativeImportedCapability: 'meter_power', cumulativeExportedCapability: exportedCap },
    capabilitiesObj: { measure_power: { value: w } },
  });
  const devices = [dev('plug', 'socket', 'meter_power.exported', 9000), dev('clamp', 'sensor', 'meter_power.returned', 4000),
    dev('main', 'sensor', 'meter_power.exported', 1500)];
  // Homey reports 7000 W (e.g. a sum) — nothing within 5 % → fall back; socket excluded
  assert.deepStrictEqual(R.suggest(devices, { totalCumulative: { W: 7000 } }).grid.map((s) => s.id), ['main']);
  // Homey reports 4010 W → the clamp matches Homey's own figure and wins
  assert.deepStrictEqual(R.suggest(devices, { totalCumulative: { W: 4010 } }).grid.map((s) => s.id), ['clamp']);
});
