// The Comma tab: the comma, managed from the car's screen. The Android app makes an SSH key of its own (in the
// head unit's keystore), puts its public half on the comma through the bridge, and then runs everything here
// over SSH (android/ CommaManager, at /app/comma on the app's own server):
//
//   Overview   the connection, the key, SSH, and starting, stopping, restarting openpilot or rebooting
//   Log        openpilot's tmux session as it scrolls (its manager's and processes' output)
//   Processes  openpilot's processes (managerState) with CPU and memory, and the device's state
//   Routes     the drives recorded on the comma; the bridge can replay one in the HUD
//   Updates    the install (fork, branch, commit), openpilot's updater, git fetch / pull, switching branches,
//              installing another fork (the current one is kept as the backup) and the panda's firmware
//   Debug      a command on the comma, and everything the app read from it
//
// Long actions are jobs on the app: their output streams into a card at the top of the tab, and they carry on
// when the tab is closed. Anything that disturbs openpilot asks first, and the app refuses it while the car moves.
import { el, fmtBytes, fmtTime, setText } from './util.js';

const SECTIONS = [['overview', 'Overview'], ['log', 'Log'], ['procs', 'Processes'], ['routes', 'Routes'], ['updates', 'Updates'], ['debug', 'Debug']];
const LOG_MS = 1500, PROCS_MS = 5000, STATUS_MS = 5000, JOB_MS = 700;
// repositories to start from (any https:// or git@ repository works); List branches shows what each has
const FORKS = ['https://github.com/sunnypilot/sunnypilot.git', 'https://github.com/commaai/openpilot.git', 'https://github.com/moistpope/sunnypilot.git'];

/** How a finished job ended: done, failed with its exit code, ran out of time, or lost its connection with the
 *  result unknown (CommaManager checks a branch switch or pull afterwards, and reports done if it got there). */
function jobState(j) {
  if (j.code === 0) return 'done';
  if (j.timedOut) return 'timed out';
  if (j.lost && j.code === -1) return 'connection closed, result unknown';
  return `failed (exit ${j.code})`;
}

export class CommaPanel {
  constructor(app) {
    this.app = app;
    this.section = 'overview';
    this.status = null;     // GET /app/comma
    this.info = null;       // GET /app/comma/info
    this.routes = null;
    this.branches = null;
    this.job = null;        // the job shown: {id, title, output, offset, done, code}
    this.logLines = 1000;
    this.logPaused = false;
    this.timers = [];
    this.busy = new Set();
  }

  get inApp() { return !!(window.WebHudApp && window.WebHudApp.appToken); }

  async call(method, path, body) {
    if (!this.token) this.token = window.WebHudApp.appToken();
    const r = await fetch('/app/comma' + path, {
      method, headers: { 'X-App-Token': this.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status}`);
    return j;
  }

  /** The car's speed (m/s) as the HUD has it: the app refuses disruptive jobs above walking pace. */
  speed() {
    const st = this.app.state;
    const cs = st && st.op && st.op.carState, v = st && st.fisker && st.fisker.vehicle;
    return cs ? Math.abs(cs.vEgo || 0) : v && v.speedKph != null ? v.speedKph / 3.6 : 0;
  }

  /** What runs on the comma, by its repository's name (sunnypilot, FrogPilot, openpilot…): the Comma tab works with any
   *  fork. Until the install has been read, or if its remote doesn't say, the driving software. */
  get pilot() {
    const remote = this.info && this.info.git && this.info.git.remote;
    const m = remote && remote.match(/([^/:]+?)(?:\.git)?\/?$/);
    return m ? m[1] : 'the driving software';
  }

  /** The same, starting a sentence: a fork's name as its makers write it (sunnypilot stays lowercase), the fallback
   *  capitalised. */
  get Pilot() { const p = this.pilot; return p === 'the driving software' ? 'The driving software' : p; }

  get sshOk() { return !!(this.status && this.status.ssh && this.status.ssh.ok); }

  leave() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.active = false;
  }

  every(ms, fn) { this.timers.push(setInterval(fn, ms)); }

  // ---- rendering --------------------------------------------------------------------------------------

  render(body, keep = false) {
    this.leave();
    this.active = true;
    this.body = body;
    if (!this.inApp) {
      body.append(el('div.banner', 'Managing the comma needs the Oceanfront View app on the car\'s screen: it holds the SSH key and talks to the comma.'));
      return;
    }
    body.append(el('div.subnav', this.app.segmented(SECTIONS, this.section, v => { this.section = v; this.app.ui.show('comma'); })));
    this.jobNode = el('div');
    body.append(this.jobNode);
    this.drawJob();
    const content = el('div');
    body.append(content);
    ({ overview: () => this.overview(content), log: () => this.log(content), procs: () => this.procs(content), routes: () => this.routesView(content),
      updates: () => this.updates(content), debug: () => this.debug(content) })[this.section]();
    if (!keep || !this.status) this.refreshStatus();
    this.every(STATUS_MS, () => this.refreshStatus());
    if (this.job && !this.job.done) this.followJob();
  }

  rerender() { if (this.active && this.app.ui.isOpen && this.app.ui.tab === 'comma') this.app.ui.show('comma', true); }

  async refreshStatus() {
    if (this.statusBusy) return;   // the app may be waiting on an SSH check
    this.statusBusy = true;
    try {
      const st = await this.call('GET', '');
      const changed = JSON.stringify(st) !== JSON.stringify(this.status);
      this.status = st;
      this.statusError = null;
      if (changed) this.rerender();
    } catch (e) {
      if (this.statusError !== e.message) { this.statusError = e.message; this.rerender(); }
    } finally {
      this.statusBusy = false;
    }
  }

  /** A button that runs fn once at a time, showing it's busy. */
  button(label, fn, { cls = '', disabled = false, key = label } = {}) {
    return el('button.btn' + cls, {
      disabled: disabled || this.busy.has(key),
      onclick: async () => {
        this.busy.add(key);
        this.rerender();
        try { await fn(); } catch (e) { this.app.toast(e.message, 5000); } finally { this.busy.delete(key); this.rerender(); }
      },
    }, this.busy.has(key) ? label + '…' : label);
  }

  needSsh(content) {
    if (this.sshOk) return false;
    content.append(el('div.banner', this.status && this.status.device ? 'Set up SSH under Overview first: the app needs its key on the comma.' : 'The comma isn\'t connected.'));
    return true;
  }

  // ---- overview -------------------------------------------------------------------------------------------

  overview(c) {
    const st = this.status;
    if (!st) { c.append(el('p.desc', this.statusError ? `Couldn't ask the app: ${this.statusError}` : 'Asking the app…')); return; }
    const d = st.device;
    c.append(el('div.section', el('h3', 'Connection'),
      d ? el('div.kv', el('span', 'Comma'), el('span', `${d.hostname} at ${d.host}`), el('span', 'Bridge'), el('span', `webhud ${d.version}`))
        : el('p.desc', 'Not connected. The app looks for the comma on the car\'s hotspot by itself (its bridge, port 8088, ' +
          'must be on: Settings → Developer → Web HUD). The HUD doesn\'t need it: the car\'s own buses drive it.'),
      el('div.btns', this.button('Look again', () => this.call('POST', '/search').then(() => {
        this.app.toast('Looking for the comma');
        [1500, 3500, 7000].forEach(ms => setTimeout(() => this.active && this.refreshStatus(), ms));   // found in a second or two, usually
      })))));

    const k = st.key;
    const keySec = el('div.section', el('h3', 'SSH key'));
    if (!k) {
      keySec.append(el('p.desc', 'The app makes a key pair of its own in the head unit\'s keystore (the private half never leaves it), then puts ' +
        'the public half on the comma through its bridge, beside any keys already there.'),
      el('div.btns', this.button('Create key', () => this.call('POST', '/key').then(s => { this.status = s; }), { cls: '.primary' })));
    } else {
      keySec.append(el('div.kv', el('span', 'Fingerprint'), el('span', k.fingerprint), el('span', 'Made'), el('span', new Date(k.created).toLocaleString())),
        el('pre.cm-key', k.publicKey));
      const ssh = st.ssh || {};
      if (d) {
        keySec.append(el('div.banner' + (ssh.ok ? '' : ssh.ok === false ? '.warn' : ''),
          ssh.ok ? `SSH works: ${ssh.user}@${d.host}` : ssh.ok === false ? `SSH: ${ssh.error}` : 'Checking SSH…'));
      }
      keySec.append(el('div.btns',
        this.button(ssh.ok ? 'Authorize again' : 'Authorize on the comma', () => this.call('POST', '/authorize').then(s => {
          this.status = s;
          this.app.toast(s.ssh && s.ssh.ok ? 'The comma lets the app in' : `Key added, but SSH: ${s.ssh && s.ssh.error}`, 4000);
        }), { cls: ssh.ok ? '' : '.primary', disabled: !d }),
        ssh.hostKey && /host key changed/.test(ssh.error || '') ? this.button('Trust the new host key', async () => {
          if (!confirm('The comma presents a different SSH host key than before. That is expected after reflashing it; otherwise something else may be answering at its address. Trust the new key?')) return;
          this.status = await this.call('DELETE', '/hostkey');
        }) : null,
        this.button('Delete key', async () => {
          if (!confirm('Delete the app\'s SSH key? It is taken off the comma too (if connected), and a new one has to be authorized.')) return;
          this.status = await this.call('DELETE', '/key');
        }, { cls: '.danger' })));
      if (ssh.hostKey) keySec.append(el('p.desc', `Comma host key: ${ssh.hostKey}`));
    }
    c.append(keySec);

    const ok = this.sshOk;
    c.append(el('div.section', el('h3', this.pilot === 'the driving software' ? 'Driving software' : this.pilot),
      el('p.desc', `Not while the car is moving. A restart takes ${this.pilot} down for half a minute or so.`),
      el('div.btns',
        this.jobButton('Start', 'start', {}, null, !ok),
        this.jobButton('Stop', 'stop', {}, `Stop ${this.pilot}? It stays off until started again or the comma restarts.`, !ok),
        this.jobButton('Restart', 'restart', {}, `Restart ${this.pilot}?`, !ok),
        this.jobButton('Reboot', 'reboot', {}, 'Reboot the comma?', !ok, '.danger'))));
    if (ok) this.summary(c);
  }

  /** Version, install and device at a glance (from info.py). */
  summary(c) {
    const sec = el('div.section', el('h3', 'Device'));
    c.append(sec);
    const fill = () => {
      const i = this.info;
      if (!i) { sec.append(el('p.desc', this.infoError ? `Couldn't read the comma: ${this.infoError}` : 'Reading…')); return; }
      const p = i.params || {}, g = i.git || {};
      sec.append(el('div.kv',
        el('span', this.Pilot), el('span', `${i.running ? 'running' : 'stopped'}${p.Version ? ' · ' + p.Version : ''}`),
        el('span', 'Install'), el('span', `${g.branch || '?'} @ ${g.commit || '?'}${g.dirty ? ' (modified)' : ''}`),
        el('span', 'Remote'), el('span', g.remote || '—'),
        el('span', 'AGNOS'), el('span', i.agnos || '—'),
        el('span', 'Dongle'), el('span', p.DongleId || '—'),
        el('span', 'Uptime'), el('span', i.uptime != null ? fmtTime(i.uptime) : '—'),
        el('span', 'Temperature'), el('span', i.maxThermalC != null ? `${i.maxThermalC} °C` : '—'),
        el('span', 'Disk'), el('span', i.disk ? `${i.disk.freeGB} GB free of ${i.disk.totalGB}` : '—'),
        el('span', 'Memory'), el('span', i.memory ? `${i.memory.availableMB} MB free of ${i.memory.totalMB}` : '—'),
      ));
    };
    fill();
    this.wantInfo();
  }

  async loadInfo() {
    this.infoAt = Date.now();
    try { this.info = await this.call('GET', '/info'); this.infoError = null; } catch (e) { this.infoError = e.message; }
  }

  /** Read the comma's state if it isn't here yet (at most every 10 s, so a failing read doesn't loop). */
  wantInfo() {
    if (this.info || this.infoLoading || Date.now() - (this.infoAt || 0) < 10000) return;
    this.infoLoading = true;
    this.loadInfo().then(() => { this.infoLoading = false; this.rerender(); });
  }

  // ---- log ------------------------------------------------------------------------------------------------

  log(c) {
    if (this.needSsh(c)) return;
    const pre = el('pre.term', this.logText || 'Reading…');
    const lines = this.app.segmented([['200', '200 lines'], ['1000', '1000'], ['3000', '3000']], String(this.logLines), v => { this.logLines = Number(v); poll(); });
    const pause = el('button.btn', { onclick: () => { this.logPaused = !this.logPaused; pause.textContent = this.logPaused ? 'Resume' : 'Pause'; } }, this.logPaused ? 'Resume' : 'Pause');
    c.append(el('p.desc', `${this.Pilot}'s tmux session on the comma ("comma"): the manager's and its processes' output, as it scrolls.`),
      lines, el('div', { style: { height: '10px' } }), pre, el('div.btns', pause));
    let first = true;
    const poll = async () => {
      if (this.logPaused || this.logBusy) return;
      this.logBusy = true;
      try {
        const r = await this.call('GET', `/log?lines=${this.logLines}`);
        const atEnd = first || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        this.logText = r.text;
        setText(pre, r.text);
        if (atEnd) pre.scrollTop = pre.scrollHeight;
        first = false;
      } catch (e) {
        setText(pre, `${this.logText || ''}\n[${e.message}]`);
      } finally {
        this.logBusy = false;
      }
    };
    requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
    poll();
    this.every(LOG_MS, poll);
  }

  // ---- processes ------------------------------------------------------------------------------------------

  procs(c) {
    if (this.needSsh(c)) return;
    const box = el('div');
    c.append(el('p.desc', `${this.Pilot}'s processes as its manager reports them (managerState), with CPU and memory from the comma's /proc.`), box);
    const draw = () => {
      box.innerHTML = '';
      const i = this.info;
      if (!i) { box.append(el('p.desc', this.infoError ? `Couldn't read the comma: ${this.infoError}` : 'Reading…')); return; }
      if (!i.processes) {
        box.append(el('div.banner', i.running ? `No process list (${i.messagingError || 'managerState is silent'})` : `${this.Pilot} isn't running.`));
      } else {
        const running = i.processes.filter(p => p.running).length;
        box.append(el('p.desc', `${running} of ${i.processes.length} running`),
          el('table.procs', i.processes.map(p => {
            const bad = p.shouldBeRunning && !p.running;
            return el('tr',
              el('td', p.name),
              el('td.st', el('i.dot' + (p.running ? '.run' : bad ? '.bad' : '.off')), p.running ? 'running' : bad ? `down${p.exitCode ? ' (' + p.exitCode + ')' : ''}` : 'off'),
              el('td', p.running ? String(p.pid) : ''),
              el('td', p.cpu != null ? `${p.cpu}%` : ''),
              el('td', p.memMB != null ? `${p.memMB} MB` : ''));
          })));
      }
      const ds = i.deviceState;
      if (ds) {
        box.append(el('div.section', { style: { marginTop: '16px' } }, el('h3', 'Device state'), el('div.kv',
          el('span', 'Onroad'), el('span', ds.started ? 'yes' : 'no'),
          el('span', 'CPU'), el('span', (ds.cpuUsagePercent || []).map(v => v + '%').join(' ')),
          el('span', 'Memory'), el('span', `${ds.memoryUsagePercent}%`),
          el('span', 'Max temp'), el('span', `${ds.maxTempC} °C (${ds.thermalStatus})`),
          el('span', 'Fan'), el('span', `${ds.fanSpeedPercentDesired}%`),
          el('span', 'Free space'), el('span', `${ds.freeSpacePercent}%`),
          el('span', 'Network'), el('span', ds.networkType),
          el('span', 'Load'), el('span', (i.load || []).map(v => v.toFixed(2)).join(' ')))));
      }
    };
    draw();
    const poll = async () => { if (this.procBusy) return; this.procBusy = true; await this.loadInfo(); this.procBusy = false; draw(); };
    if (!this.info || Date.now() - (this.infoAt || 0) > PROCS_MS) poll();
    this.every(PROCS_MS, poll);
  }

  // ---- routes ---------------------------------------------------------------------------------------------

  routesView(c) {
    if (this.needSsh(c)) return;
    const box = el('div');
    c.append(el('p.desc', 'Drives recorded on the comma (/data/media/0/realdata), newest first. Play one to watch it in the HUD (the bridge replays it; not while driving).'),
      el('div.btns', { style: { marginTop: 0, marginBottom: '12px' } }, this.button('Refresh', () => this.loadRoutes())), box);
    const r = this.routes;
    if (!r) {
      box.append(el('p.desc', this.routesError ? `Couldn't read the routes: ${this.routesError}` : 'Reading…'));
      if (!this.routesError && !this.routesLoading) { this.routesLoading = true; this.loadRoutes().finally(() => { this.routesLoading = false; }); }
      return;
    }
    if (r.freeGB != null) box.append(el('p.desc', `${r.routes.length} routes · ${r.freeGB} GB free`));
    if (!r.routes.length) box.append(el('p.desc', 'No recorded routes.'));
    const list = el('div.routes');
    for (const rt of r.routes) {
      const when = rt.end ? new Date(rt.end * 1000) : null;
      const kinds = Object.entries(rt.files).map(([k, n]) => `${k} ${n}`).join(' · ');
      list.append(el('div.route',
        el('div', el('b', rt.name), rt.preserved ? el('span.badge', 'preserved') : null,
          el('small', `${when ? when.toLocaleDateString() + ' ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' : ''}` +
            `${rt.segments.length} seg · ${fmtBytes(rt.size)}`)),
        el('p.desc', { style: { margin: '4px 0 0' } }, kinds),
        this.app.commaConnected ? el('div.segs', el('button', { onclick: () => { this.app.replay('load', { route: rt.name, segment: null }); this.app.ui.close(); } }, '▶ Play')) : null));
    }
    box.append(list);
  }

  async loadRoutes() {
    try { this.routes = await this.call('GET', '/routes'); this.routesError = null; } catch (e) { this.routesError = e.message; }
    this.rerender();
  }

  // ---- updates --------------------------------------------------------------------------------------------

  updates(c) {
    if (this.needSsh(c)) return;
    const i = this.info;
    if (!i) { c.append(el('p.desc', this.infoError ? `Couldn't read the comma: ${this.infoError}` : 'Reading…')); this.wantInfo(); return; }
    const g = i.git || {}, p = i.params || {};
    const [ahead, behind] = (g.upstream || '').split(/\s+/).map(Number);
    const restartBox = (id, label, on = true) => {
      const box = el('input', { type: 'checkbox', checked: on });
      this[id] = box;
      const text = el('span', typeof label === 'function' ? label() : label);
      if (typeof label === 'function') this[id + 'Label'] = () => setText(text, label());   // follows what's typed or picked
      return el('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', marginTop: '8px' } }, box, text);
    };

    c.append(el('div.section', el('h3', 'Installed'), el('div.kv',
      el('span', 'Repository'), el('span', g.remote || '—'),
      el('span', 'Branch'), el('span', g.branch || '—'),
      el('span', 'Commit'), el('span', `${g.commit || '?'} ${g.subject || ''}`),
      el('span', 'Date'), el('span', g.date ? new Date(g.date).toLocaleString() : '—'),
      el('span', 'State'), el('span', [g.dirty ? 'modified' : 'clean', g.prebuilt ? 'prebuilt' : 'built on the comma',
        Number.isFinite(behind) ? (behind ? `${behind} behind` : 'up to date') + (ahead ? `, ${ahead} ahead` : '') + ' (last fetch)' : null].filter(Boolean).join(' · ')),
      el('span', 'Backup'), el('span', g.backup || 'none'),
    ), el('div.btns', this.button('Refresh', () => this.loadInfo()))));

    c.append(this.updateSection(g));

    const branchIn = el('input.cm-field', { placeholder: 'Branch name', value: this.branchDraft || '', oninput: e => { this.branchDraft = e.target.value; this.branchRestartLabel && this.branchRestartLabel(); }, list: 'cm-branches' });
    const datalist = el('datalist', { id: 'cm-branches' }, (this.branches || []).map(b => el('option', { value: b })));
    c.append(el('div.section', el('h3', 'Branch'),
      el('p.desc', `Switch the install to another branch of ${g.remote ? g.remote.replace(/^(https?:\/\/|git@)[^/:]+[/:]/, '').replace(/\.git$/, '') : 'its repository'}. The updater is pointed at it too.`),
      branchIn, datalist,
      this.branches ? el('p.desc', `${this.branches.length} branches on the remote`) : null,
      restartBox('branchRestart', () => `Restart ${this.pilot}${(this.branchDraft || '').trim() ? ' on ' + this.branchDraft.trim() : ''} when done`),
      el('div.btns',
        this.button('List branches', async () => { this.branches = (await this.call('GET', '/branches')).branches; }),
        this.jobButton('Switch', 'branch', () => ({ branch: branchIn.value.trim(), restart: this.branchRestart.checked }),
          () => `Switch the comma to ${branchIn.value.trim()}? Local changes in /data/openpilot are discarded.`))));

    const urlIn = el('input.cm-field', { placeholder: 'https://github.com/owner/repo.git', value: this.forkUrl || '', oninput: e => { this.forkUrl = e.target.value; this.forkRebootLabel && this.forkRebootLabel(); } });
    const forkBranch = el('input.cm-field', { placeholder: 'Branch', value: this.forkBranch || '', oninput: e => { this.forkBranch = e.target.value; this.forkRebootLabel && this.forkRebootLabel(); }, list: 'cm-fork-branches' });
    const forkList = el('datalist', { id: 'cm-fork-branches' }, (this.forkBranches || []).map(b => el('option', { value: b })));
    c.append(el('div.section', el('h3', 'Install a fork'),
      el('p.desc', 'Clone another repository and branch beside the current install, then swap it in. The current install is kept as the backup ' +
        '(/data/openpilot.bak, replacing the one before) and can be restored. The comma reboots into the new one, which builds on first start if it isn\'t prebuilt.'),
      el('div.btns', { style: { marginTop: 0, marginBottom: '10px' } }, FORKS.map(u => el('button.btn', {
        onclick: () => { if (this.forkUrl !== u) { this.forkBranches = null; this.forkBranch = ''; } this.forkUrl = u; this.rerender(); } },
      u.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '')))),
      urlIn, forkBranch, forkList,
      this.forkBranches ? el('p.desc', `${this.forkBranches.length} branches in ${this.forkBranchesOf}`) : null,
      restartBox('forkReboot', () => {
        // named after the fork going in, from its URL as typed
        const m = (this.forkUrl || '').trim().match(/([^/:]+?)(?:\.git)?\/?$/), b = (this.forkBranch || '').trim();
        return `Reboot the comma into ${m ? m[1] : 'it'}${b && (!m || b.toLowerCase() !== m[1].toLowerCase()) ? ' (' + b + ')' : ''} when done`;
      }),
      el('div.btns',
        this.button('List branches', async () => {
          const u = urlIn.value.trim();
          this.forkBranches = (await this.call('GET', `/branches?url=${encodeURIComponent(u)}`)).branches;
          this.forkBranchesOf = u;
        }, { key: 'forkBranches', disabled: !this.sshOk }),
        this.jobButton('Install', 'install', () => ({ url: urlIn.value.trim(), branch: forkBranch.value.trim(), restart: this.forkReboot.checked }),
          () => `Install ${urlIn.value.trim()} (${forkBranch.value.trim()}) on the comma? ${this.Pilot} stops while it swaps, and the current install becomes the backup.`, false, '.primary'),
        g.backup ? this.jobButton('Restore the backup', 'restore', () => ({ restart: this.forkReboot.checked }),
          `Swap the backup (${g.backup}) back in? The current install becomes the backup.`) : null)));

    // the ways round the Update button: openpilot's own updater, and git's two steps on their own
    c.append(el('details.section', el('summary', el('h3', { style: { display: 'inline' } }, 'Advanced')),
      el('h4', 'Built-in updater'),
      el('p.desc', 'comma\'s own updater, which runs by itself while the car is off: it checks the branch it follows, downloads an update in the ' +
        'background and installs it the next time the comma starts. Update above does the same at once.'),
      el('div.kv',
        el('span', 'State'), el('span', p.UpdaterState || '—'),
        el('span', 'Follows'), el('span', p.UpdaterTargetBranch || g.branch || '—'),
        el('span', 'Update'), el('span', p.UpdateAvailable === '1' ? `ready: ${p.UpdaterNewDescription || ''}` : p.UpdaterFetchAvailable === '1' ? 'available to download' : 'none known'),
        el('span', 'Last check'), el('span', p.LastUpdateTime || '—')),
      el('div.btns',
        this.jobButton('Check', 'update_check'),
        this.jobButton('Download', 'update_download'),
        p.UpdateAvailable === '1' ? this.jobButton('Reboot to install', 'reboot', {}, 'Reboot the comma to install the update?', false, '.primary') : null),
      el('h4', 'Git'),
      el('p.desc', 'Update\'s two steps on their own: Fetch only looks for new commits (nothing on the comma changes); Pull brings them in ' +
        '(fast-forward only, with its submodules).'),
      restartBox('pullRestart', `Restart ${this.pilot} after pulling`),
      el('div.btns', this.jobButton('Fetch', 'fetch'),
        this.jobButton('Pull', 'pull', () => ({ restart: this.pullRestart.checked }), 'Pull the latest of this branch into the comma\'s install?'))));

    c.append(el('div.section', el('h3', 'Panda'),
      el('p.desc', `The panda's firmware from this install (panda/board). ${this.Pilot} flashes it by itself when it starts with a different one; ` +
        `flashing here stops ${this.pilot}, builds and flashes, and starts it again. Recover is for a panda stuck in its bootloader (DFU).`),
      el('div.btns',
        this.jobButton('Build', 'panda_build', {}, 'Build the panda firmware? It takes a few minutes of CPU.'),
        this.jobButton('Build & flash', 'panda_flash', {}, `Stop ${this.pilot}, build and flash the panda, and start ${this.pilot} again?`, false, '.primary'),
        this.jobButton('Recover (DFU)', 'panda_recover', {}, `Recover the panda from DFU? ${this.Pilot} stops meanwhile.`))));
  }

  // ---- debug ----------------------------------------------------------------------------------------------

  debug(c) {
    if (this.needSsh(c)) return;
    const cmd = el('input.cm-field', { placeholder: 'A command, run as comma in /data/openpilot', value: this.cmdDraft || '', oninput: e => { this.cmdDraft = e.target.value; },
      onkeydown: e => { if (e.key === 'Enter') run.click(); } });
    const run = this.jobButton('Run', 'exec', () => ({ cmd: cmd.value }), null, false, '.primary');
    c.append(el('div.section', el('h3', 'Command'),
      el('p.desc', 'Runs on the comma over SSH; its output shows above. Not while the car is moving.'),
      cmd, el('div.btns', run,
        ...[['Disk', 'df -h /data'], ['Panda', 'python3 -c "from panda import Panda; [print(s, Panda(s).health()) for s in Panda.list()]"'],
          ['Network', 'ip -br addr'], ['dmesg', 'dmesg | tail -n 60'], ['Params', 'ls /data/params/d']]
          .map(([l, v]) => el('button.btn', { onclick: () => { this.cmdDraft = v; cmd.value = v; } }, l)))));
    const jobs = el('div.section', el('h3', 'Recent jobs'));
    c.append(jobs);
    this.call('GET', '/jobs').then(r => {
      jobs.append(r.jobs.length ? el('div.kv', r.jobs.flatMap(j => [el('span', new Date(j.startedAt).toLocaleTimeString()),
        el('a', { href: '#', onclick: e => { e.preventDefault(); this.showJob(j.id); } }, `${j.title} · ${j.done ? jobState(j) : 'running'}`)]))
        : el('p.desc', 'None yet.'));
    }).catch(() => {});
    c.append(el('div.section', el('h3', 'What the app read'), el('pre.term.short', this.info ? JSON.stringify(this.info, null, 1) : 'Nothing yet.'),
      el('div.btns', this.button('Read again', () => this.loadInfo()))));
  }

  // ---- jobs -----------------------------------------------------------------------------------------------

  /** A button that starts a job: args an object or a function giving one; ask a question (or a function giving one) to confirm. */
  // Update: look (fetch, and what the new commits are and touch), then Update or Cancel
  updateSection(g) {
    const sec = el('div.section', el('h3', 'Update'));
    const pv = this.preview;
    if (!pv || pv.branch !== g.branch) {
      sec.append(el('p.desc', `Looks for new commits on ${g.branch || 'this branch'} and shows what they change before anything is installed.`),
        el('div.btns', this.button('Check for updates', async () => { this.preview = await this.call('GET', '/preview'); this.preview.at = Date.now(); },
          { key: 'preview', disabled: !this.sshOk || (this.job && !this.job.done), cls: '.primary' })));
      return sec;
    }
    const again = this.button('Check again', async () => { this.preview = await this.call('GET', '/preview'); this.preview.at = Date.now(); }, { key: 'preview' });
    const cancel = el('button.btn', { onclick: () => { this.preview = null; this.rerender(); } }, pv.behind ? 'Cancel' : 'Close');
    if (pv.error || !pv.upstream || !Number.isFinite(pv.behind)) {
      sec.append(el('p.desc', pv.error || 'The comma\'s answer didn\'t say what\'s new. Try again.'), el('div.btns', again, cancel));
      return sec;
    }
    if (!pv.behind) {
      sec.append(el('p.desc', `Up to date with ${pv.upstream}` + (pv.ahead ? `, and ${pv.ahead} commit${pv.ahead > 1 ? 's' : ''} ahead of it (local ones)` : '') + '.'),
        el('div.btns', again, cancel));
      return sec;
    }
    const n = pv.behind;
    sec.append(el('p.desc', `${n} new commit${n > 1 ? 's' : ''} on ${pv.upstream}` + (pv.commits.length < n ? ` (the latest ${pv.commits.length} shown)` : '') + ':'));
    sec.append(el('div.kv', pv.commits.flatMap(c => [
      el('span', c.hash),
      el('span', c.subject, el('small', ` · ${c.author}${c.date ? ', ' + new Date(c.date).toLocaleDateString() : ''}`)),
    ])));
    if (pv.areas.length) {
      sec.append(el('p.desc', { style: { marginTop: '10px' } }, 'What changes: ' + pv.areas.slice(0, 12)
        .map(a => pv.submodules.includes(a.area) ? `${a.area} (new version)` : `${a.area} (${a.files} file${a.files > 1 ? 's' : ''})`).join(', ') +
        (pv.areas.length > 12 ? `, and ${pv.areas.length - 12} more` : '') + '.'));
    }
    if (!pv.prebuilt) sec.append(el('p.desc', `${this.Pilot} is built on the comma, so the restart rebuilds what changed: that can take a few minutes.`));
    if (pv.ahead) {
      sec.append(el('div.banner', `The comma also has ${pv.ahead} commit${pv.ahead > 1 ? 's' : ''} of its own that ${pv.upstream} doesn't. ` +
        'Update only moves forward, so it will stop without changing anything; Switch branch below replaces the install with the remote\'s.'));
    }
    sec.append(el('div.btns',
      this.jobButton(`Update (${n})`, 'pull', () => { this.preview = null; return { restart: true }; }, null, false, '.primary'),
      cancel));
    sec.append(el('p.desc', `Update pulls them in and restarts ${this.pilot}. Not while driving.`));
    return sec;
  }

  jobButton(label, action, args = {}, ask = null, disabled = false, cls = '') {
    return el('button.btn' + cls, {
      disabled: disabled || !this.sshOk || (this.job && !this.job.done),
      onclick: async () => {
        const a = typeof args === 'function' ? args() : args;
        const q = typeof ask === 'function' ? ask() : ask;
        if (q && !confirm(q)) return;
        try {
          const j = await this.call('POST', '/jobs', { action, speed: this.speed(), ...a });
          this.job = { ...j, output: '', offset: 0 };
          this.rerender();
          this.followJob();
        } catch (e) {
          this.app.toast(e.message, 5000);
        }
      },
    }, label);
  }

  async showJob(id) {
    this.job = { id, title: '', output: '', offset: 0, done: false };
    this.rerender();
    this.followJob();
  }

  followJob() {
    if (this.jobTimer) return;
    const tick = async () => {
      const j = this.job;
      if (!j) { clearInterval(this.jobTimer); this.jobTimer = 0; return; }
      try {
        const r = await this.call('GET', `/jobs/${j.id}?from=${j.offset}`);
        if (this.job !== j) return;
        j.output += r.output;
        if (j.output.length > 400000) j.output = j.output.slice(-300000);
        Object.assign(j, { title: r.title, offset: r.offset, done: r.done, code: r.code, timedOut: r.timedOut, lost: r.lost });
        this.drawJob();
        if (r.done) {
          clearInterval(this.jobTimer);
          this.jobTimer = 0;
          this.info = null;   // the install or openpilot may have changed: read it again
          this.infoAt = 0;
          this.rerender();
        }
      } catch (e) {
        clearInterval(this.jobTimer);
        this.jobTimer = 0;
      }
    };
    this.jobTimer = setInterval(tick, JOB_MS);
    tick();
  }

  drawJob() {
    const node = this.jobNode, j = this.job;
    if (!node) return;
    node.innerHTML = '';
    if (!j) return;
    const state = j.done ? jobState(j) : 'running…';
    const pre = el('pre.term.short', j.output || '…');
    node.append(el('div.section', el('h3', j.title || 'Job', el('small', state)), pre,
      j.done ? el('div.btns', el('button.btn', { onclick: () => { this.job = null; this.drawJob(); } }, 'Dismiss')) : null));
    requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
  }
}
