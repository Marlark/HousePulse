'use strict';

/**
 * Widget backend API. Each exported function name matches a key in the widget's "api"
 * block in app.json, and is called from the widget frontend via Homey.api(method, path, body).
 *
 * The logic lives in app.js so device listeners can be shared between several widget
 * instances that show the same devices.
 */
module.exports = {

  // POST /subscribe  { instanceId, sourceIds, split } → { sources, split, debug, serverTime }
  // split: { grid, solar, ev, battery: [sourceId], invert: { grid, battery } } for "charged from solar"
  async subscribe({ homey, body }) {
    const { instanceId, sourceIds, split } = body || {};
    return homey.app.subscribeWidget({ instanceId, sourceIds, split });
  },

  // GET /suggest → { roles: { grid: [{ id, name }], solar: [...], ... } }
  async suggest({ homey }) {
    return homey.app.suggestSources();
  },

};
