'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const EnergyLedger = require('./lib/EnergyLedger');
const EnergyRoles = require('./lib/EnergyRoles');
const AppDependencies = require('./lib/AppDependencies');
const SolarSplit = require('./lib/SolarSplit');

const WIDGET_ID = 'energy_flow_dash';
const EVENTS = {
  value: 'energy_update', // { deviceId, capability, value, ts }
  status: 'energy_status', // { deviceId, available, missing }
  today: 'energy_today', // { sourceId, inKwh, outKwh, inSource, outSource, date }
  split: 'energy_split', // { key, date, evKwh, evSolarKwh, batteryKwh, batterySolarKwh }
};

const MAX_SOURCES_PER_INSTANCE = 12; // 10 device settings + margin
const MAX_AUTOCOMPLETE_RESULTS = 60;
const MAX_SOURCE_ID_LENGTH = 200;

// Widget instances re-subscribe every minute; this is only used for debug bookkeeping.
const INSTANCE_TTL_MS = 5 * 60 * 1000;
// Sources keep being listened to (so today's kWh stays correct while no dashboard is open)
// until no widget has asked for them for this long.
const SOURCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TICK_INTERVAL_MS = 60 * 1000;
const SAVE_INTERVAL_MS = 5 * 60 * 1000;
const TODAY_EMIT_MIN_DELTA_KWH = 0.01;
const SPLIT_EMIT_MIN_DELTA_KWH = 0.01;
const MAX_RECENT_ERRORS = 20;
const REALTIME_MIN_INTERVAL_MS = 1000;
const DEVICE_CACHE_MS = 30 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MB = 1024 * 1024;
// Capabilities that make a device energy-relevant (power, energy meters, battery level).
const ENERGY_CAP_RE = /^(measure_power|meter_power|measure_battery)/;

// Waiting for other apps at startup (see lib/AppDependencies.js).
const WAIT_FOR_APPS_SETTING = 'waitForApps';
const DEPENDENCY_POLL_MS = 5 * 1000;
const DEPENDENCY_MAX_WAIT_MS = 10 * 60 * 1000;

// Homey sets DEBUG=1 only when the app runs via `homey app run`. Never on installed apps.
const DEBUG_ENABLED = process.env.DEBUG === '1';
const DEBUG_STATUS_INTERVAL_MS = 60 * 1000;

// Autocomplete settings can't be cleared in Homey, so every picker offers this entry instead.
// The widget treats it as "no device selected". Must match NONE_ID in the widget's index.html.
const NONE_ID = '__none__';
const LABELS = {
  en: { none: '— None —', noneDescription: 'Remove the device from the widget', socOnly: 'State of charge only' },
  sv: { none: '— Ingen —', noneDescription: 'Ta bort enheten från widgeten', socOnly: 'Endast laddnivå' },
  no: { none: '— Ingen —', noneDescription: 'Fjern enheten fra widgeten', socOnly: 'Kun ladenivå' },
  da: { none: '— Ingen —', noneDescription: 'Fjern enheden fra widgetten', socOnly: 'Kun ladeniveau' },
  de: { none: '— Keine —', noneDescription: 'Gerät aus dem Widget entfernen', socOnly: 'Nur Ladestand' },
  nl: { none: '— Geen —', noneDescription: 'Apparaat uit de widget verwijderen', socOnly: 'Alleen laadniveau' },
};

// Widget setting id → role
const SETTING_ROLES = {
  grid_device: 'grid',
  solar_device: 'solar',
  solar_device_2: 'solar',
  ev_device: 'ev',
  ev_device_2: 'ev',
  car_device: 'car',
  battery_device: 'battery',
  battery_device_2: 'battery',
  home_device: 'home',
  extra_device: 'extra',
};

class HousePulseApp extends Homey.App {

  async onInit() {
    this.apiPromise = null;

    // deviceId -> watcher (see ensureWatcher)
    this.watchers = new Map();
    // widget instanceId -> { sourceIds: Set<string>, lastSeen: number }
    this.widgetInstances = new Map();
    // sourceId -> last time a widget asked for it
    this.tracked = this.homey.settings.get('trackedDevices') || {};

    this.ledger = new EnergyLedger({
      getTimezone: () => this.homey.clock.getTimezone(),
      data: this.homey.settings.get('ledger'),
    });
    // How much of today's EV and battery charging came from solar, per widget role setup.
    this.split = new SolarSplit({
      today: (now) => this.ledger.today(now),
      data: this.homey.settings.get('solarSplit'),
    });
    // key -> totals last sent to the widgets
    this.lastEmittedSplit = new Map();
    // What is in storage now, so saveState() only writes changes.
    this.savedJson = {
      ledger: JSON.stringify(this.ledger.toJSON()),
      solarSplit: JSON.stringify(this.split.toJSON()),
      trackedDevices: JSON.stringify(this.tracked),
    };
    this.deviceCache = null;

    this.registerAutocompleteListeners();
    this.tickTimer = this.homey.setInterval(() => this.onTick(), TICK_INTERVAL_MS);
    this.saveTimer = this.homey.setInterval(() => this.saveState(), SAVE_INTERVAL_MS);

    if (DEBUG_ENABLED) {
      this.debugStats = {
        realtimeEvents: 0, todayEvents: 0, statusEvents: 0, subscribeCalls: 0, startedAt: Date.now(),
      };
      this.debugTimer = this.homey.setInterval(() => this.logDebugStatus(), DEBUG_STATUS_INTERVAL_MS);
      this.debug('Debug mode ON (homey app run). Status is logged every', DEBUG_STATUS_INTERVAL_MS / 1000, 's');
      this.logDebugInventory().catch((err) => this.debug('Inventory failed:', err.message));
      this.getAppsOverview()
        .then(({ apps, waitFor }) => this.debug(`Apps: ${apps.length} other app(s), waiting for [${waitFor.join(', ')}],`
          + ` with widget devices: [${apps.filter((x) => x.usedByWidget).map((x) => `${x.name} (${x.state})`).join(', ')}]`))
        .catch((err) => this.error('App list failed:', err.message));
      // Self-check that the diagnostics report (app settings page) can be built.
      this.homey.setTimeout(() => this.buildDiagnostics({ anonymize: true })
        .then((r) => this.debug(`Diagnostics self-check OK: ${r.devices.length} devices, ${r.sources.length} sources,`
          + ` ${JSON.stringify(r).length} bytes, example: ${JSON.stringify(r.devices.find((d) => d.energy.length) || null)}`))
        .catch((err) => this.error('Diagnostics self-check failed:', err.message)), 5000);
    }

    // Wait for the apps the user depends on, then resume listening to sources from before the
    // restart. Runs in the background: onInit() must return quickly or Homey thinks we hang.
    this.startup = {
      state: 'waiting', startedAt: Date.now(), readyAt: null, waitedFor: [], waitedMs: 0, timedOut: false, pending: [],
    };
    this.startupPromise = this.waitForDependencies()
      .then(() => this.restoreSources())
      .catch((err) => this.error('Could not restore listeners:', err.message));

    this.log('HousePulse initialized');
  }

  async onUninit() {
    this.homey.clearInterval(this.tickTimer);
    this.homey.clearInterval(this.saveTimer);
    if (this.debugTimer) this.homey.clearInterval(this.debugTimer);

    this.ledger.tick();
    this.updateSplit();
    this.saveState();
    for (const deviceId of [...this.watchers.keys()]) {
      await this.destroyWatcher(deviceId);
    }
    this.widgetInstances.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Waiting for other apps at startup                                   */
  /* ------------------------------------------------------------------ */

  getWaitForApps() {
    return AppDependencies.normaliseIds(this.homey.settings.get(WAIT_FOR_APPS_SETTING), this.homey.manifest.id);
  }

  setWaitForApps(ids) {
    const clean = AppDependencies.normaliseIds(ids, this.homey.manifest.id);
    this.homey.settings.set(WAIT_FOR_APPS_SETTING, clean);
    this.log(`Apps to wait for at startup: ${clean.length ? clean.join(', ') : 'none'}`);
    return clean;
  }

  get isStarting() {
    return this.startup.state !== 'ready';
  }

  async waitForDependencies() {
    const ids = this.getWaitForApps();
    this.startup.waitedFor = ids;
    if (ids.length) this.log(`Waiting for ${ids.length} app(s) to run: ${ids.join(', ')}`);

    let lastPending = '';
    const result = await AppDependencies.waitForApps({
      ids,
      getApps: async () => (await this.getApi()).apps.getApps(),
      sleep: (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)),
      intervalMs: DEPENDENCY_POLL_MS,
      maxWaitMs: DEPENDENCY_MAX_WAIT_MS,
      onPending: (pending) => {
        this.startup.pending = pending;
        const text = pending.map((app) => `${app.name} (${app.state})`).join(', ');
        if (text !== lastPending) this.log(`Still waiting for: ${text}`);
        lastPending = text;
      },
      onError: (err) => this.debug('App list not available yet:', err.message),
    });

    Object.assign(this.startup, {
      state: 'ready', readyAt: Date.now(), waitedMs: result.waitedMs, timedOut: result.timedOut, pending: result.pending,
    });
    if (result.timedOut) {
      this.error(`Started anyway after ${Math.round(result.waitedMs / 1000)} s; not running: `
        + `${result.pending.map((app) => `${app.name} (${app.state})`).join(', ')}`);
    } else if (ids.length) {
      this.log(`All apps run after ${Math.round(result.waitedMs / 1000)} s, starting`);
    }
  }

  /** For the settings page: installed apps, which to wait for, and how the last start went. */
  async getAppsOverview() {
    const api = await this.getApi();
    const apps = Object.values(await api.apps.getApps() || {});
    const { devices } = await this.getDevicesCached();

    // Apps owning devices that report power, energy or battery level (the candidates), and
    // among them the apps owning devices that widgets show (the ones worth waiting for).
    const energyAppIds = new Set();
    for (const device of Object.values(devices)) {
      const appId = AppDependencies.appIdFromDriver(device.driverId);
      if (appId && Array.isArray(device.capabilities) && device.capabilities.some((cap) => ENERGY_CAP_RE.test(cap))) {
        energyAppIds.add(appId);
      }
    }
    const usedAppIds = new Set();
    for (const sourceId of Object.keys(this.tracked)) {
      const device = devices[EnergyRoles.parseSourceId(sourceId).deviceId];
      const appId = device && AppDependencies.appIdFromDriver(device.driverId);
      if (appId) usedAppIds.add(appId);
    }

    const ownId = this.homey.manifest.id;
    const list = apps
      .filter((app) => app && app.id && app.id !== ownId)
      .map((app) => ({
        id: app.id,
        name: app.name || app.id,
        state: app.state || 'unknown',
        enabled: app.enabled !== false,
        usedByWidget: usedAppIds.has(app.id),
        hasEnergyDevices: energyAppIds.has(app.id) || usedAppIds.has(app.id),
      }))
      .sort((a, b) => (b.usedByWidget - a.usedByWidget) || a.name.localeCompare(b.name));

    return { apps: list, waitFor: this.getWaitForApps(), startup: this.startup };
  }

  labels() {
    return LABELS[this.homey.i18n.getLanguage()] || LABELS.en;
  }

  /* ------------------------------------------------------------------ */
  /* Debug helpers (no-ops unless running via `homey app run`)           */
  /* ------------------------------------------------------------------ */

  debug(...args) {
    if (DEBUG_ENABLED) this.log('[DEBUG]', ...args);
  }

  logDebugStatus() {
    const uptimeMin = ((Date.now() - this.debugStats.startedAt) / 60000).toFixed(1);
    this.debug(`Status after ${uptimeMin} min:`, {
      widgetInstances: [...this.widgetInstances.entries()].map(([id, entry]) => ({
        id,
        sources: [...entry.sourceIds],
        lastSeenSecondsAgo: Math.round((Date.now() - entry.lastSeen) / 1000),
      })),
      watchedDevices: [...this.watchers.values()].map((watcher) => ({
        name: watcher.name,
        available: watcher.available,
        capabilities: [...watcher.capabilityInstances.keys()],
        sources: [...watcher.sources.entries()].map(([sourceId, s]) => ({
          sourceId, power: s.power, soc: s.soc, meters: s.meters, today: this.ledger.get(sourceId),
        })),
      })),
      ...this.debugStats,
      runtime: this.runtimeStats(),
    });
  }

  /** Memory use and uptime of the app process (Homey limits how much memory an app may use). */
  runtimeStats() {
    const mb = (bytes) => (typeof bytes === 'number' ? Math.round((bytes / MB) * 10) / 10 : null);
    let memoryMB = null;
    try {
      const mem = process.memoryUsage();
      memoryMB = {
        rss: mb(mem.rss), heapUsed: mb(mem.heapUsed), heapTotal: mb(mem.heapTotal), external: mb(mem.external),
      };
    } catch (err) {
      // Homey's app sandbox can't read the resident set size: process.memoryUsage() throws
      // "ENOENT ... uv_resident_set_memory". V8's own heap statistics still work there.
      try {
        // Loaded here, inside the try: if the sandbox ever blocks it, only this stat is lost.
        // eslint-disable-next-line global-require
        const heap = require('node:v8').getHeapStatistics();
        memoryMB = {
          rss: null, heapUsed: mb(heap.used_heap_size), heapTotal: mb(heap.total_heap_size), external: mb(heap.external_memory),
        };
      } catch (e) { /* leave memoryMB null */ }
    }
    return {
      memoryMB,
      uptimeMinutes: Math.round(process.uptime() / 60),
      watchedDevices: this.watchers.size,
      sources: Object.keys(this.tracked).length,
    };
  }

  /** Keep the most recent errors for the diagnostics page, then log as usual. */
  error(...args) {
    if (!this.recentErrors) this.recentErrors = [];
    this.recentErrors.push({
      at: new Date().toISOString(),
      message: args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '),
    });
    if (this.recentErrors.length > MAX_RECENT_ERRORS) this.recentErrors.shift();
    super.error(...args);
  }

  /**
   * Diagnostics report for the app settings page: how the user's devices present themselves
   * (class, Homey energy metadata, chosen kWh meters, driver) and what the widget does with
   * them. Lets users of any brand send a useful bug report without developer tools.
   * @param {object} opts
   * @param {boolean} opts.anonymize Replace device and zone names with neutral labels.
   */
  async buildDiagnostics({ anonymize = false } = {}) {
    const api = await this.getApi();
    const [devicesById, zones] = await Promise.all([api.devices.getDevices(), api.zones.getZones()]);
    const devices = Object.values(devicesById);
    const liveReport = await this.getLiveReport();
    const now = Date.now();

    const labels = new Map();
    const nameOf = (device) => {
      if (!device) return null;
      if (!anonymize) return device.name;
      if (!labels.has(device.id)) labels.set(device.id, `Device ${labels.size + 1}`);
      return labels.get(device.id);
    };
    const zoneOf = (device) => {
      const zone = device && zones[device.zone];
      if (!zone) return null;
      return anonymize ? `Zone ${Object.keys(zones).indexOf(device.zone) + 1}` : zone.name;
    };
    const energyCaps = (d) => (d.capabilities || []).filter((cap) => ENERGY_CAP_RE.test(cap));
    const valueOf = (d, cap) => {
      const obj = d.capabilitiesObj && d.capabilitiesObj[cap];
      if (!obj) return null;
      const ts = obj.lastUpdated ? new Date(obj.lastUpdated).getTime() : null;
      return { value: obj.value, ageSeconds: Number.isFinite(ts) ? Math.round((now - ts) / 1000) : null };
    };

    const relevant = devices.filter((d) => energyCaps(d).length);
    const suggestion = EnergyRoles.suggest(devices, liveReport);
    const suggestionNames = {};
    for (const [role, list] of Object.entries(suggestion)) {
      suggestionNames[role] = list.map((item) => {
        const { deviceId, capabilityId } = EnergyRoles.parseSourceId(item.id);
        return [nameOf(devicesById[deviceId]), capabilityId].filter(Boolean).join(' / ');
      });
    }

    return {
      generatedAt: new Date(now).toISOString(),
      app: { id: this.homey.manifest.id, version: this.homey.manifest.version },
      runtime: this.runtimeStats(),
      startup: { ...this.startup, waitFor: this.getWaitForApps() },
      homey: {
        version: this.homey.version,
        platform: this.homey.platform,
        platformVersion: this.homey.platformVersion,
        language: this.homey.i18n.getLanguage(),
        timezone: this.homey.clock.getTimezone(),
      },
      anonymized: anonymize,
      widgets: [...this.widgetInstances.values()].map((entry) => ({
        sources: entry.sourceIds.size,
        lastSeenSecondsAgo: Math.round((now - entry.lastSeen) / 1000),
      })),
      sources: Object.keys(this.tracked).map((sourceId) => {
        const { deviceId, capabilityId } = EnergyRoles.parseSourceId(sourceId);
        const watcher = this.watchers.get(deviceId);
        const source = watcher && watcher.sources.get(sourceId);
        const device = devicesById[deviceId];
        return {
          device: nameOf(device) || '(missing)',
          capability: capabilityId,
          watched: Boolean(source),
          available: watcher ? watcher.available : null,
          power: source && source.power ? { capability: source.power, ...valueOf(device, source.power) } : null,
          soc: source && source.soc ? { capability: source.soc, ...valueOf(device, source.soc) } : null,
          kwhMeters: source ? source.meters : null,
          today: this.ledger.get(sourceId),
        };
      }),
      homeyLiveReport: liveReport ? {
        gridW: liveReport.totalCumulative ? liveReport.totalCumulative.W : null,
        consumedW: liveReport.totalConsumed ? liveReport.totalConsumed.W : null,
        generatedW: liveReport.totalGenerated ? liveReport.totalGenerated.W : null,
      } : null,
      autoSuggestion: suggestionNames,
      devices: relevant.map((d) => {
        const e = d.energyObj || {};
        return {
          name: nameOf(d),
          zone: zoneOf(d),
          class: d.class,
          virtualClass: d.virtualClass || null,
          driver: d.driverId || d.driverUri || null,
          available: d.available !== false,
          energy: ['cumulative', 'generator', 'homeBattery', 'evCharger', 'electricCar'].filter((k) => e[k]),
          kwhMeters: EnergyRoles.pickMeters(d, 'measure_power'),
          capabilities: Object.fromEntries(energyCaps(d).map((cap) => [cap, valueOf(d, cap)])),
        };
      }),
      recentErrors: this.recentErrors || [],
    };
  }

  /**
   * Debug only: log every energy-relevant device with its class, Homey energy metadata and
   * power/meter/battery capabilities, Homey's own live energy report, and what the widget
   * would suggest. Lets users of other brands send a log showing how their devices look.
   */
  async logDebugInventory() {
    const api = await this.getApi();
    const devices = Object.values(await api.devices.getDevices());
    const relevant = devices.filter((d) => Array.isArray(d.capabilities)
      && d.capabilities.some((cap) => ENERGY_CAP_RE.test(cap)));

    this.debug(`Inventory: ${relevant.length} energy-relevant device(s) of ${devices.length}`);
    for (const d of relevant) {
      const caps = d.capabilities.filter((cap) => ENERGY_CAP_RE.test(cap));
      const e = d.energyObj || {};
      const flags = ['cumulative', 'generator', 'homeBattery', 'evCharger', 'electricCar'].filter((k) => e[k]);
      this.debug(`  ${d.name} | class=${d.class}/${d.virtualClass || '-'} | energy=[${flags.join(',')}]`
        + ` | meters=${JSON.stringify(EnergyRoles.pickMeters(d, 'measure_power'))} | ${caps.join(', ')}`);
    }

    const liveReport = await this.getLiveReport();
    this.debug('Homey live report: grid', liveReport && liveReport.totalCumulative,
      'consumed', liveReport && liveReport.totalConsumed, 'generated', liveReport && liveReport.totalGenerated);
    this.debug('Auto-suggestion:', JSON.stringify(EnergyRoles.suggest(devices, liveReport)));
  }

  /* ------------------------------------------------------------------ */
  /* Homey Web API                                                       */
  /* ------------------------------------------------------------------ */

  /** Lazily create the Web API client so a temporary failure doesn't crash the app. */
  async getApi() {
    if (!this.apiPromise) {
      this.apiPromise = HomeyAPI.createAppAPI({ homey: this.homey }).catch((err) => {
        this.apiPromise = null;
        throw err;
      });
    }
    return this.apiPromise;
  }

  async getLiveReport() {
    try {
      const api = await this.getApi();
      return await api.energy.getLiveReport({});
    } catch (err) {
      this.debug('Live energy report not available:', err.message);
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Widget settings: device pickers and auto-suggestion                 */
  /* ------------------------------------------------------------------ */

  registerAutocompleteListeners() {
    const widget = this.homey.dashboards.getWidget(WIDGET_ID);

    for (const [settingId, role] of Object.entries(SETTING_ROLES)) {
      widget.registerSettingAutocompleteListener(settingId, async (query) => {
        const results = await this.searchSources(query, role);
        this.debug(`Autocomplete ${settingId} query="${query}" → ${results.length} entr(ies)`);
        return results;
      });
    }
  }

  /**
   * Devices, zones and Homey's live report, cached for DEVICE_CACHE_MS. The pickers call this on
   * every keystroke and every widget start asks for suggestions; with 100+ devices fetching the
   * full list each time is wasted work for Homey. (Diagnostics always fetch fresh data.)
   */
  async getDevicesCached() {
    if (!this.deviceCache || Date.now() - this.deviceCache.at > DEVICE_CACHE_MS) {
      const api = await this.getApi();
      const cache = {
        at: Date.now(),
        promise: Promise.all([api.devices.getDevices(), api.zones.getZones(), this.getLiveReport()])
          .then(([devices, zones, liveReport]) => ({ devices, zones, liveReport })),
      };
      cache.promise.catch(() => {
        if (this.deviceCache === cache) this.deviceCache = null; // don't cache failures
      });
      this.deviceCache = cache;
    }
    return this.deviceCache.promise;
  }

  async searchSources(query, role) {
    const { devices, zones } = await this.getDevicesCached();
    const labels = this.labels();
    const needle = String(query || '').trim().toLowerCase();
    const matches = (text) => !needle || text.toLowerCase().includes(needle);

    const entries = Object.values(devices)
      .flatMap((device) => EnergyRoles.pickerEntries(device, role, {
        zoneName: zones[device.zone] ? zones[device.zone].name : null,
        socOnlyLabel: labels.socOnly,
      }))
      .filter((entry) => matches(entry.name) || matches(entry.description))
      .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
      .slice(0, MAX_AUTOCOMPLETE_RESULTS)
      .map(({ id, name, description }) => ({ id, name, description }));

    const noneMatches = Object.values(LABELS).some((l) => matches(l.none));
    const none = noneMatches ? [{ id: NONE_ID, name: labels.none, description: labels.noneDescription }] : [];
    return none.concat(entries);
  }

  /** Suggested sources per role, for widgets that have no configuration yet. */
  async suggestSources() {
    // Devices and live report from the same moment, so the grid meter can be matched.
    const { devices, liveReport } = await this.getDevicesCached();
    const suggestion = EnergyRoles.suggest(Object.values(devices), liveReport);
    this.debug('Suggest for unconfigured widget:', JSON.stringify(suggestion));
    return { roles: suggestion };
  }

  /* ------------------------------------------------------------------ */
  /* Widget subscriptions                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Called from the widget's api.js. Registers which sources a widget instance shows,
   * makes sure they are listened to, and returns a snapshot of current values.
   */
  async subscribeWidget({ instanceId, sourceIds, split }) {
    if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 128) {
      throw new Error('Invalid widget instance id');
    }
    if (!Array.isArray(sourceIds)) {
      throw new Error('sourceIds must be an array');
    }

    const wanted = new Set(sourceIds
      .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_SOURCE_ID_LENGTH && id !== NONE_ID)
      .slice(0, MAX_SOURCES_PER_INSTANCE));

    const now = Date.now();
    const previous = this.widgetInstances.get(instanceId);
    // The roles (grid, solar, EV, battery) for "charged from solar". Only sources this widget shows.
    let splitKey = null;
    if (split && typeof split === 'object') {
      const own = { invert: split.invert };
      for (const role of ['grid', 'solar', 'ev', 'battery']) {
        own[role] = Array.isArray(split[role]) ? split[role].filter((id) => wanted.has(id)) : [];
      }
      splitKey = this.split.configure(own, now);
    }
    this.widgetInstances.set(instanceId, { sourceIds: wanted, lastSeen: now, splitKey });
    // Hour precision is plenty for the 7-day retention, and avoids a storage write every minute.
    const trackedAt = Math.floor(now / HOUR_MS) * HOUR_MS;
    for (const sourceId of wanted) this.tracked[sourceId] = trackedAt;

    if (DEBUG_ENABLED) {
      this.debugStats.subscribeCalls++;
      const previousIds = previous ? previous.sourceIds : new Set();
      this.debug(`Subscribe from ${instanceId}${previous ? ' (refresh)' : ' (new)'}:`, {
        sources: [...wanted],
        added: [...wanted].filter((id) => !previousIds.has(id)),
        removed: [...previousIds].filter((id) => !wanted.has(id)),
      });
    }

    // Sources this widget deliberately dropped (setting changed, e.g. to "None") are released
    // right away unless another active widget still shows them. A widget that merely stops
    // reporting (dashboard closed) keeps its sources for SOURCE_RETENTION_MS instead.
    if (previous) {
      for (const sourceId of previous.sourceIds) {
        if (wanted.has(sourceId) || this.isSourceUsedByOtherInstance(sourceId, instanceId)) continue;
        this.debug(`Releasing ${sourceId}: removed from widget ${instanceId}`);
        await this.forgetSource(sourceId, { keepToday: true });
      }
    }

    if (this.isStarting) {
      return {
        starting: true,
        waitingFor: this.startup.pending.map((app) => app.name),
        sources: [],
        debug: DEBUG_ENABLED,
        serverTime: Date.now(),
      };
    }

    await Promise.all([...wanted].map((sourceId) => this.ensureSource(sourceId)));
    const snapshot = [...wanted].map((sourceId) => this.getSourceSnapshot(sourceId));

    if (DEBUG_ENABLED) {
      for (const s of snapshot) {
        if (s.missing) this.debug(`  ${s.id}: MISSING (deleted, no access or capability gone)`);
        else this.debug(`  ${s.name} [${s.id}]: available=${s.available} power=${JSON.stringify(s.power)}`
          + ` soc=${JSON.stringify(s.soc)} today=${JSON.stringify(s.today)}`);
      }
    }

    // `debug` tells the widget to show its debug footer; false on installed apps.
    return {
      sources: snapshot,
      split: splitKey ? { key: splitKey, ...this.split.get(splitKey) } : null,
      debug: DEBUG_ENABLED,
      serverTime: Date.now(),
    };
  }

  isSourceUsedByOtherInstance(sourceId, instanceId) {
    for (const [otherId, entry] of this.widgetInstances) {
      if (otherId !== instanceId && entry.sourceIds.has(sourceId)) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Sources and device watchers                                         */
  /* ------------------------------------------------------------------ */

  async restoreSources() {
    const cutoff = Date.now() - SOURCE_RETENTION_MS;
    const ids = Object.entries(this.tracked).filter(([, ts]) => ts >= cutoff).map(([id]) => id);
    this.debug(`Restoring ${ids.length} source(s)`);
    await Promise.all(ids.map((id) => this.ensureSource(id)));
  }

  /** Make sure a source's device is watched and the capabilities it needs are listened to. */
  async ensureSource(sourceId) {
    const { deviceId, capabilityId } = EnergyRoles.parseSourceId(sourceId);
    await this.ensureWatcher(deviceId);

    const watcher = this.watchers.get(deviceId);
    if (!watcher || !watcher.device || watcher.sources.has(sourceId)) return;

    const { device } = watcher;
    const { power, soc } = EnergyRoles.resolveSource(device, capabilityId);
    const meters = EnergyRoles.pickMeters(device, power);
    watcher.sources.set(sourceId, { power, soc, meters });

    // Seed today's ledger with the current readings.
    const values = device.capabilitiesObj || {};
    this.ledger.configure(sourceId, meters);
    // Stored values can be hours old: pass when they were measured, so the next report's
    // increase is judged over the right time span.
    const now = Date.now();
    for (const meter of [meters.in, meters.out]) {
      if (!meter || !values[meter]) continue;
      const measured = values[meter].lastUpdated ? new Date(values[meter].lastUpdated).getTime() : NaN;
      this.ledger.onMeter(sourceId, meter, values[meter].value, now, Number.isFinite(measured) ? Math.min(measured, now) : now);
    }
    if (power && values[power]) this.ledger.onPower(sourceId, values[power].value);

    for (const cap of [power, soc, meters.in, meters.out]) {
      if (cap) this.ensureCapability(watcher, cap);
    }

    this.debug(`Source ${sourceId} (${watcher.name}): power=${power || '-'} soc=${soc || '-'}`
      + ` kWh in=${meters.in || (power ? 'integrated' : '-')} out=${meters.out || (power ? 'integrated' : '-')}`);
  }

  ensureWatcher(deviceId) {
    const existing = this.watchers.get(deviceId);
    if (existing) return existing.ready;

    const watcher = {
      deviceId,
      device: null,
      name: null,
      available: true,
      capabilityInstances: new Map(),
      sources: new Map(), // sourceId -> { power, soc, meters }
      lastEmittedToday: new Map(), // sourceId -> { in, out }
      throttle: new Map(), // capabilityId -> { lastSent, timer, pending } (see emitValue)
      handlers: null,
      ready: null,
    };
    this.watchers.set(deviceId, watcher);

    watcher.ready = this.attachWatcher(watcher).catch((err) => {
      this.error(`Could not watch device ${deviceId}:`, err.message);
      // Drop the watcher so the next subscribe retries; the snapshot reports it as missing.
      if (this.watchers.get(deviceId) === watcher) this.watchers.delete(deviceId);
    });
    return watcher.ready;
  }

  async attachWatcher(watcher) {
    const api = await this.getApi();
    const device = await api.devices.getDevice({ id: watcher.deviceId });

    watcher.device = device;
    watcher.name = device.name;
    watcher.available = device.available !== false;

    // Device-level changes: availability, rename, deletion.
    watcher.handlers = {
      update: (props) => this.onDeviceUpdate(watcher, props),
      delete: () => this.onDeviceDeleted(watcher),
    };
    device.on('update', watcher.handlers.update);
    device.on('delete', watcher.handlers.delete);
    await device.connect();
  }

  ensureCapability(watcher, capabilityId) {
    if (watcher.capabilityInstances.has(capabilityId)) return;
    if (!(watcher.device.capabilities || []).includes(capabilityId)) return;

    watcher.capabilityInstances.set(capabilityId, watcher.device.makeCapabilityInstance(
      capabilityId,
      (value, instance) => this.onCapabilityValue(watcher, capabilityId, value, instance),
    ));
  }

  async destroyWatcher(deviceId) {
    const watcher = this.watchers.get(deviceId);
    if (!watcher) return;

    this.watchers.delete(deviceId);
    await watcher.ready;

    for (const instance of watcher.capabilityInstances.values()) {
      try {
        instance.destroy();
      } catch (err) {
        this.error(`Error destroying capability listener for ${deviceId}:`, err.message);
      }
    }
    watcher.capabilityInstances.clear();

    for (const state of watcher.throttle.values()) {
      if (state.timer) this.homey.clearTimeout(state.timer);
    }
    watcher.throttle.clear();

    if (watcher.device && watcher.handlers) {
      watcher.device.off('update', watcher.handlers.update);
      watcher.device.off('delete', watcher.handlers.delete);
      watcher.device.disconnect().catch(() => {});
    }
    this.debug(`Stopped watching ${watcher.name || deviceId}`);
  }

  /**
   * Stop tracking a source; stop watching its device when no sources are left.
   * keepToday keeps today's ledger entry, so a source re-added the same day continues its
   * total (e.g. when another, currently closed, dashboard also shows it). saveState() drops
   * such untracked entries once the day is over.
   */
  async forgetSource(sourceId, { keepToday = false } = {}) {
    delete this.tracked[sourceId];
    if (!keepToday) this.ledger.remove(sourceId);

    const { deviceId } = EnergyRoles.parseSourceId(sourceId);
    const watcher = this.watchers.get(deviceId);
    if (!watcher) return;
    watcher.sources.delete(sourceId);
    watcher.lastEmittedToday.delete(sourceId);
    if (watcher.sources.size === 0) await this.destroyWatcher(deviceId);
  }

  onCapabilityValue(watcher, capabilityId, value, instance) {
    const now = Date.now();
    let isLive = false;
    const meterSources = [];

    for (const [sourceId, source] of watcher.sources) {
      if (source.power === capabilityId) {
        this.ledger.onPower(sourceId, value, now);
        isLive = true;
      }
      if (source.soc === capabilityId) isLive = true;
      if (source.meters.in === capabilityId || source.meters.out === capabilityId) {
        this.ledger.onMeter(sourceId, capabilityId, value, now);
        meterSources.push(sourceId);
      }
    }

    // A report means the device is alive again, even if no 'update' event arrived.
    if (!watcher.available) this.setAvailable(watcher, true);

    for (const sourceId of meterSources) this.emitToday(watcher, sourceId);
    if (!isLive) return;
    if (this.split.entries.size) this.updateSplit(now);

    this.debug(`Update ${watcher.name} ${capabilityId} = ${value}`);
    this.emitValue(watcher, capabilityId, value, instance && instance.lastChanged ? instance.lastChanged.getTime() : now);
  }

  /**
   * Push a live value to the widgets at most once per REALTIME_MIN_INTERVAL_MS per device and
   * capability. Meters that report every second would otherwise send 60 messages a minute to
   * every widget. Values in between are coalesced: the latest one is sent when the interval
   * ends, so the widget always ends up with the newest value. (Today's kWh still use every report.)
   */
  emitValue(watcher, capabilityId, value, ts) {
    const payload = { deviceId: watcher.deviceId, capability: capabilityId, value, ts };
    let state = watcher.throttle.get(capabilityId);
    if (!state) {
      state = { lastSent: 0, timer: null, pending: null };
      watcher.throttle.set(capabilityId, state);
    }

    const wait = state.lastSent + REALTIME_MIN_INTERVAL_MS - Date.now();
    if (wait <= 0 && !state.timer) {
      state.lastSent = Date.now();
      this.sendValue(payload);
      return;
    }

    state.pending = payload;
    if (state.timer) return;
    state.timer = this.homey.setTimeout(() => {
      state.timer = null;
      const pending = state.pending;
      state.pending = null;
      if (!pending || this.watchers.get(watcher.deviceId) !== watcher) return; // watcher was stopped
      state.lastSent = Date.now();
      this.sendValue(pending);
    }, Math.max(0, wait));
  }

  sendValue(payload) {
    if (DEBUG_ENABLED) this.debugStats.realtimeEvents++;
    this.homey.api.realtime(EVENTS.value, payload);
  }

  onDeviceUpdate(watcher, props) {
    if (!props) return;
    if (typeof props.name === 'string') watcher.name = props.name;
    if ('available' in props) this.setAvailable(watcher, props.available !== false);
  }

  setAvailable(watcher, available) {
    if (watcher.available === available) return;
    watcher.available = available;
    this.debug(`${watcher.name} is now ${available ? 'available' : 'UNAVAILABLE'}`);
    this.emitStatus(watcher.deviceId, { available, missing: false });
  }

  onDeviceDeleted(watcher) {
    this.debug(`${watcher.name} was DELETED`);
    this.emitStatus(watcher.deviceId, { available: false, missing: true });
    Promise.all([...watcher.sources.keys()].map((sourceId) => this.forgetSource(sourceId)))
      .then(() => this.destroyWatcher(watcher.deviceId))
      .catch((err) => this.error('Error removing deleted device:', err.message));
  }

  emitStatus(deviceId, status) {
    if (DEBUG_ENABLED) this.debugStats.statusEvents++;
    this.homey.api.realtime(EVENTS.status, { deviceId, ...status });
  }

  /** Push today's totals for a source when they changed noticeably. */
  emitToday(watcher, sourceId) {
    const today = this.ledger.get(sourceId);
    if (!today) return;

    const last = watcher.lastEmittedToday.get(sourceId);
    const changed = !last
      || Math.abs(today.inKwh - last.in) >= TODAY_EMIT_MIN_DELTA_KWH
      || Math.abs(today.outKwh - last.out) >= TODAY_EMIT_MIN_DELTA_KWH;
    if (!changed) return;

    watcher.lastEmittedToday.set(sourceId, { in: today.inKwh, out: today.outKwh });
    if (DEBUG_ENABLED) this.debugStats.todayEvents++;
    this.homey.api.realtime(EVENTS.today, { sourceId, ...today });
  }

  /** Integrate "charged from solar" up to now with the latest powers. */
  updateSplit(now = Date.now()) {
    this.split.update((sourceId) => this.ledger.getPower(sourceId), now);
  }

  /** Push the "charged from solar" totals that changed noticeably. */
  emitSplits(now = Date.now()) {
    for (const key of this.split.entries.keys()) {
      const totals = this.split.get(key, now);
      const last = this.lastEmittedSplit.get(key);
      const changed = !last || last.date !== totals.date
        || ['evKwh', 'evSolarKwh', 'batteryKwh', 'batterySolarKwh']
          .some((k) => Math.abs(totals[k] - last[k]) >= SPLIT_EMIT_MIN_DELTA_KWH);
      if (!changed) continue;
      this.lastEmittedSplit.set(key, totals);
      this.homey.api.realtime(EVENTS.split, { key, ...totals });
    }
  }

  getSourceSnapshot(sourceId) {
    const { deviceId } = EnergyRoles.parseSourceId(sourceId);
    const watcher = this.watchers.get(deviceId);
    const source = watcher && watcher.sources.get(sourceId);
    if (!watcher || !watcher.device || !source || (!source.power && !source.soc)) {
      return { id: sourceId, deviceId, missing: true };
    }

    const read = (cap) => {
      if (!cap) return null;
      const obj = watcher.device.capabilitiesObj && watcher.device.capabilitiesObj[cap];
      const ts = obj && obj.lastUpdated ? new Date(obj.lastUpdated).getTime() : null;
      return { capability: cap, value: obj ? obj.value : null, ts: Number.isFinite(ts) ? ts : null };
    };

    return {
      id: sourceId,
      deviceId,
      name: watcher.name,
      available: watcher.available,
      power: read(source.power),
      soc: read(source.soc),
      today: source.power ? this.ledger.get(sourceId) : null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Periodic work                                                       */
  /* ------------------------------------------------------------------ */

  onTick() {
    const now = Date.now();

    // Midnight reset + integrate held power for sources without kWh meters.
    this.ledger.tick(now);
    this.updateSplit(now);
    this.emitSplits(now);
    for (const watcher of this.watchers.values()) {
      for (const [sourceId, source] of watcher.sources) {
        if (source.power) this.emitToday(watcher, sourceId);
      }
    }

    for (const [instanceId, entry] of [...this.widgetInstances.entries()]) {
      if (now - entry.lastSeen > INSTANCE_TTL_MS) {
        this.widgetInstances.delete(instanceId);
        this.debug(`Widget instance ${instanceId} went away (no subscribe for ${INSTANCE_TTL_MS / 60000} min)`);
      }
    }

    for (const [sourceId, ts] of Object.entries(this.tracked)) {
      if (now - ts > SOURCE_RETENTION_MS) {
        this.debug(`Forgetting ${sourceId}: no widget has shown it for ${SOURCE_RETENTION_MS / 86400000} days`);
        this.forgetSource(sourceId).catch((err) => this.error('Error forgetting source:', err.message));
      }
    }
  }

  /**
   * Persist today's totals and the tracked sources, but only what actually changed since the
   * last save: every write ends up in Homey's flash storage.
   */
  saveState() {
    try {
      // Drop ledger entries of released sources once their day is over.
      const today = this.ledger.today();
      for (const [sourceId, entry] of [...this.ledger.entries]) {
        if (!(sourceId in this.tracked) && entry.date !== today) this.ledger.remove(sourceId);
      }

      this.split.prune();
      for (const key of [...this.lastEmittedSplit.keys()]) {
        if (!this.split.entries.has(key)) this.lastEmittedSplit.delete(key);
      }

      const state = { ledger: this.ledger.toJSON(), trackedDevices: this.tracked, solarSplit: this.split.toJSON() };
      for (const [key, value] of Object.entries(state)) {
        const json = JSON.stringify(value);
        if (json === this.savedJson[key]) continue;
        this.homey.settings.set(key, value);
        this.savedJson[key] = json;
      }
    } catch (err) {
      this.error('Could not save state:', err.message);
    }
  }

}

module.exports = HousePulseApp;
