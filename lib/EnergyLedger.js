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

const DIRECTIONS = ['in', 'out'];

function emptyDirection() {
  // pending: set at midnight; the next reading turns it into an interpolated baseline.
  return {
    kwh: 0, baseline: null, last: null, lastTs: null, pending: null,
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
   * Reset today's totals when the date has changed. For meters, the reading at midnight is
   * estimated on the next reading by interpolating between the last reading before midnight
   * and the first one after. This stays correct when the app was off over midnight, instead of
   * counting the energy between shutdown and midnight as today's.
   */
  rollover(entry, now) {
    const date = this.today(now);
    if (entry.date === date) return;

    entry.date = date;
    const midnight = startOfDay(now, this.getTimezone());
    for (const dir of DIRECTIONS) {
      const d = entry[dir];
      d.kwh = 0;
      d.baseline = null;
      d.pending = null;
      if (!entry.meters[dir] || d.last === null) continue;
      if (typeof d.lastTs === 'number' && d.lastTs < midnight) {
        d.pending = { value: d.last, ts: d.lastTs, midnight };
      } else {
        // Data saved by an older version (no timestamp): best effort.
        d.baseline = d.last;
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
  }

  onMeter(deviceId, capabilityId, value, now = Date.now()) {
    const entry = this.entries.get(deviceId);
    if (!entry || typeof value !== 'number' || !Number.isFinite(value)) return;

    const dir = DIRECTIONS.find((key) => entry.meters[key] === capabilityId);
    if (!dir) return;

    this.rollover(entry, now);
    const d = entry[dir];

    if (d.pending && now > d.pending.ts && value >= d.pending.value) {
      // Estimate the meter reading at midnight (linear between the readings around it).
      const { value: before, ts, midnight } = d.pending;
      const fraction = Math.min(1, Math.max(0, (midnight - ts) / (now - ts)));
      d.baseline = before + (value - before) * fraction;
    }
    d.pending = null;

    // First reading ever, or the meter was reset: start counting from here.
    if (d.baseline === null || value < d.baseline) d.baseline = value;
    d.last = value;
    d.lastTs = now;
    d.kwh = value - d.baseline;
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
