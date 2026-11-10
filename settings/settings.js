/*
 * HousePulse – app settings page: apps to wait for at startup, and diagnostics.
 *
 * Shared by settings/index.html (window.HousePulseSettings) and the tests (require).
 * Everything that touches the page goes through the `doc` / `win` arguments so it can be
 * tested without a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HousePulseSettings = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  /**
   * Homey's own settings stylesheet has no dark mode, so the page follows the device:
   * an explicit ?theme= parameter or a dark-mode class if Homey ever provides one,
   * otherwise prefers-color-scheme (what the Homey app's web view reports).
   */
  function detectTheme(win, doc) {
    let param = null;
    try {
      param = new URLSearchParams((win.location && win.location.search) || '').get('theme');
    } catch (err) { /* ignore */ }
    if (param === 'dark' || param === 'light') return param;

    const cls = doc.documentElement && doc.documentElement.classList;
    if (cls && (cls.contains('homey-dark-mode') || cls.contains('dark'))) return 'dark';
    if (win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  }

  /** Set data-theme on <html> now, and follow later changes of the device setting. */
  function applyTheme(win, doc) {
    const apply = () => doc.documentElement.setAttribute('data-theme', detectTheme(win, doc));
    apply();
    if (win.matchMedia) {
      const query = win.matchMedia('(prefers-color-scheme: dark)');
      if (query && typeof query.addEventListener === 'function') query.addEventListener('change', apply);
    }
  }

  /**
   * Split the apps into what the settings page shows:
   *   main:   apps with devices in a widget, and apps already chosen (never hidden)
   *   energy: other apps owning devices with power, energy or battery level (behind "show more")
   *   other:  everything else (behind "show all", with search)
   * Each group keeps the order the app sent (widget apps first, then by name).
   */
  function groupApps(apps, waitFor) {
    const chosen = new Set(waitFor);
    const groups = { main: [], energy: [], other: [] };
    for (const app of apps) {
      if (app.usedByWidget || chosen.has(app.id)) groups.main.push(app);
      else if (app.hasEnergyDevices) groups.energy.push(app);
      else groups.other.push(app);
    }
    return groups;
  }

  /** "Last start" line for the wait-for-apps section. */
  function startupText(startup, tr) {
    if (!startup) return '';
    const names = (list) => (list || []).map((app) => app.name).join(', ');
    const seconds = String(Math.round((startup.waitedMs || 0) / 1000));
    if (startup.state === 'ready' && !(startup.waitedFor || []).length) return tr('settings.lastNoWait');
    if (startup.state !== 'ready') return tr('settings.lastWaiting').replace('{apps}', names(startup.pending) || '…');
    if (startup.timedOut) {
      return tr('settings.lastTimedOut').replace('{s}', seconds).replace('{apps}', names(startup.pending));
    }
    return tr('settings.lastWaited').replace('{s}', seconds);
  }

  function init(Homey, doc, win) {
    const $ = (id) => doc.getElementById(id);
    const tr = (key) => Homey.__(key) || key;

    for (const el of doc.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);

    /* ---------- Apps to wait for at startup ---------- */

    let boxes = []; // { box, app, label } for every rendered app

    function checkedIds() {
      return boxes.filter(({ box }) => box.checked).map(({ box }) => box.value);
    }

    /** "Choose the widget's apps" only makes sense while one of them is not ticked yet. */
    function updatePickButton() {
      const widgetBoxes = boxes.filter(({ app }) => app.usedByWidget);
      $('pick-widget-apps').hidden = widgetBoxes.length === 0;
      $('pick-widget-apps').disabled = widgetBoxes.every(({ box }) => box.checked);
    }

    function saveApps() {
      updatePickButton();
      Homey.api('PUT', '/wait-for-apps', { ids: checkedIds() }, (err) => {
        $('wait-message').textContent = err ? `${tr('settings.waitError')}: ${err.message || err}` : tr('settings.waitSaved');
      });
    }

    function pickWidgetApps() {
      for (const { box, app } of boxes) if (app.usedByWidget) box.checked = true;
      saveApps();
    }

    function appRow(app, chosen, group) {
      const label = doc.createElement('label');
      label.className = 'homey-form-checkbox app';
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.className = 'homey-form-checkbox-input';
      box.value = app.id;
      box.checked = chosen.has(app.id);
      box.addEventListener('change', saveApps);
      const mark = doc.createElement('span');
      mark.className = 'homey-form-checkbox-checkmark';
      const text = doc.createElement('span');
      text.className = 'homey-form-checkbox-text';
      text.textContent = app.name;
      const meta = doc.createElement('span');
      meta.className = 'app__meta';
      const state = app.enabled ? tr(`settings.state_${app.state}`) : tr('settings.disabled');
      meta.textContent = [state, app.usedByWidget ? tr('settings.waitUsed') : null].filter(Boolean).join(' · ');
      if (app.usedByWidget) meta.classList.add('app__meta--used');
      text.appendChild(meta);
      label.append(box, mark, text);
      boxes.push({
        box, app, label, group,
      });
      return label;
    }

    /** A "show more" button that reveals its section once. Hidden when the section is empty. */
    function setupMore(buttonId, sectionId, textKey, count) {
      const button = $(buttonId);
      button.hidden = count === 0;
      button.textContent = tr(textKey).replace('{n}', String(count));
      $(sectionId).hidden = true;
      button.onclick = () => {
        $(sectionId).hidden = false;
        button.hidden = true;
      };
    }

    /** Search among "all other apps", by name or id. */
    function filterAll() {
      const query = $('app-search').value.trim().toLowerCase();
      let shown = 0;
      for (const { app, label, group } of boxes) {
        if (group !== 'other') continue;
        const match = !query || app.name.toLowerCase().includes(query) || app.id.toLowerCase().includes(query);
        label.hidden = !match;
        if (match) shown++;
      }
      $('app-search-empty').hidden = shown > 0;
    }

    function renderApps({ apps = [], waitFor = [], startup = null } = {}) {
      $('wait-status').textContent = startupText(startup, tr);
      boxes = [];
      const groups = groupApps(apps, waitFor);
      const chosen = new Set(waitFor);
      for (const [group, listId] of [['main', 'apps'], ['energy', 'apps-energy'], ['other', 'apps-all']]) {
        const list = $(listId);
        list.textContent = '';
        for (const app of groups[group]) list.appendChild(appRow(app, chosen, group));
      }
      setupMore('more-energy', 'apps-energy', 'settings.moreEnergy', groups.energy.length);
      setupMore('more-all', 'apps-all-section', 'settings.moreAll', groups.other.length);
      $('app-search').value = '';
      $('app-search-empty').hidden = true;
      updatePickButton();
      $('wait-message').textContent = apps.length ? '' : tr('settings.waitNone');
    }

    function loadApps() {
      $('wait-message').textContent = tr('settings.waitLoading');
      Homey.api('GET', '/apps', null, (err, result) => {
        if (err) {
          $('wait-message').textContent = `${tr('settings.waitError')}: ${err.message || err}`;
          return;
        }
        renderApps(result);
      });
    }

    /* ---------- Diagnostics ---------- */

    function load() {
      $('status').textContent = tr('settings.loading');
      const anonymize = $('anonymize').checked ? '1' : '0';
      Homey.api('GET', `/diagnostics?anonymize=${anonymize}`, null, (err, report) => {
        if (err) {
          $('status').textContent = `${tr('settings.error')}: ${err.message || err}`;
          return;
        }
        $('report').value = JSON.stringify(report, null, 2);
        $('status').textContent = tr('settings.ready');
      });
    }

    async function copy() {
      const text = $('report').value;
      try {
        await win.navigator.clipboard.writeText(text);
        $('status').textContent = tr('settings.copied');
      } catch (err) {
        // The clipboard API may be unavailable in the Homey app: select the text instead.
        $('report').focus();
        $('report').select();
        let ok = false;
        try {
          ok = doc.execCommand('copy');
        } catch (e) { /* ignore */ }
        $('status').textContent = tr(ok ? 'settings.copied' : 'settings.copyManually');
      }
    }

    $('refresh').addEventListener('click', load);
    $('anonymize').addEventListener('change', load);
    $('copy').addEventListener('click', copy);
    $('pick-widget-apps').addEventListener('click', pickWidgetApps);
    $('app-search').addEventListener('input', filterAll);
    $('app-search').placeholder = tr('settings.searchApps');

    loadApps();
    load();
    Homey.ready();
    return { load, copy, loadApps };
  }

  return {
    detectTheme, applyTheme, init, startupText, groupApps,
  };
}));
