'use strict';

/**
 * App-level API, used by the app settings page (settings/index.html).
 * Function names match the keys in the "api" block of app.json.
 */
module.exports = {

  // GET /diagnostics?anonymize=1
  async getDiagnostics({ homey, query }) {
    return homey.app.buildDiagnostics({ anonymize: query && query.anonymize === '1' });
  },

  // GET /apps: installed apps, which ones to wait for at startup, and how the last start went
  async getApps({ homey }) {
    return homey.app.getAppsOverview();
  },

  // PUT /wait-for-apps { ids: string[] }
  async setWaitForApps({ homey, body }) {
    if (!body || !Array.isArray(body.ids)) throw new Error('ids must be an array');
    return { waitFor: homey.app.setWaitForApps(body.ids) };
  },

};
