// Music and navigation from the head unit. What's playing shows in a card at the bottom, with its
// controls. The next turn shows in a card at the top (unless the ground style is Flat: then floating over the ground with a bar
// counting down to it), and as an arrow on the road ahead (navarrow.js)
// once it's near. The Android app (android/, HudListener.kt) reads them from the head unit's media
// session and its turn-by-turn notification, and sends them as they are (webhud:media, webhud:nav
// events). They're parsed here, so the parsing can change without reinstalling the app. In a plain
// browser there's no app and both cards stay hidden. Settings > Display > Debug has a demo of both.
import { $, el, iconSvg, setClass, setText } from './util.js';
import { iconManeuverFromUrl } from './navicon.js';
import * as THREE from '../vendor/three.module.min.js';

const UNIT_M = { mi: 1609.344, mile: 1609.344, miles: 1609.344, ft: 0.3048, feet: 0.3048, foot: 0.3048, yd: 0.9144, yds: 0.9144, yard: 0.9144,
  yards: 0.9144, km: 1000, m: 1, meter: 1, meters: 1 };
const DIST_RE = /(\d+(?:[.,]\d+)?)\s*(miles?|mi|feet|foot|ft|yards?|yds?|km|met(?:er|re)s?|m)(?![a-z])/i;   // British spelling too
const TRIP_RE = /\b\d+\s*(?:min|hr|h)\b|\bETA\b|arriv/i;

// The maneuver an instruction describes: { kind, side } with kind one of straight, slight, turn, sharp,
// uturn, keep, ramp, merge, roundabout, arrive; side 'left' | 'right' | null. Null when it says none.
export function maneuverOf(text) {
  const t = (text || '').toLowerCase();
  if (!t) return null;
  const side = /\bleft\b/.test(t) ? 'left' : /\bright\b/.test(t) ? 'right' : null;
  if (/destination|arriv|you have reached/.test(t)) return { kind: 'arrive', side };
  if (/u-?turn/.test(t)) return { kind: 'uturn', side: side || 'left' };
  if (/roundabout|rotary|traffic circle/.test(t)) return { kind: 'roundabout', side };
  if (/sharp (left|right)/.test(t)) return { kind: 'sharp', side };
  if (/(slight|bear) (left|right)/.test(t)) return { kind: 'slight', side };
  if (/\b(keep|stay)\b|\bfork\b/.test(t)) return { kind: 'keep', side };
  if (/\bexit\b|\bramp\b/.test(t)) return { kind: 'ramp', side: side || 'right' };
  if (/\bmerge\b/.test(t)) return { kind: 'merge', side };
  if (/\bturn\b/.test(t) && side) return { kind: 'turn', side };
  if (side && /\b(left|right) (onto|on|at|to)\b|^(left|right)\b/.test(t)) return { kind: 'turn', side };
  if (/continue|straight|\bhead\b|\bgo\b|\bstay on\b/.test(t)) return { kind: 'straight', side: null };
  return null;
}

// A turn-by-turn notification as it came (title, text, subText, bigText, info): the next turn's distance
// (as written, and m), what to do there, the street, and the trip line (time, distance, ETA).
export function parseNav(raw) {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const fields = [raw.title, raw.text, raw.bigText].map(clean).filter(Boolean);
  let dist = null, instruction = '';
  for (const f of fields) {
    const m = DIST_RE.exec(f);
    if (m && !dist && !TRIP_RE.test(f)) {
      const value = parseFloat(m[1].replace(',', '.')), unit = m[2].toLowerCase().replace(/re(s?)$/, 'er$1'), k = UNIT_M[unit] || 1;
      // what it was rounded to: "0.3 mi" is 0.25..0.35 mi, "550 ft" 525..575 ft
      const decimals = (m[1].split(/[.,]/)[1] || '').length;
      const half = decimals ? 0.5 * 10 ** -decimals : value % 100 === 0 ? 50 : value % 50 === 0 ? 25 : value % 10 === 0 ? 5 : 0.5;
      dist = { text: `${m[1]} ${m[2]}`, value: m[1], unit: m[2], m: value * k, half: half * k };
      const rest = clean(f.replace(m[0], '').replace(/^(in|within)\b\s*/i, '').replace(/^[,·•\-–—:\s]+|[,·•\-–—:\s]+$/g, ''));
      if (rest.length > 2) instruction = rest;
    } else if (!instruction && !TRIP_RE.test(f)) instruction = f;
  }
  if (!instruction) instruction = fields.find(f => !TRIP_RE.test(f) && !DIST_RE.test(f)) || '';
  const trip = [raw.subText, raw.info, raw.text, raw.title].map(clean).find(f => f && f !== instruction && TRIP_RE.test(f)) || '';
  const maneuver = maneuverOf(instruction);
  // Google Maps often gives just the road ("Hartwith Lane"), the turn being in its picture (navicon.js)
  let street = streetOf(instruction);
  if (!street && !maneuver && instruction && !DIST_RE.test(instruction) && /[a-z]/i.test(instruction)) street = instruction.replace(/[.!]+$/, '');
  return { dist, instruction, street, trip, maneuver };
}

// the street an instruction names: after its most telling word ("...take the 2nd exit onto High St"),
// not a phrase like "the fork" or "the right" (but streets called "The ...": The Mall, The Strand)
const NOT_STREET = /^the\s+(fork|roundabout|right|left|exit|end|ramp|slip|junction|motorway|traffic|lights|next|first|second|third|road|street|destination|\d)/i;
export function streetOf(instruction) {
  for (const word of ['onto', 'towards?', 'on', 'to', 'at']) {
    const m = new RegExp(`.*\\b${word}\\s+(.+)$`, 'i').exec(instruction);
    if (m && !NOT_STREET.test(m[1])) return m[1].replace(/[.!]+$/, '');
  }
  return '';
}

// arrow icons for the card, drawn for the right-hand maneuver; the left ones are mirrored
const MANEUVER_SVG = {
  straight: '<path d="M12 21V4M6 10l6-6 6 6"/>',
  slight: '<path d="M9 21v-7l8-8"/><path d="M10 6h7v7"/>',
  turn: '<path d="M7 21v-8a4 4 0 0 1 4-4h9"/><path d="M15 4l5 5-5 5"/>',
  sharp: '<path d="M8 3v8l9 9"/><path d="M10 20h7v-7"/>',
  uturn: '<path d="M8 21V10a5 5 0 0 1 10 0v6"/><path d="M14.5 13l3.5 3.5 3.5-3.5"/>',
  keep: '<path d="M12 21v-6l5-6V3"/><path d="M14 6l3-3 3 3"/><path d="M12 15L7 9V5" opacity=".35"/>',
  ramp: '<path d="M8 21V11l9-7"/><path d="M11.5 4H17v5.5"/><path d="M8 11V3" opacity=".35"/>',
  merge: '<path d="M12 21V12L6 6V3"/><path d="M12 12l6-6"/><path d="M15 6h3v3"/>',
  roundabout: '<circle cx="12" cy="10" r="4"/><path d="M12 21v-7M15 7l4-4M15.5 3H19v3.5"/>',
  arrive: '<path d="M6 21V4h11l-2.5 4 2.5 4H6"/>',
};
function maneuverSvg(mv) {
  const body = MANEUVER_SVG[mv.kind] || MANEUVER_SVG.straight;
  const flip = mv.side === 'left' && !['straight', 'arrive', 'merge'].includes(mv.kind) ? ' transform="matrix(-1 0 0 1 24 0)"' : '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><g${flip}>${body}</g></svg>`;
}

// the step in a few words, as the concepts have it: "Turn left", "Keep right", "Exit 7A" (the instruction up to its road)
function shortStep(p) {
  const s = (p.instruction || p.street || '').replace(/\s+(?:onto|on to|on|into|towards?|toward|to continue on|to stay on|at|for)\s.*$/i, '').trim();
  return s.length > 28 ? s.slice(0, 27).trimEnd() + '…' : s;
}

// a distance in the units the nav app writes (miles and yards, or feet; km and m), rounded as it rounds them
function fmtDist(m, unit) {
  const u = (unit || '').toLowerCase();
  if (/^(mi|mile|miles|yd|yds|yard|yards|ft|feet|foot)$/.test(u)) {
    if (m >= 0.25 * 1609.344) return `${(m / 1609.344).toFixed(m < 16093 ? 1 : 0)} mi`;
    return /^(ft|feet|foot)$/.test(u) ? `${Math.round(m / 0.3048 / 50) * 50} ft` : `${Math.round(m / 0.9144 / 10) * 10} yd`;
  }
  return m >= 1000 ? `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km` : `${Math.round(m / 10) * 10} m`;
}

const fmtTime = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export class Infotainment {
  constructor(app) {
    this.app = app;
    this.media = null;   // as the app sent it, with `art` kept from the last message that had it
    this.nav = null;     // { raw, parsed }
    this.demo = null;
    this._buildMusic();
    this._buildNav();
    window.addEventListener('webhud:media', (e) => { if (!this.demo) this.setMedia(e.detail); });
    window.addEventListener('webhud:nav', (e) => { if (!this.demo) this.setNav(e.detail); });
    window.addEventListener('webhud:infotainment', () => this._pull());   // the app was away, or the page just finished loading
    this._pull();   // what the app already had before this page loaded
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => this.layout());
      ro.observe($('#replaybar'));
      ro.observe(this.music);
    }
    this.apply();
  }

  // everything the app has, pictures included
  _pull() {
    if (this.demo) return;
    try {
      const now = window.WebHudApp?.infotainment?.();
      if (now) { const j = JSON.parse(now); this.setMedia(j.media); this.setNav(j.nav); }
    } catch { /* not in the app, or an older one */ }
  }

  // the settings changed
  apply() {
    const s = this.app.settings;
    if (s.demoInfotainment && !this.demo) this.demo = new Demo(this);
    if (!s.demoInfotainment && this.demo) { this.demo = null; this.setMedia(null); this.setNav(null); this._pull(); }
    this._showMusic();
    this._showNav();
  }

  // ---- music ----

  // What's playing, along the bottom of the screen as in the concept's boards (01's open bottom): the title, the artist
  // and album and a hairline of progress, as type on the scene (by day on a light veil), with play/pause and next on
  // the driver's side beside the controls' button. Their icons are small; each button's touch area is large and reaches
  // down to the screen's edge (app.css), for a big screen that's hard to hit accurately while driving.
  _buildMusic() {
    this.title = el('b.mc-title');
    this.artist = el('span.mc-artist');
    this.bar = el('i');
    const btn = (icon, action, label) => {
      const b = el('button.mc-btn', { type: 'button', 'aria-label': label, onclick: () => this.command(action) });
      b.innerHTML = iconSvg(icon);
      return b;
    };
    this.play = btn('play', 'toggle', 'Play or pause');
    this.next = btn('next', 'next', 'Next track');
    this.music = el('section.musicbar.hidden', { id: 'musiccard', 'aria-label': 'Now playing' },
      el('div.mc-ctl', this.play, this.next),
      el('div.mc-meta', this.title, this.artist, el('div.mc-bar', this.bar)));
    $('#app').append(this.music);
  }

  setMedia(m) {
    if (m && !m.art && this.media && m.artKey && m.artKey === this.media.artKey) m.art = this.media.art;
    this.media = m && (m.title || m.artist) ? m : null;
    this._showMusic();
  }

  // a control on the card: to the app (the head unit's media session), or the demo
  command(action) {
    if (this.demo) { this.demo.command(action); return; }
    try { window.WebHudApp?.media?.(action); } catch { /* not in the app */ }
  }

  _showMusic() {
    const m = this.media, on = !!m && this.app.settings.showMusic !== false;
    setClass(this.music, 'hidden', !on);
    if (!on) { this.layout(); return; }
    setText(this.title, m.title || m.album || '');
    setText(this.artist, [m.artist, m.album].filter(Boolean).join(' · '));
    const ctl = !!this.demo || !!window.WebHudApp?.media;
    const can = m.actions || {};
    this.next.disabled = !ctl || can.next === false;
    this.play.disabled = !ctl;
    const icon = m.playing ? 'pause' : 'play';
    if (this.play.dataset.icon !== icon) { this.play.innerHTML = iconSvg(icon); this.play.dataset.icon = icon; }
    setClass(this.music, 'timed', m.duration > 0);
    this.layout();
    this.tick();
  }

  // the progress bar: from the last position the app sent, played on at its speed while playing
  tick() {
    const m = this.media;
    if (!m || !(m.duration > 0) || this.music.classList.contains('hidden')) return;
    const pos = Math.min(m.duration, (m.position || 0) + (m.playing ? (Date.now() - (m.at || Date.now())) * (m.speed || 1) : 0));
    this.bar.style.width = `${(pos / m.duration * 100).toFixed(2)}%`;
  }

  // ---- navigation ----

  _buildNav() {
    this.navIcon = el('div.nc-icon');
    this.navDist = el('b');
    this.navUnit = el('small');
    this.navWhat = el('div.nc-what');
    this.navTrip = el('div.nc-trip');
    this.navCard = el('section.card.navcard.hidden', { id: 'navcard', 'aria-label': 'Next turn' },
      this.navIcon, el('div.nc-dist', this.navDist, this.navUnit), el('div.nc-text', this.navWhat, this.navTrip));
    $('#app').append(this.navCard);
    // the floating read-out instead (any ground style but Flat): over the ground beside the car, after the Ocean concepts: the arrow, a bar counting down to the turn, the step in a few words, the distance under it
    this.tfIcon = el('div.tf-icon');
    this.tfFill = el('i');
    this.tfWhat = el('div.tf-what');
    this.tfDist = el('div.tf-dist');
    this.turnFloat = el('div.turnfloat.hidden', { 'aria-label': 'Next turn' }, this.tfIcon, el('div.tf-bar', this.tfFill), this.tfWhat, this.tfDist);
    $('#app').append(this.turnFloat);
    this.tf = { step: null, start: 0, p: new THREE.Vector3() };
  }

  setNav(raw) {
    this.nav = raw && (raw.title || raw.text) ? { raw, parsed: parseNav(raw) } : null;
    if (this.nav && !raw.icon && this.navIconKey === raw.iconKey) raw.icon = this.navIconData;
    if (this.nav) { this.navIconKey = raw.iconKey; this.navIconData = raw.icon; }
    this._showNav();
    // the words don't say what to do: read it from the nav app's picture of the turn
    const nav = this.nav;
    if (nav && !nav.parsed.maneuver && raw.icon) {
      iconManeuverFromUrl(raw.icon, raw.iconKey || raw.icon).then((m) => {
        if (m && this.nav === nav && !nav.parsed.maneuver) { nav.parsed = { ...nav.parsed, maneuver: m }; this._showNav(); }
      });
    }
  }

  _showNav() {
    const n = this.nav, on = !!n && this.app.settings.showNav !== false;
    setClass(this.navCard, 'hidden', !on);
    setClass(this.turnFloat, 'hidden', !on);
    const arrow = this.app.scene.navArrow;
    this.app.scene.setNav?.(on ? n.parsed : null);
    if (!on) { arrow.set(null); this.layout(); return; }
    const p = n.parsed;
    setText(this.navDist, p.dist ? p.dist.value : '');
    setText(this.navUnit, p.dist ? p.dist.unit : '');
    setText(this.navWhat, p.street || p.instruction);
    setText(this.navTrip, p.street && p.instruction !== p.street ? `${p.instruction}${p.trip ? ' · ' + p.trip : ''}` : p.trip);
    // our arrow when the words say what to do, else the nav app's own picture of it
    // (read from that picture, the picture stays)
    const ours = p.maneuver && !p.maneuver.fromIcon;
    const key = ours ? `${p.maneuver.kind}-${p.maneuver.side}` : `img:${n.raw.iconKey || ''}`;
    if (this.navIcon.dataset.key !== key) {
      this.navIcon.dataset.key = key;
      if (ours) this.navIcon.innerHTML = maneuverSvg(p.maneuver);
      else this.navIcon.replaceChildren(...(n.raw.icon ? [el('img', { src: n.raw.icon, alt: '' })] : []));
      this.tfIcon.replaceChildren(...[...this.navIcon.childNodes].map(c => c.cloneNode(true)));
    }
    setText(this.tfWhat, shortStep(p));
    if (this.tf.step !== p.instruction) { this.tf.step = p.instruction; this.tf.start = 0; }
    arrow.set(p.maneuver && p.dist ? { ...p.maneuver, m: p.dist.m, half: p.dist.half, step: p.instruction } : null);
    this.layout();
  }

  // The floating turn, each frame: placed over the ground low beside the car (a point in the car frame projected through
  // the scene's camera), its bar the share of the distance to the turn still to go, counted from where it was when the
  // step came. The distance is the nav arrow's own, carried down with the car between notifications. It replaces the
  // card at the top whenever the ground style is not Flat (the classic look keeps the card).
  _turnFloat() {
    const tfEl = this.turnFloat, n = this.nav;
    const on = !!n && !tfEl.classList.contains('hidden') && this.app.settings.groundStyle !== 'flat';
    const root = document.documentElement;
    if (root.classList.contains('tf-on') !== on) { root.classList.toggle('tf-on', on); this.layout(); }
    if (!on) return;
    const scene = this.app.scene, p = n.parsed;
    const turn = scene.navArrow && scene.navArrow.turn;
    const left = turn && turn.step === p.instruction ? Math.max(0, turn.at - scene.navArrow.road.odo) : p.dist ? p.dist.m : null;
    if (left != null) {
      this.tf.start = Math.max(this.tf.start, left, 50);
      this.tfFill.style.width = `${(100 * left / this.tf.start).toFixed(1)}%`;   // drains to the turn
    }
    setText(this.tfDist, left != null ? fmtDist(left, p.dist && p.dist.unit) : '');
    // low over the ground beside the car, clear of the road ahead, the cars on it and the route: 7 m ahead, 6 m to the
    // passenger's side (the right, or the left with the driver on the right: html.rhd), 0.4 m up (scene X = -y, Y up, Z = -x)
    const side = root.classList.contains('rhd') ? -1 : 1;
    const v = this.tf.p.set(6 * side, 0.4, -7).project(scene.camera);
    const W = window.innerWidth, H = window.innerHeight;
    // kept in the screen and above what's along the bottom (the music, replay bar and controls: layout's --bottom-h)
    const lo = Math.min(120, W / 2), top = 60, bottom = Math.max(top, H - (this._bottomH || 0) - 70);
    const x = Math.min(W - lo, Math.max(lo, (v.x + 1) / 2 * W)), y = Math.min(bottom, Math.max(top, (1 - v.y) / 2 * H));
    tfEl.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -50%)`;
    tfEl.style.visibility = v.z < 1 ? '' : 'hidden';
  }

  // ---- layout and per frame ----

  // what stacks against what: the alerts under the nav card; along the bottom, the replay bar over the music, the open
  // controls over the replay bar beside their button, and the road's name and the toasts over all of it
  layout() {
    const root = document.documentElement.style;
    const nav = this.navCard.classList.contains('hidden') ? 0 : this.navCard.offsetHeight;
    root.setProperty('--navcard-h', `${nav ? nav + 8 : 0}px`);
    const music = this.music.classList.contains('hidden') ? 0 : this.music.offsetHeight;
    root.setProperty('--music-h', `${music ? music + 8 : 0}px`);
    const rb = $('#replaybar'), btn = $('#btn-menu'), shown = (e) => !e.classList.contains('hidden') && e.offsetHeight > 0;
    const top = Math.min(...[btn, this.music, rb].filter(shown).map(e => e.getBoundingClientRect().top));
    const lift = shown(rb) ? btn.getBoundingClientRect().top - rb.getBoundingClientRect().top : 0;
    root.setProperty('--dock-lift', `${Math.max(0, Math.round(lift))}px`);
    this._bottomH = Math.max(0, Math.round(window.innerHeight - top + 8));
    root.setProperty('--bottom-h', `${this._bottomH}px`);
  }

  frame(dt) {
    if (this.demo) this.demo.frame(dt);
    this._turnFloat();
    this._t = (this._t || 0) + dt;
    if (this._t > 0.25) { this._t = 0; this.tick(); }
  }
}

// ---- demo ----------------------------------------------------------------------------------------

const DEMO_TRACKS = [
  ['Solar Sky', 'The Pulse Lines', 'Open Road', 214000, ['#3e6ae1', '#9b5de5']],
  ['Coastline at Night', 'Hollywood Mode', 'California', 187000, ['#f15bb5', '#fee440']],
  ['Lane Keeping', 'Adaptive Cruise', 'Long Drive', 241000, ['#00bbf9', '#00f5d4']],
];
const DEMO_ROUTE = [
  ['Turn right onto W Pico Blvd', 420],
  ['Turn left onto S Robertson Blvd', 650],
  ['Slight right onto the I-10 E ramp', 900],
  ['Keep left to continue on I-10 E', 1400],
  ['Take exit 7A toward Santa Monica Blvd', 1800],
  ['Make a U-turn', 500],
  ['Your destination will be on the right', 300],
];

// Plays the parts of the app and the nav app: a playlist that plays on, and a route whose next turn
// comes nearer as the car drives (the HUD's own speed), written the way Google Maps writes its notification.
class Demo {
  constructor(info) {
    this.info = info;
    this.track = 0;
    this.pos = 0;
    this.playing = true;
    this.step = 0;
    this.left = DEMO_ROUTE[0][1];
    this.sent = 0;
    this.arts = DEMO_TRACKS.map(([title, , , , colors]) => demoArt(title, colors));
    this._sendMedia();
    this._sendNav();
  }

  command(action) {
    if (action === 'toggle') this.playing = !this.playing;
    else if (action === 'next' || (action === 'prev' && this.pos < 3000)) {
      const n = DEMO_TRACKS.length;
      this.track = (this.track + (action === 'next' ? 1 : n - 1)) % n;
      this.pos = 0;
    } else if (action === 'prev') this.pos = 0;
    this._sendMedia();
  }

  frame(dt) {
    if (this.playing) {
      this.pos += dt * 1000;
      if (this.pos >= DEMO_TRACKS[this.track][3]) { this.command('next'); return; }
    }
    this.left -= this.info.app.vehicle.speed * dt;
    if (this.left < -15) {
      this.step = (this.step + 1) % DEMO_ROUTE.length;
      this.left = DEMO_ROUTE[this.step][1];
    }
    this.sent += dt;
    if (this.sent > 1) this._sendNav();   // the nav app updates its notification about once a second
  }

  _sendMedia() {
    const [title, artist, album, duration] = DEMO_TRACKS[this.track];
    this.info.setMedia({ app: 'Demo player', title, artist, album, duration, position: this.pos, speed: 1, at: Date.now(),
      playing: this.playing, art: this.arts[this.track], artKey: `demo${this.track}`, actions: { prev: true, next: true } });
  }

  _sendNav() {
    this.sent = 0;
    const app = this.info.app, metric = app.hud.unitFor(app.settings, app.state && app.state.fisker) === 'kmh';
    const fmt = (m) => {
      m = Math.max(0, m);
      if (metric) return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 50) * 50 || 10} m`;
      return m >= 161 ? `${(m / 1609.344).toFixed(1)} mi` : `${Math.round(m / 0.3048 / 50) * 50 || 20} ft`;
    };
    const rest = this.left + DEMO_ROUTE.slice(this.step + 1).reduce((a, [, d]) => a + d, 0);
    const min = Math.max(1, Math.round(rest / 13 / 60));
    const eta = new Date(Date.now() + min * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    this.info.setNav({ app: 'Demo maps', title: fmt(this.left), text: DEMO_ROUTE[this.step][0], subText: `${min} min · ${fmt(rest)} · ${eta} ETA` });
  }
}

function demoArt(title, [a, b]) {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 160, 160);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  g.fillStyle = grad;
  g.fillRect(0, 0, 160, 160);
  g.fillStyle = 'rgba(255,255,255,.9)';
  g.font = '700 64px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(title.split(' ').map(w => w[0]).join('').slice(0, 2), 80, 84);
  return c.toDataURL('image/png');
}
