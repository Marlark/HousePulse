'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const SolarSplit = require('../lib/SolarSplit');

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} ${a} ≠ ${b}`);
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 10, 10, 0, 0);
// Day changes at a fixed point, so tests do not depend on the timezone.
const today = (now) => (now < T0 + 24 * 60 * MIN ? '2026-11-10' : '2026-11-11');

const CONFIG = {
  grid: ['grid'], solar: ['sun'], ev: ['ev'], battery: ['bat'], invert: { grid: false, battery: false },
};

/** A SolarSplit with one configuration and settable powers. */
function setup(config = CONFIG) {
  const split = new SolarSplit({ today });
  const key = split.configure(config, T0);
  const powers = {};
  const set = (values, ts) => Object.assign(powers, Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value, ts }])));
  const update = (now) => split.update((id) => powers[id] || null, now);
  return {
    split, key, set, update,
  };
}

test('needs grid, solar and an EV or a battery', () => {
  const split = new SolarSplit({ today });
  assert.strictEqual(split.configure({ grid: ['g'], solar: ['s'] }, T0), null);
  assert.strictEqual(split.configure({ grid: [], solar: ['s'], ev: ['e'] }, T0), null);
  assert.strictEqual(split.configure(null, T0), null);
  assert.ok(split.configure({ grid: ['g'], solar: ['s'], ev: ['e'] }, T0));
});

test('the same roles in another order give the same entry', () => {
  const split = new SolarSplit({ today });
  const a = split.configure({ grid: ['g'], solar: ['s2', 's1'], ev: ['e'] }, T0);
  const b = split.configure({ ev: ['e', 'e'], solar: ['s1', 's2'], grid: ['g'] }, T0);
  assert.strictEqual(a, b);
  assert.strictEqual(split.entries.size, 1);
});

test('while exporting, all EV charging is solar', () => {
  const { split, key, set, update } = setup();
  set({ grid: -1000, sun: 5000, ev: 3000, bat: 0 }, T0);
  update(T0);
  update(T0 + 10 * MIN);
  const t = split.get(key, T0 + 10 * MIN);
  close(t.evKwh, 0.5);
  close(t.evSolarKwh, 0.5);
});

test('while importing, the EV gets the same mix as the house', () => {
  const { split, key, set, update } = setup();
  // 3 kW solar + 2 kW import = 5 kW supply → 60 % solar
  set({ grid: 2000, sun: 3000, ev: 4000, bat: 0 }, T0);
  update(T0);
  update(T0 + 6 * MIN);
  const t = split.get(key, T0 + 6 * MIN);
  close(t.evKwh, 0.4);
  close(t.evSolarKwh, 0.24);
});

test('battery discharge counts as not solar; battery charging is split too', () => {
  const { split, key, set, update } = setup();
  // Night: battery discharges 2 kW into the EV, 1 kW import → 0 % solar
  set({ grid: 1000, sun: 0, ev: 3000, bat: -2000 }, T0);
  update(T0);
  // Day: 6 kW solar, battery charges 3 kW, exporting → all solar
  set({ grid: -2000, sun: 6000, ev: 0, bat: 3000 }, T0 + 10 * MIN);
  update(T0 + 10 * MIN);
  update(T0 + 20 * MIN);
  const t = split.get(key, T0 + 20 * MIN);
  close(t.evKwh, 0.5);
  close(t.evSolarKwh, 0);
  close(t.batteryKwh, 0.5);
  close(t.batterySolarKwh, 0.5);
});

test('sign settings are applied to grid and battery', () => {
  const { split, key, set, update } = setup({ ...CONFIG, invert: { grid: true, battery: false } });
  // Meter reports export as positive: 2000 = selling 2 kW, so the EV is fully solar
  set({ grid: 2000, sun: 5000, ev: 3000, bat: 0 }, T0);
  update(T0);
  update(T0 + 10 * MIN);
  const t = split.get(key, T0 + 10 * MIN);
  close(t.evSolarKwh, t.evKwh);
});

test('no grid value, long gaps and silent devices are not counted', () => {
  const { split, key, set, update } = setup();
  set({ sun: 5000, ev: 3000 }, T0);
  update(T0);
  update(T0 + 5 * MIN);
  assert.strictEqual(split.get(key, T0 + 5 * MIN).evKwh, 0, 'grid unknown');

  set({ grid: 0 }, T0 + 5 * MIN);
  update(T0 + 5 * MIN);
  update(T0 + 60 * MIN);
  assert.strictEqual(split.get(key, T0 + 60 * MIN).evKwh, 0, 'gap of 55 min');

  // The EV reported 31 minutes ago: ignored
  set({ grid: 0, sun: 5000 }, T0 + 60 * MIN);
  set({ ev: 3000 }, T0 + 29 * MIN);
  update(T0 + 60 * MIN);
  update(T0 + 65 * MIN);
  assert.strictEqual(split.get(key, T0 + 65 * MIN).evKwh, 0);
});

test('totals reset at midnight and survive a restart', () => {
  const { split, key, set, update } = setup();
  set({ grid: -1000, sun: 5000, ev: 3000, bat: 0 }, T0);
  update(T0);
  update(T0 + 10 * MIN);

  const restored = new SolarSplit({ today, data: JSON.parse(JSON.stringify(split.toJSON())) });
  close(restored.get(key, T0 + 10 * MIN).evKwh, 0.5);

  const tomorrow = T0 + 24 * 60 * MIN;
  assert.strictEqual(split.get(key, tomorrow).evKwh, 0, 'a new day reads as zero');
  set({ grid: -1000, sun: 5000, ev: 3000, bat: 0 }, tomorrow);
  update(tomorrow);
  assert.strictEqual(split.get(key, tomorrow).date, '2026-11-11');
  assert.strictEqual(split.get(key, tomorrow).evKwh, 0);
});

test('configurations no widget has shown for a week are pruned', () => {
  const { split } = setup();
  split.prune(T0 + 6 * 24 * 60 * MIN);
  assert.strictEqual(split.entries.size, 1);
  split.prune(T0 + 8 * 24 * 60 * MIN);
  assert.strictEqual(split.entries.size, 0);
});

test('solarFraction', () => {
  close(SolarSplit.solarFraction({ grid: 2000, solar: 3000, battery: 0 }), 0.6);
  close(SolarSplit.solarFraction({ grid: -500, solar: 3000, battery: 1000 }), 1);
  close(SolarSplit.solarFraction({ grid: 0, solar: 1000, battery: -1000 }), 0.5);
  assert.strictEqual(SolarSplit.solarFraction({ grid: 0, solar: 0, battery: 0 }), 0);
});
