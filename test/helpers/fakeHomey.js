'use strict';

/**
 * Test doubles for the Homey runtime: the `homey` module (Homey.App), the `homey-api` module
 * (HomeyAPI.createAppAPI) and devices that behave like homey-api devices. app.js is loaded
 * unchanged; only these two modules are swapped out.
 */

const Module = require('node:module');
const { EventEmitter } = require('node:events');

let currentApi = null;

class FakeApp {
  log() {}

  error(...args) {
    this.loggedErrors = this.loggedErrors || [];
    this.loggedErrors.push(args.join(' '));
  }
}

const fakeHomeyModule = { App: FakeApp };
const fakeHomeyApiModule = { HomeyAPI: { createAppAPI: async () => currentApi } };

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'homey') return fakeHomeyModule;
  if (request === 'homey-api') return fakeHomeyApiModule;
  return originalLoad.call(this, request, parent, isMain);
};

/** A device like the ones homey-api returns: capability values, events, capability instances. */
class FakeDevice extends EventEmitter {
  constructor({
    id, name, cls = 'sensor', virtualClass = null, zone = 'z1', capabilities = {}, energyObj = {},
    available = true, driverId = 'homey:app:com.example:driver',
  }) {
    super();
    Object.assign(this, { id, name, class: cls, virtualClass, zone, energyObj, available, driverId });
    this.capabilities = Object.keys(capabilities);
    this.capabilitiesObj = {};
    for (const [cap, value] of Object.entries(capabilities)) {
      // Last measured an hour ago: realistic, and leaves room for the test reports that follow.
      this.capabilitiesObj[cap] = { value, lastUpdated: new Date(Date.now() - 3600e3), title: cap };
    }
    this.instances = []; // capability instances handed out (and whether they were destroyed)
    this.connected = false;
  }

  async connect() { this.connected = true; }

  async disconnect() { this.connected = false; }

  makeCapabilityInstance(capabilityId, listener) {
    const instance = {
      capabilityId, listener, destroyed: false, lastChanged: null,
      destroy() { this.destroyed = true; },
    };
    this.instances.push(instance);
    return instance;
  }

  activeInstances(capabilityId) {
    return this.instances.filter((i) => !i.destroyed && (!capabilityId || i.capabilityId === capabilityId));
  }

  /** The device reports a new value, like a real driver calling setCapabilityValue. */
  report(capabilityId, value, at = new Date()) {
    this.capabilitiesObj[capabilityId] = { ...this.capabilitiesObj[capabilityId], value, lastUpdated: at };
    for (const instance of this.activeInstances(capabilityId)) {
      instance.lastChanged = at;
      instance.listener(value, instance);
    }
  }

  setAvailable(available) {
    this.available = available;
    this.emit('update', { available });
  }

  remove() {
    this.emit('delete');
  }
}

/**
 * Create the app with fake devices.
 * @returns {Promise<{ app, homey, devices, realtime, autocomplete, store }>}
 */
async function createApp({
  devices = [], zones = { z1: { name: 'Garage' } }, liveReport = null, store = {}, language = 'en',
  apps = {}, // id -> { id, name, state, enabled }; tests may change states later
} = {}) {
  const byId = Object.fromEntries(devices.map((d) => [d.id, d]));
  const apiCalls = { getDevices: 0 };
  currentApi = {
    devices: {
      getDevices: async () => {
        apiCalls.getDevices++;
        return byId;
      },
      getDevice: async ({ id }) => {
        if (!byId[id]) throw new Error(`Device not found: ${id}`);
        return byId[id];
      },
    },
    zones: { getZones: async () => zones },
    energy: { getLiveReport: async () => liveReport },
    apps: {
      getApps: async () => {
        if (apps.failNext) {
          apps.failNext = false;
          throw new Error('Not ready');
        }
        return Object.fromEntries(Object.entries(apps).filter(([, app]) => app && typeof app === 'object'));
      },
    },
  };

  const realtime = [];
  const autocomplete = {};
  const settingsWrites = [];
  const timeouts = new Map(); // id -> fn; run with runTimeouts()
  let nextTimeout = 1;
  const homey = {
    manifest: { id: 'io.github.marlark.housepulse', version: '1.0.0' },
    version: '12.2.0',
    platform: 'local',
    platformVersion: 2,
    settings: {
      get: (key) => (key in store ? JSON.parse(JSON.stringify(store[key])) : null),
      set: (key, value) => {
        settingsWrites.push(key);
        store[key] = JSON.parse(JSON.stringify(value));
      },
    },
    clock: { getTimezone: () => 'Europe/Stockholm' },
    i18n: { getLanguage: () => language },
    api: { realtime: (event, data) => realtime.push({ event, data }) },
    dashboards: {
      getWidget: () => ({ registerSettingAutocompleteListener: (id, fn) => { autocomplete[id] = fn; } }),
    },
    // Timers never fire on their own: tests call app.onTick() / app.saveState() directly, and
    // runTimeouts() runs pending timeouts (regardless of their delay).
    setInterval: () => ({}),
    clearInterval: () => {},
    setTimeout: (fn) => {
      const id = nextTimeout++;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout: (id) => { timeouts.delete(id); },
  };
  const runTimeouts = () => {
    const pending = [...timeouts.entries()];
    timeouts.clear();
    for (const [, fn] of pending) fn();
    return pending.length;
  };

  delete require.cache[require.resolve('../../app')];
  const HousePulseApp = require('../../app');
  const app = new HousePulseApp();
  app.homey = homey;
  homey.app = app; // like Homey: api.js reaches the app through homey.app
  await app.onInit();
  await flush();
  return {
    app, homey, devices: byId, realtime, autocomplete, store, settingsWrites, apiCalls, runTimeouts, pendingTimeouts: timeouts,
  };
}

/** Let pending promise chains (e.g. restoring sources after start) finish. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

module.exports = { FakeDevice, createApp, flush };
