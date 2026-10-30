// Oceanfront View's own version and its updates, for the Software sheet. The Android app (AppUpdater, at
// /app/update on its own server) asks the repository's GitHub releases for a newer APK, downloads it, checks it
// (the release's SHA-256, this app, the same signing key) and installs it: silently through root, which starts the
// app again, else Android's own installer asks on screen. The HUD restarts either way, so not while the car moves.
// In a plain browser there's no app to update: the page is whatever the server serves.
import { el, fmtBytes, setClass } from './util.js';

const CHECK_EVERY_MS = 30 * 60 * 1000;   // opening the sheet checks again after this long
const POLL_MS = 700;                     // while an update downloads and installs
const BUSY = ['downloading', 'verifying', 'installing', 'confirm'];
const NOTES_MAX = 320;

const day = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export class AppUpdate {
  constructor(app) {
    this.app = app;
    this.st = null;       // GET /app/update
    this.error = null;    // the last request's failure
    this.node = null;     // the sheet's copy, rebuilt with the sheet
    this.timer = 0;
  }

  get inApp() { return !!(window.WebHudApp && window.WebHudApp.appToken); }
  get busy() { return !!this.st && BUSY.includes(this.st.state); }

  async call(method, path, body) {
    if (!this.token) this.token = window.WebHudApp.appToken();
    const r = await fetch('/app/update' + path, {
      method, headers: { 'X-App-Token': this.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ? `${j.error} (${r.status})` : `the app answered ${r.status} ${r.statusText || ''} to ${method} /app/update${path}`.trim());
    return j;
  }

  /** The section's contents: a fresh node each time the sheet is built, kept up to date while it's shown. `plain`:
   *  in the settings sheet's own style (Settings > About) rather than the car controls' design (the Software sheet). */
  render(plain = false) {
    this.plain = plain;
    this.node = el(plain ? 'div' : 'div.fo-appupdate');
    if (!this.inApp) {
      this.node.append(
        el('div.fo-rows', el('div.fo-row', el('div.fo-row__lbl', el('b', 'Version')), el('span.fo-row__val', 'Web page'))),
        el('p.fo-note', 'The app on the car\'s screen checks for updates and installs them itself; here the page is whatever the server serves.'),
      );
      return this.node;
    }
    this.draw();
    this.refresh();
    return this.node;
  }

  async refresh() {
    try {
      this.st = await this.call('GET', '');
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
    this.draw();
    if (this.st && !this.st.checking && !this.busy && (!this.st.checkedAt || Date.now() - this.st.checkedAt > CHECK_EVERY_MS)) this.check();
    else this.follow();
  }

  async check() {
    if (this.st) this.st.checking = true;
    this.draw();
    try {
      this.st = await this.call('POST', '/check');
      this.error = null;
    } catch (e) {
      this.error = e.message;
      if (this.st) this.st.checking = false;
    }
    this.draw();
  }

  async install() {
    const l = this.st.latest;
    if (!confirm(`Install Oceanfront View ${l.version}? It downloads ${fmtBytes(l.size)}, then the HUD restarts with the new version.`)) return;
    try {
      this.st = await this.call('POST', '/install', { speed: this.app.ui.comma.speed() });
      this.error = null;
    } catch (e) {
      this.error = e.message;
    }
    this.draw();
    this.follow();
  }

  /** Polls while an update is under way and the sheet shows it. */
  follow() {
    clearTimeout(this.timer);
    if (!this.busy || !this.node || !this.node.isConnected) return;
    this.timer = setTimeout(async () => {
      try { this.st = await this.call('GET', ''); } catch (e) { /* the app restarting */ }
      this.draw();
      this.follow();
    }, POLL_MS);
  }

  draw() {
    const n = this.node;
    if (!n) return;
    const st = this.st;
    const plain = this.plain;
    const row = plain
      ? (label, val, sub) => [el('span', label), el('span', val || '', sub ? el('small', ` · ${sub}`) : null)]
      : (label, val, sub, cls) => el('div.fo-row', el('div.fo-row__lbl', el('b', label), sub ? el(`small.fo-row__sub${cls ? '.' + cls : ''}`, sub) : null), val ? el('span.fo-row__val', val) : null);
    const rows = (...r) => (plain ? el('div.kv', r.flat()) : el('div.fo-rows', r));
    const note = (text, bad = false) => (plain ? el(bad ? 'div.banner' : 'p.desc', { style: { whiteSpace: 'pre-line', marginTop: '10px' } }, text) : el(bad ? 'p.fo-note.bad' : 'p.fo-note', { style: { whiteSpace: 'pre-line' } }, text));
    const kids = [];
    if (!st) {
      kids.push(rows(row('Version', '…')));
      if (this.error) kids.push(note(`Couldn't ask the app: ${this.error}`));
      n.replaceChildren(...kids);
      return;
    }
    const l = st.latest;
    let latest, latestSub = null, latestCls = null;
    if (st.checking) latest = 'Checking…';
    else if (st.checkError) { latest = '—'; latestSub = st.checkError; }
    else if (!l && this.error) { latest = '—'; latestSub = this.error; }
    else if (!l) latest = 'Not checked';
    else if (st.newer) { latest = `${l.version} · ${fmtBytes(l.size)}`; latestSub = `Update available · released ${day(Date.parse(l.published))}`; latestCls = 'ok'; }
    else { latest = l.version; latestSub = 'No update available'; latestCls = 'ok'; }
    kids.push(rows(
      row('Version', st.installed.version, `Installed ${day(st.installed.updated)}`),
      row('Latest release', latest, latestSub, latestCls),
    ));

    if (st.newer && l.notes) {
      // markdown's marks off, its lines kept: headings and quotes only at a line's start (a > inside is just text), bullets as •
      const text = l.notes.split(/\r?\n/).map(line => line.replace(/^\s*(#+|>)\s*/, '').replace(/^\s*[-*+]\s+/, '• ').replace(/[*_`]/g, '').trimEnd())
        .filter((line, i, a) => line || (i > 0 && a[i - 1])).join('\n').trim();
      kids.push(note(text.length > NOTES_MAX ? text.slice(0, NOTES_MAX - 1).trimEnd() + '…' : text));
    }

    if (st.state === 'downloading') {
      const frac = st.total > 0 ? Math.min(1, st.done / st.total) : 0;
      if (!plain) kids.push(el('div.fo-progress', el('i', { style: { width: `${(frac * 100).toFixed(1)}%` } })));
      kids.push(note(`Downloading ${fmtBytes(st.done)} of ${fmtBytes(st.total)} (${Math.round(frac * 100)}%)`));
    } else if (st.state === 'verifying') {
      kids.push(note('Checking the download…'));
    } else if (st.state === 'installing') {
      kids.push(note(st.root ? 'Installing. The HUD restarts in a moment.' : 'Installing…'));
    } else if (st.state === 'confirm') {
      kids.push(note('Android asks to install the update: confirm it on screen. The first time it may ask to allow this app to install apps.'));
    } else if (st.state === 'failed') {
      kids.push(note(`The update failed: ${st.error}`, true));
    }
    if (this.error && l) kids.push(note(this.error, true));   // without a release it shows in the row above

    const checkBtn = el(plain ? 'button.btn' : 'button.fo-btn', { onclick: () => this.check() }, st.checking ? 'Checking…' : 'Check for updates');
    checkBtn.disabled = st.checking || this.busy;
    const btns = el(plain ? 'div.btns' : 'div.fo-btns', checkBtn);
    if (st.newer) {
      const inst = el(plain ? 'button.btn.primary' : 'button.fo-btn.primary', { onclick: () => this.install() }, this.busy ? 'Updating…' : `Install ${l.version}`);
      inst.disabled = this.busy;
      btns.append(inst);
    }
    kids.push(btns);
    n.replaceChildren(...kids);
    setClass(n, 'busy', this.busy);
  }
}
