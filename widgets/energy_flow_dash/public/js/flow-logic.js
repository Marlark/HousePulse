/*
 * HousePulse – Energy Flow widget logic.
 *
 * Pure functions with no DOM access, shared by the widget (window.FlowLogic) and the tests
 * (require). Keep it free of browser- or Node-only APIs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlowLogic = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Roles with their own node in the flow. 'extra' is an optional big consumer (heat pump,
  // sauna, pool…) fed from Home, shown bottom right.
  const NODE_ROLES = ['grid', 'solar', 'ev', 'battery', 'extra'];
  // Widget settings that feed each role. 'car' and 'home' have no node of their own:
  // the car's SoC is shown on the EV charger, the home meter drives the centre node.
  const ROLE_SETTINGS = {
    grid: ['grid_device'],
    solar: ['solar_device', 'solar_device_2'],
    ev: ['ev_device', 'ev_device_2'],
    battery: ['battery_device', 'battery_device_2'],
    car: ['car_device'],
    home: ['home_device'],
    extra: ['extra_device'],
  };
  const ALL_ROLES = Object.keys(ROLE_SETTINGS);
  // Roles the app can suggest devices for. Home and the extra node are always the user's choice.
  const SUGGESTED_ROLES = ['grid', 'solar', 'ev', 'battery', 'car'];
  // "— None —" entry in the device pickers (see NONE_ID in app.js): means no device.
  const NONE_ID = '__none__';

  const IDLE_THRESHOLD_W = 10;
  const HOME_CALC_WARNING_W = -100;
  // "≈" is shown when an estimated (integrated) direction contributed at least this much.
  const APPROXIMATE_MIN_KWH = 0.005;

  const sum = (values) => values.reduce((a, b) => a + b, 0);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /* ---------------- Choosing sources ---------------- */

  function isSet(settings, key) {
    return Boolean(settings[key] && settings[key].id);
  }

  /**
   * Roles the user hasn't touched (no device and no "None" in any of the role's settings).
   * Those use the app's suggestions; every other role uses the settings as they are.
   */
  function autoRoles(settings) {
    return SUGGESTED_ROLES.filter((role) => !ROLE_SETTINGS[role].some((key) => isSet(settings, key)));
  }

  /**
   * Decide which sources each role shows.
   * @param {object} settings Widget settings ({ grid_device: { id, name }, ... })
   * @param {object|null} suggestion Result of GET /suggest ({ roles: { grid: [{ id, name }] } })
   * @returns {{ roles: Object<string, {id: string, name: ?string}[]>, autoUsedRoles: string[] }}
   */
  function pickSources(settings, suggestion) {
    const auto = autoRoles(settings);
    const roles = {};
    const autoUsedRoles = [];

    for (const role of ALL_ROLES) {
      const picked = auto.includes(role)
        ? ((suggestion && suggestion.roles && suggestion.roles[role]) || [])
        : ROLE_SETTINGS[role].map((key) => settings[key]);

      const seen = new Set();
      roles[role] = [];
      for (const item of picked) {
        const id = item && typeof item === 'object' ? item.id : null;
        if (!id || id === NONE_ID || seen.has(id)) continue;
        seen.add(id);
        roles[role].push({ id, name: item.name || null });
      }
      if (auto.includes(role) && roles[role].length) autoUsedRoles.push(role);
    }
    return { roles, autoUsedRoles };
  }

  /* ---------------- Per-role aggregation ---------------- */

  /** Normalised sign: grid +import/-export, battery +charging/-discharging, others positive. */
  function normalise(role, watts, invert = {}) {
    if (role === 'grid') return invert.grid ? -watts : watts;
    if (role === 'battery') return invert.battery ? -watts : watts;
    return Math.abs(watts);
  }

  /** A non-idle power value that hasn't been reported for longer than staleMs. */
  function isStale(source, now, staleMs) {
    return staleMs > 0
      && source.powerTs !== null && source.powerTs !== undefined
      && now - source.powerTs > staleMs
      && Math.abs(source.power) >= IDLE_THRESHOLD_W;
  }

  /**
   * Combine the sources of one role into what the widget shows.
   * @param {string} role
   * @param {object[]} list Source states ({ missing, available, hasPower, power, powerTs, hasSoc, soc, name })
   */
  function aggregateRole(role, list, { now, staleMs = 0, invert = {} } = {}) {
    const live = list.filter((s) => !s.missing && s.available);
    const powered = live.filter((s) => s.hasPower && s.power !== null);
    const fresh = powered.filter((s) => !isStale(s, now, staleMs));
    const stale = powered.filter((s) => isStale(s, now, staleMs));
    const socs = live.filter((s) => s.hasSoc && s.soc !== null).map((s) => s.soc);
    const allMissing = list.length > 0 && list.every((s) => s.missing);

    return {
      configured: list.length > 0,
      allMissing,
      allOffline: list.length > 0 && live.length === 0 && !allMissing,
      hasPower: list.some((s) => s.hasPower),
      power: fresh.length ? sum(fresh.map((s) => normalise(role, s.power, invert))) : null,
      // Only "stale" when nothing fresh is left to show.
      staleSince: fresh.length === 0 && stale.length ? Math.min(...stale.map((s) => s.powerTs)) : null,
      soc: socs.length ? sum(socs) / socs.length : null,
      names: list.map((s) => s.name).filter(Boolean),
    };
  }

  /**
   * Status text key for a node: notSet, missing, offline, lastSeen, idle, import, export,
   * producing, charging, discharging, consuming.
   */
  function statusKey(role, info, watts) {
    if (!info.configured) return 'notSet';
    if (info.allMissing) return 'missing';
    if (info.allOffline) return 'offline';
    if (info.staleSince !== null) return 'lastSeen';
    if (watts === null || Math.abs(watts) < IDLE_THRESHOLD_W) return 'idle';
    switch (role) {
      case 'grid': return watts > 0 ? 'import' : 'export';
      case 'solar': return 'producing';
      case 'ev': return 'charging';
      case 'battery': return watts > 0 ? 'charging' : 'discharging';
      case 'extra': return 'consuming';
      default: return 'idle';
    }
  }

  /** true = energy moving toward Home, false = away from Home, null = no flow. */
  function towardHome(role, watts) {
    if (watts === null || Math.abs(watts) < IDLE_THRESHOLD_W) return null;
    switch (role) {
      case 'grid': return watts > 0;
      case 'solar': return true;
      case 'battery': return watts < 0;
      case 'ev': return false;
      case 'extra': return false;
      default: return null;
    }
  }

  /** Today's kWh for a role as { in, out, approximate }, or null when there is no data yet. */
  function aggregateToday(role, list, invert = {}) {
    const withData = list.filter((s) => !s.missing && s.today);
    if (!withData.length) return null;
    const flip = (role === 'grid' && invert.grid) || (role === 'battery' && invert.battery);

    let inKwh = 0;
    let outKwh = 0;
    let approximate = false;
    for (const { today } of withData) {
      // Named kWh meters (imported/exported, charged/discharged) are right regardless of the
      // power sign. Only integrated directions follow the sign, so only those are flipped.
      // When one direction is a meter and the other integrated, the integrated one measured
      // the wrong direction and is unknown.
      const inMeter = today.inSource === 'meter';
      const outMeter = today.outSource === 'meter';
      const part = (meter, ownKwh, otherMeter, otherKwh) => {
        if (!flip || meter) return { kwh: ownKwh, integrated: !meter };
        if (otherMeter) return { kwh: 0, integrated: false };
        return { kwh: otherKwh, integrated: true };
      };
      const pin = part(inMeter, today.inKwh, outMeter, today.outKwh);
      const pout = part(outMeter, today.outKwh, inMeter, today.inKwh);
      inKwh += pin.kwh;
      outKwh += pout.kwh;
      if ((pin.integrated && pin.kwh >= APPROXIMATE_MIN_KWH)
        || (pout.integrated && pout.kwh >= APPROXIMATE_MIN_KWH)) approximate = true;
    }
    return { in: inKwh, out: outKwh, approximate };
  }

  /* ---------------- Home and self-sufficiency ---------------- */

  /**
   * Calculated home consumption in W (may be negative when a sign is wrong), or null
   * without a grid value. In: grid import + solar + battery discharge; out: battery charge + EV.
   */
  function calcHome(powers) {
    if (powers.grid === null || powers.grid === undefined) return null;
    return powers.grid + (powers.solar || 0) - (powers.battery || 0) - (powers.ev || 0);
  }

  /**
   * What the Home node shows when an extra consumer is shown separately: the rest of the house.
   * `total` is the whole home consumption (measured or calculated), which includes the extra
   * consumer, since it is fed from Home.
   */
  function homeRest(total, extraPower) {
    if (total === null || total === undefined) return null;
    return Math.max(0, total - Math.max(0, extraPower || 0));
  }

  /**
   * For a persistently negative calculated consumption: which single sign setting would make
   * it plausible? 'grid', 'battery' or 'unknown'.
   */
  function signHintKind(raw, powers) {
    const fixedByGrid = raw - 2 * powers.grid >= HOME_CALC_WARNING_W;
    const fixedByBattery = powers.battery !== null && powers.battery !== undefined
      && Math.abs(powers.battery) >= IDLE_THRESHOLD_W
      && raw + 2 * powers.battery >= HOME_CALC_WARNING_W;
    if (fixedByGrid && !fixedByBattery) return 'grid';
    if (fixedByBattery && !fixedByGrid) return 'battery';
    return 'unknown';
  }

  /** Share (0–1) of the current consumption not covered by grid import, or null. */
  function selfSufficiencyNow(powers, home) {
    if (powers.grid === null || powers.grid === undefined || home === null) return null;
    const consumption = home + (powers.ev || 0) + Math.max(0, powers.battery || 0);
    if (consumption < IDLE_THRESHOLD_W) return null;
    return clamp01(1 - Math.max(0, powers.grid) / consumption);
  }

  /** Share (0–1) of today's consumption not bought from the grid, or null. */
  function selfSufficiencyToday({ grid, solar, battery }) {
    if (!grid || !solar) return null;
    const consumption = grid.in + (solar.in + solar.out) - grid.out + (battery ? battery.out - battery.in : 0);
    if (consumption < 0.1) return null;
    return clamp01(1 - grid.in / consumption);
  }

  /**
   * Self-consumption: share (0–1) of the current solar production used in the house (home, EV,
   * battery) instead of being sold, or null without meaningful production.
   */
  function selfConsumptionNow(powers) {
    if (powers.grid === null || powers.grid === undefined) return null;
    const solar = powers.solar || 0;
    if (solar < IDLE_THRESHOLD_W) return null;
    return clamp01(1 - Math.max(0, -powers.grid) / solar);
  }

  /** Share (0–1) of today's solar production not sold to the grid, or null. */
  function selfConsumptionToday({ grid, solar }) {
    if (!grid || !solar) return null;
    const produced = solar.in + solar.out;
    if (produced < 0.1) return null;
    return clamp01(1 - grid.out / produced);
  }

  /* ---------------- Animation ---------------- */

  /** Seconds for one dot to cross a connector: faster for higher power. */
  function flowDuration(watts) {
    const kw = Math.min(Math.abs(watts) / 1000, 11);
    return Math.max(0.6, 2.8 - Math.log2(1 + kw) * 0.6);
  }

  /** Connector thickness in px: 2 px when idle-ish, up to 6 px around 7 kW and above. */
  function flowWeight(watts) {
    const kw = Math.abs(watts) / 1000;
    return 2 + Math.min(4, Math.log2(1 + kw) * 1.4);
  }

  return {
    NODE_ROLES,
    ROLE_SETTINGS,
    ALL_ROLES,
    SUGGESTED_ROLES,
    NONE_ID,
    IDLE_THRESHOLD_W,
    HOME_CALC_WARNING_W,
    toNumber,
    autoRoles,
    pickSources,
    normalise,
    isStale,
    aggregateRole,
    statusKey,
    towardHome,
    aggregateToday,
    calcHome,
    homeRest,
    signHintKind,
    selfSufficiencyNow,
    selfSufficiencyToday,
    selfConsumptionNow,
    selfConsumptionToday,
    flowDuration,
    flowWeight,
  };
}));
