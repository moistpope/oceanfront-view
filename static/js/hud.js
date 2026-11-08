import { cameraSignUnit, cameraSignValue, signStyle, leftTraffic } from './regional.js';
// DOM overlay: speed, gear, steering assist (MADS), ACC set speed + gap, speed limit, telltales, alerts.
import { $, $$, el, icon, iconSvg, setClass, setText, setClassName, setStyleVar, prettyLabel, MS_TO_KPH, MS_TO_MPH } from './util.js';
import { EnergyDetails } from './energy.js';

const BELT_HOLD_S = 1.5;   // s the driver's belt must read unbuckled before its light shows

const GEAR_LETTER = {
  park: 'P', reverse: 'R', neutral: 'N', drive: 'D', eco: 'D', sport: 'D', low: 'D', brake: 'D', manumatic: 'D',
  gear_P: 'P', gear_N: 'N', R_gear: 'R', D_gear: 'D', gear_D: 'D', gear_E: 'D', gear_S: 'D',
};
const PERSONALITY_BARS = { aggressive: 1, standard: 2, relaxed: 3 };


// The power bar up the energy card's outer edge: Tesla's bar without the graduations. Its origin is the middle;
// consumption draws up in the text color, regeneration down in green. The value is the motors' electrical power from
// the Fisker bus (fisker_world.js power: kw actual, demandKw asked), eased so it reads. A tap shows the last minute as a
// trace at the card's foot, now at the bar's end and fading out inward: consumption above the line, regen below. The
// battery's details (energy.js) open from the charge.
const ECON_DRIVE_KW = 180;   // full scale to the right
const ECON_REGEN_KW = 60;    // ...and to the left (the Ocean regenerates far less than it drives)
const ECON_SECONDS = 60;
class Econ {
  constructor(app) {
    this.box = $('#econ');
    this.card = $('#energycard');
    this.canvas = $('#econ-graph');
    this.kw = 0;
    this.hist = [];   // [t, kw]
    this.lastAt = 0;
    this.details = new EnergyDetails(app);
    this.box.addEventListener('click', () => {
      this.card.classList.toggle('graph');
      if (this.card.classList.contains('graph')) this.draw(performance.now() / 1000);
    });
  }
  update(kw, t, carState) {
    this.details.sample(carState, t);
    const have = kw != null && isFinite(kw);
    setClass(this.box, 'hidden', !have && t - this.lastAt > 3);
    if (!have) return;
    this.lastAt = t;
    this.kw += (kw - this.kw) * 0.25;
    const v = Math.abs(this.kw) < 0.3 ? 0 : this.kw;
    // how far each side reaches, as a share of the bar (across it, or up and down it in the wide strip: app.css)
    // (to a fifth of a percent of the bar: below a pixel, and steady at a steady power, so it isn't rewritten every frame)
    const share = (x, full) => `${(Math.round(Math.min(50, Math.max(0, x) / full * 50) * 5) / 5).toFixed(1)}%`;
    setStyleVar(this.box, '--pos', share(v, ECON_DRIVE_KW));
    setStyleVar(this.box, '--neg', share(-v, ECON_REGEN_KW));
    this.hist.push([t, kw]);
    while (this.hist.length && t - this.hist[0][0] > ECON_SECONDS) this.hist.shift();
    if (this.card.classList.contains('graph')) this.draw(t);
  }
  draw(t) {
    const c = this.canvas, ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width, h = c.height, mid = h * 0.65;   // more room above the line: consumption is the bigger number
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(this.box);
    // now at the bar's end of the card: the right, or the left with the driver on the right
    const rhd = document.documentElement.classList.contains('rhd');
    const x = (tt) => rhd ? (t - tt) / ECON_SECONDS * w : w - (t - tt) / ECON_SECONDS * w;
    const y = (kw) => kw >= 0 ? mid - Math.min(1, kw / ECON_DRIVE_KW) * mid : mid + Math.min(1, -kw / ECON_REGEN_KW) * (h - mid);
    for (const [sign, color] of [[1, style.getPropertyValue('--text')], [-1, style.getPropertyValue('--green')]]) {
      ctx.beginPath();
      ctx.moveTo(x(this.hist[0]?.[0] ?? t), mid);
      for (const [tt, kw] of this.hist) ctx.lineTo(x(tt), y(sign > 0 ? Math.max(0, kw) : Math.min(0, kw)));
      ctx.lineTo(x(t), mid);
      ctx.closePath();
      ctx.fillStyle = color.trim() || '#888';
      ctx.globalAlpha = 0.85;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = (style.getPropertyValue('--muted') || '#888').trim();
    ctx.fillRect(0, mid - 0.5, w, 1);
  }
}

export class Hud {
  constructor(app) {
    this.app = app;
    this.econ = new Econ(app);
    this.speed = $('#speed');
    this.unit = $('#speed-unit');
    this.latIcon = $('#lat-icon');
    this.latIcon.innerHTML = iconSvg('wheel');
    this.setspeed = $('#setspeed');
    this.setspeedVal = $('#setspeed-val');
    this.gap = $('#gap');
    this.limit = $('#limit');
    this.assistText = $('#assist-text');
    this.alerts = $('#alerts');
    this.telltales = $('#telltales');
    this.roadinfo = $('#roadinfo');
    this.roadname = $('#roadname');
    this.roadnameName = $('#roadname-name');
    this.roadnameRef = $('#roadname-ref');
    this.lastRoadName = { key: '', at: 0 };
    this.blinkL = $('#blink-l');
    this.blinkR = $('#blink-r');
    this.gears = $$('#gear span');
    this.tt = {};
    for (const name of ['beam', 'belt', 'door', 'hands', 'eye', 'bsd', 'aeb', 'warn']) {
      this.tt[name] = icon(name);
      this.tt[name].classList.add('hidden');
      this.telltales.append(this.tt[name]);
    }
    this.lastAlertKey = '';
    this.lastRoadKey = '';
    this.isMetric = null;
    // the energy card (index.html): the time, the battery's charge and range (a tap: its details), the temperature
    this.ec = { clock: $('#ec-clock'), soc: $('#ec-soc'), unit: $('#ec-unit'), temp: $('#ec-temp') };
    $('#ec-batt').addEventListener('click', () => this.econ.details.open());
    this.clockMin = -1;
    this.rhd = false;
  }

  unitFor(settings, f) {
    if (settings.units === 'mph' || settings.units === 'kmh') return settings.units;
    const icc = f && f.vehicle && f.vehicle.displayUnit;
    if (icc) return icc;
    return this.isMetric ? 'kmh' : 'mph';
  }

  update(state, settings, vehicle) {
    const op = state.op || {};
    const f = state.fisker;
    const cs = op.carState;
    const unit = this.unitFor(settings, f);
    const conv = unit === 'kmh' ? MS_TO_KPH : MS_TO_MPH;

    // power: the motors' electrical power from the Fisker bus, when it's there
    const pw = f && f.power ? (f.power.kw != null ? f.power.kw : f.power.demandKw) : null;
    this.econ.update(pw, performance.now() / 1000, this.app.carState);

    // speed: what the cluster shows (ICC display speed via carState.vEgoCluster), else Fisker CAN
    let v = null;
    if (cs) v = (cs.vEgoCluster != null && cs.vEgoCluster > 0 ? cs.vEgoCluster : cs.vEgo) * conv;
    else if (f && f.vehicle && f.vehicle.displaySpeed != null && f.vehicle.displayUnit === unit) v = f.vehicle.displaySpeed;
    else if (f && f.vehicle && f.vehicle.speedKph != null) v = f.vehicle.speedKph / 3.6 * conv;
    setText(this.speed, v == null ? '--' : String(Math.max(0, Math.round(v))));
    setText(this.unit, unit === 'kmh' ? 'km/h' : 'mph');

    // gear
    const g = GEAR_LETTER[(cs && cs.gear) || ''] || GEAR_LETTER[(f && f.vehicle && f.vehicle.gear) || ''] || '';
    this.gears.forEach(s => setClass(s, 'on', s.dataset.g === g));

    // blinkers mirror the car's flashing lamp outputs (see vehicle.js)
    const lights = (f && f.vehicle && f.vehicle.lights) || {};
    setClass(this.blinkL, 'on', vehicle.lamps.left);
    setClass(this.blinkR, 'on', vehicle.lamps.right);

    this._assist(op, f, unit, conv);
    this._limit(op, f, unit, conv, v, settings);
    this._telltales(op, f, cs, lights);
    this._alerts(state, op, f);
    this._roadinfo(f, unit);
    this._roadname(state);
    this._energy(f, unit);
    this._driverSide(settings, f);
  }

  // The driver's side: as set (Display -> Driver's side), else the right where traffic keeps left. The layout mirrors
  // for a driver on the right (app.css html.rhd).
  _driverSide(settings, f) {
    const rhd = settings.driverSide === 'right' || (settings.driverSide !== 'left' && leftTraffic(settings, f));
    if (rhd === this.rhd) return;
    this.rhd = rhd;
    document.documentElement.classList.toggle('rhd', rhd);
    this.app.updateLayout();
  }

  // The energy card: the time (to the minute), the battery's usable charge and the range the car estimates (the car's
  // own buses, carstate.js), and the outside temperature, in the speed's units.
  _energy(f, unit) {
    const cs = this.app.carState, now = new Date(), min = now.getHours() * 60 + now.getMinutes();
    if (min !== this.clockMin) {
      this.clockMin = min;
      setText(this.ec.clock, now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    }
    const soc = cs ? cs.value('BMS_Bat_SoC_usable') : undefined;
    setText(this.ec.soc, soc == null ? '--' : String(Math.round(soc)));
    const km = cs && cs.label('VCU_DrvRngVld') === 'Valid' ? cs.value('VCU_DrvgMilg') : undefined;
    const range = km == null ? '' : unit === 'kmh' ? `${Math.round(km)} km` : `${Math.round(km / 1.609344)} mi`;
    setText(this.ec.unit, range ? `% · ${range}` : '%');
    let tc = f && f.vehicle ? f.vehicle.outsideTempC : null;
    if (tc == null && cs && cs.value('ECC_OutdTVld') === 1) tc = cs.value('ECC_OutdT');
    setText(this.ec.temp, tc == null ? '' : unit === 'kmh' ? `${Math.round(tc)}°C` : `${Math.round(tc * 9 / 5 + 32)}°F`);
  }

  // The road we're on, bottom center: the map match's name and ref (mapmatch.js), else the road name
  // sunnypilot's mapd reports; the last one stays, dimmed, for a while when neither has one.
  _roadname(state) {
    const m = state.map, way = m && m.way;
    const mapd = state.op && state.op.liveMapDataSP && state.op.liveMapDataSP.roadName;
    let name = '', ref = '', stale = false;
    const pretty = (r) => (r || '').split(';').map(x => x.trim()).filter(Boolean).join(' · ');
    if (way && (way.name || way.ref)) { name = way.name || pretty(way.ref); ref = way.name ? pretty(way.ref) : ''; }
    else if (mapd) { name = pretty(mapd); }
    const now = performance.now();
    if (name) this.lastRoadName = { key: name + '|' + ref, name, ref, at: now };
    else if (now - this.lastRoadName.at < 8000 && this.lastRoadName.name) { name = this.lastRoadName.name; ref = this.lastRoadName.ref; stale = true; }
    setClass(this.roadname, 'hidden', !name);
    setClass(this.roadname, 'stale', stale);
    if (!name) return;
    const key = name + '|' + ref;
    if (this.roadname.dataset.key !== key) {
      this.roadname.dataset.key = key;
      setText(this.roadnameName, name);
      setText(this.roadnameRef, ref);
    }
  }

  _assist(op, f, unit, conv) {
    const mads = op.selfdriveStateSP && op.selfdriveStateSP.mads;
    const cc = op.carControl;
    const ss = op.selfdriveState;
    const tja = f && f.assist && f.assist.tja;
    let latCls = '';
    let latText = '';
    if (cc && cc.latActive) { latCls = 'active'; latText = mads && mads.enabled && !(ss && ss.enabled) ? 'MADS steering' : 'Steering'; }
    else if (mads && mads.state === 'softDisabling') { latCls = 'warn'; latText = 'Take over'; }
    else if (mads && mads.enabled) { latCls = 'override'; latText = mads.state === 'overriding' ? 'Driver steering' : 'Steering paused'; }
    else if (tja && (tja.v === 3 || tja.v === 4)) { latCls = 'active'; latText = 'Fisker autosteer'; }
    else if (!cc && f && f.vehicle && f.vehicle.epsLatCtrl && f.vehicle.epsLatCtrl.v === 2) { latCls = 'active'; latText = 'Steering'; }   // the car's own buses: the EPS is being steered
    else if ((mads && mads.available) || (ss && ss.engageable) || (!cc && f && f.vehicle && f.vehicle.epsLatCtrl && f.vehicle.epsLatCtrl.v === 1)) latCls = 'available';
    setClassName(this.latIcon, 'assist-icon ' + latCls);

    // ACC set speed: Fisker ADAS (cluster unit) first, then openpilot's cruise state
    const acc = f && f.acc;
    const cs = op.carState;
    let set = null, engaged = false, available = false;
    if (acc && acc.state) {
      engaged = !!acc.engaged;
      available = ![0, 1, 9, 10].includes(acc.state.v);
      if (acc.setSpeed != null) {
        const iccUnit = f.vehicle && f.vehicle.displayUnit;
        set = iccUnit && iccUnit !== unit ? acc.setSpeed * (unit === 'kmh' ? 1.609344 : 1 / 1.609344) : acc.setSpeed;
      }
    }
    if (cs && cs.cruise) {
      engaged = engaged || cs.cruise.enabled;
      available = available || cs.cruise.available;
      if (set == null && cs.cruise.speedCluster > 0) set = cs.cruise.speedCluster * conv;
    }
    if (op.selfdriveState && op.selfdriveState.enabled && cs && cs.vCruiseCluster > 0 && cs.vCruiseCluster < 255) {
      set = cs.vCruiseCluster / 3.6 * conv;
      engaged = true;
    }
    setText(this.setspeedVal, set == null ? '--' : String(Math.round(set)));
    setClassName(this.setspeed, 'setspeed ' + (engaged ? 'engaged' : available ? 'available' : 'off'));

    // following distance: Fisker time gap (1-4) or openpilot personality (1-3)
    let bars = 0, maxBars = 4;
    if (acc && acc.timeGap >= 1 && acc.timeGap <= 4) bars = acc.timeGap;
    else if (cc && cc.hud && cc.hud.leadDistanceBars) { bars = cc.hud.leadDistanceBars; maxBars = 3; }
    else if (op.selfdriveState && PERSONALITY_BARS[op.selfdriveState.personality]) { bars = PERSONALITY_BARS[op.selfdriveState.personality]; maxBars = 3; }
    $$('i', this.gap).forEach((b, i) => { setClass(b, 'on', i < bars); const d = i < maxBars ? '' : 'none'; if (b.style.display !== d) b.style.display = d; });
    setClass(this.gap, 'engaged', engaged);

    // status line
    const md = op.modelV2;
    let text = '';
    if (md && md.laneChangeState && md.laneChangeState !== 'off') {
      text = `Changing lanes ${md.laneChangeDirection === 'left' ? '←' : '→'}`;
    } else if (latText || engaged) {
      const parts = [];
      if (latText) parts.push(latText);
      if (engaged) parts.push(set != null ? `ACC ${Math.round(set)}` : 'ACC');
      text = parts.join(' · ');
    } else if (op.selfdriveState && op.selfdriveState.experimentalMode) text = 'Experimental mode';
    const bold = latCls === 'active' || engaged, key = (bold ? 'b:' : ':') + text;
    if (this.assistKey !== key) {   // (rebuilt only when it changes: the HUD updates every frame)
      this.assistKey = key;
      this.assistText.innerHTML = '';
      if (text) this.assistText.append(bold ? el('b', text) : text);
    }
  }

  _limit(op, f, unit, conv, v, settings) {
    let value = null, style = signStyle(settings, unit, f);
    const tsr = f && f.tsr;
    if (tsr && tsr.speedLimit) {
      value = cameraSignValue(settings, tsr, unit);
      const sourceUnit = cameraSignUnit(settings, tsr);
      style = signStyle(settings, sourceUnit || unit, f);
    } else {
      const sl = op.longitudinalPlanSP && op.longitudinalPlanSP.speedLimit;
      const ms = sl && sl.valid && sl.value > 0 ? sl.value : (op.liveMapDataSP && op.liveMapDataSP.speedLimit);
      if (ms) value = Math.round(ms * conv);
    }
    setClass(this.limit, 'hidden', !value);
    if (!value) return;
    const over = v != null && v > value + 2;
    const key = `${style}${value}${over}`;
    if (this.limit.dataset.key === key) return;
    this.limit.dataset.key = key;
    this.limit.className = `limit ${style}${over ? ' over' : ''}`;
    this.limit.innerHTML = style === 'us' ? `<small>SPEED</small><small>LIMIT</small><b>${value}</b>` : `${value}`;
  }

  _telltales(op, f, cs, lights) {
    const show = (name, color) => {
      const t = this.tt[name];
      setClassName(t, 'tt' + (color ? ' ' + color : '') + (color === false ? ' hidden' : ''));
    };
    show('beam', lights.high ? 'blue' : (lights.low ? 'green' : false));
    // unbuckled for BELT_HOLD_S on end: a frame or two of "not buckled" (the buckle switch's message now and then
    // reads so for a moment) flickered the light
    const unlatched = (cs && cs.seatbeltUnlatched) || (f && f.vehicle && f.vehicle.seatbelt && f.vehicle.seatbelt.driver === 1);
    const now = performance.now() / 1000;
    if (!unlatched) this.beltSince = null; else if (this.beltSince == null) this.beltSince = now;
    show('belt', this.beltSince != null && now - this.beltSince >= BELT_HOLD_S ? 'red' : false);
    const doors = f && f.vehicle && f.vehicle.doors;
    const doorOpen = (cs && cs.doorOpen) || (doors && (doors.fl || doors.fr || doors.rl || doors.rr || doors.trunk || doors.hood));
    show('door', doorOpen ? 'red' : false);
    const hands = f && f.assist && ((f.assist.handsOnRequest && f.assist.handsOnRequest.v) || (f.assist.hodWarning && f.assist.hodWarning.v));
    show('hands', hands ? 'amber' : false);
    const dm = op.driverMonitoringState;
    show('eye', dm && dm.distracted ? 'amber' : false);
    const bsd = f && f.threats && f.threats.bsdState;
    show('bsd', bsd && bsd.v === 4 ? 'amber' : (bsd && bsd.v === 0 ? '' : false));
    const aeb = f && f.aeb && f.aeb.warning && f.aeb.warning.v;
    show('aeb', aeb ? 'red' : false);
    const fault = f && f.warnings && f.warnings.sysFault && f.warnings.sysFault.v;
    show('warn', fault ? (fault >= 2 ? 'red' : 'amber') : false);
  }

  _alerts(state, op, f) {
    const items = [];
    const ss = op.selfdriveState;
    if (ss && ss.alertSize && ss.alertSize !== 'none' && (ss.alertText1 || ss.alertText2)) {
      items.push({ cls: ss.alertStatus || 'normal', t1: ss.alertText1, t2: ss.alertText2 });
    }
    if (f && f.warnings) {
      const w = f.warnings;
      if (w.takeover && w.takeover.v >= 1 && w.takeover.v <= 3) items.push({ cls: 'critical', t1: 'Take control', t2: 'Fisker ADAS takeover request' });
      if (f.aeb && f.aeb.warning && f.aeb.warning.v >= 2) items.push({ cls: 'critical', t1: 'Collision warning', t2: prettyLabel(f.aeb.warning.n) });
      if (w.text && w.text.v) items.push({ cls: 'userPrompt', t1: prettyLabel(w.text.n), t2: 'Fisker ADAS' });
      if (w.highPriority && w.highPriority.v) items.push({ cls: 'userPrompt', t1: prettyLabel(w.highPriority.n), t2: '' });
    }
    const notice = state.server && state.server.notice;
    if (notice) items.push({ cls: 'info', t1: notice, t2: '' });
    const key = JSON.stringify(items);
    if (key === this.lastAlertKey) return;
    this.lastAlertKey = key;
    this.alerts.innerHTML = '';
    for (const a of items.slice(0, 3)) this.alerts.append(el(`div.alert.${a.cls}`, el('b', a.t1 || ''), a.t2 ? el('span', a.t2) : null));
  }

  _roadinfo(f, unit) {
    const rows = [];
    if (f) {
      const tlr = f.tlr;
      if (tlr && tlr.detected) {
        const color = (tlr.active && tlr.active.color) || tlr.color || '';
        const c = color.toLowerCase();
        const lamp = c.startsWith('red') ? 'red' : c.includes('amber') || c.includes('orange') ? 'amber' : c.includes('green') ? 'green' : '';
        const arrow = /arrow/i.test(tlr.shape || '') ? ` (${prettyLabel(tlr.shape).toLowerCase()})` : '';
        rows.push(['tl', el('div.ri', el(`i.lamp.${lamp || 'none'}`), `${prettyLabel(color || 'Traffic')} light${arrow}`,
          tlr.dist ? el('small', `${Math.round(tlr.dist)} m`) : null)]);
      }
      if (f.tsr && f.tsr.prohibited) rows.push(['ps', el('div.ri', '⛔ ', prettyLabel(f.tsr.prohibited))]);
      // closest park-distance-control reading per bumper (cm), when an obstacle is in range
      const pdc = f.parking && f.parking.pdc;
      for (const [k, name] of [['front', 'Front'], ['rear', 'Rear']]) {
        const vals = pdc ? pdc[k].filter(v => v != null) : [];
        if (vals.length) {
          const cm = Math.min(...vals);
          const txt = unit === 'kmh' ? `${cm} cm` : `${Math.round(cm / 2.54)} in`;
          rows.push([`pdc${k}`, el(`div.ri${cm < 40 ? '.bad' : ''}`, el('i.lamp.' + (cm < 40 ? 'red' : cm < 80 ? 'amber' : 'green')), name, el('small', txt))]);
        }
      }
      const road = f.road || {};
      for (const k of ['construction', 'landmark', 'laneMarking', 'hazard']) {
        const it = road[k];
        if (it && it.dist) rows.push([k, el('div.ri', prettyLabel(it.type || k), el('small', `${it.dist} m`))]);
      }
    }
    const key = rows.map(r => r[0] + r[1].textContent).join('|');
    if (key === this.lastRoadKey) return;
    this.lastRoadKey = key;
    this.roadinfo.innerHTML = '';
    rows.forEach(r => this.roadinfo.append(r[1]));
  }
}
