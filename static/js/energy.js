// Battery and energy details: the sheet behind the energy card's charge (hud.js). First the battery as the BMS and the
// VCU report it on the car's own buses (carstate.js): its usable charge and the range the car estimates, the real
// charge, the energy available, its health and capacity, and the pack's voltage, current and power. Then the VCU's energy
// counters. The VCU keeps energy
// counters by consumer on IBUS1 (0x578-0x57C, 2 Hz, 0.1 kWh steps), one set for driving ("non-charging
// mode": traction, climate, battery thermal management, accessories, external discharge) and one for
// charging (into the battery, climate, battery thermal management, accessories, the charger's losses),
// each with the total and the VCU's own shares in percent. The matrix mislabels the external discharge
// counter as battery thermal management; the signal names are taken as the truth.
//
// The sheet shows each set as its total, a stacked share bar with a legend, and a graph of what each
// consumer counted up over the last WINDOW_SECONDS: a rising staircase whose slope is that consumer's
// power. The counters are sampled all the time (EnergyDetails.sample, from the HUD's frame), so the
// graph has history when the sheet opens. The sheet is built on first open, from the HUD's tokens.
import { el, setClass, setText, iconSvg } from './util.js';

export const WINDOW_SECONDS = 600;
const SAMPLE_SECONDS = 0.5;

export const MODE_SIGNAL = 'VCU_ActEgyCnsTyp';
// what the ICC shows for the energy figure, as the VCU asks (by vehicle speed)
const MODE_TEXT = { 0: '', 1: 'Car shows power', 2: 'Car shows energy per km', 3: '' };

// The hue slots are app.css --s1..--s5 (validated for both themes): the main consumer blue, climate
// orange, battery thermal aqua, accessories yellow, the fifth magenta, the same in both sets.
export const MODES = [
  { key: 'drive', title: 'Driving', total: 'VCU_NotChrgModVehTotCnseEgy', totalLabel: 'used', rows: [
    { key: 'drv', label: 'Driving', sig: 'VCU_NotChrgModVehDrvCnseEgy', perc: 'VCU_NotChrgModVehDrvCnseEgyPerc', slot: 1 },
    { key: 'ecc', label: 'Climate', sig: 'VCU_NotChrgModECCCnseEgy', perc: 'VCU_NotChrgModECCCnseEgyPerc', slot: 2 },
    { key: 'bhm', label: 'Battery thermal', sig: 'VCU_NotChrgModBHMCnseEgy', perc: 'VCU_NotChrgModBHMCnseEgyPerc', slot: 3 },
    { key: 'acsy', label: 'Accessories', sig: 'VCU_NotChrgModAcsyCnseEgy', perc: 'VCU_NotChrgModAcsyCnseEgyPerc', slot: 4 },
    { key: 'ext', label: 'External discharge', sig: 'VCU_NotChrgModExtDchaCnseEgy', perc: 'VCU_NotChrgModExtDchaCnseEgyPerc', slot: 5 },
  ] },
  { key: 'charge', title: 'Charging', total: 'VCU_ChrgModVehTotChrgEgy', totalLabel: 'from the charger', rows: [
    { key: 'batt', label: 'Into the battery', sig: 'VCU_ChrgModVehChrgEgy', perc: 'VCU_ChrgModVehChrgEgyPerc', slot: 1 },
    { key: 'ecc', label: 'Climate', sig: 'VCU_ChrgModECCCnseEgy', perc: 'VCU_ChrgModECCCnseEgyPerc', slot: 2 },
    { key: 'bhm', label: 'Battery thermal', sig: 'VCU_ChrgModBattHeatgMngCnseEgy', perc: 'VCU_ChrgModBHMCnseEgyPerc', slot: 3 },
    { key: 'acsy', label: 'Accessories', sig: 'VCU_ChrgModAcsyCnseEgy', perc: 'VCU_ChrgModAcsyCnseEgyPerc', slot: 4 },
    { key: 'loss', label: 'Charging losses', sig: 'VCU_ChrgModChrgEffCnseEgy', perc: 'VCU_ChrgModChrgEffCnseEgyPerc', slot: 5 },
  ] },
];

/** Samples of a set of counters over the last `seconds`: what each counted up, as a running sum of its
 *  positive steps, so a counter that resets (or a gap in the data) adds nothing rather than going negative. */
export class EnergyLog {
  constructor(seconds = WINDOW_SECONDS) {
    this.seconds = seconds;
    this.samples = [];   // [{ t, v: { key: kWh | undefined } }], one older than the window kept so its step counts
  }
  push(t, v) {
    this.samples.push({ t, v });
    while (this.samples.length > 2 && t - this.samples[1].t > this.seconds) this.samples.shift();
  }
  /** [[t, kWh counted up to t]] for one key. */
  series(key) {
    const out = [];
    let sum = 0, prev;
    for (const s of this.samples) {
      const x = s.v[key];
      if (x != null && prev != null && x > prev) sum += x - prev;
      if (x != null) prev = x;
      out.push([s.t, sum]);
    }
    return out;
  }
  used(key) {
    const s = this.series(key);
    return s.length ? s[s.length - 1][1] : 0;
  }
  /** The average power (kW) over the window of the keys together: the energy between the counter's first
   *  and last step edges over that time, which the 0.1 kWh steps don't bias; null under two steps. */
  rate(keys) {
    const all = keys.map(k => this.series(k));
    const n = all[0]?.length || 0;
    let first = -1, last = -1, prev = 0;
    for (let i = 0; i < n; i++) {
      const v = all.reduce((a, s) => a + s[i][1], 0);
      if (i && v > prev + 1e-9) { if (first < 0) first = i; last = i; }
      prev = v;
    }
    if (first < 0 || last === first) return null;
    const t0 = all[0][first][0], t1 = all[0][last][0];
    const e = all.reduce((a, s) => a + s[last][1] - s[first][1], 0);
    return t1 > t0 ? e / ((t1 - t0) / 3600) : null;
  }
  /** the time the samples span, s */
  get span() { return this.samples.length > 1 ? this.samples[this.samples.length - 1].t - this.samples[0].t : 0; }
  clear() { this.samples.length = 0; }
}

const fmtKwh = (v) => v == null ? '--' : v.toFixed(1);

/** The figures of one set: the VCU's total and shares when it fills them, else the counters summed and the shares
 *  worked out from them (the car's VCU leaves the totals and every share at zero, and fills one counter). */
export function shares(total, vals, percs) {
  const sum = vals.reduce((a, v) => a + (v || 0), 0);
  const whole = total != null && total > 0 ? total : sum;
  const vcu = percs.some(p => p != null && p > 0);
  const pcts = vals.map((v, i) => vcu ? percs[i] : (whole > 0 && v != null ? v / whole * 100 : null));
  return { whole, pcts, computed: !vcu && whole > 0 };
}
const fmtKw = (kw) => kw >= 10 ? kw.toFixed(0) : kw.toFixed(1);
const fmtScale = (v) => v >= 1 ? v.toFixed(1) : String(+v.toFixed(2));   // 0.05, 0.5, 2.0

export class EnergyDetails {
  constructor(app) {
    this.app = app;
    this.logs = {};
    for (const m of MODES) this.logs[m.key] = new EnergyLog();
    this.lastSample = -Infinity;
    this.root = null;
    this.ui = {};
    this.cursor = null;   // { mode, x } while a pointer is over a graph
    this.onKey = (e) => { if (e.key === 'Escape') this.close(); };
  }

  get isOpen() { return !!this.root && !this.root.classList.contains('hidden'); }

  /** Called every frame with the car-state read-out and the time in seconds; samples at SAMPLE_SECONDS. */
  sample(cs, t) {
    if (!cs || t - this.lastSample < SAMPLE_SECONDS) return;
    this.lastSample = t;
    for (const m of MODES) {
      const v = {};
      for (const r of m.rows) v[r.key] = cs.value(r.sig);
      this.logs[m.key].push(t, v);
    }
    if (this.isOpen) this.render(cs, t);
  }

  open() {
    this.build();
    this.root.classList.remove('hidden');
    this.root.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', this.onKey);
    this.render(this.app.carState, performance.now() / 1000);
  }

  close() {
    if (!this.root) return;
    this.root.classList.add('hidden');
    this.root.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', this.onKey);
  }

  build() {
    if (this.root) return;
    const close = el('button.icon.close', { 'aria-label': 'Close', onclick: () => this.close(), html: iconSvg('close') });
    const mode = el('span.chip.en-mode.hidden');
    const body = el('div.dialog-body');
    const b = this.ui.batt = { soc: el('b', '--'), range: el('small.en-total-what', ''), fill: el('i'), kv: el('div.kv.bt-kv') };
    b.empty = el('p.en-empty', 'Waiting for the car…');
    b.live = el('div.en-live.hidden',
      el('div.en-head', el('h3', 'Battery'), el('div.en-total', b.soc, el('small', '%'), b.range)),
      el('div.bt-bar', b.fill), b.kv);
    body.append(el('section.en-sec', b.empty, b.live));
    for (const m of MODES) {
      const u = this.ui[m.key] = {};
      u.total = el('b', '--');
      u.bar = el('div.en-bar');
      u.legend = el('div.en-legend');
      u.rows = {};
      for (const r of m.rows) {
        const row = u.rows[r.key] = { kwh: el('span.kwh', '--'), pct: el('span.pct', ''), rate: el('span.rate', '') };
        u.bar.append(el('i', { style: { background: `var(--s${r.slot})` } }));
        u.legend.append(el('i', { style: { background: `var(--s${r.slot})` } }), el('span.lbl', r.label), row.kwh, row.pct, row.rate);
      }
      u.window = el('span');
      u.canvas = el('canvas.en-graph', { 'aria-label': `${m.title}: energy counted up over the last ${WINDOW_SECONDS / 60} minutes` });
      u.canvas.addEventListener('pointermove', (e) => { this.cursor = { mode: m.key, x: e.offsetX }; this.draw(m, this.lastSample); });
      u.canvas.addEventListener('pointerleave', () => { this.cursor = null; this.draw(m, this.lastSample); });
      u.empty = el('p.en-empty', 'Waiting for the car…');
      u.live = el('div.en-live.hidden',
        el('div.en-head', el('h3', m.title), el('div.en-total', u.total, el('small', 'kWh'), el('small.en-total-what', m.totalLabel))),
        u.bar, u.legend,
        el('div.en-graph-title', el('span', `Last ${WINDOW_SECONDS / 60} minutes`), u.window),
        u.canvas);
      body.append(el('section.en-sec', u.empty, u.live));
    }
    this.ui.foot = el('p.dialog-foot');
    body.append(this.ui.foot);
    const card = el('div.dialog-card', { role: 'dialog', 'aria-label': 'Battery and energy details' },
      el('header', el('h2', 'Battery & energy'), mode, close), body);
    this.root = el('div.dialog.hidden', { id: 'energy', 'aria-hidden': 'true', onclick: (e) => { if (e.target === this.root) this.close(); } }, card);
    this.ui.mode = mode;
    document.getElementById('app').append(this.root);
  }

  // the battery's figures, where the car reports them
  renderBattery(cs) {
    const b = this.ui.batt, v = (n) => cs.value(n);
    const soc = v('BMS_Bat_SoC_usable'), real = v('BMS_Bat_SOC_Real'), soh = v('BMS_Bat_SOH'), cap = v('BMS_Bat_Actual_Pack_Capacity');
    const avl = cs.label('VCU_PwrBattAvlEgy') === 'Invalid' ? undefined : v('VCU_PwrBattAvlEgy');
    const km = cs.label('VCU_DrvRngVld') === 'Valid' ? v('VCU_DrvgMilg') : undefined;
    const volts = v('BMS_Bat_Hvmeasure_V_Pack'), amps = v('BMS_Bat_HVmeasure_Current');
    const live = [soc, real, soh, avl, km, volts].some(x => x != null);
    setClass(b.empty, 'hidden', live);
    setClass(b.live, 'hidden', !live);
    if (!live) return;
    const metric = this.app.hud && this.app.hud.unitFor(this.app.settings, this.app.state && this.app.state.fisker) === 'kmh';
    const dist = (k) => metric ? `${Math.round(k)} km` : `${Math.round(k / 1.609344)} mi`;
    setText(b.soc, soc == null ? '--' : String(Math.round(soc)));
    setText(b.range, km == null ? '' : `${dist(km)} range`);
    b.fill.style.width = `${Math.max(0, Math.min(100, soc ?? 0))}%`;
    const rows = [
      ['Usable charge', soc != null ? `${Math.round(soc)}%` : null],
      ['Real charge', real != null ? `${Math.round(real)}%` : null],
      ['Range', km != null ? dist(km) : null],
      ['Energy available', avl != null ? `${fmtKwh(avl)} kWh` : null],
      ['Health', soh != null ? `${Math.round(soh)}%` : null],
      ['Capacity', cap != null ? `${cap.toFixed(1)} Ah` : null],
      ['Pack', volts != null ? `${volts.toFixed(0)} V` + (amps != null ? ` · ${amps.toFixed(1)} A · ${fmtKw(volts * amps / 1000)} kW` : '') : null],
    ].filter(r => r[1] != null);
    const key = rows.map(r => r.join('=')).join('|');
    if (b.kv.dataset.key === key) return;
    b.kv.dataset.key = key;
    b.kv.replaceChildren(...rows.flatMap(([k, val]) => [el('span', k), el('span', val)]));
  }

  render(cs, t) {
    if (!this.root || !cs) return;
    this.renderBattery(cs);
    const modeRaw = cs.rawOf(MODE_SIGNAL);
    const modeText = modeRaw == null ? '' : (MODE_TEXT[modeRaw] || '');
    setClass(this.ui.mode, 'hidden', !modeText);
    setText(this.ui.mode, modeText);
    let computed = false;
    for (const m of MODES) {
      const u = this.ui[m.key], log = this.logs[m.key];
      const total = cs.value(m.total);
      const vals = m.rows.map(r => cs.value(r.sig));
      const live = total != null || vals.some(v => v != null);
      setClass(u.empty, 'hidden', live);
      setClass(u.live, 'hidden', !live);
      if (!live) continue;
      const sh = shares(total, vals, m.rows.map(r => cs.value(r.perc)));
      computed = computed || sh.computed;
      setText(u.total, fmtKwh(sh.whole));
      const segs = u.bar.children;
      m.rows.forEach((r, i) => {
        const v = vals[i], pct = sh.pcts[i];
        segs[i].style.flexGrow = pct == null || pct <= 0 ? '0' : String(pct);
        setClass(segs[i], 'hidden', !(pct > 0));
        const row = u.rows[r.key];
        setText(row.kwh, fmtKwh(v) + ' kWh');
        setText(row.pct, pct == null ? '' : `${pct.toFixed(pct >= 10 ? 0 : 1)}%`);
        const kw = log.rate([r.key]);
        setText(row.rate, kw != null ? `${fmtKw(kw)} kW` : '');
      });
      const used = m.rows.reduce((a, r) => a + log.used(r.key), 0), kw = log.rate(m.rows.map(r => r.key));
      setText(u.window, used > 0 ? `${fmtKwh(used)} kWh` + (kw != null ? ` · ${fmtKw(kw)} kW` : '') : '');
      this.draw(m, t);
    }
    setText(this.ui.foot, 'VCU energy counters on IBUS1 (0x578–0x57C), 0.1 kWh steps. ' +
      (computed ? 'The VCU leaves its totals and shares at zero on this car, so the totals and shares here are worked out from the counters it does fill. '
        : 'The totals and shares are the VCU\'s own. ') +
      'The graphs show what each consumer counted up; the slope is its power.');
  }

  // The graph: the consumers' counted-up kWh stacked over the window, the oldest at the left edge, now at
  // the right; a hairline grid at half and full scale, with the scale at the right; a pointer over it reads
  // every consumer at that moment.
  draw(m, t) {
    const u = this.ui[m.key], c = u.canvas, log = this.logs[m.key];
    if (!c || !c.isConnected || u.live.classList.contains('hidden')) return;
    const rect = c.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(rect.width), H = Math.round(rect.height);
    if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const st = getComputedStyle(this.root);
    const tok = (n) => st.getPropertyValue(n).trim();
    const text = tok('--text'), muted = tok('--muted'), line = tok('--line'), surface = tok('--panel-solid');
    const padR = 58, padT = 6, padB = 16, left = 0, right = W - padR, top = padT, bottom = H - padB;
    const plotW = right - left, plotH = bottom - top;
    // the stack, bottom to top, and its scale
    const series = m.rows.map(r => log.series(r.key));
    const n = series[0]?.length || 0;
    const totals = new Array(n).fill(0);
    series.forEach(s => s.forEach((p, i) => { totals[i] += p[1]; }));
    const ymax = niceMax(Math.max(0.1, ...totals));
    const x = (tt) => right - (t - tt) / WINDOW_SECONDS * plotW;
    const y = (v) => bottom - v / ymax * plotH;
    // grid
    ctx.font = '11px ' + tok('--font');
    ctx.textBaseline = 'middle';
    ctx.fillStyle = muted;
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    for (const f of [0.5, 1]) {
      const yy = Math.round(y(ymax * f)) + 0.5;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillText(`${fmtScale(ymax * f)} kWh`, right + 6, yy);
    }
    ctx.beginPath(); ctx.moveTo(left, bottom + 0.5); ctx.lineTo(right, bottom + 0.5); ctx.strokeStyle = muted; ctx.stroke();
    ctx.textBaseline = 'alphabetic';
    for (const [sec, label, align] of [[WINDOW_SECONDS, `−${WINDOW_SECONDS / 60} min`, 'left'], [WINDOW_SECONDS / 2, `−${WINDOW_SECONDS / 120} min`, 'center'], [0, 'now', 'right']]) {
      ctx.textAlign = align;
      ctx.fillText(label, x(t - sec), H - 3);
    }
    if (n < 2) return;
    // the areas, each with a 2 px edge in the surface color so the fills stay apart
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, plotW, plotH + 1); ctx.clip();
    const lower = new Array(n).fill(0);
    m.rows.forEach((r, k) => {
      const s = series[k];
      const upper = s.map((p, i) => lower[i] + p[1]);
      if (upper[n - 1] <= lower[n - 1]) return;   // nothing counted: no area
      ctx.beginPath();
      s.forEach((p, i) => { const px = x(p[0]), py = y(upper[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(x(s[i][0]), y(lower[i]));
      ctx.closePath();
      ctx.fillStyle = tok(`--s${r.slot}`);
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      s.forEach((p, i) => { const px = x(p[0]), py = y(upper[i]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.strokeStyle = surface;
      ctx.lineWidth = 2;
      ctx.stroke();
      for (let i = 0; i < n; i++) lower[i] = upper[i];
    });
    ctx.restore();
    // the pointer: a hairline, and every consumer's figure at that moment
    const cur = this.cursor;
    if (cur && cur.mode === m.key && cur.x >= left && cur.x <= right) {
      const tt = t - (right - cur.x) / plotW * WINDOW_SECONDS;
      let i = log.samples.findIndex(s => s.t >= tt);
      if (i < 0) i = n - 1;
      const xx = Math.round(x(log.samples[i].t)) + 0.5;
      ctx.strokeStyle = text; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, bottom); ctx.stroke();
      const lines = m.rows.map((r, k) => [r, series[k][i][1]]).filter(([, v]) => v > 0);
      const ago = Math.round(t - log.samples[i].t);
      const head = ago < 5 ? 'now' : `${Math.floor(ago / 60)}:${String(ago % 60).padStart(2, '0')} ago`;
      ctx.font = '11px ' + tok('--font');
      const rows = [[null, head, ''], ...lines.map(([r, v]) => [r, r.label, `${v.toFixed(2)} kWh`])];
      const bw = Math.max(...rows.map(([, a, b]) => ctx.measureText(a).width + ctx.measureText(b).width)) + 36;
      const bh = rows.length * 16 + 10;
      const bx = Math.min(Math.max(left, xx + 10), right - bw), by = top + 4;
      ctx.fillStyle = surface; ctx.globalAlpha = 0.94;
      roundRect(ctx, bx, by, bw, bh, 6); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = line; ctx.lineWidth = 1; roundRect(ctx, bx + 0.5, by + 0.5, bw - 1, bh - 1, 6); ctx.stroke();
      ctx.textBaseline = 'middle';
      rows.forEach(([r, a, b], k) => {
        const yy = by + 5 + 8 + k * 16;
        if (r) { ctx.fillStyle = tok(`--s${r.slot}`); roundRect(ctx, bx + 8, yy - 4, 8, 8, 2); ctx.fill(); }
        ctx.fillStyle = r ? text : muted; ctx.textAlign = 'left'; ctx.fillText(a, bx + (r ? 22 : 8), yy);
        ctx.fillStyle = text; ctx.textAlign = 'right'; ctx.fillText(b, bx + bw - 8, yy);
      });
    }
  }
}

/** A round scale just above v: 0.1, 0.2, 0.5, 1, 2, 5, 10 ... */
export function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
