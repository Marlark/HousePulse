'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'widgets', 'energy_flow_dash', 'public');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});

// Close every widget after each test (also when it failed), so no timers keep the process alive.
const openWidgets = [];
afterEach(() => { for (const w of openWidgets.splice(0)) w.close(); });

/**
 * Load the real widget (index.html + flow-logic.js) in jsdom with a fake Homey.
 * Timeouts are shortened in this test copy only, so tests run in milliseconds.
 */
function loadWidget({ settings = {}, api, language = 'en' } = {}) {
  let html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const logic = fs.readFileSync(path.join(PUBLIC, 'js', 'flow-logic.js'), 'utf8');
  const shorten = [
    ['<script src="js/flow-logic.js"></script>', `<script>${logic}</script>`],
    ['const API_TIMEOUT_MS = 10 * 1000;', 'const API_TIMEOUT_MS = 60;'],
    ['const SUGGEST_RETRY_MS = 15 * 1000;', 'const SUGGEST_RETRY_MS = 60;'],
    ['const STARTING_RETRY_MS = 5 * 1000;', 'const STARTING_RETRY_MS = 40;'],
    ['const SIGN_HINT_AFTER_MS = 3 * 60 * 1000;', 'const SIGN_HINT_AFTER_MS = 0;'],
  ];
  for (const [from, to] of shorten) {
    assert.ok(html.includes(from), `widget changed, update the test: ${from}`);
    html = html.replace(from, () => to);
  }
  html = html.replace(/<link rel="stylesheet"[^>]*>/, '');

  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://homey.local/widget/' });
  const handlers = {};
  const homey = {
    calls: [],
    readyAt: null,
    readyCalls: 0,
    getSettings: () => settings,
    on: (event, fn) => { handlers[event] = fn; },
    ready() { this.readyCalls++; this.readyAt = Date.now(); },
    setHeight() {},
    getWidgetInstanceId: () => 'test-widget',
    i18n: { getLanguage: () => language },
    api(method, apiPath, body) {
      this.calls.push({ method, path: apiPath, body });
      return api(apiPath, body);
    },
  };
  const startedAt = Date.now();
  dom.window.console.error = () => {}; // expected errors (timeouts) are part of the tests
  dom.window.onHomeyReady(homey);

  const doc = dom.window.document;
  openWidgets.push({ close: () => dom.window.close() });
  const node = (role) => doc.querySelector(`[data-node="${role}"]`);
  return {
    dom,
    homey,
    startedAt,
    emit: (event, data) => handlers[event](data),
    text: (selector) => (doc.querySelector(selector) || {}).textContent,
    value: (role) => node(role).querySelector('[data-value]').textContent,
    status: (role) => node(role).querySelector('[data-status]').textContent,
    hasClass: (role, cls) => node(role).classList.contains(cls),
    isHidden: (id) => doc.getElementById(id).hidden,
    subscribes: () => homey.calls.filter((c) => c.path === '/subscribe'),
    close: () => dom.window.close(),
  };
}

/* ---------------- Fixtures ---------------- */

const now = () => Date.now();
const snap = (id, { power = null, soc = null, today = null, available = true, missing = false } = {}) => ({
  id, deviceId: id.split('|')[0], name: id, available, missing,
  power: power === null ? null : { capability: 'measure_power', value: power, ts: now() },
  soc: soc === null ? null : { capability: 'measure_battery', value: soc, ts: now() },
  today,
});
const DEVICES = {
  grid: snap('grid', { power: 800, today: { inKwh: 5.2, outKwh: 3.1, inSource: 'meter', outSource: 'meter' } }),
  solar: snap('solar', { power: 4100 }),
  zappi: snap('zappi', { power: 2300 }),
  bat: snap('bat', { power: 900, soc: 62 }),
  car: snap('car', { soc: 41 }),
};
const SUGGESTION = {
  roles: {
    grid: [{ id: 'grid', name: 'Meter' }], solar: [{ id: 'solar', name: 'Inverter' }], ev: [{ id: 'zappi', name: 'Charger' }],
    battery: [{ id: 'bat', name: 'Battery' }], car: [{ id: 'car', name: 'Car' }], home: [],
  },
};
const subscribeWith = (devices = DEVICES, extra = {}) => (body) => ({
  sources: body.sourceIds.map((id) => devices[id] || snap(id, { missing: true })), debug: false, serverTime: now(), ...extra,
});
function api({ suggest = async () => SUGGESTION, subscribe = subscribeWith() } = {}) {
  return (apiPath, body) => (apiPath === '/suggest' ? suggest() : Promise.resolve(subscribe(body)));
}

/* ---------------- Startup ---------------- */

test('tells Homey it is ready immediately, even when the app never answers', async () => {
  const w = loadWidget({ api: () => never() });
  await wait(5);
  assert.strictEqual(w.homey.readyCalls, 1, 'ready() although no API call has answered');
  assert.ok(w.homey.readyAt - w.startedAt < 50);
  await wait(20);
  assert.strictEqual(w.isHidden('message'), false);
  assert.strictEqual(w.text('#message-title'), 'Looking for energy devices…');
});

test('suggestions: one subscribe with the full set, and the "picked automatically" note', async () => {
  const w = loadWidget({ settings: { ev_device: { id: 'zappi', name: 'Zappi' } }, api: api() });
  await wait(50);
  assert.strictEqual(w.subscribes().length, 1, 'no subscribe with a partial set first');
  assert.deepStrictEqual([...w.subscribes()[0].body.sourceIds].sort(), ['bat', 'car', 'grid', 'solar', 'zappi']);
  assert.strictEqual(w.isHidden('auto-note'), false);
  assert.strictEqual(w.value('grid'), '800 W');
  assert.strictEqual(w.status('grid'), 'Import');
});

test('suggestions time out: the chosen devices still show, other roles wait with "…"', async () => {
  const w = loadWidget({ settings: { ev_device: { id: 'zappi', name: 'Zappi' } }, api: api({ suggest: never }) });
  await wait(20);
  assert.strictEqual(w.status('ev'), '…');
  await wait(150); // past the (shortened) timeout
  assert.deepStrictEqual([...w.subscribes()[0].body.sourceIds], ['zappi']);
  assert.strictEqual(w.status('ev'), 'Charging');
  assert.strictEqual(w.status('grid'), '…', 'still waiting for a suggestion, not "Not set"');
});

test('suggestions arrive after a failed attempt: the widget fills in', async () => {
  let attempts = 0;
  const suggest = async () => {
    attempts++;
    if (attempts === 1) throw new Error('app starting');
    return SUGGESTION;
  };
  const w = loadWidget({ api: api({ suggest }) });
  await wait(250);
  assert.ok(attempts >= 2);
  assert.strictEqual(w.isHidden('flow'), false);
  assert.strictEqual(w.value('solar'), '4.10 kW');
});

test('"None" everywhere and nothing suggested: asks to configure', async () => {
  const settings = { grid_device: { id: '__none__', name: 'None' } };
  const w = loadWidget({ settings, api: api({ suggest: async () => ({ roles: {} }) }) });
  await wait(50);
  assert.strictEqual(w.text('#message-title'), 'No devices selected');
});

test('a failing first subscribe shows an error instead of an empty widget', async () => {
  const settings = { grid_device: { id: 'grid', name: 'Meter' }, ev_device: { id: '__none__' }, solar_device: { id: '__none__' },
    battery_device: { id: '__none__' }, car_device: { id: '__none__' }, home_device: { id: '__none__' } };
  const w = loadWidget({ settings, api: () => Promise.reject(new Error('boom')) });
  await wait(30);
  assert.strictEqual(w.text('#message-title'), 'Could not load devices');
});

/* ---------------- Live updates ---------------- */

test('live values, status changes and today\'s totals update the view', async () => {
  const w = loadWidget({ api: api(), language: 'sv' });
  await wait(50);

  w.emit('energy_update', { deviceId: 'grid', capability: 'measure_power', value: -2350, ts: now() });
  await wait(40);
  assert.strictEqual(w.value('grid'), '2,35 kW', 'Swedish number format');
  assert.strictEqual(w.status('grid'), 'Säljer');

  w.emit('energy_update', { deviceId: 'bat', capability: 'measure_battery', value: 15, ts: now() });
  await wait(40);
  assert.strictEqual(w.text('[data-node="battery"] [data-badge]'), '15 %');
  assert.ok(w.hasClass('battery', 'is-low'));

  w.emit('energy_status', { deviceId: 'solar', available: false, missing: false });
  await wait(40);
  assert.ok(w.hasClass('solar', 'is-offline'));
  assert.strictEqual(w.status('solar'), 'Offline');

  w.emit('energy_today', { sourceId: 'grid', inKwh: 7.25, outKwh: 3.1, inSource: 'meter', outSource: 'meter' });
  await wait(40);
  assert.strictEqual(w.text('[data-today="import"] [data-value]'), '7,3 kWh');
});

test('"charged from solar" is shown on the EV item and updated live', async () => {
  const calls = [];
  const base = api();
  const w = loadWidget({
    language: 'sv',
    api: async (apiPath, body) => {
      calls.push({ path: apiPath, body });
      const result = await base(apiPath, body);
      if (apiPath === '/subscribe') {
        return {
          ...result,
          split: {
            key: 'k1', evKwh: 10, evSolarKwh: 6.8, batteryKwh: 0, batterySolarKwh: 0,
          },
        };
      }
      return result;
    },
  });
  await wait(50);
  const sent = calls.find((c) => c.path === '/subscribe').body.split;
  assert.ok(Array.isArray(sent.grid) && Array.isArray(sent.ev) && sent.invert, 'the widget sends its roles');

  w.emit('energy_today', { sourceId: 'zappi', inKwh: 10, outKwh: 0, inSource: 'meter', outSource: 'meter' });
  await wait(40);
  assert.strictEqual(w.text('[data-today="ev"] [data-value]'), '10,0 kWh · 68 % sol');

  w.emit('energy_split', {
    key: 'other', evKwh: 10, evSolarKwh: 1, batteryKwh: 0, batterySolarKwh: 0,
  });
  w.emit('energy_split', {
    key: 'k1', evKwh: 12, evSolarKwh: 9, batteryKwh: 0, batterySolarKwh: 0,
  });
  await wait(40);
  assert.strictEqual(w.text('[data-today="ev"] [data-value]'), '10,0 kWh · 75 % sol', 'other widgets\' keys are ignored');
});

test('solar self-consumption today is shown next to self-sufficiency', async () => {
  const w = loadWidget({ api: api(), language: 'sv' });
  await wait(50);
  w.emit('energy_today', { sourceId: 'grid', inKwh: 2, outKwh: 3, inSource: 'meter', outSource: 'meter' });
  w.emit('energy_today', { sourceId: 'solar', inKwh: 10, outKwh: 0, inSource: 'meter', outSource: 'meter' });
  await wait(40);
  assert.strictEqual(w.text('[data-today="selfUse"] [data-label]'), 'Egenanvändning sol');
  const value = w.text('[data-today="selfUse"] [data-value]');
  assert.ok(value.includes('70 % idag'), value);
});

test('the car\'s state of charge is shown on the EV charger', async () => {
  const w = loadWidget({ api: api() });
  await wait(50);
  assert.strictEqual(w.text('[data-node="ev"] [data-badge]'), '41 %');
  assert.ok(w.hasClass('ev', 'has-soc'));
});

test('home consumption is calculated, and a wrong grid sign triggers the hint', async () => {
  const w = loadWidget({ api: api() });
  await wait(50);
  // 800 + 4100 - 900 - 2300
  assert.strictEqual(w.value('home'), '1.70 kW');
  assert.strictEqual(w.isHidden('sign-hint'), true);

  // Grid meter with the wrong sign: really importing, reported as a big export
  w.emit('energy_update', { deviceId: 'grid', capability: 'measure_power', value: -6000, ts: now() });
  await wait(40);
  assert.strictEqual(w.value('home'), '0 W');
  assert.strictEqual(w.isHidden('sign-hint'), false);
  assert.match(w.text('#sign-hint'), /Invert grid sign/);
});

test('debug footer only when the app runs in debug mode', async () => {
  const normal = loadWidget({ api: api() });
  await wait(50);
  assert.strictEqual(normal.isHidden('debug'), true);

  const debug = loadWidget({ api: api({ subscribe: subscribeWith(DEVICES, { debug: true }) }) });
  await wait(50);
  assert.strictEqual(debug.isHidden('debug'), false);
  assert.match(debug.text('#debug'), /DEBUG · test-widget · AUTO/);
});

/* ---------------- Performance ---------------- */

test('an update that changes nothing visible does not touch the page', async () => {
  const w = loadWidget({ api: api() });
  await wait(60);
  const { window } = w.dom;
  let mutations = 0;
  const observer = new window.MutationObserver((list) => { mutations += list.length; });
  observer.observe(window.document.body, { subtree: true, childList: true, attributes: true, characterData: true });

  // Same value again (meters often repeat themselves): re-render, but nothing to change
  w.emit('energy_update', { deviceId: 'grid', capability: 'measure_power', value: 800, ts: now() });
  await wait(40);
  assert.strictEqual(mutations, 0, `${mutations} DOM mutation(s) for an unchanged value`);

  // A real change touches the page
  w.emit('energy_update', { deviceId: 'grid', capability: 'measure_power', value: 900, ts: now() });
  await wait(40);
  assert.ok(mutations > 0);
  assert.strictEqual(w.value('grid'), '900 W');
  observer.disconnect();
});

test('flow animations only animate transform and opacity (no layout work per frame)', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'css', 'style.css'), 'utf8');
  const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)];
  assert.ok(keyframes.length >= 2, 'keyframes found');
  for (const [, name, body] of keyframes) {
    const properties = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    for (const property of properties) {
      assert.ok(['transform', 'opacity'].includes(property), `@keyframes ${name} animates "${property}"`);
    }
  }
});

/* ---------------- Extra consumer node ---------------- */

const withHeatPump = { ...DEVICES, hp: snap('hp', { power: 1200, today: { inKwh: 6.5, outKwh: 0, inSource: 'meter', outSource: 'integrated' } }) };

test('the extra node is hidden until a device is chosen', async () => {
  const w = loadWidget({ api: api() });
  await wait(50);
  assert.strictEqual(w.dom.window.document.querySelector('[data-node="extra"]').hidden, true);
  assert.ok(w.dom.window.document.querySelector('[data-conn="extra"]').classList.contains('is-hidden'));
});

test('extra node: shown with its type name, and Home shows the rest of the house', async () => {
  const settings = { extra_device: { id: 'hp', name: 'Heat pump device' } };
  const w = loadWidget({ settings, api: api({ subscribe: subscribeWith(withHeatPump) }) });
  await wait(60);
  const doc = w.dom.window.document;
  assert.strictEqual(doc.querySelector('[data-node="extra"]').hidden, false);
  assert.strictEqual(w.text('[data-node="extra"] [data-label]'), 'Heat pump', 'default name from the type');
  assert.strictEqual(w.value('extra'), '1.20 kW');
  assert.strictEqual(w.status('extra'), 'Consuming');
  // whole home 800 + 4100 - 900 - 2300 = 1700 W, of which 1200 W is the heat pump
  assert.strictEqual(w.value('home'), '500 W');
  assert.strictEqual(w.text('[data-today="extra"] [data-label]'), 'Heat pump');
  assert.strictEqual(w.text('[data-today="extra"] [data-value]'), '6.5 kWh');
  assert.ok(doc.querySelector('[data-conn="extra"]').classList.contains('is-active'));
});

test('extra node: own name and icon from the settings', async () => {
  const settings = { extra_device: { id: 'hp', name: 'x' }, extra_type: 'sauna', extra_name: '  Bastun  ' };
  const w = loadWidget({ settings, api: api({ subscribe: subscribeWith(withHeatPump) }), language: 'sv' });
  await wait(60);
  // The hidden *attribute* is what hides an <svg> (it has no .hidden property in browsers)
  const icons = [...w.dom.window.document.querySelectorAll('[data-extra-icon]')].filter((i) => !i.hasAttribute('hidden'));
  assert.deepStrictEqual(icons.map((i) => i.dataset.extraIcon), ['sauna']);
  assert.strictEqual(w.text('[data-node="extra"] [data-label]'), 'Bastun', 'trimmed custom name');
  assert.strictEqual(w.status('extra'), 'Förbrukar');
});

test('while the app waits for other apps at startup, the widget says so and asks again', async () => {
  let starting = true;
  const subscribe = (body) => (starting
    ? { starting: true, waitingFor: ['Huawei Solar', 'myenergi'], sources: [], debug: false, serverTime: now() }
    : subscribeWith()(body));
  const w = loadWidget({ language: 'sv', api: api({ subscribe }) });
  await wait(30);
  assert.strictEqual(w.isHidden('message'), false);
  assert.strictEqual(w.text('#message-title'), 'Väntar på appar…');
  assert.strictEqual(w.text('#message-text'), 'HousePulse startar när de här apparna körs: Huawei Solar, myenergi.');

  starting = false;
  await wait(250); // past the (shortened) retry, with room for a slow test machine
  assert.ok(w.subscribes().length >= 2, 'asked again');
  assert.strictEqual(w.isHidden('message'), true);
  assert.strictEqual(w.value('grid'), '800 W');
});
