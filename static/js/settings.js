// Settings sheet: display, a live CAN signal browser (the car's IBUS1/IBUS2, and the comma's ADAS bus), the
// comma's management (comma.js) and, with the comma connected, its CAN overrides (opendbc/car/fisker/values.py),
// driving params, playback and connection info.
import { $, $$, el, api, fmtBytes, fmtTime, prettyLabel, prettySignal, iconSvg } from './util.js';
import { OCEAN_PAINTS, OCEAN_WHEELS, oceanPaint } from './models.js';
import { RX_IDS } from './ibus_tables.js';
import { CommaPanel } from './comma.js';

// tab -> what it needs the comma for
const OFFLINE_TABS = new Map([
  ['overrides', 'The CAN settings are kept on it and applied by it; they stay as they were.'],
  ['driving', 'The driving settings are openpilot\'s, on the comma.'],
  ['playback', 'The recorded drives are on the comma.'],
]);

// the signal browser's buses: the car's own two (what the app reads, CanIds.RX), and the comma's ADAS bus
const SIG_SOURCES = [['IBUS1', 'IBUS1'], ['IBUS2', 'IBUS2'], ['ADAS', 'ADAS bus (comma)']];

export class Settings {
  constructor(app) {
    this.app = app;
    this.sheet = $('#settings');
    this.body = $('#tab-body');
    this.tab = 'display';
    this.sigBus = 'IBUS1';
    this.comma = new CommaPanel(app);
    this.displaySection = 'general';
    $('#btn-settings').innerHTML = iconSvg('gear');
    $('#settings-close').innerHTML = iconSvg('close');
    $('#btn-settings').addEventListener('click', () => this.open());
    $('#settings-close').addEventListener('click', () => this.close());
    $$('#tabs button').forEach(b => b.addEventListener('click', () => this.show(b.dataset.tab)));
    this.overrides = null;
    this.edits = {};
    this.dbc = null;
    this.expanded = new Set();
    this.rawData = {};
  }

  get isOpen() { return !this.sheet.classList.contains('hidden'); }

  open(tab) {
    this.sheet.classList.remove('hidden');
    this.sheet.setAttribute('aria-hidden', 'false');
    this.show(tab || this.tab);
  }

  close() {
    this.sheet.classList.add('hidden');
    this.sheet.setAttribute('aria-hidden', 'true');
    this.app.subscribeRaw('ibus', []);
    this.comma.leave();
  }

  /** Without the comma these tabs have nothing to show or change: the overrides, params and drives live there. */
  needsComma(tab) {
    if (this.app.commaConnected || !OFFLINE_TABS.has(tab)) return false;
    this.body.append(el('div.banner', 'The comma isn\'t connected (it\'s optional: the HUD runs from the car). ' + OFFLINE_TABS.get(tab)));
    return true;
  }

  // keep: re-render the open tab after a change without moving it -- the new content is built off-screen
  // and swapped in at the same scroll position, so the page neither jumps to the top nor flashes empty
  async show(tab, keep = false) {
    keep = keep && tab === this.tab;
    this.tab = tab;
    $$('#tabs button').forEach(b => {
      b.classList.toggle('on', b.dataset.tab === tab);
      if (b.dataset.tab === tab) b.scrollIntoView({ inline: 'nearest', block: 'nearest' });   // a narrow bar scrolls to it
    });
    if (tab !== 'signals') this.app.subscribeRaw('ibus', []);
    if (tab !== 'comma') this.comma.leave();
    const render = {
      overrides: () => this.renderOverrides(), driving: () => this.renderDriving(), display: () => this.renderDisplay(),
      playback: () => this.renderPlayback(), signals: () => this.renderSignals(), about: () => this.renderAbout(),
      comma: () => this.comma.render(this.body, keep),
    }[tab];
    const live = this.body;
    if (!keep) {
      live.innerHTML = '';
      live.scrollTop = 0;
      if (!this.needsComma(tab)) render && render();
      return;
    }
    const scroll = live.scrollTop, offscreen = document.createElement('div');
    this.body = offscreen;
    const done = this.needsComma(tab) ? null : render && render();   // every renderer takes this.body before its first await
    this.body = live;
    await done;
    if (this.tab !== tab) return;      // switched tabs meanwhile
    live.replaceChildren(...offscreen.childNodes);
    live.scrollTop = scroll;
  }

  // ---- CAN overrides --------------------------------------------------------------------------

  async renderOverrides(reload = true) {
    const body = this.body;
    if (reload || !this.overrides) {
      body.append(el('p.desc', 'Loading…'));
      try {
        this.overrides = await api('/api/overrides');
      } catch (e) {
        body.innerHTML = '';
        body.append(el('div.banner.bad', `Couldn't load overrides: ${e.message}`));
        return;
      }
      this.edits = {};
    }
    if (this.tab !== 'overrides') return;
    const scroll = body.scrollTop;   // edits re-render in place
    body.innerHTML = '';
    const data = this.overrides;
    if (!data.supported) {
      body.append(el('div.banner', 'This car has no editable CAN overrides.'));
      return;
    }
    body.append(el('p.desc', 'Signals openpilot replaces when it relays these ICC frames to the ADAS module ' +
      '(defaults from opendbc/car/fisker/values.py). Changes apply within a fraction of a second, no restart needed.'));
    if (!data.editable) body.append(el('div.banner.warn', 'Changes are locked while the car is moving.'));
    const showAll = !!this.showAllSignals;

    for (const table of data.tables) {
      const edits = this.edits[table.message] || {};
      const sec = el('div.section');
      sec.append(el('h3', prettySignal(table.message).replace(/^0x/, 'ICC 0x'), el('code', table.message),
        table.customized ? el('span.badge', 'customized') : el('span.badge.gray', 'code defaults')));
      sec.append(el('p.desc', table.description));
      const rows = el('div.rows');
      const signals = table.signals.filter(s => showAll || s.override != null || s.default != null || (s.name in edits));
      for (const sig of signals) rows.append(this.overrideRow(table, sig, edits, data.editable));
      if (!signals.length) rows.append(el('div.row', el('div.lbl', el('small', 'No overrides — the ICC frame passes through unchanged.'))));
      sec.append(rows);
      const dirty = Object.keys(edits).length > 0;
      sec.append(el('div.btns',
        el('button.btn.primary', { disabled: !dirty || !data.editable, onclick: () => this.saveOverrides(table) }, 'Save'),
        el('button.btn', { disabled: !dirty, onclick: () => { delete this.edits[table.message]; this.renderOverrides(false); } }, 'Revert'),
        el('button.btn.danger', { disabled: !table.customized || !data.editable, onclick: () => this.resetOverrides(table) }, 'Reset to code defaults'),
      ));
      body.append(sec);
    }
    body.append(el('div.row', el('div.lbl', el('b', 'Show every signal'), el('small', 'Add overrides for signals the code leaves alone.')),
      this.app.switch(showAll, v => { this.showAllSignals = v; this.renderOverrides(false); })));
    body.scrollTop = scroll;
  }

  overrideRow(table, sig, edits, editable) {
    const has = (k) => Object.prototype.hasOwnProperty.call(edits, k);
    const value = has(sig.name) ? edits[sig.name] : sig.override;
    const changed = has(sig.name);
    const enumEntries = Object.entries(sig.values || {});
    const label = (v) => (v == null ? '—' : (sig.values && sig.values[String(Math.round(v))] ? `${prettyLabel(sig.values[String(Math.round(v))])} (${v})` : String(v)));

    const setEdit = (v) => {
      const t = (this.edits[table.message] = this.edits[table.message] || {});
      if (v === sig.override || (v === null && sig.override == null)) delete t[sig.name];
      else t[sig.name] = v;
      if (!Object.keys(t).length) delete this.edits[table.message];
      this.renderOverrides(false);
    };

    let control;
    if (sig.locked) {
      control = el('small', 'pass-through');
    } else if (enumEntries.length && enumEntries.length <= 64) {
      control = el('select', { disabled: !editable, onchange: (e) => setEdit(e.target.value === '' ? null : Number(e.target.value)) },
        el('option', { value: '' }, 'Pass through (ICC value)'),
        enumEntries.map(([k, n]) => el('option', { value: k, selected: value != null && Number(k) === value }, `${prettyLabel(n)} (${k})`)));
      if (value == null) control.value = '';
    } else {
      const input = el('input', { type: 'number', step: sig.factor, min: sig.min, max: sig.max, value: value ?? '', placeholder: 'pass', disabled: !editable,
        onchange: (e) => setEdit(e.target.value === '' ? null : Number(e.target.value)) });
      control = input;
    }
    const meta = [];
    if (sig.default != null) meta.push(`default ${label(sig.default)}`);
    else meta.push('default pass-through');
    return el(`div.row${changed ? '.changed' : ''}${sig.locked ? '.locked' : ''}`,
      el('div.lbl', el('b', prettySignal(sig.name)),
        el('small', sig.comment || sig.name),
        el('small.cur', `ICC sends ${label(sig.current)} · ${meta.join(' · ')}`)),
      control);
  }

  async saveOverrides(table) {
    const current = {};
    for (const s of table.signals) if (s.override != null) current[s.name] = s.override;
    const edits = this.edits[table.message] || {};
    for (const [k, v] of Object.entries(edits)) {
      if (v === null) delete current[k];
      else current[k] = v;
    }
    try {
      this.overrides = await api('/api/overrides', { method: 'PUT', body: { [table.message]: current } });
      delete this.edits[table.message];
      this.app.toast(`${table.message} saved`);
    } catch (e) {
      this.app.toast(`Save failed: ${e.message}`);
    }
    this.renderOverrides(false);
  }

  async resetOverrides(table) {
    if (!confirm(`Reset ${table.message} to the defaults in values.py?`)) return;
    try {
      this.overrides = await api(`/api/overrides?message=${encodeURIComponent(table.message)}`, { method: 'DELETE' });
      delete this.edits[table.message];
      this.app.toast(`${table.message} reset to code defaults`);
    } catch (e) {
      this.app.toast(`Reset failed: ${e.message}`);
    }
    this.renderOverrides(false);
  }

  // ---- driving params ----------------------------------------------------------------------------

  async renderDriving() {
    const body = this.body;
    let p;
    try { p = await api('/api/params'); } catch (e) { body.append(el('div.banner.bad', e.message)); return; }
    if (this.tab !== 'driving') return;
    const put = async (obj) => {
      try { await api('/api/params', { method: 'PUT', body: obj }); this.app.toast('Saved'); this.renderDrivingSoon(); } catch (e) { this.app.toast(e.message); }
    };
    body.append(el('div.section',
      el('h3', 'Following distance'),
      el('p.desc', 'openpilot driving personality (used with openpilot longitudinal control). The Fisker ADAS time gap is set with the steering wheel buttons.'),
      this.app.segmented([['0', 'Aggressive'], ['1', 'Standard'], ['2', 'Relaxed']], String(p.LongitudinalPersonality ?? 1), v => put({ LongitudinalPersonality: Number(v) })),
    ));
    if (typeof p.FiskerACCTerrain === 'boolean') {
      const toggles = [['FiskerACCAutoSpeed', 'ACC auto speed', 'Set speed follows the speed limit.'],
        ['FiskerACCTerrain', 'ACC Terrain Mode', 'The factory ACC terrain setting. Its effect on driving behavior is unverified.']];
      body.append(el('div.section',
        el('h3', 'Fisker ACC defaults'),
        el('p.desc', 'The comma\'s own toggles, applied after a restart. Car → Assist sets these live and wins over them once set there.'),
        el('div.rows', toggles.filter(([k]) => typeof p[k] === 'boolean').map(([k, t, d]) =>
          el('div.row', el('div.lbl', el('b', t), el('small', d)), this.app.switch(p[k], v => put({ [k]: v })))))));
    } else {
      body.append(el('div.section', el('h3', 'Fisker ACC'),
        el('p.desc', 'The ACC defaults require an updated comma WebHUD server.')));
    }
    if ('FiskerSpeedLimitUnit' in p) {
      // what the comma tells the ADAS in the head unit's map metadata (ICC_0x362): the ADAS reads the unit of the
      // speed-limit signs from it, and UK head units send it blank (km/h), so 30 mph signs set ACC to 30 km/h
      const countries = [[0, 'As the head unit sends'], [826, 'United Kingdom'], [372, 'Ireland'], [840, 'United States'],
        [124, 'Canada'], [276, 'Germany'], [250, 'France'], [528, 'Netherlands'], [56, 'Belgium'], [40, 'Austria'],
        [756, 'Switzerland'], [208, 'Denmark'], [578, 'Norway'], [752, 'Sweden']];
      const country = Number(p.FiskerCountryCode) || 0;
      if (!countries.some(([c]) => c === country)) countries.push([country, `Code ${country}`]);
      body.append(el('div.section',
        el('h3', 'Speed-limit signs (ADAS)'),
        el('p.desc', 'What the comma tells the ADAS about where the car is, for the signs its camera reads and auto speed. ' +
          'Applied at the next car start. In the UK: Follow dash (or mph), Left, United Kingdom.'),
        el('div.rows',
          el('div.row', el('div.lbl', el('b', 'Sign units'), el('small', 'Follow dash uses the cluster\'s mph / km/h setting.')),
            this.app.segmented([['0', 'Follow dash'], ['1', 'mph'], ['2', 'km/h'], ['3', 'Head unit']], String(p.FiskerSpeedLimitUnit ?? 0),
              v => put({ FiskerSpeedLimitUnit: Number(v) }))),
          el('div.row', el('div.lbl', el('b', 'Traffic side'), el('small', 'The side of the road the car drives on.')),
            this.app.segmented([['0', 'Head unit'], ['1', 'Left'], ['2', 'Right']], String(p.FiskerTrafficSide ?? 0),
              v => put({ FiskerTrafficSide: Number(v) }))),
          el('div.row', el('div.lbl', el('b', 'Country'), el('small', 'The country the ADAS reads signs for.')),
            el('select', { onchange: (e) => put({ FiskerCountryCode: Number(e.target.value) }) },
              countries.map(([c, n]) => el('option', { value: c, selected: c === country }, n)))))));
    }
    body.append(el('div.section', el('div.rows',
      el('div.row', el('div.lbl', el('b', 'Experimental mode'), el('small', 'End-to-end longitudinal from the driving model.')),
        this.app.switch(!!p.ExperimentalMode, v => put({ ExperimentalMode: v }))),
      el('div.row', el('div.lbl', el('b', 'Use metric units'), el('small', 'Device-wide setting; the HUD follows the cluster unit when available.')),
        this.app.switch(!!p.IsMetric, v => put({ IsMetric: v }))),
    )));
  }

  renderDrivingSoon() { setTimeout(() => { if (this.tab === 'driving') this.show('driving', true); }, 150); }

  // the lane confidence right now, under the threshold slider (Display)
  showLaneConf() {
    const road = this.app.scene.road;
    if (this.laneConfNow) this.laneConfNow.textContent = `Now ${Math.round(road.laneConf * 100)}%, lanes ${road.lanesShown ? 'shown' : 'hidden'}`;
  }

  // ---- display (stored in this browser) ------------------------------------------------------------

  // split into sections picked from a bar at the top, so no page is one long list
  renderDisplay() {
    const sec = this.displaySection;
    this.laneConfNow = this.positionNow = null;   // only the Road section shows them
    this.body.append(el('div.subnav', this.app.segmented([['general', 'General'], ['road', 'Road'], ['objects', 'Objects'], ['debug', 'Debug']], sec,
      v => { this.displaySection = v; this.show('display'); })));
    ({ general: () => this.displayGeneral(), road: () => this.displayRoad(), objects: () => this.displayObjects(), debug: () => this.displayDebug() })[sec]();
  }

  // on/off display settings: [setting, title, description]
  toggleRows(toggles) {
    const s = this.app.settings;
    return el('div.section', el('div.rows', toggles.map(([k, t, d]) =>
      el('div.row', el('div.lbl', el('b', t), el('small', d)), this.app.switch(s[k] !== false, v => this.app.setSetting(k, v))))));
  }

  displayGeneral() {
    const s = this.app.settings;
    const set = (k, v) => this.app.setSetting(k, v);
    const body = this.body;
    body.append(el('div.section', el('h3', 'Theme'),
      this.app.segmented([['auto', 'Auto'], ['light', 'Day'], ['dark', 'Night']], s.theme, v => set('theme', v))));
    body.append(el('div.section', el('h3', 'Speed units'),
      this.app.segmented([['auto', 'Follow cluster'], ['mph', 'mph'], ['kmh', 'km/h']], s.units, v => set('units', v))));
    body.append(el('div.section', el('h3', 'Traffic side'),
      el('p.desc', 'Which side of a two-way road to drive on. For the UK, choose Left.'),
      this.app.segmented([['auto', 'Follow car'], ['left', 'Left (UK)'], ['right', 'Right']], s.trafficSide || 'auto', v => set('trafficSide', v))));
    body.append(el('div.section', el('h3', 'Camera speed-sign units'),
      el('p.desc', 'Units of the number read from signs, before display conversion. Choose mph for UK signs if Follow car converts them incorrectly.'),
      this.app.segmented([['auto', 'Follow car'], ['mph', 'mph'], ['kmh', 'km/h']], s.cameraSignUnits || 'auto', v => set('cameraSignUnits', v))));
    body.append(el('div.section', el('h3', 'Speed-sign style'),
      el('p.desc', 'The speed limit sign drawn on the HUD and by the road. Follow units uses the US sign for mph, except with left-hand (UK) traffic.'),
      this.app.segmented([['auto', 'Follow units'], ['round', 'Round (UK/EU)'], ['us', 'US']], s.signStyle || 'auto', v => set('signStyle', v))));
    const paint = oceanPaint(s.egoPaint);
    body.append(el('div.section', el('h3', 'Paint', el('small', `${paint.name} · ${paint.finish.toLowerCase()}`)),
      el('div.swatches', OCEAN_PAINTS.map(p => el('button.swatch' + (p === paint ? '.on' : ''),
        { title: `${p.name} (${p.code}, ${p.finish.toLowerCase()})`, onclick: () => set('egoPaint', p.code) },
        el('i', { style: { background: p.hex } }), el('span', p.name))))));
    body.append(el('div.section', el('h3', 'Wheels'),
      el('p.desc', 'F3 is the Ocean\'s aero wheel; F5 (seven spokes) and F6 (ten) are modeled from photos. Alloy or gloss black.'),
      this.app.segmented(OCEAN_WHEELS.map(w => [w.id, w.label]), s.egoWheels, v => set('egoWheels', v))));
    body.append(this.toggleRows([
      ['showTracks', 'Power trails', 'Glowing particle trails behind the rear tires, colored by how hard the motors pull (blue light, through the spectrum to red at full power); longer the faster you go.'],
      ['autoView', 'Auto view', 'Switch to the top view while parking and back when driving.'],
      ['showMusic', 'Music', 'What the head unit is playing, in a card at the bottom with its controls. Needs the HUD\'s Android app on the car\'s screen.'],
      ['showNav', 'Navigation', 'The next turn from the head unit\'s navigation, in a card at the top and as an arrow on the road once it\'s near. ' +
        'Needs the HUD\'s Android app on the car\'s screen.'],
    ]));
  }

  displayRoad() {
    const s = this.app.settings;
    const set = (k, v) => this.app.setSetting(k, v);
    const body = this.body;
    body.append(el('div.section', el('h3', 'Lane lines'),
      el('p.desc', 'Blended: the Fisker ADAS lanes, refined with openpilot\'s where they agree and filled in where only openpilot sees a line. ' +
        'Or either source alone, or both drawn separately (openpilot faint).'),
      this.app.segmented([['blend', 'Blended'], ['fisker', 'Fisker ADAS'], ['model', 'openpilot'], ['both', 'Both']], s.laneSource, v => set('laneSource', v))));
    // dragging moves the threshold live (the view reads the settings each frame); it's saved on release
    const thr = s.laneConfThreshold;
    const pct = (v) => `${Math.round(v * 100)}%`;
    const value = el('b', pct(thr));
    const fill = (v) => slider.style.setProperty('--p', `${(v - 0.1) / 0.8 * 100}%`);
    const slider = el('input', { type: 'range', min: 0.1, max: 0.9, step: 0.05, value: thr,
      oninput: (e) => {
        s.laneConfThreshold = Number(e.target.value);
        value.textContent = pct(s.laneConfThreshold);
        fill(s.laneConfThreshold);
      },
      onchange: (e) => set('laneConfThreshold', Number(e.target.value)) });
    fill(thr);
    this.laneConfNow = el('small.cur', '');
    body.append(el('div.section', el('h3', 'Lane confidence'),
      el('p.desc', 'How sure the HUD must be of the lanes before it draws them. Confidence builds while the ego lane\'s lines are seen ' +
        'and stay where they were predicted, and stays with each stretch of road as you drive onto it. Under the threshold the ground is a ' +
        'disc around the car; past it the disc grows out into the road. Lower shows lanes sooner and on worse roads, higher only on clear ones.'),
      el('div.rows', el('div.row', el('div.lbl', el('b', 'Show lanes from'), this.laneConfNow), value)), slider));
    this.showLaneConf();
    body.append(this.toggleRows([
      ['showRoad', 'Inferred road', 'Fill in the road and lanes the cameras don\'t report, following the last known lanes and your path.'],
      ['mapRoad', 'Map road', 'Draw the road from the map: the roads around you, their junctions, and what stands along them, placed by the car\'s own motion with the GPS and heading eased in. The cameras\' lanes only pick the lane you\'re drawn in. Off, or without a map, the road is the cameras\' alone.'],
      ['showGround', 'Ground texture', 'Fine textured ground that moves under the car with its speed and steering.'],
      ['showSigns', 'Traffic lights & signs', 'The map\'s signals, stop and yield signs, limits and crossings where the map has them (the signal ahead shows the camera\'s light), and the lights, signs and stop lines the car\'s camera reports, placed where they most likely are.'],
      ['showPath', 'Planned path', 'Blue band along openpilot\'s path while steering is engaged.'],
    ]));
    // the map around the car is downloaded ahead and kept (maptiles.py MapPrefetch)
    this.mapStatus = el('small.cur', '');
    body.append(el('div.section', el('h3', 'Map download'),
      el('p.desc', 'The map within this distance of the car -- the road tiles and what stands along the roads -- is downloaded in the ' +
        'background and kept for good, so the next drive through the area needs no network. Off downloads only what is in view.'),
      this.app.segmented([['0', 'Off'], ['10', '10 km'], ['25', '25 km'], ['50', '50 km'], ['100', '100 km']], String(s.mapPrefetchKm ?? 25), v => set('mapPrefetchKm', Number(v))),
      this.mapStatus));
    this.showMapStatus();
    // where the pose's fixes and heading come from (state.js setPositionSource)
    this.positionNow = el('small.cur', '');
    body.append(el('div.section', el('h3', 'Position'),
      el('p.desc', 'Where the car is placed on the map from. Car: the telematics box\'s GPS and heading on the car\'s buses. ' +
        'This screen: the location of the Android device the HUD runs on, for cars whose telematics box gives no position; ' +
        'its heading then comes from the direction of travel, so the map turns into place once the car is moving. ' +
        'Needs the HUD\'s Android app and its location permission.'),
      this.app.segmented([['car', 'Car'], ['device', 'This screen']], s.positionSource === 'device' ? 'device' : 'car', v => set('positionSource', v)),
      this.positionNow));
    this.showPositionStatus();
  }

  /** The position source's state: the screen's last fix, or what's wrong. */
  showPositionStatus() {
    const out = this.positionNow;
    if (!out) return;
    const app = this.app;
    if (app.settings.positionSource !== 'device') { out.textContent = 'From the telematics box.'; return; }
    if (!window.WebHudApp?.setLocation) { out.textContent = 'Needs the HUD\'s Android app on the car\'s screen.'; return; }
    const f = app.deviceFix;
    if (!f) { out.textContent = 'Waiting for a fix from this screen.'; return; }
    if (f.error) { out.textContent = f.error; return; }
    const age = (Date.now() - (f.at ?? f.rx)) / 1000;
    out.textContent = age > 5 ? `No fix for ${Math.round(age)} s.`
      : `Fix ${f.acc != null ? `\u00b1${Math.round(f.acc)} m` : ''}, ${age.toFixed(1)} s old` + (f.bearing != null ? `, heading ${Math.round(f.bearing)}\u00b0` : '');
  }

  /** What the server has of the map around the car (GET /map/status). */
  showMapStatus() {
    const out = this.mapStatus;
    if (!out) return;
    fetch('/map/status').then(r => (r.ok ? r.json() : null)).then((st) => {
      if (!st || out !== this.mapStatus) return;
      if (!st.center) { out.textContent = 'Waiting for a position.'; return; }
      out.textContent = `Within ${st.radius_km} km: ${st.roads_ready}/${st.tiles} road tiles, ${st.features_ready}/${st.tiles} feature tiles` +
        (st.busy ? ', downloading' : '') + (st.errors ? `, ${st.errors} failed` : '');
    }).catch(() => { out.textContent = ''; });
  }

  displayObjects() {
    const s = this.app.settings;
    const body = this.body;
    body.append(el('div.section', el('h3', 'Objects'),
      el('p.desc', 'World model: the radar, the ADAS camera\'s object list and openpilot\'s leads fused into one set of objects, ' +
        'each source weighted by how far it\'s trusted for what it measures, placed on the ground as the car moves and turns. ' +
        'Raw sources: each source drawn as it reports, for checking them against each other.'),
      this.app.segmented([['world', 'World model'], ['raw', 'Raw sources']], s.objectMode, v => this.app.setSetting('objectMode', v))));
    body.append(this.toggleRows([
      ['showOpLeads', 'openpilot leads', 'Show radarState leads the ADAS object list doesn\'t already cover.'],
      ['showLowConf', 'Low-confidence objects', 'World model: also draw, faintly, the objects it doubts, which it otherwise hides: radar-only things standing ' +
        'in your path that openpilot\'s camera model doesn\'t see (to the radar, sign gantries, traffic lights and bridges look like stopped cars), ' +
        'that the radar draws as a wide thin strip, that it hasn\'t classified (point targets need a camera detection too), ' +
        'or that it has tracked for under 1.3 s.'],
      ['showUss', 'Parking sensors', 'Ultrasonic zone arcs around the car at low speed.'],
    ]));
  }

  displayDebug() {
    const s = this.app.settings;
    const set = (k, v) => this.app.setSetting(k, v);
    const body = this.body;
    body.append(this.toggleRows([
      ['showRadar', 'Radar objects', 'Every track of the mid-range radar (its private CAN, bus 1) as a see-through car, with a ring at the point it reports, ' +
        'to check the radar decoding against the camera\'s cars. Needs a harness that taps the radar bus.'],
      ['radarAllTracks', 'All radar tracks', 'Radar objects: also show tracks younger than 1.3 s, most of which flicker in and out (the radar reports every candidate).'],
      ['showObjectStats', 'Object stats', 'Tag every object with its source (ADAS camera, openpilot, radar), track ID, position (x ahead, y left/right), ' +
        'speed over the ground and relative, heading and size, in m, m/s and degrees. The ADAS reports no speeds: those are this view\'s estimate.'],
      ['demoInfotainment', 'Demo music & navigation', 'A made-up playlist and route in the music and navigation cards, the next turn ' +
        'coming nearer as the car drives, for trying them without the head unit.'],
      ['carDemo', 'Demo car controls', 'Also show the car-control menus\' mockups: controls with nothing on the car behind them (Connectivity, ' +
        'Navigation, Profiles, the climate temperatures, Hollywood Mode...), tagged Demo. Off, the menus hold only what sends to the car, ' +
        'reads from it, or can\'t be set from here and says why.'],
      ['demoCarState', 'Demo live car state', 'Fill the "From the car" read-out in the car-control menus with made-up values, ' +
        'for trying it without the car\'s CAN link.'],
      ['showFps', 'Frame rate', 'Frames per second under the status card. Tap it for the slowest frame, the HUD\'s own script time per frame, ' +
        'draw calls, triangles and the render resolution.'],
    ]));
    body.append(el('div.section', el('h3', 'Render resolution'),
      el('p.desc', 'The 3D view\'s resolution, as a share of the screen\'s. While frames come slower than the screen refreshes, Auto ' +
        'first drops the blur behind the HUD\'s cards, then steps the resolution down (to 60%), and brings them back once frames keep up. ' +
        'The counter shows the resolution when it\'s below 100%.'),
      this.app.segmented([['auto', 'Auto'], ['1', 'Full'], ['0.75', '75%'], ['0.5', '50%']], s.renderScale, v => set('renderScale', v))));
    body.append(el('div.section', el('h3', 'Geometry calibration'),
      el('p.desc', 'The ADAS lane heading direction is verified on the car; lane curvature and object heading signs aren\'t documented. ' +
        'Flip these if lines bend or cars point the wrong way compared to the openpilot lanes.'),
      el('div.rows',
        el('div.row', el('div.lbl', el('b', 'Measured sensor calibration'),
          el('small', 'World model: correct each source by what replaying drives against GPS, openpilot\'s leads and lanes measured: ' +
            'the ADAS camera\'s object range (0.8x the radar\'s, from about the rear axle) and lateral scale and latency, the radar\'s ' +
            'Doppler scale and a 0.6 deg yaw, and the wheel speed (3% low). Off takes every source as it decodes, for comparison.')),
          this.app.switch(s.calibration !== false, v => { set('calibration', v); this.app.toast(v ? 'Measured calibration on' : 'Calibration off'); })),
        el('div.row', el('div.lbl', el('b', 'Invert lane heading')), this.app.switch(s.laneHeadingSign === -1, v => set('laneHeadingSign', v ? -1 : 1))),
        el('div.row', el('div.lbl', el('b', 'Invert lane curvature')), this.app.switch(s.laneCurvatureSign === -1, v => set('laneCurvatureSign', v ? -1 : 1))),
        el('div.row', el('div.lbl', el('b', 'Invert object heading')), this.app.switch(s.objectHeadingSign === -1, v => set('objectHeadingSign', v ? -1 : 1))),
      )));
  }

  // ---- playback ---------------------------------------------------------------------------------------

  async renderPlayback() {
    const body = this.body;
    const state = this.app.state;
    if (state && state.mode === 'replay' && state.replay) {
      const r = state.replay;
      body.append(el('div.banner', `Playing ${r.route} · ${fmtTime(r.t)} / ${fmtTime(r.duration)}`, ' ',
        el('button.btn', { onclick: () => { this.app.replay('live'); this.close(); } }, 'Back to live')));
    }
    const input = el('input', { type: 'file', accept: '.zst,.bz2,.rlog,.qlog,*/*', style: { display: 'none' }, onchange: e => this.upload(e.target.files[0]) });
    const dz = el('div.dropzone', { onclick: () => input.click() }, 'Drop an rlog / qlog file here, or tap to choose one', input);
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) this.upload(e.dataTransfer.files[0]); });
    body.append(dz);
    if (state && state.server && state.server.moving) body.append(el('div.banner.warn', 'Playback is unavailable while the car is moving.'));
    body.append(el('div.btns', { style: { marginTop: '0', marginBottom: '16px' } },
      el('button.btn', { onclick: () => { this.app.replay('demo'); this.close(); } }, 'Play demo drive')));

    const list = el('div.routes', el('p.desc', 'Loading routes…'));
    body.append(el('div.section', el('h3', 'Routes on this device'), list));
    let data;
    try { data = await api('/api/routes'); } catch (e) { list.innerHTML = ''; list.append(el('div.banner.bad', e.message)); return; }
    if (this.tab !== 'playback') return;
    list.innerHTML = '';
    if (!data.routes.length) list.append(el('p.desc', 'No recorded routes found.'));
    for (const r of data.routes.slice(0, 60)) {
      const when = new Date(r.mtime * 1000);
      list.append(el('div.route',
        el('div', el('b', r.name), el('small', `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${r.segments.length} seg · ${fmtBytes(r.size)}`)),
        el('div.segs',
          el('button', { onclick: () => this.play(r.name, null) }, '▶ Play'),
          r.segments.map(sg => el('button', { title: sg.kind, onclick: () => this.play(r.name, sg.n) }, String(sg.n))))));
    }
  }

  play(route, segment) {
    this.app.replay('load', { route, segment });
    this.close();
  }

  async upload(file) {
    if (!file) return;
    this.app.toast(`Uploading ${file.name} (${fmtBytes(file.size)})…`, 60000);
    try {
      await api(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'PUT', body: file });
      this.app.toast('Uploaded — starting playback');
      this.close();
    } catch (e) {
      this.app.toast(`Upload failed: ${e.message}`);
    }
  }

  // ---- signal browser ---------------------------------------------------------------------------------

  // The car's buses as the app reads them (the IBUS DBC, decoded in the worker; the messages the app lets through),
  // or the comma's ADAS bus (the ADASBUS DBC) while it's connected. An IBUS2 message the comma's ADAS bus is giving
  // says so: the worker takes it from the comma then, complete, rather than from the gateway's mirror.
  // Why the car controls' sends might not reach the car: what was sent and what the CAN helper answered, and the
  // interfaces as the kernel has them (bus state, listen-only, error counters, frames out). Copy it into a chat.
  linkCheck() {
    const out = el('pre.diag');
    const app = window.WebHudApp;
    const run = () => {
      try { out.textContent = app.canDiag(); } catch (e) { out.textContent = `Couldn't check: ${e.message}`; }
    };
    const copy = () => navigator.clipboard?.writeText(out.textContent).then(() => this.app.toast('Copied'), () => this.app.toast('Couldn\'t copy: select the text instead'));
    return el('div.section',
      el('h3', 'Sending to the car'),
      el('p.desc', 'Try a car control (lock, a window, a seat), then check here: it shows what went out, what the CAN helper said, and the state of the CAN chips.'),
      el('div.row', el('div.lbl', el('small', app && app.canDiag ? '' : 'Only in the app on the car')),
        el('button.btn', { disabled: !(app && app.canDiag), onclick: run }, 'Check the link'),
        el('button.btn', { onclick: copy }, 'Copy')),
      out);
  }

  renderSignals() {
    const body = this.body;
    const adas = this.sigBus === 'ADAS';
    if (adas && !this.app.commaConnected) this.sigBus = 'IBUS1';
    const bus = this.sigBus;
    const dbc = bus === 'ADAS' ? this.app.dbc : this.app.ibusDbc;
    body.append(el('div.subnav', this.app.segmented(SIG_SOURCES.filter(([k]) => k !== 'ADAS' || this.app.commaConnected), bus,
      v => { this.sigBus = v; this.show('signals'); })));
    if (!dbc || !dbc.messages.length) {
      body.append(el('p.desc', 'Loading DBC…'));
      return;
    }
    const ids = bus === 'ADAS' ? null : new Set(RX_IDS[bus]);
    const messages = dbc.messages.filter(m => !ids || ids.has(m.address));
    const filter = el('input.sig-filter', { type: 'search', placeholder: 'Filter messages or signals (e.g. Obj1, VCU, 0x31C)', value: this.sigFilter || '' });
    const list = el('div');
    if (bus === 'IBUS1') body.append(this.linkCheck());
    body.append(el('p.desc', bus === 'ADAS'
      ? 'Live decoded ADASBUS messages (Fisker FM29 matrix), from the frames the comma streams. Tap a message to watch its signals.'
      : `Live decoded ${bus} messages (FM29 ${bus} matrix), as Pulse's CAN controller reads them from the car` +
        (bus === 'IBUS2' ? ', the gateway\'s mirror of the ADAS bus among them' : '') +
        `: the ${messages.length} messages the app listens for. Tap a message to watch its signals.`), filter, list);
    const draw = () => {
      const q = (this.sigFilter || '').toLowerCase();
      list.innerHTML = '';
      this.msgNodes = new Map();
      for (const m of messages) {
        const hex = '0x' + m.address.toString(16).toUpperCase().padStart(3, '0');
        const match = !q || m.name.toLowerCase().includes(q) || hex.toLowerCase().includes(q) ||
          m.signals.some(s => s.name.toLowerCase().includes(q) || (s.comment || '').toLowerCase().includes(q));
        if (!match) continue;
        const key = bus + '/' + hex;
        const open = this.expanded.has(key);
        const info = el('em', ''), via = el('i', '');
        const node = el('div.msg',
          el('button', { onclick: () => { open ? this.expanded.delete(key) : this.expanded.add(key); draw(); this.subscribe(); } },
            el('b', hex), el('small', `${m.name}${m.comment ? ' — ' + m.comment : ''}`), via, info));
        let table = null;
        if (open) {
          table = el('table');
          for (const sg of m.signals) {
            table.append(el('tr', { dataset: { sig: sg.name } }, el('td', sg.name, el('div', { style: { color: 'var(--muted)', fontFamily: 'var(--font)' } }, sg.comment || '')),
              el('td.v', '—')));
          }
          node.append(table);
        }
        this.msgNodes.set(hex, { node, info, via, table, msg: m });
        list.append(node);
      }
      this.updateRaw();
    };
    filter.addEventListener('input', () => { this.sigFilter = filter.value; draw(); });
    this.rawData = {};
    draw();
    this.subscribe();
  }

  /** The worker watches the open messages of the bus on show (both IBUS buses come from one decoder). */
  subscribe() {
    const bus = this.sigBus, prefix = bus + '/';
    const addrs = this.tab === 'signals' ? [...this.expanded].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)) : [];
    // every message is watched for its age and rate; the open ones' signals are what the table shows
    const all = this.msgNodes ? [...this.msgNodes.keys()] : [];
    this.app.subscribeRaw(bus === 'ADAS' ? 'adas' : 'ibus', this.tab === 'signals' ? [...new Set([...addrs, ...all])] : []);
  }

  onRaw(source, data) {
    if ((source === 'adas') !== (this.sigBus === 'ADAS')) return;
    this.rawData = data;
    if (this.tab === 'signals' && this.isOpen) this.updateRaw();
  }

  updateRaw() {
    if (!this.msgNodes) return;
    const busSrc = { IBUS1: 0, IBUS2: 2 }[this.sigBus];
    for (const [hex, n] of this.msgNodes) {
      const d = this.rawData[hex];
      // one decoder holds both IBUS buses: a message seen on the other one isn't this bus's
      if (!d || (busSrc !== undefined && d.src !== busSrc)) { n.info.textContent = this.sigBus === 'ADAS' ? '' : 'not seen'; continue; }
      n.info.textContent = `${d.count} frames · ${d.age < 1 ? 'live' : d.age + ' s ago'}`;
      n.via.textContent = d.via === 'comma' ? 'via comma' : '';
      if (!n.table) continue;
      for (const tr of n.table.rows) {
        const name = tr.dataset.sig;
        const v = d.signals[name];
        const sig = n.msg.signals.find(sg => sg.name === name);
        const lbl = sig && sig.values && v != null ? sig.values[String(Math.round((v - sig.offset) / sig.factor))] : null;
        const td = tr.cells[1];
        const text = v == null ? '—' : `${v}${sig && sig.unit ? ' ' + sig.unit : ''}`;
        td.innerHTML = '';
        td.append(text);
        if (lbl) td.append(el('small', prettyLabel(lbl)));
      }
    }
  }

  // ---- about ------------------------------------------------------------------------------------------

  async renderAbout() {
    const body = this.body;
    // the app's version and its updates, as on the car controls' Software sheet (appupdate.js)
    body.append(el('div.section', el('h3', 'Oceanfront View'), this.app.car.appUpdate.render(true)));
    const src = { car: this.app.state && this.app.state.comma ? "The car's IBUS1/IBUS2, with the comma's ADAS bus, radar and openpilot" : "The car's IBUS1/IBUS2",
      comma: 'The comma alone (no car buses here)', replay: 'A drive the comma is replaying', none: 'Nothing yet: the car is asleep, or this isn\'t the car\'s screen' }[this.app.source];
    body.append(el('div.section', el('h3', 'Driving data'), el('div.kv', el('span', 'Source'), el('span', src))));
    let st = null;
    if (this.app.commaConnected) { try { st = await api('/api/status'); } catch { st = null; } }
    if (this.tab !== 'about') return;
    if (st) {
      body.append(el('div.section', el('h3', 'Comma'), el('div.kv',
        el('span', 'Bridge'), el('span', st.version),
        el('span', 'Mode'), el('span', st.mode),
        el('span', 'Car'), el('span', st.brand || 'unknown'),
        el('span', 'mDNS'), el('span', `${st.hostname} via ${st.mdns}`),
        el('span', 'Onroad'), el('span', st.onroad ? 'yes' : 'no'),
        el('span', 'Live data'), el('span', st.liveError ? `unavailable (${st.liveError})` : 'ok'),
        ...st.urls.flatMap(u => [el('span', u.includes('.local') ? 'mDNS' : 'IP'), el('a', { href: u }, u)]),
      )));
    }
    body.append(el('p.desc', 'Touch: one finger rotates around the car, two fingers zoom and pan. The view recenters on the car a few seconds after you let go.'));
    body.append(el('div.section', el('h3', 'Credits'), el('p.desc',
      'Fisker Ocean 3D model: Pulse Ocean v0.10. Paint colors are approximations of the factory paint chips (',
      el('a', { href: 'https://www.automotivetouchup.com/touch-up-paint/fisker-automotive/2023/all-models/', target: '_blank' }, 'AutomotiveTouchup'), ', ',
      el('a', { href: 'https://www.carwow.co.uk/fisker/ocean/colours', target: '_blank' }, 'Carwow'),
      '). 3D rendering by three.js (MIT).')));
  }
}
