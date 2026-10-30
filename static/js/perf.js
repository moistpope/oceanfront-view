// The frame rate: a counter under the status card (Settings > Display > Debug), and the 3D view's
// render resolution. On 'auto', while frames come slower than the display refreshes and the typical (median) frame
// takes longer than the display's frame time, the blur behind the HUD's cards goes first, then the resolution steps
// down (a few long frames alone, which a lower resolution wouldn't fix, don't count); once frames have kept up for a while they come
// back a step at a time, and a step that brings the slowdown straight back is held off for a minute. Tap
// the counter for what a frame costs.
import { $, el, setClass, setText } from './util.js';

const WINDOW_MS = 1000;
// auto's steps: the resolution, as a share of the full one (scene.js: the device's pixel ratio, at most 1.75),
// and whether the cards keep their blur
const AUTO_LEVELS = [{ scale: 1, blur: true }, { scale: 1, blur: false }, { scale: 0.85 }, { scale: 0.7 }, { scale: 0.6 }];
const SLOW = 0.88, FAST = 0.97;            // of the display's rate: below, a window is slow; at or above, fast
const DOWN_AFTER = 2, UP_AFTER = 8;        // slow / fast windows in a row before a step
const HOLD_MS = 60000;                     // after a step up that turned slow again, no step up for this long
const OVER_BUDGET = 1.15;                  // a window's median frame this far over the display's frame time: the GPU can't keep up
const HZ = 60;                             // the screen's refresh rate: the Ocean's center screen is a fixed 60 Hz

export class FrameMeter {
  constructor(app) {
    this.app = app;
    this.el = el('button.fps', { type: 'button', 'aria-label': 'Frame rate', onclick: () => { this.detail = !this.detail; this._show(); } });
    $('#app').append(this.el);
    this.detail = false;
    this.hz = HZ;          // the display's refresh rate (not measured: a guess from bunched frames once pinned the resolution low)
    this.level = 0;        // AUTO_LEVELS index while on auto
    this.slow = 0;         // slow windows in a row
    this.fast = 0;         // fast windows in a row
    this.raisedAt = -1e9;  // when auto last stepped up
    this.holdUntil = 0;
    this.stats = null;
    this._reset(performance.now());
    this.apply();
  }

  // the settings changed: show or hide the counter, set the resolution
  apply() {
    const s = this.app.settings;
    setClass(this.el, 'hidden', !s.showFps);
    this._setLevel();
    this._show();
  }

  // one animation frame: the time since the last one and what the HUD's own work took (ms)
  tick(now, interval, work) {
    const w = this.win;
    if (interval > 0 && interval < 250) {   // longer: the page was hidden or the tab throttled
      w.frames++;
      w.intervals.push(interval);
      w.worst = Math.max(w.worst, interval);
      w.work += work;
    }
    if (now - w.start < WINDOW_MS) return;
    const r = this.app.scene.renderer.info.render;
    const fps = w.frames * 1000 / (now - w.start);
    if (w.frames >= 10) {   // fewer: the page is hidden, or a tab in the background
      const sorted = w.intervals.sort((a, b) => a - b), median = sorted[sorted.length >> 1];
      this.stats = { fps, worst: w.worst, median, work: w.work / w.frames, calls: r.calls, tris: r.triangles };
      // a page the browser calls hidden may be throttled (a covered window): not slow, so auto waits
      if (this.app.settings.renderScale === 'auto' && !document.hidden) this._auto(fps, median, now);
    }
    this._reset(now);
    this._show();
  }

  // slow: fewer frames than the display shows, with the typical frame over its time, so the GPU is behind and a lower
  // resolution helps. Fewer frames from a few long ones (a map tile parsed, garbage collected) is a hitch the
  // resolution doesn't cause: neither slow nor fast, so auto holds.
  _auto(fps, median, now) {
    const slow = fps < this.hz * SLOW && median > OVER_BUDGET * 1000 / this.hz, fast = fps >= this.hz * FAST;
    this.slow = slow ? this.slow + 1 : 0;
    this.fast = fast ? this.fast + 1 : 0;
    if (this.slow >= DOWN_AFTER && this.level < AUTO_LEVELS.length - 1) {
      if (now - this.raisedAt < 4 * WINDOW_MS) this.holdUntil = now + HOLD_MS;   // the step up didn't hold
      this.level++;
      this.slow = 0;
      this._setLevel();
    } else if (this.fast >= UP_AFTER && this.level > 0 && now > this.holdUntil) {
      this.level--;
      this.fast = 0;
      this.raisedAt = now;
      this._setLevel();
    }
  }

  // the resolution and blur: auto's current step, or the resolution set
  _setLevel() {
    const auto = this.app.settings.renderScale === 'auto', step = AUTO_LEVELS[this.level];
    const k = auto ? step.scale : Number(this.app.settings.renderScale) || 1;
    if (this.app.scene.renderScale !== k) this.app.scene.setRenderScale(k);
    document.documentElement.classList.toggle('lowfx', auto && !step.blur);
  }

  _reset(now) { this.win = { start: now, frames: 0, worst: 0, work: 0, intervals: [] }; }

  _show() {
    const s = this.stats;
    if (!s || !this.app.settings.showFps) return;
    const scale = this.app.scene.renderScale;
    const lowfx = document.documentElement.classList.contains('lowfx');
    let text = `${Math.round(s.fps)} fps`;
    if (scale < 1) text += ` · ${Math.round(scale * 100)}%`;
    // the comma camera's own rate while its window is open (roadcam.js): frames shown per second
    const cam = this.app.roadcam?.camStats;
    if (cam) text += ` · cam ${cam.shown} fps`;
    if (this.detail) {
      text += ` · median ${s.median.toFixed(1)} ms · worst ${Math.round(s.worst)} ms · JS ${s.work.toFixed(1)} ms · ${s.calls} draws · ${Math.round(s.tris / 1000)}k tris`;
      if (scale === 1) text += ' · 100%';
      if (lowfx) text += ' · no blur';
      if (cam) text += ` · cam ${cam.rx} in, ${cam.decoded} decoded${cam.lost ? `, ${cam.lost} lost` : ''}${cam.skipped ? `, ${cam.skipped} skipped` : ''}`;
    }
    setText(this.el, text);
    setClass(this.el, 'low', s.fps < this.hz * SLOW);
  }
}
