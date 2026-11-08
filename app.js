'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const EnergyLedger = require('./lib/EnergyLedger');
const EnergyRoles = require('./lib/EnergyRoles');

const WIDGET_ID = 'energy_flow_dash';
const EVENTS = {
  value: 'energy_update', // { deviceId, capability, value, ts }
  status: 'energy_status', // { deviceId, available, missing }
  today: 'energy_today', // { sourceId, inKwh, outKwh, inSource, outSource, date }
};

const MAX_SOURCES_PER_INSTANCE = 12;
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
    }

    // Resume listening to sources from before the restart, without blocking startup.
    this.restoreSources().catch((err) => this.error('Could not restore listeners:', err.message));

    this.log('HousePulse initialized');
  }

  async onUninit() {
    this.homey.clearInterval(this.tickTimer);
    this.homey.clearInterval(this.saveTimer);
    if (this.debugTimer) this.homey.clearInterval(this.debugTimer);

    this.ledger.tick();
    this.saveState();
    for (const deviceId of [...this.watchers.keys()]) {
      await this.destroyWatcher(deviceId);
    }
    this.widgetInstances.clear();
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
    });
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
      && d.capabilities.some((cap) => /^(measure_power|meter_power|measure_battery)/.test(cap)));

    this.debug(`Inventory: ${relevant.length} energy-relevant device(s) of ${devices.length}`);
    for (const d of relevant) {
      const caps = d.capabilities.filter((cap) => /^(measure_power|meter_power|measure_battery)/.test(cap));
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

  async searchSources(query, role) {
    const api = await this.getApi();
    const [devices, zones] = await Promise.all([
      api.devices.getDevices(),
      api.zones.getZones(),
    ]);
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
    const api = await this.getApi();
    const devices = Object.values(await api.devices.getDevices());
    const suggestion = EnergyRoles.suggest(devices, await this.getLiveReport());
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
  async subscribeWidget({ instanceId, sourceIds }) {
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
    this.widgetInstances.set(instanceId, { sourceIds: wanted, lastSeen: now });
    for (const sourceId of wanted) this.tracked[sourceId] = now;

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
    return { sources: snapshot, debug: DEBUG_ENABLED, serverTime: Date.now() };
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
    for (const meter of [meters.in, meters.out]) {
      if (meter && values[meter]) this.ledger.onMeter(sourceId, meter, values[meter].value);
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

    if (DEBUG_ENABLED) {
      this.debugStats.realtimeEvents++;
      this.debug(`Update ${watcher.name} ${capabilityId} = ${value}`);
    }
    this.homey.api.realtime(EVENTS.value, {
      deviceId: watcher.deviceId,
      capability: capabilityId,
      value,
      ts: instance && instance.lastChanged ? instance.lastChanged.getTime() : now,
    });
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

  saveState() {
    try {
      // Drop ledger entries of released sources once their day is over.
      const today = this.ledger.today();
      for (const [sourceId, entry] of [...this.ledger.entries]) {
        if (!(sourceId in this.tracked) && entry.date !== today) this.ledger.remove(sourceId);
      }

      this.homey.settings.set('ledger', this.ledger.toJSON());
      this.homey.settings.set('trackedDevices', this.tracked);
    } catch (err) {
      this.error('Could not save state:', err.message);
    }
  }

}

module.exports = HousePulseApp;
