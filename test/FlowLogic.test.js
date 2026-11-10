'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const F = require('../widgets/energy_flow_dash/public/js/flow-logic');

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const source = (overrides = {}) => ({
  missing: false, available: true, hasPower: true, power: 0, powerTs: 0, hasSoc: false, soc: null, name: 'x', today: null, ...overrides,
});
const suggestion = {
  roles: {
    grid: [{ id: 'grid', name: 'Grid meter' }],
    solar: [{ id: 'solar', name: 'Inverter' }],
    ev: [{ id: 'zappi', name: 'Charger' }],
    battery: [{ id: 'bat', name: 'Battery' }],
    car: [{ id: 'car', name: 'Car' }],
    home: [],
  },
};
const ids = (list) => list.map((s) => s.id);

/* ---------------- Choosing sources ---------------- */

test('pickSources: nothing configured → every role uses the suggestion', () => {
  const { roles, autoUsedRoles } = F.pickSources({}, suggestion);
  assert.deepStrictEqual(ids(roles.grid), ['grid']);
  assert.deepStrictEqual(ids(roles.ev), ['zappi']);
  assert.deepStrictEqual(autoUsedRoles, ['grid', 'solar', 'ev', 'battery', 'car']);
});

test('pickSources: choosing one device keeps the suggestions for the other roles (regression)', () => {
  const { roles, autoUsedRoles } = F.pickSources({ ev_device: { id: 'other', name: 'Other charger' } }, suggestion);
  assert.deepStrictEqual(ids(roles.ev), ['other']);
  assert.deepStrictEqual(ids(roles.grid), ['grid']);
  assert.deepStrictEqual(ids(roles.solar), ['solar']);
  assert.deepStrictEqual(ids(roles.battery), ['bat']);
  assert.deepStrictEqual(ids(roles.car), ['car']);
  assert.ok(!autoUsedRoles.includes('ev'));
});

test('pickSources: "None" turns a role off instead of falling back to the suggestion', () => {
  const { roles, autoUsedRoles } = F.pickSources({ ev_device: { id: F.NONE_ID, name: 'None' } }, suggestion);
  assert.deepStrictEqual(roles.ev, []);
  assert.ok(!autoUsedRoles.includes('ev'));
  assert.deepStrictEqual(ids(roles.grid), ['grid']);
});

test('pickSources: second slot only, duplicates removed, no suggestion available', () => {
  const settings = {
    solar_device_2: { id: 's2', name: 'Inverter 2' },
    battery_device: { id: 'b', name: 'B' },
    battery_device_2: { id: 'b', name: 'B again' },
  };
  const { roles, autoUsedRoles } = F.pickSources(settings, null);
  assert.deepStrictEqual(ids(roles.solar), ['s2']);
  assert.deepStrictEqual(ids(roles.battery), ['b']);
  assert.deepStrictEqual(roles.grid, []);
  assert.deepStrictEqual(autoUsedRoles, []);
});

/* ---------------- Aggregation ---------------- */

test('aggregateRole: sums power with the right sign per role', () => {
  const now = 1000;
  const grid = F.aggregateRole('grid', [source({ power: 1500 })], { now, invert: { grid: true } });
  assert.strictEqual(grid.power, -1500);
  const solar = F.aggregateRole('solar', [source({ power: -3000 }), source({ power: 2000 })], { now });
  assert.strictEqual(solar.power, 5000, 'solar is always positive, two inverters add up');
});

test('aggregateRole: averages state of charge, ignores missing/offline sources', () => {
  const info = F.aggregateRole('battery', [
    source({ hasSoc: true, soc: 40, power: 500 }),
    source({ hasSoc: true, soc: 80, power: 500 }),
    source({ hasSoc: true, soc: 10, power: 9000, available: false }),
  ], { now: 0 });
  assert.strictEqual(info.soc, 60);
  assert.strictEqual(info.power, 1000);
});

test('aggregateRole: stale only when no fresh value is left; idle values never go stale', () => {
  const staleMs = 10 * 60 * 1000;
  const now = 60 * 60 * 1000;
  const old = source({ power: 2000, powerTs: now - 20 * 60 * 1000 });
  const fresh = source({ power: 500, powerTs: now - 1000 });

  const onlyOld = F.aggregateRole('ev', [old], { now, staleMs });
  assert.strictEqual(onlyOld.power, null);
  assert.strictEqual(onlyOld.staleSince, old.powerTs);
  assert.strictEqual(F.statusKey('ev', onlyOld, onlyOld.power), 'lastSeen');

  const mixed = F.aggregateRole('ev', [old, fresh], { now, staleMs });
  assert.strictEqual(mixed.power, 500);
  assert.strictEqual(mixed.staleSince, null);

  const nightSolar = F.aggregateRole('solar', [source({ power: 0, powerTs: 0 })], { now, staleMs });
  assert.strictEqual(nightSolar.staleSince, null, 'solar at 0 W during the night is not "old"');

  const never = F.aggregateRole('ev', [old], { now, staleMs: 0 });
  assert.strictEqual(never.power, 2000, 'staleMs 0 = never mark as old');
});

test('aggregateRole + statusKey: missing, offline and not set', () => {
  assert.strictEqual(F.statusKey('grid', F.aggregateRole('grid', [], { now: 0 }), null), 'notSet');
  const missing = F.aggregateRole('grid', [source({ missing: true })], { now: 0 });
  assert.strictEqual(F.statusKey('grid', missing, null), 'missing');
  const offline = F.aggregateRole('grid', [source({ available: false })], { now: 0 });
  assert.strictEqual(F.statusKey('grid', offline, null), 'offline');
});

test('statusKey and towardHome follow the flow direction', () => {
  const info = { configured: true, allMissing: false, allOffline: false, staleSince: null };
  assert.strictEqual(F.statusKey('grid', info, 800), 'import');
  assert.strictEqual(F.statusKey('grid', info, -800), 'export');
  assert.strictEqual(F.statusKey('battery', info, -800), 'discharging');
  assert.strictEqual(F.statusKey('battery', info, 5), 'idle');
  assert.strictEqual(F.towardHome('grid', 800), true);
  assert.strictEqual(F.towardHome('grid', -800), false);
  assert.strictEqual(F.towardHome('battery', -800), true);
  assert.strictEqual(F.towardHome('ev', 3000), false);
  assert.strictEqual(F.towardHome('solar', 5), null);
});

test('aggregateToday: invert flips only integrated directions, marks estimates only when they contributed', () => {
  // Named meters (imported/exported) are right whatever the power sign: invert must not swap them
  const meter = { inKwh: 6.4, outKwh: 9.1, inSource: 'meter', outSource: 'meter' };
  const grid = F.aggregateToday('grid', [source({ today: meter })], { grid: true });
  assert.deepStrictEqual(grid, { in: 6.4, out: 9.1, approximate: false });

  // Integrated from an inverted power sign: swapped
  const integrated = { inKwh: 2, outKwh: 5, inSource: 'integrated', outSource: 'integrated' };
  assert.deepStrictEqual(F.aggregateToday('grid', [source({ today: integrated })], { grid: true }),
    { in: 5, out: 2, approximate: true });
  assert.deepStrictEqual(F.aggregateToday('battery', [source({ today: integrated })], { battery: true }),
    { in: 5, out: 2, approximate: true });

  // Import meter + integrated export with inverted sign: the integrated half measured imports
  const mixed = { inKwh: 7, outKwh: 7, inSource: 'meter', outSource: 'integrated' };
  assert.deepStrictEqual(F.aggregateToday('grid', [source({ today: mixed })], { grid: true }),
    { in: 7, out: 0, approximate: false });

  // Solar with a real production meter and an integrated (but zero) reverse direction
  const solar = F.aggregateToday('solar', [source({ today: { inKwh: 28, outKwh: 0, inSource: 'meter', outSource: 'integrated' } })]);
  assert.strictEqual(solar.approximate, false);

  const ev = F.aggregateToday('ev', [source({ today: { inKwh: 11.2, outKwh: 0, inSource: 'integrated', outSource: 'integrated' } })]);
  assert.strictEqual(ev.approximate, true);
  assert.strictEqual(F.aggregateToday('ev', [source()]), null);
});

/* ---------------- Home and self-sufficiency ---------------- */

test('calcHome: same numbers as checked by hand in the screenshots', () => {
  assert.strictEqual(F.calcHome({ grid: -1850, solar: 7420, battery: 1200, ev: 3680 }), 690);
  assert.strictEqual(F.calcHome({ grid: 850, solar: 4100, battery: 900, ev: 2300 }), 1750);
  assert.strictEqual(F.calcHome({ grid: -1200, solar: 5600, battery: -800, ev: null }), 5200);
  assert.strictEqual(F.calcHome({ grid: null, solar: 5000 }), null);
});

test('signHintKind: points at the setting that would fix a negative consumption', () => {
  // Grid sign inverted: really importing 2000 W, reported as -2000
  const gridWrong = { grid: -2000, solar: 0, battery: 0, ev: 0 };
  assert.strictEqual(F.signHintKind(F.calcHome(gridWrong), gridWrong), 'grid');
  // Battery sign inverted: really discharging 1500 W, reported as +1500 (charging)
  const batteryWrong = { grid: 200, solar: 0, battery: 1500, ev: 0 };
  assert.strictEqual(F.signHintKind(F.calcHome(batteryWrong), batteryWrong), 'battery');
});

test('self-sufficiency now and today', () => {
  assert.strictEqual(F.selfSufficiencyNow({ grid: -1850, ev: 3680, battery: 1200 }, 690), 1);
  close(F.selfSufficiencyNow({ grid: 1000, ev: 0, battery: 0 }, 4000), 0.75);
  assert.strictEqual(F.selfSufficiencyNow({ grid: 0, ev: 0, battery: 0 }, 5), null, 'no meaningful consumption');
  assert.strictEqual(F.selfSufficiencyNow({ grid: null }, 500), null);

  // 1 - 6.4 / (6.4 + 28.4 - 9.1 + (6.1 - 8.3)) = 1 - 6.4 / 23.5
  close(F.selfSufficiencyToday({
    grid: { in: 6.4, out: 9.1 }, solar: { in: 28.4, out: 0 }, battery: { in: 8.3, out: 6.1 },
  }), 1 - 6.4 / 23.5);
  assert.strictEqual(F.selfSufficiencyToday({ grid: { in: 1, out: 0 }, solar: null }), null);
});

test('solar self-consumption now and today', () => {
  // 4 kW solar, selling 1 kW: 75 % used in the house
  close(F.selfConsumptionNow({ grid: -1000, solar: 4000 }), 0.75);
  assert.strictEqual(F.selfConsumptionNow({ grid: 500, solar: 3000 }), 1, 'buying: all solar used');
  assert.strictEqual(F.selfConsumptionNow({ grid: -6000, solar: 4000 }), 0, 'battery also exporting: clamped');
  assert.strictEqual(F.selfConsumptionNow({ grid: -100, solar: 5 }), null, 'no meaningful production');
  assert.strictEqual(F.selfConsumptionNow({ grid: null, solar: 3000 }), null);

  close(F.selfConsumptionToday({ grid: { in: 6.4, out: 9.1 }, solar: { in: 28.4, out: 0 } }), 1 - 9.1 / 28.4);
  assert.strictEqual(F.selfConsumptionToday({ grid: { in: 1, out: 0 }, solar: { in: 0.05, out: 0 } }), null, 'night');
  assert.strictEqual(F.selfConsumptionToday({ grid: null, solar: { in: 5, out: 0 } }), null);
});

test('animation helpers stay within their ranges', () => {
  assert.ok(F.flowDuration(0) <= 2.8 && F.flowDuration(50000) >= 0.6);
  assert.ok(F.flowDuration(5000) < F.flowDuration(500));
  assert.strictEqual(F.flowWeight(0), 2);
  assert.strictEqual(F.flowWeight(100000), 6);
});

/* ---------------- Extra consumer node ---------------- */

test('extra node: never suggested, flows away from Home, shown as "consuming"', () => {
  const { roles, autoUsedRoles } = F.pickSources({ extra_device: { id: 'hp', name: 'Heat pump' } }, {
    roles: { ...suggestion.roles, extra: [{ id: 'nope', name: 'x' }] },
  });
  assert.deepStrictEqual(ids(roles.extra), ['hp']);
  assert.ok(!autoUsedRoles.includes('extra'));
  assert.deepStrictEqual(F.pickSources({}, suggestion).roles.extra, [], 'not filled from a suggestion');

  const info = { configured: true, allMissing: false, allOffline: false, staleSince: null };
  assert.strictEqual(F.statusKey('extra', info, 1800), 'consuming');
  assert.strictEqual(F.statusKey('extra', info, 3), 'idle');
  assert.strictEqual(F.towardHome('extra', 1800), false);
  assert.strictEqual(F.aggregateRole('extra', [source({ power: -1800 })], { now: 0 }).power, 1800, 'always positive');
});

test('extra node: Home shows the rest of the house; self-sufficiency still uses everything', () => {
  const powers = { grid: 3000, solar: 0, battery: 0, ev: 0, extra: 1800 };
  const total = F.calcHome(powers); // the extra consumer is fed from Home, so it is part of this
  assert.strictEqual(total, 3000);
  assert.strictEqual(F.homeRest(total, powers.extra), 1200);
  assert.strictEqual(F.homeRest(total, null), 3000);
  assert.strictEqual(F.homeRest(500, 1800), 0, 'never negative');
  assert.strictEqual(F.homeRest(null, 1800), null);
  assert.strictEqual(F.selfSufficiencyNow(powers, total), 0);
});

test('only grid, solar, EV, battery and car are ever filled automatically', () => {
  assert.deepStrictEqual(F.autoRoles({}), ['grid', 'solar', 'ev', 'battery', 'car']);
  const allChosen = {
    grid_device: { id: 'g' }, solar_device: { id: 's' }, ev_device: { id: 'e' }, battery_device: { id: 'b' }, car_device: { id: 'c' },
  };
  assert.deepStrictEqual(F.autoRoles(allChosen), [], 'no suggestions needed although home and extra are empty');
});
