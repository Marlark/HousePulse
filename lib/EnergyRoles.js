'use strict';

/**
 * Brand-independent knowledge about energy devices, based on what Homey standardises:
 *   - device.energyObj: set by drivers following Homey's Energy guidelines
 *       cumulative + cumulativeImported/ExportedCapability  → whole-home (grid) meter
 *       generator                                          → solar / generation
 *       homeBattery                                        → home battery
 *       evCharger                                          → EV charger
 *       electricCar                                        → electric car
 *       meterPowerImported/ExportedCapability               → kWh meters for the device
 *   - device.class / device.virtualClass
 *   - standard capabilities (measure_power, measure_battery, meter_power.*) and their
 *     sub-capabilities (measure_power.solar etc.) for hybrid inverters/dongles that report
 *     several flows in one device.
 *
 * A "source" is what a widget setting points at:
 *   "<deviceId>"                 → the device's main values (measure_power and/or measure_battery)
 *   "<deviceId>|<capabilityId>"  → exactly that one capability (a power sub-capability, or SoC)
 */

const EnergyLedger = require('./EnergyLedger');

const SOURCE_SEPARATOR = '|';
const POWER_CAP = /^measure_power(\.|$)/;
const SOC_CAP = 'measure_battery';

// Roles that show power, and roles that show state of charge.
const POWER_ROLES = ['grid', 'solar', 'ev', 'battery', 'home', 'extra'];
const SOC_ROLES = ['battery', 'car'];

// Name hints for power sub-capabilities, used to rank/suggest them (e.g. measure_power.solar,
// measure_power.grid_active_power, measure_power.battery / .batt_charge).
const SUBCAP_HINTS = {
  solar: /solar|pv|generat|production/i,
  grid: /grid|meter|net/i,
  battery: /batt/i,
  ev: /charg|ev/i,
  home: /house|home|consum|load/i,
};

// Device classes that are never the whole-home meter, even if marked cumulative.
const NOT_GRID_CLASSES = ['socket', 'light', 'heater', 'thermostat', 'airconditioning', 'fan',
  'kettle', 'coffeemachine', 'washer', 'dryer', 'dishwasher', 'oven', 'fridge', 'tv', 'amplifier'];

// Big consumers listed first in the picker for the extra node.
const EXTRA_CLASSES = ['heatpump', 'boiler', 'heater', 'airconditioning'];

const MAX_PER_ROLE = { grid: 1, solar: 2, ev: 2, battery: 2, car: 1, home: 1 };

function energy(device) {
  return device.energyObj || device.energy || {};
}

function caps(device) {
  return Array.isArray(device.capabilities) ? device.capabilities : [];
}

function powerCaps(device) {
  // Main measure_power first, then sub-capabilities.
  return caps(device).filter((cap) => POWER_CAP.test(cap))
    .sort((a, b) => (a === 'measure_power' ? -1 : b === 'measure_power' ? 1 : a.localeCompare(b)));
}

function isClass(device, cls) {
  return device.class === cls || device.virtualClass === cls;
}

/** How likely a whole device is to fill a role (0 = no hint). */
function deviceRoleScore(device, role) {
  const e = energy(device);
  switch (role) {
    case 'grid':
      if (e.cumulative) return e.cumulativeExportedCapability ? 3 : 2;
      return caps(device).some((cap) => /^meter_power\.(imported|exported)$/.test(cap)) ? 1 : 0;
    case 'solar': return e.generator || isClass(device, 'solarpanel') ? 3 : 0;
    case 'battery': return e.homeBattery || isClass(device, 'battery') ? 3 : 0;
    case 'ev': return e.evCharger || isClass(device, 'evcharger') ? 3 : 0;
    case 'car': return e.electricCar || isClass(device, 'car') ? 3 : 0;
    // The extra node is for a big consumer: list heating devices first.
    case 'extra': return EXTRA_CLASSES.some((cls) => isClass(device, cls)) ? 2 : 0;
    default: return 0;
  }
}

function parseSourceId(sourceId) {
  const [deviceId, capabilityId = null] = String(sourceId).split(SOURCE_SEPARATOR);
  return { deviceId, capabilityId };
}

function makeSourceId(deviceId, capabilityId = null) {
  return capabilityId ? `${deviceId}${SOURCE_SEPARATOR}${capabilityId}` : deviceId;
}

/** Which capabilities a source reads, given the device. */
function resolveSource(device, capabilityId) {
  const all = caps(device);
  if (capabilityId) {
    if (!all.includes(capabilityId)) return { power: null, soc: null };
    if (capabilityId === SOC_CAP) return { power: null, soc: SOC_CAP };
    return { power: POWER_CAP.test(capabilityId) ? capabilityId : null, soc: null };
  }
  return {
    power: all.includes('measure_power') ? 'measure_power' : null,
    soc: all.includes(SOC_CAP) ? SOC_CAP : null,
  };
}

/**
 * kWh meters for a source, as { in, out } where "in" is the direction of positive power.
 * Uses Homey's energy metadata first, then common capability names. Only the device's main
 * measure_power has matching meters; sub-capabilities are integrated by the ledger instead.
 */
function pickMeters(device, powerCap) {
  if (powerCap !== 'measure_power') return { in: null, out: null };

  const all = caps(device);
  const has = (cap) => (cap && all.includes(cap) ? cap : null);
  const e = energy(device);
  let meters = { in: null, out: null };

  if (e.cumulative) {
    meters = { in: has(e.cumulativeImportedCapability), out: has(e.cumulativeExportedCapability) };
  } else if (e.generator) {
    // For generators Homey calls production "exported"; production is positive power here.
    meters = { in: has(e.meterPowerExportedCapability) || has(e.meterPowerImportedCapability), out: null };
  } else {
    meters = { in: has(e.meterPowerImportedCapability), out: has(e.meterPowerExportedCapability) };
  }

  if (!meters.in && !meters.out) meters = EnergyLedger.pickMeters(all);
  return meters;
}

function capabilityTitle(device, cap) {
  const obj = device.capabilitiesObj && device.capabilitiesObj[cap];
  return (obj && obj.title) || cap;
}

/**
 * Picker entries for a role. Each device gets a main entry, plus one entry per power
 * sub-capability, plus (for batteries) a "state of charge only" entry when the device has both.
 */
function pickerEntries(device, role, { zoneName, socOnlyLabel }) {
  const entries = [];
  const pCaps = powerCaps(device);
  const hasSoc = caps(device).includes(SOC_CAP);
  const wantsPower = POWER_ROLES.includes(role);
  const wantsSoc = SOC_ROLES.includes(role);
  const score = deviceRoleScore(device, role);

  const relevant = (wantsPower && pCaps.length) || (wantsSoc && hasSoc);
  if (!relevant) return entries;

  const units = [];
  if (pCaps.includes('measure_power')) units.push('W');
  if (hasSoc) units.push('%');
  if (pickMeters(device, 'measure_power').in) units.push('kWh');

  const mainUsable = (wantsPower && pCaps.includes('measure_power')) || (wantsSoc && hasSoc);
  if (mainUsable) {
    entries.push({
      id: makeSourceId(device.id),
      name: device.name,
      description: [zoneName, units.join(' · ')].filter(Boolean).join(' — '),
      score: score * 10,
    });
  }

  if (wantsPower) {
    for (const cap of pCaps.filter((c) => c !== 'measure_power')) {
      const hint = SUBCAP_HINTS[role] && SUBCAP_HINTS[role].test(cap) ? 5 : 0;
      entries.push({
        id: makeSourceId(device.id, cap),
        name: `${device.name} – ${capabilityTitle(device, cap)}`,
        description: [zoneName, cap].filter(Boolean).join(' — '),
        score: score * 10 + hint - 1,
      });
    }
  }

  if (role === 'battery' && hasSoc && pCaps.length) {
    entries.push({
      id: makeSourceId(device.id, SOC_CAP),
      name: `${device.name} – ${socOnlyLabel}`,
      description: [zoneName, SOC_CAP].filter(Boolean).join(' — '),
      score: score * 10 - 2,
    });
  }

  return entries;
}

/**
 * Suggest sources per role for a widget with no configuration.
 * @param {object[]} devices
 * @param {object|null} liveReport Homey's live energy report (to identify the main meter).
 * @returns {Object<string, {id: string, name: string}[]>}
 */
function suggest(devices, liveReport) {
  const result = {};
  const pick = (role, list) => {
    result[role] = list.slice(0, MAX_PER_ROLE[role]).map(({ id, name }) => ({ id, name }));
  };
  const byScore = (role) => devices
    .map((device) => ({ device, score: deviceRoleScore(device, role) }))
    .filter((x) => x.score >= 3)
    .map((x) => x.device);
  const watts = (device) => {
    const v = device.capabilitiesObj && device.capabilitiesObj.measure_power
      && device.capabilitiesObj.measure_power.value;
    return typeof v === 'number' ? v : null;
  };

  // Grid: whole-home meters. Per-circuit meters (e.g. clamp meters) are sometimes marked
  // cumulative too, so: 1) the meter matching Homey's own grid figure, 2) otherwise rank by
  // how "grid-like" the meter is, 3) then by largest load.
  const meters = devices.filter((d) => energy(d).cumulative
    && caps(d).includes('measure_power')
    && !NOT_GRID_CLASSES.some((cls) => isClass(d, cls)));
  const homeyGrid = liveReport && liveReport.totalCumulative ? liveReport.totalCumulative.W : null;
  const matchesHomey = (d) => typeof homeyGrid === 'number' && watts(d) !== null
    && Math.abs(watts(d) - homeyGrid) <= Math.max(50, Math.abs(homeyGrid) * 0.05);
  const gridLikeness = (d) => {
    const e = energy(d);
    let score = 0;
    if (/export/i.test(e.cumulativeExportedCapability || '')) score += 2; // vs. "returned" on circuit meters
    if (/import/i.test(e.cumulativeImportedCapability || '')) score += 1;
    return score;
  };
  meters.sort((a, b) => (Number(matchesHomey(b)) - Number(matchesHomey(a)))
    || (gridLikeness(b) - gridLikeness(a))
    || (Math.abs(watts(b) ?? 0) - Math.abs(watts(a) ?? 0)));
  pick('grid', meters.map((d) => ({ id: d.id, name: d.name })));

  for (const role of ['solar', 'battery', 'ev', 'car']) {
    pick(role, byScore(role).map((d) => ({ id: d.id, name: d.name })));
  }

  // Hybrid inverters/dongles: fall back to a matching power sub-capability.
  for (const role of ['grid', 'solar', 'battery']) {
    if (result[role].length) continue;
    for (const device of devices) {
      const cap = powerCaps(device).find((c) => c !== 'measure_power' && SUBCAP_HINTS[role].test(c));
      if (cap) {
        pick(role, [{ id: makeSourceId(device.id, cap), name: `${device.name} – ${capabilityTitle(device, cap)}` }]);
        break;
      }
    }
  }

  result.home = [];
  return result;
}

module.exports = {
  SOC_CAP,
  parseSourceId,
  makeSourceId,
  resolveSource,
  pickMeters,
  pickerEntries,
  suggest,
};
