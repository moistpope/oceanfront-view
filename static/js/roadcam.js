// The camera view: a window over the 3D view with the comma's camera, from sunnypilot's webhud /video socket
// (relayed by the app like /ws), in one of three styles. Road and wide: the whole 16:9 picture with the model's
// path, lane lines, road edges and leads over it. Mirror: the comma 4's own driving screen, its shape (536 x 240),
// its camera choice and everything it draws (commaui.js). The window can be dragged and resized in any of them; a
// tap shows its controls (close, and the style).
// The video is H.264 from the comma's livestream encoder, decoded here with WebCodecs; the overlay is drawn
// here too, onto each frame from the model output computed from that frame (roadcam_geom.js has the maths).
import { $, iconSvg, setClass, setText } from './util.js';
import {
  CAMERAS, LINE_HALF_WIDTH, MICI, PATH_HALF_WIDTH, ZOOM, accelColor, avcCodec, fitStream, indexAt, leadChevron,
  lineRibbon, modelFor, parseFrame, pathDistance, projector,
} from './roadcam_geom.js';
import { CommaScreen } from './commaui.js';

const MODELS_KEPT = 30;          // 1.5 s of model output, to match frames against
// A decoded frame waits at most this long for the model output computed from it (it's usually there already).
// Frames aren't held longer or in numbers: a hardware decoder has only a few output buffers, and one that has
// handed them all out stops decoding until they come back (the stutter of the first version).
const MODEL_WAIT_MS = 40;
const MAX_HELD = 2;              // decoded frames held at once, besides the one on screen
const MAX_DECODE_QUEUE = 30;     // a decoder this far behind (1.5 s) has stalled: start again at a keyframe
const MIN_WIDTH = 280;           // px: the smallest the window gets
const STALL_MS = 4000;           // no frame for this long: say so, and reconnect after three times that
const ASPECTS = { mirror: MICI.width / MICI.height, plain: 16 / 9 };   // the comma 4's screen; the camera's picture
const MODES = ['road', 'wide', 'mirror'];   // mirror: the comma 4's screen, with whichever camera it shows
const PATH_COLORS = {            // bottom to top (model_renderer.py THROTTLE_COLORS / NO_THROTTLE_COLORS)
  throttle: ['rgba(13,248,122,.4)', 'rgba(114,255,92,.35)', 'rgba(114,255,92,0)'],
  idle: ['rgba(242,242,242,.4)', 'rgba(242,242,242,.35)', 'rgba(242,242,242,0)'],
};
const WIDE_CAM_MAX_SPEED = 5, ROAD_CAM_MIN_SPEED = 10;   // m/s: the comma 4 goes wide in experimental mode below these
const CONTROLS_MS = 4000;        // a tap shows the controls this long

export class RoadCam {
  constructor(app) {
    this.app = app;
    this.root = $('#roadcam');
    this.canvas = $('#roadcam-canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.status = $('#roadcam-status');
    this.camera = 'road';
    this.mode = 'mirror';
    this.hud = null;
    this.screen = new CommaScreen();
    this.lastDrawAt = 0;
    this.isOpen = false;
    this.ws = null;
    this.retry = 0;
    this.decoder = null;
    this.configuring = false;
    this.codec = null;
    this.needKey = true;
    this.pending = [];            // decoded frames waiting for their model output: {frame, frameId, camera, at}
    this.shown = null;            // the frame on screen
    this.models = [];
    this.calib = null;
    this.error = null;
    this.lastFrameAt = 0;
    this.dirty = false;
    this.stats = { since: performance.now(), rx: 0, decoded: 0, shown: 0, skipped: 0, gaps: 0, lastId: -1 };
    this.camStats = null;         // the last second's frame rates, while frames come in (perf.js shows them)
    for (const b of this.root.querySelectorAll('[data-roadcam]')) {
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setMode(b.dataset.roadcam); this.showControls(); });
    }
    $('#roadcam-close').innerHTML = iconSvg('close');
    $('#roadcam-close').addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.geo = { ...(app.settings?.roadcamGeo || {}) };
    this.bindDrag();
  }

  /**
   * Where the window sits and how big it is: anywhere from just under the drive card down to just above the dock,
   * from MIN_WIDTH up to the screen's width (in the style's shape). Kept in the settings as fractions of the room it has
   * (roadcamX, roadcamY, roadcamSize) so it lands in the same place after a rotation or a reload.
   */
  bounds() {
    const box = this.root.offsetParent?.getBoundingClientRect() || { top: 0, width: window.innerWidth, height: window.innerHeight };
    // under the drive card and the frame-rate chip just below it, above the dock
    const below = ['#drive', 'button.fps'].map(q => $(q)).filter(e => e && e.offsetParent).map(e => e.getBoundingClientRect().bottom);
    const top = Math.max(16, ...below.map(b => b - box.top + 12)), bottom = box.height - 96;
    const maxW = Math.max(MIN_WIDTH, Math.min(box.width - 32, (bottom - top) * this.aspect, 1600));
    return { left: 16, right: box.width - 16, top, bottom, maxW };
  }

  /** Lays the window out from the fractions: size first, then the place within the room that size leaves. */
  place(geo = this.geo) {
    if (!this.isOpen) return;
    const b = this.bounds(), clamp01 = (v, d) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
    const g = { x: clamp01(geo.x, 0.5), y: clamp01(geo.y, 0), size: clamp01(geo.size, 1) };
    const w = MIN_WIDTH + g.size * (b.maxW - MIN_WIDTH), h = w / this.aspect;
    const roomX = Math.max(0, b.right - b.left - w), roomY = Math.max(0, b.bottom - b.top - h);
    Object.assign(this.root.style, { width: `${Math.round(w)}px`, left: `${Math.round(b.left + g.x * roomX)}px`, top: `${Math.round(b.top + g.y * roomY)}px` });
    this.geo = g;
    this.dirty = true;
  }

  /** The fractions for a window at (left, top) and `w` wide, kept inside the room. */
  fit(left, top, w) {
    const b = this.bounds();
    const size = b.maxW > MIN_WIDTH ? (Math.min(b.maxW, Math.max(MIN_WIDTH, w)) - MIN_WIDTH) / (b.maxW - MIN_WIDTH) : 1;
    const ww = MIN_WIDTH + size * (b.maxW - MIN_WIDTH), h = ww / this.aspect;
    const roomX = b.right - b.left - ww, roomY = b.bottom - b.top - h;
    return {
      size,
      x: roomX > 0 ? Math.min(1, Math.max(0, (left - b.left) / roomX)) : 0.5,
      y: roomY > 0 ? Math.min(1, Math.max(0, (top - b.top) / roomY)) : 0,
    };
  }

  bindDrag() {
    // drag the window to move it, or its corner handle to resize it (the top-left corner stays put); a tap that
    // doesn't move shows the controls
    let drag = null;
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: this.root.offsetLeft, top: this.root.offsetTop,
               w: this.root.offsetWidth, resize: !!e.target.closest('.roadcam-resize'), moved: false };
      this.root.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.root.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 8) return;
      drag.moved = true;
      this.place(drag.resize
        ? this.fit(drag.left, drag.top, drag.w + (Math.abs(dx) > Math.abs(dy * this.aspect) ? dx : dy * this.aspect))   // whichever way the corner went further
        : this.fit(drag.left + dx, drag.top + dy, drag.w));
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const tapped = !drag.moved && e.type === 'pointerup';
      drag = null;
      if (tapped) { this.showControls(); return; }
      const r = (v) => Math.round(v * 1000) / 1000;
      this.app.setSetting?.('roadcamGeo', { x: r(this.geo.x), y: r(this.geo.y), size: r(this.geo.size) });
    };
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => this.place());
  }

  /** The window's shape: the comma 4 screen's for the mirror, the camera picture's otherwise. */
  get aspect() { return this.mode === 'mirror' ? ASPECTS.mirror : ASPECTS.plain; }

  static get supported() { return typeof window !== 'undefined' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window; }

  open(mode = this.mode) {
    this.mode = MODES.includes(mode) ? mode : 'mirror';   // 'auto' from 1.3.2 is the mirror
    this.camera = this.mode === 'mirror' ? this.autoCamera() : this.mode;
    this.root.style.aspectRatio = String(this.aspect);
    this.markCamera();
    if (this.isOpen) { this.send({ type: 'camera', camera: this.camera }); return; }
    this.isOpen = true;
    this.showControls();
    setClass(this.root, 'hidden', false);
    this.place();   // once it's shown and has a size
    this.markButton();
    this.resetStats();
    if (!RoadCam.supported) { this.say('This screen can’t decode the camera video (no WebCodecs in its WebView).'); return; }
    this.say('Connecting to the comma…');
    this.connect();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    setClass(this.root, 'hidden', true);
    this.markButton();
    this.camStats = null;
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch { /* gone */ } }
    this.resetDecoder();
    if (this.shown) { this.shown.frame.close(); this.shown = null; }
    this.models = [];
    this.hud = null;
  }

  /** Road or wide (the plain view of that camera), or the mirror of the comma's screen (its camera). */
  setMode(mode) {
    if (!MODES.includes(mode) || mode === this.mode) return;
    this.mode = mode;
    this.app.setSetting?.('roadcam', mode);
    this.markCamera();
    this.root.style.aspectRatio = String(this.aspect);
    this.place();   // the same place and size, in the new shape
    this.setCamera(mode === 'mirror' ? this.autoCamera() : mode);
  }

  /** The comma 4's choice (mici augmented_road_view.py): wide in experimental mode at low speed, with hysteresis. */
  autoCamera() {
    const h = this.hud;
    if (!h || !h.experimental) return 'road';
    if (h.vEgo < WIDE_CAM_MAX_SPEED) return 'wide';
    if (h.vEgo > ROAD_CAM_MIN_SPEED) return 'road';
    return this.camera;
  }

  setCamera(camera) {
    if (!CAMERAS.includes(camera) || camera === this.camera) return;
    this.camera = camera;
    this.resetDecoder();   // its output is tied to the camera it decodes
    this.send({ type: 'camera', camera });
  }

  showControls() {
    setClass(this.root, 'controls', true);
    clearTimeout(this.controlsTimer);
    this.controlsTimer = setTimeout(() => setClass(this.root, 'controls', false), CONTROLS_MS);
  }

  /** The dock's live camera button shows whether the camera view is up. */
  markButton() {
    const b = $('#btn-roadcam');
    if (!b) return;
    setClass(b, 'on', this.isOpen);
    b.setAttribute('aria-pressed', String(this.isOpen));
  }

  markCamera() {
    for (const b of this.root.querySelectorAll('[data-roadcam]')) setClass(b, 'on', b.dataset.roadcam === this.mode);
  }

  say(text) {
    setText(this.status, text || '');
    setClass(this.status, 'hidden', !text);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // ---- the socket ----------------------------------------------------------------------------------------
  connect() {
    clearTimeout(this.retryTimer);
    if (!this.isOpen) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/video?camera=${this.camera}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.needKey = true;
    this.lastFrameAt = performance.now();   // the stall clock starts now
    ws.onopen = () => { if (this.ws === ws) { this.retry = 0; this.lastFrameAt = performance.now(); } };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') this.onText(ev.data);
      else this.onFrame(parseFrame(ev.data));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.isOpen) return;
      if (!this.shown) this.say(this.app.commaConnected ? 'The comma’s camera isn’t answering. Trying again…' : 'The camera view needs the comma.');
      this.retryTimer = setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.retry++));
    };
    ws.onerror = () => ws.close();
  }

  onText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'model') {
      this.models.push(msg);
      if (this.models.length > MODELS_KEPT) this.models.shift();
      this.dirty = true;
    } else if (msg.type === 'hud') {
      this.hud = msg;
      if (this.mode === 'mirror') this.setCamera(this.autoCamera());
    } else if (msg.type === 'calib') {
      this.calib = msg;
      this.dirty = true;
    } else if (msg.type === 'error') {
      this.error = msg.message;
      if (!this.shown) this.say(`The comma couldn’t start the camera: ${msg.message}`);
    }
  }

  // ---- decoding ------------------------------------------------------------------------------------------
  onFrame(f) {
    if (!f || f.camera !== this.camera) return;
    this.lastFrameAt = performance.now();
    const st = this.stats;
    st.rx++;
    if (st.lastId >= 0 && f.frameId > st.lastId + 1) st.gaps += f.frameId - st.lastId - 1;   // dropped before they got here
    st.lastId = f.frameId;
    if (this.needKey && !f.key) return;
    if (f.key && !this.decoder) {
      if (!this.configuring) {
        const codec = avcCodec(f.data);
        if (codec) this.makeDecoder(codec);
      }
      return;   // decoding starts at the keyframe after the decoder is set up (one every 5 frames)
    }
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE && !f.key) { this.needKey = true; return; }
    this.needKey = false;
    try {
      // the timestamp carries the frame id through the decoder
      this.decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: f.frameId, data: f.data }));
    } catch (e) {
      this.fail(e);
    }
  }

  /** Hardware decoding where the WebView offers it for this stream, else software. */
  async makeDecoder(codec) {
    this.configuring = true;
    const camera = this.camera;
    try {
      let config = null;
      for (const hw of ['prefer-hardware', 'no-preference']) {
        const c = { codec, optimizeForLatency: true, hardwareAcceleration: hw };   // Annex B (SPS/PPS in band): no description
        if ((await VideoDecoder.isConfigSupported(c)).supported) { config = c; break; }
      }
      if (!this.isOpen || camera !== this.camera || this.decoder) return;
      if (!config) { this.error = `this screen can’t decode ${codec}`; this.say(`This screen can’t decode the camera’s video (${codec}).`); return; }
      const decoder = new VideoDecoder({
        output: (frame) => {
          if (!this.isOpen || camera !== this.camera || decoder !== this.decoder) { frame.close(); return; }
          this.stats.decoded++;
          this.pending.push({ frame, frameId: frame.timestamp, camera, at: performance.now() });
          while (this.pending.length > MAX_HELD) { this.pending.shift().frame.close(); this.stats.skipped++; }
        },
        error: (e) => this.fail(e),
      });
      decoder.configure(config);
      this.codec = codec;
      this.decoder = decoder;
      this.needKey = true;
    } catch (e) {
      this.fail(e);
    } finally {
      this.configuring = false;
    }
  }

  fail(e) {
    this.app.reportError?.(e);
    this.resetDecoder();
  }

  resetDecoder() {
    if (this.decoder) { try { this.decoder.close(); } catch { /* closed */ } }
    this.decoder = null;
    this.needKey = true;
    this.dropPending();
  }

  dropPending() {
    for (const p of this.pending) p.frame.close();
    this.pending = [];
  }

  // ---- drawing (every animation frame, from main.js) ------------------------------------------------------
  frame() {
    if (!this.isOpen) return;
    const now = performance.now();
    const next = this.pick(now);
    if (next) {
      if (this.shown) this.shown.frame.close();
      this.shown = next;
      this.stats.shown++;
      this.dirty = true;
      if (this.status.textContent) this.say('');
    } else if (this.ws && now - this.lastFrameAt > STALL_MS) {
      // the encoder takes a few seconds to come up (camerad too, parked)
      this.say(this.error ? `The comma couldn’t start the camera: ${this.error}` : 'Waiting for the comma’s camera…');
      if (now - this.lastFrameAt > 3 * STALL_MS) { this.lastFrameAt = now; this.reconnect(); }
    }
    // the mirror every frame while there's a picture: the screen's filters animate between the comma's updates
    if (this.dirty || (this.shown && this.mode === 'mirror')) this.draw(now);
    if (now - this.stats.since >= 1000) this.showStats(now);
  }

  resetStats() {
    Object.assign(this.stats, { since: performance.now(), rx: 0, decoded: 0, shown: 0, skipped: 0, gaps: 0 });
  }

  /** Frames per second at each step, for the frame-rate chip (perf.js): where frames go missing, if they do. */
  showStats(now) {
    const st = this.stats, secs = (now - st.since) / 1000, r = (n) => Math.round(n / secs);
    this.camStats = st.rx ? { rx: r(st.rx), decoded: r(st.decoded), shown: r(st.shown), lost: r(st.gaps), skipped: r(st.skipped) } : null;
    this.resetStats();
  }

  reconnect() {
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch { /* gone */ } }
    this.resetDecoder();
    this.connect();
  }

  /**
   * The next frame to show, in order: one per screen refresh (60 Hz against the stream's 20), so frames that
   * arrive in a bunch over Wi-Fi are spread out rather than skipped. It waits briefly for its model output.
   * Frames beyond MAX_HELD were already let go in the decoder's output (a backlog is latency, not smoothness).
   */
  pick(now) {
    const p = this.pending[0];
    if (!p) return null;
    const latest = this.models.length ? this.models[this.models.length - 1] : null;
    const latestId = latest ? (this.camera === 'wide' ? (latest.frameIdExtra || latest.frameId) : latest.frameId) : -1;
    if (p.frameId > latestId && now - p.at < MODEL_WAIT_MS && this.pending.length < MAX_HELD) return null;
    return this.pending.shift();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.root.clientWidth * dpr), h = Math.round(this.root.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    return [w, h];
  }

  draw(now = performance.now()) {
    if (this.mode !== 'mirror') { this.lastDrawAt = 0; this.drawPlain(); return; }
    this.dirty = false;
    const [vw, vh] = this.resize();
    const ctx = this.ctx;
    const dt = this.lastDrawAt ? (now - this.lastDrawAt) / 1000 : 1 / 60;
    this.lastDrawAt = now;
    ctx.setTransform(vw / MICI.width, 0, 0, vh / MICI.height, 0, 0);
    const shown = this.shown;
    const cam = shown ? this.calib?.cameras?.[shown.camera] : null;
    this.screen.draw(ctx, {
      frame: shown?.frame || null,
      cam,
      wide: shown?.camera === 'wide',
      model: shown && (cam?.Mfull || cam?.M) ? modelFor(this.models, shown.frameId, shown.camera) : null,
      hud: this.hud,
      now: now / 1000,
      dt,
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Road and wide: the whole picture, and the model's lines on it as the big comma screens draw them. */
  drawPlain() {
    this.dirty = false;
    const [vw, vh] = this.resize();
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, vw, vh);
    if (!this.shown) return;
    const { frame, frameId, camera } = this.shown;
    const width = frame.displayWidth, height = frame.displayHeight;
    const cam = this.calib?.cameras?.[camera];
    const M = cam?.M && cam.width === width && cam.height === height ? cam.M : null;
    const fit = fitStream(width, height, vw, vh, M, ZOOM[camera]);
    ctx.drawImage(frame, fit.tx, fit.ty, width * fit.scale, height * fit.scale);
    const model = M ? modelFor(this.models, frameId, camera) : null;
    if (model) this.drawModel(ctx, model, projector(M, fit), vw, vh);
  }

  drawModel(ctx, m, project, vw, vh) {
    const fill = (poly, style) => {
      if (poly.length < 3) return;
      ctx.beginPath();
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
      ctx.fillStyle = style;
      ctx.fill();
    };
    const path = m.path || [];
    if (!path.length) return;
    const reach = pathDistance(path, null);
    (m.lanes || []).forEach((line, i) => {
      const p = m.laneProbs?.[i] ?? 0;
      fill(lineRibbon(line, LINE_HALF_WIDTH * p, 0, reach, project), `rgba(255,255,255,${Math.min(0.7, Math.max(0, p))})`);
    });
    (m.edges || []).forEach((line, i) => {
      const a = Math.min(1, Math.max(0, 1 - (m.edgeStds?.[i] ?? 1)));
      fill(lineRibbon(line, LINE_HALF_WIDTH, 0, reach, project), `rgba(255,0,0,${a})`);
    });

    const lead = m.leads?.[0] || null;
    const ribbon = lineRibbon(path, PATH_HALF_WIDTH, m.pathZ || 0, pathDistance(path, lead), project);
    if (ribbon.length >= 3) {
      const ys = ribbon.map(p => p[1]);
      const bottom = Math.min(vh, Math.max(...ys)), top = Math.max(0, Math.min(...ys));
      const g = ctx.createLinearGradient(0, bottom, 0, top);
      if (m.experimental && m.accel?.length) {
        // colored by the planned acceleration along the path: each point's color where it lands on screen
        const n = Math.min(Math.floor(ribbon.length / 2), m.accel.length);
        for (let i = 0; i < n; i += 2) {
          const y = ribbon[i][1];
          if (y < 0 || y > vh) continue;
          const along = 1 - y / vh;
          g.addColorStop(Math.min(1, Math.max(0, (bottom - y) / Math.max(1, bottom - top))), accelColor(m.accel[i], along));
        }
      } else {
        const colors = m.allowThrottle || !m.longControl ? PATH_COLORS.throttle : PATH_COLORS.idle;
        colors.forEach((c, i) => g.addColorStop(i / 2, c));
      }
      fill(ribbon, g);
    }

    if (m.longControl) {
      for (const ld of m.leads || []) {
        const i = indexAt(path, ld.d);
        const z = (path[i]?.[2] || 0) + (m.pathZ || 0);
        const pt = project(ld.d, ld.y, z);
        if (!pt) continue;
        const c = leadChevron(ld, pt, vw, vh);
        fill(c.glow, 'rgb(218,202,37)');
        fill(c.chevron, `rgba(201,34,49,${c.alpha})`);
      }
    }
  }
}
