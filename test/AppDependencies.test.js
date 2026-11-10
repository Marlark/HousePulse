'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const D = require('../lib/AppDependencies');

const apps = (states) => Object.fromEntries(Object.entries(states).map(([id, state]) => [id, {
  id, name: id.toUpperCase(), state, enabled: state !== 'disabled',
}]));

test('appIdFromDriver: app id from a driver id', () => {
  assert.strictEqual(D.appIdFromDriver('homey:app:com.huawei.solar:inverter'), 'com.huawei.solar');
  assert.strictEqual(D.appIdFromDriver('homey:manager:vdevice:virtual'), null);
  assert.strictEqual(D.appIdFromDriver(undefined), null);
});

test('normaliseIds: strings only, no duplicates, never our own app', () => {
  assert.deepStrictEqual(D.normaliseIds(['a', 'a', '', 5, 'own', 'b'], 'own'), ['a', 'b']);
  assert.deepStrictEqual(D.normaliseIds('a', 'own'), []);
  assert.deepStrictEqual(D.normaliseIds(null, 'own'), []);
});

test('pendingApps: waits for starting/stopped/crashed apps, skips missing and disabled ones', () => {
  const list = apps({
    run: 'running', start: 'starting', stop: 'stopped', crash: 'crashed', off: 'disabled',
  });
  const pending = D.pendingApps(list, ['run', 'start', 'stop', 'crash', 'off', 'not-installed']);
  assert.deepStrictEqual(pending.map((p) => [p.id, p.state]), [['start', 'starting'], ['stop', 'stopped'], ['crash', 'crashed']]);
  // An array (instead of an object keyed by id) works too
  assert.strictEqual(D.pendingApps(Object.values(list), ['start']).length, 1);
});

/** Fake clock: sleep() advances time instantly. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('waitForApps: polls until every app runs', async () => {
  const c = clock();
  const states = { a: 'starting', b: 'running' };
  let polls = 0;
  const seen = [];
  const result = await D.waitForApps({
    ids: ['a', 'b'],
    getApps: async () => {
      polls++;
      if (polls === 3) states.a = 'running';
      return apps(states);
    },
    ...c,
    intervalMs: 5000,
    maxWaitMs: 600000,
    onPending: (pending) => seen.push(pending.map((p) => p.id).join()),
  });
  assert.deepStrictEqual(result, { waitedMs: 10000, timedOut: false, pending: [] });
  assert.deepStrictEqual(seen, ['a', 'a']);
});

test('waitForApps: nothing to wait for returns at once, without asking Homey', async () => {
  const result = await D.waitForApps({
    ids: [], getApps: async () => { throw new Error('must not be called'); }, ...clock(), intervalMs: 1, maxWaitMs: 1,
  });
  assert.deepStrictEqual(result, { waitedMs: 0, timedOut: false, pending: [] });
});

test('waitForApps: starts anyway after the time limit and says which apps did not run', async () => {
  const result = await D.waitForApps({
    ids: ['a'], getApps: async () => apps({ a: 'crashed' }), ...clock(), intervalMs: 5000, maxWaitMs: 60000,
  });
  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.waitedMs, 60000);
  assert.deepStrictEqual(result.pending.map((p) => p.id), ['a']);
});

test('waitForApps: an unreadable app list (early in the boot) is retried', async () => {
  let calls = 0;
  const errors = [];
  const result = await D.waitForApps({
    ids: ['a'],
    getApps: async () => {
      calls++;
      if (calls < 3) throw new Error('API not ready');
      return apps({ a: 'running' });
    },
    ...clock(),
    intervalMs: 5000,
    maxWaitMs: 600000,
    onError: (err) => errors.push(err.message),
  });
  assert.strictEqual(result.timedOut, false);
  assert.deepStrictEqual(errors, ['API not ready', 'API not ready']);
});
