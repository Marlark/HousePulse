'use strict';

/**
 * "Charged from solar": how much of today's EV charging and home battery charging came from
 * the solar panels.
 *
 * At every moment the energy flowing into the house comes from three supplies: solar
 * production, grid import and battery discharge. Each consumer gets the same mix
 * (proportional split), so the solar share of the EV and the battery charging right now is
 *
 *   solar ÷ (solar + grid import + battery discharge)
 *
 * When the house exports, all charging is solar. Battery discharge counts as "not solar",
 * even though the battery may have been charged from solar earlier, so the figure is a lower
 * bound for an EV charged from a home battery.
 *
 * One entry per role configuration (which sources are grid, solar, EV and battery, plus the
 * sign settings), shared by widgets with the same devices. The app keeps integrating while no
 * dashboard is open, like the kWh totals.
 */

const SPLIT_ROLES = ['grid', 'solar', 'ev', 'battery'];

// Gaps longer than this are not integrated (app restart, devices silent).
const MAX_INTEGRATION_GAP_MS = 10 * 60 * 1000;
// A source that hasn't reported for this long is ignored (its last value is unreliable).
// Generous, because many devices only report when the value changes.
const MAX_POWER_AGE_MS = 30 * 60 * 1000;
// Configurations no widget has shown for this long are dropped.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_SOURCES_PER_ROLE = 8;

function emptyTotals() {
  return {
    evKwh: 0, evSolarKwh: 0, batteryKwh: 0, batterySolarKwh: 0,
  };
}

/**
 * Validated, canonical configuration, or null when there is nothing to split: needs grid,
 * solar, and at least one of EV and battery.
 */
function normaliseConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const config = { invert: { grid: false, battery: false } };
  for (const role of SPLIT_ROLES) {
    const ids = Array.isArray(raw[role]) ? raw[role] : [];
    config[role] = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 256))]
      .sort()
      .slice(0, MAX_SOURCES_PER_ROLE);
  }
  if (raw.invert && typeof raw.invert === 'object') {
    config.invert.grid = raw.invert.grid === true;
    config.invert.battery = raw.invert.battery === true;
  }
  if (!config.grid.length || !config.solar.length || (!config.ev.length && !config.battery.length)) return null;
  return config;
}

function configKey(config) {
  return JSON.stringify(config);
}

/**
 * Current role powers in W, normalised like the widget: grid > 0 import, battery > 0
 * charging, solar and EV positive. Returns null when the grid power is unknown.
 * `getPower(sourceId)` → { value, ts } (ts = when it was reported) or null.
 */
function rolePowers(config, getPower, now) {
  const powers = {};
  for (const role of SPLIT_ROLES) {
    let total = null;
    for (const id of config[role]) {
      const p = getPower(id);
      if (!p || typeof p.value !== 'number' || !Number.isFinite(p.value)) continue;
      if (typeof p.ts === 'number' && now - p.ts > MAX_POWER_AGE_MS) continue;
      let w = p.value;
      if (role === 'grid' && config.invert.grid) w = -w;
      else if (role === 'battery' && config.invert.battery) w = -w;
      else if (role === 'solar' || role === 'ev') w = Math.abs(w);
      total = (total || 0) + w;
    }
    powers[role] = total;
  }
  return powers.grid === null ? null : powers;
}

/** Solar share (0–1) of what flows into the house right now. */
function solarFraction({ grid, solar, battery }) {
  const sun = Math.max(0, solar || 0);
  const supply = sun + Math.max(0, grid || 0) + Math.max(0, -(battery || 0));
  return supply > 0 ? sun / supply : 0;
}

class SolarSplit {

  /**
   * @param {object} opts
   * @param {(now: number) => string} opts.today Local date (YYYY-MM-DD) for a timestamp.
   * @param {object} [opts.data] Persisted state from toJSON().
   */
  constructor({ today, data }) {
    this.today = today;
    // key -> { config, date, seenAt, totals, state: { ev, battery, fraction, ts } | null }
    this.entries = new Map();
    if (data && typeof data === 'object') {
      for (const [key, saved] of Object.entries(data)) {
        const config = normaliseConfig(saved && saved.config);
        if (!config || configKey(config) !== key) continue;
        this.entries.set(key, {
          config,
          date: typeof saved.date === 'string' ? saved.date : null,
          seenAt: Number.isFinite(saved.seenAt) ? saved.seenAt : 0,
          totals: { ...emptyTotals(), ...(saved.totals || {}) },
          state: null,
        });
      }
    }
  }

  /** Register a widget's roles. Returns the entry key, or null when there is nothing to split. */
  configure(rawConfig, now = Date.now()) {
    const config = normaliseConfig(rawConfig);
    if (!config) return null;
    const key = configKey(config);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        config, date: this.today(now), seenAt: now, totals: emptyTotals(), state: null,
      };
      this.entries.set(key, entry);
    }
    entry.seenAt = now;
    return key;
  }

  /** All source ids used by any configuration. */
  sourceIds() {
    const ids = new Set();
    for (const { config } of this.entries.values()) {
      for (const role of SPLIT_ROLES) config[role].forEach((id) => ids.add(id));
    }
    return ids;
  }

  /**
   * Integrate the previous powers up to now, then take the current ones. Call it whenever a
   * power value changes and periodically. Returns the keys whose day rolled over.
   */
  update(getPower, now = Date.now()) {
    const date = this.today(now);
    for (const entry of this.entries.values()) {
      if (entry.date !== date) {
        entry.date = date;
        entry.totals = emptyTotals();
      }

      const s = entry.state;
      if (s) {
        const dt = now - s.ts;
        if (dt > 0 && dt <= MAX_INTEGRATION_GAP_MS) {
          const toKwh = (w) => (w * dt) / 3.6e9; // W·ms → kWh
          entry.totals.evKwh += toKwh(s.ev);
          entry.totals.evSolarKwh += toKwh(s.ev * s.fraction);
          entry.totals.batteryKwh += toKwh(s.battery);
          entry.totals.batterySolarKwh += toKwh(s.battery * s.fraction);
        }
      }

      const powers = rolePowers(entry.config, getPower, now);
      entry.state = powers ? {
        ev: Math.max(0, powers.ev || 0),
        battery: Math.max(0, powers.battery || 0),
        fraction: solarFraction(powers),
        ts: now,
      } : null;
    }
  }

  /** Today's totals for a key: { date, evKwh, evSolarKwh, batteryKwh, batterySolarKwh } or null. */
  get(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.date !== this.today(now)) return { date: this.today(now), ...emptyTotals() };
    return { date: entry.date, ...entry.totals };
  }

  /** Drop configurations no widget has shown for a week. */
  prune(now = Date.now()) {
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.seenAt > RETENTION_MS) this.entries.delete(key);
    }
  }

  toJSON() {
    const out = {};
    for (const [key, entry] of this.entries) {
      // Hour precision for seenAt: plenty for the retention, and fewer storage writes.
      out[key] = {
        config: entry.config,
        date: entry.date,
        seenAt: Math.floor(entry.seenAt / 3600000) * 3600000,
        totals: entry.totals,
      };
    }
    return out;
  }

}

module.exports = SolarSplit;
module.exports.normaliseConfig = normaliseConfig;
module.exports.solarFraction = solarFraction;
module.exports.MAX_POWER_AGE_MS = MAX_POWER_AGE_MS;
