'use strict';

/**
 * Widget backend API. Each exported function name matches a key in the widget's "api"
 * block in app.json, and is called from the widget frontend via Homey.api(method, path, body).
 *
 * The logic lives in app.js so device listeners can be shared between several widget
 * instances that show the same devices.
 */
module.exports = {

  // POST /subscribe  { instanceId, sourceIds } → { sources, debug, serverTime }
  async subscribe({ homey, body }) {
    const { instanceId, sourceIds } = body || {};
    return homey.app.subscribeWidget({ instanceId, sourceIds });
  },

  // GET /suggest → { roles: { grid: [{ id, name }], solar: [...], ... } }
  async suggest({ homey }) {
    return homey.app.suggestSources();
  },

};
