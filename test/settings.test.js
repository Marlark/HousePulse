'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Settings = require('../settings/settings');

const ROOT = path.join(__dirname, '..');
const LANGUAGES = ['en', 'sv', 'no', 'da', 'de', 'nl'];
const locales = Object.fromEntries(LANGUAGES.map((lang) => [lang,
  JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf8'))]));
const pageHtml = fs.readFileSync(path.join(ROOT, 'settings', 'index.html'), 'utf8');
const lookup = (obj, key) => key.split('.').reduce((o, part) => (o ? o[part] : undefined), obj);
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The real settings page in jsdom, without its scripts (/homey.js only exists on Homey):
 * settings.js is driven directly with the page's document, so markup and script must match.
 */
function fakePage() {
  const dom = new JSDOM(pageHtml.replace(/<script[\s\S]*?<\/script>/g, ''), { url: 'https://homey.local/settings/' });
  const doc = dom.window.document;
  doc.execCommand = () => false; // jsdom has no clipboard commands
  const els = new Proxy({}, { get: (_, id) => doc.getElementById(id) });
  const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type));
  return { dom, doc, els, fire };
}

const NO_APPS = { apps: [], waitFor: [], startup: { state: 'ready', waitedFor: [], waitedMs: 0 } };

function fakeHomey({ lang = 'en', respond = (p) => ({ path: p }), apps = NO_APPS } = {}) {
  const calls = [];
  return {
    calls,
    readyCalled: false,
    __: (key) => lookup(locales[lang], key),
    ready() { this.readyCalled = true; },
    api(method, apiPath, body, callback) {
      calls.push({ method, path: apiPath, body });
      let result;
      if (apiPath === '/apps') result = apps;
      else if (apiPath === '/wait-for-apps') result = { waitFor: body.ids };
      else result = respond(apiPath);
      if (result instanceof Error) callback(result);
      else callback(null, result);
    },
  };
}

const fakeWindow = ({ search = '', dark = false, clipboard } = {}) => ({
  location: { search },
  matchMedia: () => ({ matches: dark, addEventListener() {} }),
  navigator: { clipboard },
});

/* ---------------- Translations ---------------- */

test('every text the settings page uses exists in all languages', () => {
  const keys = [...pageHtml.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  const scriptKeys = [...fs.readFileSync(path.join(ROOT, 'settings', 'settings.js'), 'utf8')
    .matchAll(/'(settings\.[a-zA-Z]+)'/g)].map((m) => m[1]);
  const all = [...new Set([...keys, ...scriptKeys])];
  assert.ok(all.length >= 8, `found only ${all.length} keys`);
  for (const lang of LANGUAGES) {
    for (const key of all) assert.ok(lookup(locales[lang], key), `${lang}: missing ${key}`);
  }
});

/* ---------------- Behaviour ---------------- */

test('init translates the page, loads an anonymized report and tells Homey it is ready', () => {
  const page = fakePage();
  const homey = fakeHomey({ lang: 'sv', respond: () => ({ app: { id: 'x' }, anonymized: true }) });
  Settings.init(homey, page.doc, fakeWindow());

  assert.strictEqual(page.doc.querySelector('[data-i18n="settings.title"]').textContent, 'Diagnostik');
  assert.deepStrictEqual(homey.calls.map((c) => c.path), ['/apps', '/diagnostics?anonymize=1']);
  assert.deepStrictEqual(JSON.parse(page.els.report.value), { app: { id: 'x' }, anonymized: true });
  assert.strictEqual(page.els.status.textContent, locales.sv.settings.ready);
  assert.strictEqual(homey.readyCalled, true);
});

test('unticking "hide names" reloads the report with names', () => {
  const page = fakePage();
  const homey = fakeHomey();
  Settings.init(homey, page.doc, fakeWindow());
  page.els.anonymize.checked = false;
  page.fire(page.els.anonymize, 'change');
  assert.strictEqual(homey.calls.at(-1).path, '/diagnostics?anonymize=0');
  page.fire(page.els.refresh, 'click');
  assert.strictEqual(homey.calls.filter((c) => c.path.startsWith('/diagnostics')).length, 3);
});

test('an API error is shown instead of a report', () => {
  const page = fakePage();
  Settings.init(fakeHomey({ respond: () => new Error('App is not running') }), page.doc, fakeWindow());
  assert.strictEqual(page.els.status.textContent, `${locales.en.settings.error}: App is not running`);
  assert.strictEqual(page.els.report.value, '');
});

test('copy: clipboard API, then execCommand fallback, then "copy manually"', async () => {
  // 1. Clipboard API works
  let copied = null;
  let page = fakePage();
  Settings.init(fakeHomey(), page.doc, fakeWindow({ clipboard: { writeText: async (t) => { copied = t; } } }));
  page.fire(page.els.copy, 'click');
  await tick();
  assert.strictEqual(copied, page.els.report.value);
  assert.strictEqual(page.els.status.textContent, locales.en.settings.copied);

  // 2. Clipboard API refused → select the text and use execCommand
  page = fakePage();
  page.doc.execCommand = () => true;
  let selected = false;
  page.els.report.select = () => { selected = true; };
  Settings.init(fakeHomey(), page.doc, fakeWindow({ clipboard: { writeText: async () => { throw new Error('denied'); } } }));
  page.fire(page.els.copy, 'click');
  await tick();
  assert.ok(selected);
  assert.strictEqual(page.els.status.textContent, locales.en.settings.copied);

  // 3. Nothing works (no clipboard API at all) → ask the user to copy the selected text
  page = fakePage();
  Settings.init(fakeHomey(), page.doc, fakeWindow());
  page.fire(page.els.copy, 'click');
  await tick();
  assert.strictEqual(page.els.status.textContent, locales.en.settings.copyManually);
});

/* ---------------- Theme ---------------- */

test('theme follows ?theme=, a dark-mode class, then the device setting', () => {
  const page = fakePage();
  assert.strictEqual(Settings.detectTheme(fakeWindow(), page.doc), 'light');
  assert.strictEqual(Settings.detectTheme(fakeWindow({ dark: true }), page.doc), 'dark');
  assert.strictEqual(Settings.detectTheme(fakeWindow({ search: '?theme=light', dark: true }), page.doc), 'light');
  assert.strictEqual(Settings.detectTheme(fakeWindow({ search: '?webview=1&theme=dark' }), page.doc), 'dark');
  page.doc.documentElement.classList.add('homey-dark-mode');
  assert.strictEqual(Settings.detectTheme(fakeWindow(), page.doc), 'dark');

  const themed = fakePage();
  Settings.applyTheme(fakeWindow({ dark: true }), themed.doc);
  assert.strictEqual(themed.doc.documentElement.getAttribute('data-theme'), 'dark');
});

test('the dark theme redefines Homey\'s own color variables', () => {
  for (const variable of ['--homey-color-text', '--homey-color-text-light', '--homey-color-line',
    '--homey-color-component', '--homey-color-highlight']) {
    assert.match(pageHtml, new RegExp(`html\\[data-theme="dark"\\][^}]*${variable}:`), `${variable} not overridden`);
  }
});

test('dark theme: a tapped (hovered) checkbox keeps readable text', () => {
  // Homey's own CSS sets label.homey-form-checkbox:hover { color: var(--homey-color-black) }, and
  // on a touch screen the label stays in :hover after a tap. Load that rule after the page's own
  // styles (like Homey does) and check that the dark theme still wins.
  const page = fakePage();
  const homeyCss = page.doc.createElement('style');
  homeyCss.textContent = ':root { --homey-color-black: #000000; } label.homey-form-checkbox:hover { color: var(--homey-color-black); }';
  page.doc.head.appendChild(homeyCss);
  page.doc.documentElement.setAttribute('data-theme', 'dark');

  const rule = [...page.doc.styleSheets].flatMap((sheet) => [...sheet.cssRules])
    .filter((r) => r.selectorText && r.selectorText.includes('label.homey-form-checkbox:hover'));
  const ours = rule.find((r) => r.selectorText.startsWith('html[data-theme="dark"]'));
  assert.ok(ours, 'dark override for the hover rule exists');
  assert.strictEqual(ours.style.color, 'var(--homey-color-text)');
  // Higher specificity than Homey's rule (1 attribute + 1 element more), so it wins regardless of order
  assert.ok(ours.selectorText.split(',').every((sel) => sel.trim().startsWith('html[data-theme="dark"] label.')));
});

/* ---------------- Apps to wait for at startup ---------------- */

const APPS = {
  apps: [
    { id: 'com.solar', name: 'Solar', state: 'running', enabled: true, usedByWidget: true, hasEnergyDevices: true },
    { id: 'com.charger', name: 'Charger', state: 'running', enabled: true, usedByWidget: true, hasEnergyDevices: true },
    { id: 'com.plug', name: 'Plug', state: 'running', enabled: true, usedByWidget: false, hasEnergyDevices: true },
    { id: 'com.alarm', name: 'Alarm', state: 'crashed', enabled: true, usedByWidget: false, hasEnergyDevices: false },
    { id: 'com.lights', name: 'Lights', state: 'running', enabled: true, usedByWidget: false, hasEnergyDevices: false },
    { id: 'com.old', name: 'Old', state: 'stopped', enabled: false, usedByWidget: false, hasEnergyDevices: false },
  ],
  waitFor: ['com.solar', 'com.lights'],
  startup: { state: 'ready', waitedFor: ['com.solar'], waitedMs: 34000, timedOut: false, pending: [] },
};

function appsPage(apps = APPS) {
  const page = fakePage();
  const homey = fakeHomey({ lang: 'sv', apps });
  Settings.init(homey, page.doc, fakeWindow());
  const rows = (listId) => [...page.els[listId].querySelectorAll('label')];
  const ids = (listId) => rows(listId).map((row) => row.querySelector('input').value);
  const box = (id) => page.doc.querySelector(`input[value="${id}"]`);
  return {
    ...page, homey, rows, ids, box,
  };
}

test('groupApps: widget and chosen apps first, then energy apps, then the rest', () => {
  const groups = Settings.groupApps(APPS.apps, APPS.waitFor);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((a) => a.id)])), {
    main: ['com.solar', 'com.charger', 'com.lights'], // Lights is chosen: never hidden
    energy: ['com.plug'],
    other: ['com.alarm', 'com.old'],
  });
});

test('apps: only the relevant apps are shown, the rest behind "show more" buttons', () => {
  const p = appsPage();
  assert.deepStrictEqual(p.ids('apps'), ['com.solar', 'com.charger', 'com.lights']);
  assert.strictEqual(p.els['apps-energy'].hidden, true);
  assert.strictEqual(p.els['apps-all-section'].hidden, true);
  assert.strictEqual(p.els['more-energy'].textContent, 'Visa fler appar med energienheter (1)');
  assert.strictEqual(p.els['more-all'].textContent, 'Visa alla övriga appar (2)');

  p.fire(p.els['more-energy'], 'click');
  assert.strictEqual(p.els['apps-energy'].hidden, false);
  assert.strictEqual(p.els['more-energy'].hidden, true, 'the button goes away once used');
  assert.deepStrictEqual(p.ids('apps-energy'), ['com.plug']);

  p.fire(p.els['more-all'], 'click');
  assert.strictEqual(p.els['apps-all-section'].hidden, false);
  assert.deepStrictEqual(p.ids('apps-all'), ['com.alarm', 'com.old']);
});

test('apps: rows show state and mark widget apps; ticking one saves the whole choice', () => {
  const p = appsPage();
  const meta = (id) => p.box(id).closest('label').querySelector('.app__meta').textContent;
  assert.strictEqual(meta('com.solar'), 'körs · har enheter i widgeten');
  assert.strictEqual(meta('com.alarm'), 'kraschad');
  assert.strictEqual(meta('com.old'), 'avstängd');
  assert.strictEqual(p.els['wait-status'].textContent, 'Senaste start: väntade 34 s på apparna.');
  assert.strictEqual(p.box('com.solar').checked, true);

  p.box('com.alarm').checked = true;
  p.fire(p.box('com.alarm'), 'change');
  assert.deepStrictEqual(p.homey.calls.at(-1), {
    method: 'PUT', path: '/wait-for-apps', body: { ids: ['com.solar', 'com.lights', 'com.alarm'] },
  });
  assert.strictEqual(p.els['wait-message'].textContent, locales.sv.settings.waitSaved);
});

test('apps: "choose the widget\'s apps" ticks them all at once, then is disabled', () => {
  const p = appsPage();
  const button = p.els['pick-widget-apps'];
  assert.strictEqual(button.hidden, false);
  assert.strictEqual(button.textContent, 'Välj widgetens appar');
  assert.strictEqual(button.disabled, false, 'Charger is not ticked yet');

  p.fire(button, 'click');
  assert.deepStrictEqual(p.homey.calls.at(-1).body.ids.sort(), ['com.charger', 'com.lights', 'com.solar']);
  assert.strictEqual(p.box('com.charger').checked, true);
  assert.strictEqual(button.disabled, true);

  p.box('com.charger').checked = false; // unticking one enables it again
  p.fire(p.box('com.charger'), 'change');
  assert.strictEqual(button.disabled, false);
});

test('apps: the button is hidden when no app has devices in a widget', () => {
  const p = appsPage({ ...APPS, apps: APPS.apps.map((a) => ({ ...a, usedByWidget: false })), waitFor: [] });
  assert.strictEqual(p.els['pick-widget-apps'].hidden, true);
});

test('apps: search filters "all other apps" by name or id', () => {
  const p = appsPage();
  p.fire(p.els['more-all'], 'click');
  const visible = () => p.rows('apps-all').filter((row) => !row.hidden).map((row) => row.querySelector('input').value);

  p.els['app-search'].value = 'ALA';
  p.fire(p.els['app-search'], 'input');
  assert.deepStrictEqual(visible(), ['com.alarm']);

  p.els['app-search'].value = 'com.old';
  p.fire(p.els['app-search'], 'input');
  assert.deepStrictEqual(visible(), ['com.old']);
  assert.strictEqual(p.els['app-search-empty'].hidden, true);

  p.els['app-search'].value = 'nothing like this';
  p.fire(p.els['app-search'], 'input');
  assert.deepStrictEqual(visible(), []);
  assert.strictEqual(p.els['app-search-empty'].hidden, false);
  assert.strictEqual(p.els['app-search'].placeholder, 'Sök app');
});

test('apps: empty sections have no "show more" button', () => {
  const p = appsPage({ ...APPS, apps: APPS.apps.slice(0, 2) });
  assert.strictEqual(p.els['more-energy'].hidden, true);
  assert.strictEqual(p.els['more-all'].hidden, true);
});

test('apps: last start texts', () => {
  const tr = (key) => lookup(locales.en, key);
  assert.strictEqual(Settings.startupText({ state: 'ready', waitedFor: [] }, tr), 'Last start: did not wait for any apps.');
  assert.strictEqual(Settings.startupText({ state: 'waiting', pending: [{ name: 'Solar' }] }, tr), 'Starting: waiting for Solar.');
  assert.strictEqual(Settings.startupText({
    state: 'ready', waitedFor: ['a'], waitedMs: 600000, timedOut: true, pending: [{ name: 'Solar' }],
  }, tr), 'Last start: started anyway after 600 s. Not running: Solar.');
});

test('apps: every app state has a text in every language', () => {
  for (const lang of LANGUAGES) {
    for (const state of ['running', 'starting', 'stopping', 'stopped', 'crashed', 'unknown']) {
      assert.ok(lookup(locales[lang], `settings.state_${state}`), `${lang}: state_${state}`);
    }
  }
});
