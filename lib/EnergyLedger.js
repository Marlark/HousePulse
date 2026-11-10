'use strict';

/**
 * Tracks today's energy (kWh) per device, in two directions:
 *   in  = energy while measure_power is positive (grid import, solar production,
 *         EV charging, battery charging)
 *   out = energy while measure_power is negative (grid export, battery discharging)
 *
 * For each direction the ledger prefers a cumulative meter capability (accurate, and it
 * survives app restarts because the midnight baseline is persisted). Without one it
 * integrates measure_power over time, holding the last value between reports.
 */

// First match wins. Totals in kWh, increasing over time.
const IN_METERS = ['meter_power.imported', 'meter_power.import', 'meter_power.charged', 'meter_power'];
const OUT_METERS = ['meter_power.exported', 'meter_power.export', 'meter_power.discharged', 'meter_power.returned'];

// Gaps longer than this (e.g. app restart, device silent) are not integrated: we can't
// know what happened in between.
const MAX_INTEGRATION_GAP_MS = 10 * 60 * 1000;

// Meter sanity limits. Meters only count up, but integrations sometimes report a slightly
// lower value (rounding, two registers with different precision) or a bogus one (0 after a
// failed read). Such readings must never wipe or inflate today's total.
// - A drop smaller than this is noise: the reading is ignored.
const METER_NOISE_KWH = 1;
// - An increase faster than this is impossible for a home (and the jump back after a bogus
//   reading): it is not counted. kW, plus a fixed allowance for meters that report rarely.
const METER_MAX_KW = 250;
const METER_MAX_JUMP_SLACK_KWH = 1;

const DIRECTIONS = ['in', 'out'];

function emptyDirection() {
  // last/lastTs: the previous meter reading. pending: set at midnight, so the next reading
  // only counts the part of its increase that falls after midnight.
  return {
    kwh: 0, last: null, lastTs: null, pending: null,
  };
}

/** Timestamp of the most recent local midnight in the given timezone. */
function startOfDay(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return now - ((get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000 + (now % 1000));
  } catch (err) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}

class EnergyLedger {

  /**
   * @param {object} opts
   * @param {() => string} opts.getTimezone IANA timezone used to decide when "today" starts.
   * @param {object} [opts.data] Previously persisted state from toJSON().
   */
  constructor({ getTimezone, data }) {
    this.getTimezone = getTimezone;
    this.entries = new Map();

    if (data && typeof data === 'object') {
      for (const [deviceId, entry] of Object.entries(data)) {
        if (entry && entry.date && entry.in && entry.out) {
          // Held power is not restored: the gap since shutdown is unknown.
          this.entries.set(deviceId, { ...entry, power: { value: null, ts: null } });
        }
      }
    }
  }

  static pickMeters(capabilities = []) {
    return {
      in: IN_METERS.find((cap) => capabilities.includes(cap)) || null,
      out: OUT_METERS.find((cap) => capabilities.includes(cap)) || null,
    };
  }

  /** Local calendar date (YYYY-MM-DD) in Homey's timezone. */
  today(now = Date.now()) {
    try {
      return new Date(now).toLocaleDateString('sv-SE', { timeZone: this.getTimezone() });
    } catch (err) {
      return new Date(now).toISOString().slice(0, 10);
    }
  }

  /** Create or update the entry for a device. Resets a direction if its meter changed. */
  configure(deviceId, meters) {
    let entry = this.entries.get(deviceId);
    if (!entry) {
      entry = {
        date: this.today(),
        meters: { in: null, out: null },
        in: emptyDirection(),
        out: emptyDirection(),
        power: { value: null, ts: null },
      };
      this.entries.set(deviceId, entry);
    }
    for (const dir of DIRECTIONS) {
      if (entry.meters[dir] !== meters[dir]) {
        entry.meters[dir] = meters[dir];
        entry[dir] = emptyDirection();
      }
    }
    return entry;
  }

  remove(deviceId) {
    this.entries.delete(deviceId);
  }

  /**
   * Reset today's totals when the date has changed. For meters, the increase between the last
   * reading before midnight and the first one after is split linearly at midnight. This stays
   * correct when the app was off over midnight, instead of counting the energy between
   * shutdown and midnight as today's.
   */
  rollover(entry, now) {
    const date = this.today(now);
    if (entry.date === date) return;

    entry.date = date;
    const midnight = startOfDay(now, this.getTimezone());
    for (const dir of DIRECTIONS) {
      const d = entry[dir];
      d.kwh = 0;
      d.pending = null;
      // Without a timestamp (data saved by an older version) the next increase counts fully.
      if (entry.meters[dir] && typeof d.lastTs === 'number' && d.lastTs < midnight) {
        d.pending = { midnight };
      }
    }
  }

  /** Add the held power since its timestamp to the integrated direction(s). */
  integrate(entry, now) {
    const { value, ts } = entry.power;
    entry.power.ts = now;
    if (value === null || ts === null) return;

    const dt = now - ts;
    if (dt <= 0 || dt > MAX_INTEGRATION_GAP_MS) return;

    const kwh = (Math.abs(value) * dt) / 3.6e9; // W·ms → kWh
    const dir = value >= 0 ? 'in' : 'out';
    if (!entry.meters[dir]) entry[dir].kwh += kwh;
  }

  onPower(deviceId, value, now = Date.now()) {
    const entry = this.entries.get(deviceId);
    if (!entry || typeof value !== 'number' || !Number.isFinite(value)) return;

    this.rollover(entry, now);
    this.integrate(entry, now);
    entry.power.value = value;
    entry.power.reportedAt = now;
  }

  /** Last reported power of a source: { value, ts } or null. */
  getPower(deviceId) {
    const entry = this.entries.get(deviceId);
    if (!entry || entry.power.value === null) return null;
    return { value: entry.power.value, ts: entry.power.reportedAt ?? null };
  }

  /**
   * A meter reading. `now` decides which day it is; `at` is when the device measured the value
   * (defaults to now). They differ when seeding from a stored value that may be hours old.
   */
  onMeter(deviceId, capabilityId, value, now = Date.now(), at = now) {
    const entry = this.entries.get(deviceId);
    if (!entry || typeof value !== 'number' || !Number.isFinite(value)) return;

    const dir = DIRECTIONS.find((key) => entry.meters[key] === capabilityId);
    if (!dir) return;

    this.rollover(entry, now);
    const d = entry[dir];
    const hasTs = typeof d.lastTs === 'number';
    if (hasTs && at < d.lastTs) return; // older than what we already have

    const accept = () => {
      d.last = value;
      d.lastTs = at;
      // A reading from before midnight (e.g. a stored value) leaves the midnight split for later.
      if (d.pending && at >= d.pending.midnight) d.pending = null;
    };

    // First reading ever: today's total counts from here.
    if (d.last === null) return accept();

    const delta = value - d.last;
    if (delta < 0) {
      // Small drop: noise, keep the higher reading. Big drop: the meter was reset or replaced
      // (or sent a bogus value): continue from the new reading, today's total is kept.
      if (-delta >= METER_NOISE_KWH) accept();
      return undefined;
    }

    const elapsed = hasTs ? at - d.lastTs : null;
    const maxDelta = elapsed !== null ? (METER_MAX_KW * elapsed) / 3.6e6 + METER_MAX_JUMP_SLACK_KWH : Infinity;
    if (delta <= maxDelta) {
      // At midnight, only the part of the increase after midnight belongs to today.
      const fraction = d.pending && elapsed > 0
        ? Math.min(1, Math.max(0, (at - d.pending.midnight) / elapsed))
        : 1;
      d.kwh += delta * fraction;
    }
    return accept();
  }

  /** Periodic update: roll over at midnight and integrate held power up to now. */
  tick(now = Date.now()) {
    for (const entry of this.entries.values()) {
      this.rollover(entry, now);
      this.integrate(entry, now);
    }
  }

  get(deviceId) {
    const entry = this.entries.get(deviceId);
    if (!entry) return null;
    return {
      date: entry.date,
      inKwh: entry.in.kwh,
      outKwh: entry.out.kwh,
      inSource: entry.meters.in ? 'meter' : 'integrated',
      outSource: entry.meters.out ? 'meter' : 'integrated',
    };
  }

  toJSON() {
    const out = {};
    for (const [deviceId, entry] of this.entries) {
      out[deviceId] = {
        date: entry.date, meters: entry.meters, in: entry.in, out: entry.out,
      };
    }
    return out;
  }

}

module.exports = EnergyLedger;
