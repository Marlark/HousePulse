'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { FakeDevice, createApp, flush } = require('./helpers/fakeHomey');

delete process.env.DEBUG; // debug logging off, like an installed app

/* ---------------- Fixtures ---------------- */

function gridMeter(overrides = {}) {
  return new FakeDevice({
    id: 'grid',
    name: 'Main meter',
    capabilities: {
      measure_power: 1500,
      meter_power: 1000,
      'meter_power.exported': 200,
      'measure_power.phase1': 500,
    },
    energyObj: { cumulative: true, cumulativeImportedCapability: 'meter_power', cumulativeExportedCapability: 'meter_power.exported' },
    ...overrides,
  });
}
const hybrid = () => new FakeDevice({
  id: 'hyb',
  name: 'Hybrid inverter',
  capabilities: { measure_power: 900, 'measure_power.solar': 4200, 'measure_power.grid': -300, measure_battery: 64 },
});
const car = () => new FakeDevice({
  id: 'car', name: 'My EV', cls: 'vehicle', virtualClass: 'car', capabilities: { measure_battery: 72 }, energyObj: { electricCar: true },
});
const thermostat = () => new FakeDevice({ id: 'thermo', name: 'Thermostat', cls: 'thermostat', capabilities: { measure_battery: 100 } });

const events = (realtime, name) => realtime.filter((e) => e.event === name).map((e) => e.data);

/* ---------------- Device pickers ---------------- */

test('registers a device picker for every widget setting', async () => {
  const { autocomplete } = await createApp();
  assert.deepStrictEqual(Object.keys(autocomplete).sort(), [
    'battery_device', 'battery_device_2', 'car_device', 'ev_device', 'ev_device_2',
    'extra_device', 'grid_device', 'home_device', 'solar_device', 'solar_device_2',
  ]);
});

test('pickers: "None" first in the user\'s language, the car before other battery devices', async () => {
  const { autocomplete } = await createApp({ devices: [thermostat(), car()], language: 'sv' });
  const results = await autocomplete.car_device('');
  assert.deepStrictEqual(results.map((r) => r.id), ['__none__', 'car', 'thermo']);
  assert.strictEqual(results[0].name, '— Ingen —');
  assert.deepStrictEqual((await autocomplete.car_device('ev')).map((r) => r.id), ['car'], 'search filters');
});

test('pickers: hybrid inverter sub-values are offered, the matching one first', async () => {
  const { autocomplete } = await createApp({ devices: [hybrid()] });
  const ids = (await autocomplete.solar_device('')).map((r) => r.id);
  assert.strictEqual(ids[1], 'hyb|measure_power.solar');
  assert.ok(ids.includes('hyb') && ids.includes('hyb|measure_power.grid'));
  const battery = (await autocomplete.battery_device('')).map((r) => r.id);
  assert.ok(battery.includes('hyb|measure_battery'), 'state-of-charge-only entry');
});

/* ---------------- Subscribing and live values ---------------- */

test('subscribe returns a snapshot and listens only to the capabilities it needs', async () => {
  const { app, devices } = await createApp({ devices: [gridMeter()] });
  const { sources } = await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });

  assert.strictEqual(sources.length, 1);
  assert.strictEqual(sources[0].power.capability, 'measure_power');
  assert.strictEqual(sources[0].power.value, 1500);
  assert.strictEqual(sources[0].soc, null);
  assert.strictEqual(sources[0].today.inSource, 'meter');
  const listened = devices.grid.activeInstances().map((i) => i.capabilityId).sort();
  assert.deepStrictEqual(listened, ['measure_power', 'meter_power', 'meter_power.exported'], 'no phase listeners');
});

test('live values and kWh are pushed to the widget', async () => {
  const { app, devices, realtime } = await createApp({ devices: [gridMeter()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });

  devices.grid.report('measure_power', 2345);
  assert.deepStrictEqual(events(realtime, 'energy_update').at(-1),
    { deviceId: 'grid', capability: 'measure_power', value: 2345, ts: events(realtime, 'energy_update').at(-1).ts });

  devices.grid.report('meter_power', 1002.5);
  const today = events(realtime, 'energy_today').at(-1);
  assert.strictEqual(today.sourceId, 'grid');
  assert.ok(Math.abs(today.inKwh - 2.5) < 1e-9);
});

test('a hybrid sub-value is its own source with estimated kWh', async () => {
  const { app, devices, realtime } = await createApp({ devices: [hybrid()] });
  const { sources } = await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['hyb|measure_power.solar', 'hyb|measure_battery'] });
  assert.deepStrictEqual(sources.map((s) => [s.power && s.power.capability, s.soc && s.soc.capability]),
    [['measure_power.solar', null], [null, 'measure_battery']]);
  assert.strictEqual(sources[0].today.inSource, 'integrated');

  devices.hyb.report('measure_power.grid', -100); // not a selected source → not pushed
  assert.strictEqual(events(realtime, 'energy_update').length, 0);
  devices.hyb.report('measure_power.solar', 5000);
  assert.strictEqual(events(realtime, 'energy_update').at(-1).capability, 'measure_power.solar');
});

/* ---------------- Availability and deletion ---------------- */

test('offline and back online are pushed to the widget', async () => {
  const { app, devices, realtime } = await createApp({ devices: [gridMeter()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });

  devices.grid.setAvailable(false);
  assert.deepStrictEqual(events(realtime, 'energy_status').at(-1), { deviceId: 'grid', available: false, missing: false });
  devices.grid.report('measure_power', 10); // a new report means it is alive again
  assert.deepStrictEqual(events(realtime, 'energy_status').at(-1), { deviceId: 'grid', available: true, missing: false });
});

test('a deleted device is reported as missing and forgotten', async () => {
  const { app, devices, realtime } = await createApp({ devices: [gridMeter()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });

  devices.grid.remove();
  await flush();
  assert.deepStrictEqual(events(realtime, 'energy_status').at(-1), { deviceId: 'grid', available: false, missing: true });
  assert.ok(!('grid' in app.tracked));
  assert.strictEqual(app.ledger.get('grid'), null);
  assert.strictEqual(devices.grid.activeInstances().length, 0);
});

test('an unknown device gives a "missing" snapshot and is logged, without failing', async () => {
  const { app } = await createApp({ devices: [gridMeter()] });
  const { sources } = await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid', 'gone'] });
  assert.strictEqual(sources[1].missing, true);
  assert.strictEqual(sources[0].power.value, 1500);
  assert.ok(app.recentErrors.some((e) => e.message.includes('gone')));
});

/* ---------------- Releasing sources ---------------- */

test('a source removed from a widget is released right away, but today\'s kWh are kept', async () => {
  const { app, devices } = await createApp({ devices: [gridMeter(), car()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid', 'car'] });
  devices.grid.report('meter_power', 1003);

  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['car'] }); // user picked "None" for the grid
  assert.strictEqual(devices.grid.activeInstances().length, 0, 'listeners stopped');
  assert.ok(!('grid' in app.tracked));
  assert.ok(Math.abs(app.ledger.get('grid').inKwh - 3) < 1e-9, 'today kept');

  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['car', 'grid'] }); // added back the same day
  devices.grid.report('meter_power', 1004);
  assert.ok(Math.abs(app.ledger.get('grid').inKwh - 4) < 1e-9, 'continues where it was');
});

test('a source still shown by another widget is not released', async () => {
  const { app, devices } = await createApp({ devices: [gridMeter()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });
  await app.subscribeWidget({ instanceId: 'w2', sourceIds: ['grid'] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: [] });
  assert.ok(devices.grid.activeInstances().length > 0);
  assert.ok('grid' in app.tracked);
});

test('sources nobody asked for in 7 days are forgotten', async () => {
  const { app, devices } = await createApp({ devices: [gridMeter()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });
  app.tracked.grid = Date.now() - 8 * 24 * 60 * 60 * 1000;
  app.onTick();
  await flush();
  assert.ok(!('grid' in app.tracked));
  assert.strictEqual(devices.grid.activeInstances().length, 0);
});

/* ---------------- Restart ---------------- */

test('after a restart the app listens again and today\'s kWh continue', async () => {
  const store = {};
  const first = await createApp({ devices: [gridMeter()], store });
  await first.app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });
  first.devices.grid.report('meter_power', 1001);
  first.app.saveState();

  const device = gridMeter();
  device.capabilitiesObj.meter_power.value = 1001;
  const second = await createApp({ devices: [device], store });
  assert.ok(device.activeInstances('meter_power').length === 1, 'restored without any widget');
  device.report('meter_power', 1001.5);
  assert.ok(Math.abs(second.app.ledger.get('grid').inKwh - 1.5) < 1e-9);
});

/* ---------------- Input validation ---------------- */

test('subscribe rejects bad input and ignores "None" and extra sources', async () => {
  const { app } = await createApp({ devices: [gridMeter()] });
  await assert.rejects(app.subscribeWidget({ instanceId: '', sourceIds: [] }));
  await assert.rejects(app.subscribeWidget({ instanceId: 'w1', sourceIds: 'grid' }));

  const many = Array.from({ length: 20 }, (_, i) => `dev${i}`);
  const { sources } = await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['__none__', 'grid', ...many] });
  assert.strictEqual(sources[0].id, 'grid');
  assert.strictEqual(sources.length, 12);
});

/* ---------------- Suggestions and diagnostics ---------------- */

test('suggestions use Homey\'s energy metadata and live report', async () => {
  const circuit = new FakeDevice({
    id: 'clamp', name: 'Clamp', capabilities: { measure_power: 3000, meter_power: 1, 'meter_power.returned': 0 },
    energyObj: { cumulative: true, cumulativeImportedCapability: 'meter_power', cumulativeExportedCapability: 'meter_power.returned' },
  });
  const { app } = await createApp({ devices: [circuit, gridMeter(), car()], liveReport: { totalCumulative: { W: 1500 } } });
  const { roles } = await app.suggestSources();
  assert.deepStrictEqual(roles.grid.map((r) => r.id), ['grid']);
  assert.deepStrictEqual(roles.car.map((r) => r.id), ['car']);
});

test('diagnostics: names hidden when anonymized, drivers and errors included', async () => {
  const { app } = await createApp({ devices: [gridMeter(), car()], zones: { z1: { name: 'Secret garage' } } });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid', 'missing-device'] });

  const anonymous = JSON.stringify(await app.buildDiagnostics({ anonymize: true }));
  assert.ok(!anonymous.includes('Main meter') && !anonymous.includes('My EV') && !anonymous.includes('Secret garage'));
  assert.ok(anonymous.includes('Device 1') && anonymous.includes('homey:app:com.example:driver'));

  const report = await app.buildDiagnostics({ anonymize: false });
  assert.ok(report.devices.some((d) => d.name === 'Main meter' && d.energy.includes('cumulative')));
  assert.deepStrictEqual(report.devices.find((d) => d.name === 'Main meter').kwhMeters,
    { in: 'meter_power', out: 'meter_power.exported' });
  assert.ok(report.recentErrors.some((e) => e.message.includes('missing-device')));
});

/* ---------------- Optimisations ---------------- */

test('live values are sent at most once per second; the latest value always arrives', async () => {
  const { app, devices, realtime, runTimeouts } = await createApp({ devices: [gridMeter()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });
  const sent = () => events(realtime, 'energy_update').map((e) => e.value);

  devices.grid.report('measure_power', 100); // sent right away
  devices.grid.report('measure_power', 200); // coalesced
  devices.grid.report('measure_power', 300); // coalesced, replaces 200
  assert.deepStrictEqual(sent(), [100]);

  runTimeouts(); // the second has passed
  assert.deepStrictEqual(sent(), [100, 300], 'latest value, not the one in between');
  assert.strictEqual(runTimeouts(), 0, 'nothing left pending');
});

test('throttling never delays the kWh count: every report reaches the ledger', async () => {
  const { app, devices } = await createApp({ devices: [gridMeter()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });
  devices.grid.report('meter_power', 1000.1);
  devices.grid.report('meter_power', 1000.2);
  devices.grid.report('meter_power', 1000.35);
  assert.ok(Math.abs(app.ledger.get('grid').inKwh - 0.35) < 1e-9);
});

test('a pending throttled value is dropped when the device is released', async () => {
  const { app, devices, realtime, runTimeouts } = await createApp({ devices: [gridMeter()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });
  devices.grid.report('measure_power', 100);
  devices.grid.report('measure_power', 200); // pending
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: [] });
  runTimeouts();
  assert.deepStrictEqual(events(realtime, 'energy_update').map((e) => e.value), [100]);
});

test('"charged from solar" is counted for the widget\'s roles and pushed', async () => {
  const sun = new FakeDevice({ id: 'sun', name: 'Inverter', cls: 'solarpanel', capabilities: { measure_power: 5000 } });
  const ev = new FakeDevice({ id: 'ev', name: 'Charger', cls: 'evcharger', capabilities: { measure_power: 0 } });
  const { app, devices, realtime } = await createApp({ devices: [gridMeter(), sun, ev] });
  const result = await app.subscribeWidget({
    instanceId: 'w1',
    sourceIds: ['grid', 'sun', 'ev'],
    split: {
      grid: ['grid'], solar: ['sun', 'not-shown'], ev: ['ev'], battery: [], invert: { grid: false },
    },
  });
  assert.ok(result.split && result.split.key, 'the widget gets its key');
  assert.strictEqual(result.split.evKwh, 0);
  assert.ok(!result.split.key.includes('not-shown'), 'only sources the widget shows');

  devices.grid.report('measure_power', -1000);
  devices.sun.report('measure_power', 5000);
  devices.ev.report('measure_power', 3000);
  const later = Date.now() + 10 * 60 * 1000;
  app.updateSplit(later);
  app.emitSplits(later);
  const pushed = events(realtime, 'energy_split').at(-1);
  assert.strictEqual(pushed.key, result.split.key);
  assert.ok(Math.abs(pushed.evKwh - 0.5) < 0.01, pushed.evKwh);
  assert.ok(Math.abs(pushed.evSolarKwh - pushed.evKwh) < 1e-9, 'exporting: all solar');

  const again = await app.subscribeWidget({ instanceId: 'w2', sourceIds: ['grid', 'sun'], split: { grid: ['grid'], solar: ['sun'] } });
  assert.strictEqual(again.split, null, 'nothing to split without an EV or battery');
});

test('state is only written to storage when it changed', async () => {
  const { app, devices, settingsWrites } = await createApp({ devices: [gridMeter()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });

  app.saveState();
  const afterFirst = settingsWrites.length;
  assert.ok(afterFirst >= 1);
  app.saveState();
  app.saveState();
  assert.strictEqual(settingsWrites.length, afterFirst, 'nothing changed → no writes');

  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] }); // the widget's minute refresh
  app.saveState();
  assert.strictEqual(settingsWrites.length, afterFirst, 'refresh within the same hour → no write');

  devices.grid.report('meter_power', 1001);
  app.saveState();
  assert.deepStrictEqual(settingsWrites.slice(afterFirst), ['ledger'], 'only the part that changed');
});

test('the device list is cached for the pickers and suggestions', async () => {
  const { app, autocomplete, apiCalls } = await createApp({ devices: [gridMeter(), car()] });
  await autocomplete.grid_device('');
  await autocomplete.grid_device('ma');
  await autocomplete.car_device('');
  await app.suggestSources();
  assert.strictEqual(apiCalls.getDevices, 1);

  app.deviceCache.at -= 31 * 1000; // cache expired
  await autocomplete.grid_device('');
  assert.strictEqual(apiCalls.getDevices, 2);
});

test('diagnostics include memory use and uptime', async () => {
  const { app } = await createApp({ devices: [gridMeter()] });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });
  const { runtime } = await app.buildDiagnostics({ anonymize: true });
  assert.ok(runtime.memoryMB.rss > 0 && runtime.memoryMB.heapUsed > 0);
  assert.strictEqual(runtime.watchedDevices, 1);
  assert.strictEqual(runtime.sources, 1);
});

test('memory stats still work in Homey\'s sandbox, where process.memoryUsage() throws', async () => {
  const { app } = await createApp({ devices: [gridMeter()] });
  const original = process.memoryUsage;
  process.memoryUsage = () => {
    throw new Error('ENOENT: no such file or directory, uv_resident_set_memory');
  };
  try {
    const { runtime } = await app.buildDiagnostics({ anonymize: true });
    assert.strictEqual(runtime.memoryMB.rss, null);
    assert.ok(runtime.memoryMB.heapUsed > 0, 'falls back to V8 heap statistics');
    assert.doesNotThrow(() => app.runtimeStats());
  } finally {
    process.memoryUsage = original;
  }
});

test('extra node picker: heating devices first, any device with power listed', async () => {
  const heatPump = new FakeDevice({ id: 'hp', name: 'Heat pump', cls: 'heatpump', capabilities: { measure_power: 1800 } });
  const plug = new FakeDevice({ id: 'plug', name: 'A plug', cls: 'socket', capabilities: { measure_power: 40 } });
  const { app, autocomplete, devices } = await createApp({ devices: [plug, heatPump] });
  assert.deepStrictEqual((await autocomplete.extra_device('')).map((r) => r.id), ['__none__', 'hp', 'plug']);

  const { sources } = await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['hp'] });
  assert.strictEqual(sources[0].power.value, 1800);
  assert.strictEqual(sources[0].today.inSource, 'integrated', 'no kWh meter → calculated');
  assert.ok(devices.hp.activeInstances('measure_power').length === 1);
});

/* ---------------- Waiting for other apps at startup ---------------- */

test('startup waits in the background for the chosen apps, then listens', async () => {
  const apps = { 'com.solar': { id: 'com.solar', name: 'Solar', state: 'starting', enabled: true } };
  const store = { waitForApps: ['com.solar'], trackedDevices: { grid: Date.now() } };
  // createApp awaits onInit(): it returns although the app is still waiting (no boot timeout)
  const { app, devices, runTimeouts } = await createApp({ devices: [gridMeter()], store, apps });

  assert.strictEqual(app.startup.state, 'waiting');
  assert.strictEqual(devices.grid.activeInstances().length, 0, 'no listeners while waiting');
  const waiting = await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });
  assert.strictEqual(waiting.starting, true);
  assert.deepStrictEqual(waiting.waitingFor, ['Solar']);
  assert.deepStrictEqual(waiting.sources, []);

  runTimeouts(); // next poll: still starting
  await flush();
  assert.strictEqual(app.startup.state, 'waiting');

  apps['com.solar'].state = 'running';
  runTimeouts();
  await flush();
  assert.strictEqual(app.startup.state, 'ready');
  assert.strictEqual(app.startup.timedOut, false);
  assert.deepStrictEqual(app.startup.waitedFor, ['com.solar']);
  assert.ok(devices.grid.activeInstances().length > 0, 'listening after the apps run');
  const ready = await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });
  assert.strictEqual(ready.starting, undefined);
  assert.strictEqual(ready.sources[0].power.value, 1500);
});

test('startup: apps that are not installed or disabled are not waited for', async () => {
  const apps = { 'com.off': { id: 'com.off', name: 'Off', state: 'stopped', enabled: false } };
  const { app } = await createApp({ store: { waitForApps: ['com.off', 'com.gone'] }, apps });
  assert.strictEqual(app.startup.state, 'ready');
});

test('startup: an unreadable app list is retried instead of failing', async () => {
  const apps = { failNext: true, 'com.solar': { id: 'com.solar', name: 'Solar', state: 'running', enabled: true } };
  const { app, runTimeouts } = await createApp({ store: { waitForApps: ['com.solar'] }, apps });
  assert.strictEqual(app.startup.state, 'waiting');
  runTimeouts();
  await flush();
  assert.strictEqual(app.startup.state, 'ready');
});

test('settings: lists other apps, the ones with widget devices first, and saves the choice', async () => {
  const solarDevice = gridMeter({ driverId: 'homey:app:com.solar:meter' });
  const plug = new FakeDevice({ id: 'plug', name: 'Plug', capabilities: { measure_power: 5 }, driverId: 'homey:app:com.plug:socket' });
  const siren = new FakeDevice({ id: 'siren', name: 'Siren', capabilities: { onoff: false }, driverId: 'homey:app:com.alarm:siren' });
  const apps = {
    'com.housepulse.energy': { id: 'com.housepulse.energy', name: 'HousePulse', state: 'running' },
    'com.alarm': { id: 'com.alarm', name: 'Alarm', state: 'running', enabled: true },
    'com.solar': { id: 'com.solar', name: 'Solar', state: 'running', enabled: true },
    'com.old': { id: 'com.old', name: 'Old', state: 'stopped', enabled: false },
    'com.plug': { id: 'com.plug', name: 'Plug', state: 'running', enabled: true },
  };
  const { app, store } = await createApp({ devices: [solarDevice, plug, siren], apps });
  await app.subscribeWidget({ instanceId: 'w1', sourceIds: ['grid'] });

  const overview = await app.getAppsOverview();
  assert.deepStrictEqual(overview.apps.map((a) => [a.id, a.usedByWidget, a.hasEnergyDevices, a.enabled]), [
    ['com.solar', true, true, true],
    ['com.alarm', false, false, true], // only a siren: no energy devices
    ['com.old', false, false, false],
    ['com.plug', false, true, true], // a socket that reports power
  ]);
  assert.deepStrictEqual(overview.waitFor, []);
  assert.strictEqual(overview.startup.state, 'ready');

  assert.deepStrictEqual(app.setWaitForApps(['com.solar', 'com.solar', 'com.housepulse.energy', 7]), ['com.solar']);
  assert.deepStrictEqual(store.waitForApps, ['com.solar']);
  assert.deepStrictEqual((await app.getAppsOverview()).waitFor, ['com.solar']);
});

test('the app API validates the wait-for-apps body', async () => {
  const api = require('../api');
  const { app, homey } = await createApp();
  await assert.rejects(api.setWaitForApps({ homey, body: { ids: 'x' } }));
  assert.deepStrictEqual(await api.setWaitForApps({ homey, body: { ids: ['com.a'] } }), { waitFor: ['com.a'] });
  assert.strictEqual(app.getWaitForApps()[0], 'com.a');
});
