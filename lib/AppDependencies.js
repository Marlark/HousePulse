'use strict';

/**
 * Waiting for other apps at startup.
 *
 * Homey starts all apps in parallel after a reboot, so the apps that own our energy devices
 * (inverter, meter, charger...) may still be starting when HousePulse starts. Until they run,
 * their devices report nothing or stale values. The user picks which apps to wait for; we poll
 * their state until all of them are "running".
 *
 * This never blocks onInit(): Homey treats an app whose onInit() takes too long as hung.
 * The app calls waitForApps() in the background and only starts listening when it resolves.
 */

const READY_STATE = 'running';

/** "homey:app:com.example.solar:inverter" → "com.example.solar" (null for other drivers). */
function appIdFromDriver(driverId) {
  if (typeof driverId !== 'string') return null;
  const match = /^homey:app:([^:]+):/.exec(driverId);
  return match ? match[1] : null;
}

/** Apps keyed by id, from homey-api's getApps() (an object keyed by id, or an array). */
function indexApps(apps) {
  const list = Array.isArray(apps) ? apps : Object.values(apps || {});
  return new Map(list.filter((app) => app && typeof app.id === 'string').map((app) => [app.id, app]));
}

/**
 * The chosen apps that are not running yet. Apps that are not installed or are disabled are
 * skipped: they will never start, and waiting for them would only delay us to the time limit.
 */
function pendingApps(apps, ids) {
  const byId = indexApps(apps);
  const pending = [];
  for (const id of ids) {
    const app = byId.get(id);
    if (!app || app.enabled === false) continue;
    if (app.state !== READY_STATE) pending.push({ id, name: app.name || id, state: app.state || 'unknown' });
  }
  return pending;
}

/** Clean list of app ids from storage or the settings page. */
function normaliseIds(ids, ownId) {
  if (!Array.isArray(ids)) return [];
  const clean = ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && id !== ownId);
  return [...new Set(clean)].slice(0, 50);
}

/**
 * Poll until all chosen apps run, or the time limit passes (then we start anyway: showing
 * something beats showing nothing).
 *
 * @param {object} opts
 * @param {string[]} opts.ids Apps to wait for.
 * @param {() => Promise<object>} opts.getApps homey-api apps.getApps().
 * @param {(ms: number) => Promise<void>} opts.sleep
 * @param {() => number} [opts.now]
 * @param {number} opts.intervalMs Time between checks.
 * @param {number} opts.maxWaitMs Give up after this long.
 * @param {(pending: object[]) => void} [opts.onPending] Called with the apps still not running.
 * @param {(err: Error) => void} [opts.onError] Called when the app list can't be read (retried).
 * @returns {Promise<{ waitedMs: number, timedOut: boolean, pending: object[] }>}
 */
async function waitForApps({
  ids, getApps, sleep, now = Date.now, intervalMs, maxWaitMs, onPending = () => {}, onError = () => {},
}) {
  const start = now();
  let pending = [];
  if (!ids.length) return { waitedMs: 0, timedOut: false, pending };

  for (;;) {
    let known = false;
    try {
      pending = pendingApps(await getApps(), ids);
      known = true;
    } catch (err) {
      // Homey's API may not answer yet this early in the boot: try again.
      onError(err);
    }
    if (known && pending.length === 0) return { waitedMs: now() - start, timedOut: false, pending };
    if (known) onPending(pending);
    if (now() - start >= maxWaitMs) return { waitedMs: now() - start, timedOut: true, pending };
    await sleep(intervalMs);
  }
}

module.exports = {
  appIdFromDriver, pendingApps, normaliseIds, waitForApps, READY_STATE,
};
