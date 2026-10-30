// The comma 4's own onroad screen, drawn over its camera in the camera view (roadcam.js): sunnypilot's
// selfdrive/ui/mici/onroad, ported piece by piece at the screen's own 536 x 240 pixels and scaled to the window.
// The path and lane lines in the status colours, the curved torque bar, the steering wheel with the turn intent,
// the set speed, alerts, the driver monitoring icon, blind spot icons, the bottom fade and rounded corners, and
// the confidence ball in the side panel. The comma sends the raw state (webhud video.py `hud`); the screen's
// filters run here, every frame, like the comma's do at 60 Hz.
import {
  MICI, STATUS, BounceFilter, Filter, arcBarPts, blendColors, clamp, interp, lengthIdx, miciFrame, miciPolygon,
  uncalibratedM,
} from './roadcam_geom.js';

const W = MICI.width, H = MICI.height, CW = MICI.content;
const FONT = 'CommaInter';
const FONT_SCALE = 1.16;                    // the small UI draws text this much bigger than its font sizes
const EM_PER_SIZE = FONT_SCALE / (3408 / 2816);   // raylib sizes a font by ascent to descent, not the em
const ASCENT = 2728 / 2816;                 // Inter's ascender, in ems: raylib puts a line's top there
const SET_SPEED_PERSISTENCE = 2.5;          // s
const KM_TO_MILE = 0.621371;
const TURN_SIGNAL_BLINK_PERIOD = 1 / (80 / 60);
const AWARENESS_UNFULL_PERCENT = 95;
const LOOKING_CENTER = [3, 6].map(d => d * Math.PI / 180);

const THROTTLE_COLORS = [[13, 248, 122, 102], [114, 255, 92, 89], [114, 255, 92, 0]];
const NO_THROTTLE_COLORS = [[242, 242, 242, 102], [242, 242, 242, 89], [242, 242, 242, 0]];
const LANE_LINE_COLORS = {
  [STATUS.DISENGAGED]: [200, 200, 200], [STATUS.OVERRIDE]: [255, 255, 255], [STATUS.ENGAGED]: [0, 255, 64],
  [STATUS.LAT_ONLY]: [0, 255, 64], [STATUS.LONG_ONLY]: [0, 255, 64],
};
const BORDER_COLORS = { [STATUS.LAT_ONLY]: [0x00, 0xC8, 0xC8], [STATUS.LONG_ONLY]: [0x96, 0x1C, 0xA8] };
const ALERT_COLORS = [[0, 0, 0], [255, 115, 0], [255, 0, 21]];   // normal, userPrompt, critical

// sizes as the screen loads them: gui_app.texture keeps the aspect ratio, inside the size asked for
const IMAGES = {
  wheel: 'wheel.png', wheelCritical: 'wheel_critical.png', exclamation: 'exclamation_point.png',
  turnIntent: 'turn_intent_left.png', blindSpot: 'blind_spot_left.png', fade: 'onroad_fade.png',
  turnSignal: 'turn_signal_left.png', dmBackground: 'dm_background.png', dmCone: 'dm_cone.png', dmPerson: 'dm_person.png',
};

const rgba = (c, a = c[3] ?? 255) => `rgba(${c[0]},${c[1]},${c[2]},${(a / 255).toFixed(3)})`;
const lerpColors = (a, b, t) => a.map((c, i) => c.map((v, k) => (1 - t) * v + t * b[i][k]));

let assets = null;
/** The screen's artwork and fonts (static/comma), loaded once; the screen draws without them until they're in. */
export function loadAssets(base = 'comma/') {
  if (assets) return assets;
  assets = { images: {}, ready: false };
  if (typeof Image === 'undefined') return assets;
  for (const [k, f] of Object.entries(IMAGES)) {
    const img = new Image();
    img.src = base + f;
    assets.images[k] = img;
  }
  if (typeof FontFace !== 'undefined' && typeof document !== 'undefined') {
    const fonts = [['Inter-Regular.ttf', '400'], ['Inter-SemiBold.ttf', '600'], ['Inter-Bold.ttf', '700']]
      .map(([f, weight]) => new FontFace(FONT, `url(${base}${f})`, { weight }));
    Promise.all(fonts.map(f => f.load().then(ff => document.fonts.add(ff)))).then(() => { assets.ready = true; }, () => {});
  }
  return assets;
}

export class CommaScreen {
  constructor() {
    this.assets = loadAssets();
    // model renderer
    this.blend = new Filter(1, 0.25);
    this.llTorque = new Filter(0, 0.1);
    // torque bar
    this.torque = new Filter(0, 0.1);
    this.torqueAlpha = new Filter(0, 0.1);
    // hud
    this.setSpeedAlpha = new Filter(0, 0.1);
    this.setSpeedChangedAt = 0;
    this.setSpeed = 255;
    this.engaged = false;
    this.wheelAlpha = new Filter(0, 0.05);
    this.wheelY = new Filter(0, 0.1);
    this.turnAlpha = new Filter(0, 0.05);
    this.turnRot = new Filter(0, 0.1);
    this.turnPre = false;
    this.turnDir = 0;
    this.bsLeft = new Filter(0, 0.15);
    this.bsRight = new Filter(0, 0.15);
    // alerts
    this.alertY = new BounceFilter(-50, 0.1);
    this.alertAlpha = new Filter(0, 0.05);
    this.prevAlert = null;
    this.signalTimer = 0;
    this.signalAlpha = new Filter(0, 0.3);
    this.lastIconSide = null;
    // driver monitoring
    this.dmFade = new Filter(0, 0.05);
    this.dmColor = new Filter(1, 0.05);
    this.dmPitch = new Filter(0, 0.05, false);
    this.dmYaw = new Filter(0, 0.05, false);
    this.dmRot = new Filter(0, 0.1, false);
    this.dmCenter = false;
    // confidence ball
    this.confidence = new Filter(-0.5, 0.5);
  }

  /**
   * One frame of the screen into ctx (already scaled so the screen is 536 x 240): the camera picture, then
   * everything the comma draws over it, in the comma's order. `now` in seconds, `dt` since the last frame.
   */
  draw(ctx, { frame, cam, wide, model, hud, now, dt }) {
    dt = clamp(dt || 1 / 60, 1 / 240, 0.25);
    const started = !!hud?.started;
    const status = started ? (hud.status || STATUS.DISENGAGED) : STATUS.DISENGAGED;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // the content area: the camera and its overlays, with rounded corners
    ctx.save();
    roundedClip(ctx, 0, 0, CW, H, 0.2 * 1.02 * H / 2);
    let proj = null;
    if (frame && cam?.Kfull) {
      const sensorW = cam.fullWidth, sensorH = cam.fullHeight;
      const M = cam.Mfull || uncalibratedM(cam.Kfull);
      const fr = miciFrame(cam.Kfull, M, CW, H, wide, hud?.vEgo || 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(frame, fr.tx, fr.ty, sensorW * fr.zoom, sensorH * fr.zoom);
      proj = { M, fr };
    } else if (frame) {   // a comma that sends no sensor intrinsics: the picture, covering the area
      const s = Math.max(CW / frame.displayWidth, H / frame.displayHeight);
      ctx.drawImage(frame, (CW - frame.displayWidth * s) / 2, (H - frame.displayHeight * s) / 2, frame.displayWidth * s, frame.displayHeight * s);
    }

    this.llTorque.update(hud?.torqueOut || 0, dt);
    if (started && proj && model && status !== STATUS.DISENGAGED) this.drawModel(ctx, model, proj, hud, status, dt);
    else this.blend.update(1, dt);

    const fade = this.img('fade');
    if (fade) ctx.drawImage(fade, 0, 0, CW, H);

    if (started) {
      const alert = hud.alert && hud.alert.size ? hud.alert : null;
      const alertToRender = alert || this.prevAlert;
      // the driver monitoring icon: not over the set speed, and not while disengaged unless it's always on
      this.drawDriverState(ctx, hud, !this.drawingTopIcons() && (status !== STATUS.DISENGAGED || hud.dm?.alwaysOn), dt);
      const critical = !!alert && alert.visual === 'steerRequired';
      this.drawAlert(ctx, alert, hud, now, dt);
      this.drawHud(ctx, hud, status, alertToRender === null, critical, now, dt);
    }
    ctx.restore();

    if (started) this.drawConfidence(ctx, hud, status, dt);
    ctx.restore();
  }

  img(k) {
    const i = this.assets.images[k];
    return i && i.complete && i.naturalWidth ? i : null;
  }

  // ---- model_renderer.py ------------------------------------------------------------------------------------
  drawModel(ctx, m, { M, fr }, hud, status, dt) {
    const path = m.path || [];
    if (!path.length) return;
    const lanes = m.lanes || [], probs = m.laneProbs || [];
    let maxDistance = clamp(path[path.length - 1][0], 10, 100);
    const laneIdx = lengthIdx(lanes[0] || [], maxDistance);
    const poly = (line, yOff, zOff, idx, invert = true) => miciPolygon(line, yOff, zOff, idx, M, fr, CW, H, invert);

    let width = 0.12;
    lanes.forEach((line, i) => {
      if (i === 1 || i === 2) width = 0.16;
      const p = poly(line, width * (probs[i] || 0), 0, laneIdx);
      if (p.length) fill(ctx, p, rgba(this.llColor(probs[i] || 0, i === 1 || i === 2, i <= 1, status)));
    });
    (m.edges || []).forEach((line, i) => {
      const p = poly(line, width, 0, laneIdx);
      // the edges go green where the lane line next to them is unsure
      if (p.length) fill(ctx, p, rgba(this.llColor(1 - (m.edgeStds?.[i] ?? 1), (probs[i + 1] ?? 0) < 0.25, i === 0, status)));
    });

    const lead = (m.leads || []).find(l => (l.i ?? 0) === 0);
    if (lead && hud?.radarValid !== false) {
      const leadD = lead.d * 2;
      maxDistance = clamp(leadD - Math.min(leadD * 0.35, 10), 0, maxDistance);
    }
    const pathPoly = poly(path, 0.9, m.pathZ ?? 1.22, lengthIdx(path, maxDistance), false);
    const allowThrottle = m.allowThrottle || !m.longControl;
    this.blend.update(allowThrottle ? 1 : 0, dt);
    if (!pathPoly.length) return;
    const g = ctx.createLinearGradient(0, H, 0, 0);   // bottom of the screen to its top
    if (m.experimental) {
      const accel = m.accel || [];
      const n = Math.min(Math.floor(pathPoly.length / 2), accel.length);
      const stops = [];
      for (let i = 0; i < n;) {
        const y = pathPoly[i][1];
        if (y < 0 || y > H) { i++; continue; }
        const along = 1 - y / H;
        const a = accel[i];
        const sat = Math.min(Math.abs(a * 1.5), 1);
        stops.push([along, hsla(clamp(60 + a * 35, 0, 120) / 360, sat, interp(sat, [0, 1], [0.95, 0.62]), interp(along, [0.375, 0.75], [0.4, 0]))]);
        i += 1 + (i + 2 < n ? 1 : 0);
      }
      if (stops.length > 1) {
        for (const [s, c] of stops) g.addColorStop(clamp(s, 0, 1), c);
        fill(ctx, pathPoly, g);
      } else {
        fill(ctx, pathPoly, 'rgba(255,255,255,0.118)');
      }
    } else {
      const t = Math.round(this.blend.x * 100) / 100;
      lerpColors(NO_THROTTLE_COLORS, THROTTLE_COLORS, clamp(t, 0, 1)).forEach((c, i) => g.addColorStop(i / 2, rgba(c)));
      fill(ctx, pathPoly, g);
    }
  }

  llColor(prob, adjacent, left, status) {
    const alpha = clamp(prob, 0, 0.7) * 255;
    let color = [255, 255, 255, alpha];
    if (adjacent) {
      const base = LANE_LINE_COLORS[status] || LANE_LINE_COLORS[STATUS.DISENGAGED];
      color = [...base, alpha];
      const torque = this.llTorque.x;
      if (Math.abs(torque) > 0.6 && left === (torque > 0)) {
        // the lines on the side being steered to go orange as the torque runs out
        color = blendColors(color, [255, 115, 0, alpha], interp(Math.abs(torque), [0.6, 0.8], [0, 1]));
      }
    }
    if (status === STATUS.DISENGAGED) color = [0, 0, 0, alpha];
    return color;
  }

  // ---- driver_state.py --------------------------------------------------------------------------------------
  drawDriverState(ctx, hud, allowed, dt) {
    const dm = hud.dm || {};
    const active = !!dm.active;
    const pitch = this.dmPitch.update((dm.pitch || 0) + 6 * Math.PI / 180, dt);
    const yaw = this.dmYaw.update((dm.yaw || 0) * (dm.rhd ? 1 : -1), dt);
    if (Math.abs(pitch) < LOOKING_CENTER[0] && Math.abs(yaw) < LOOKING_CENTER[0]) this.dmCenter = true;
    else if (Math.abs(pitch) > LOOKING_CENTER[1] || Math.abs(yaw) > LOOKING_CENTER[1]) this.dmCenter = false;
    const rotation = Math.atan2(pitch * 2, yaw) * 180 / Math.PI;
    const diff = ((rotation - this.dmRot.x + 180) % 360 + 360) % 360 - 180;
    this.dmRot.update(this.dmRot.initialized ? this.dmRot.x + diff : rotation, dt);
    const shouldDraw = allowed && !(hud.alert && hud.alert.size) && dm.seen;
    const fade = this.dmFade.update(!shouldDraw ? 0 : active ? 1 : 0.35, dt);
    const unfull = active && (dm.awareness ?? 100) < AWARENESS_UNFULL_PERCENT;
    const green = this.dmColor.update(unfull ? 0 : 1, dt);
    if (fade < 0.004) return;
    const x = 16, y = 10, size = 60, inner = 52;
    const bg = this.img('dmBackground'), person = this.img('dmPerson'), cone = this.img('dmCone');
    ctx.save();
    if (bg) { ctx.globalAlpha = fade; ctx.drawImage(bg, x, y, size, size); }
    if (person) { ctx.globalAlpha = 0.9 * fade; ctx.drawImage(person, x + (size - inner) / 2, y + (size - inner) / 2, inner, inner); }
    if (active && cone) {
      const c = [0, 1, 2].map(k => Math.round([0, 255, 64][k] * green + [255, 115, 0][k] * (1 - green)));
      ctx.globalAlpha = fade;
      ctx.translate(x + size / 2, y + size / 2);
      ctx.rotate((this.dmRot.x - 90) * Math.PI / 180);
      ctx.drawImage(tinted(cone, c, inner), -inner / 2, -inner / 2, inner, inner);
    }
    ctx.restore();
  }

  // ---- alert_renderer.py ------------------------------------------------------------------------------------
  drawAlert(ctx, current, hud, now, dt) {
    this.alertY.update(current ? 0 : -50, dt);
    const alpha = this.alertAlpha.update(current ? 1 : 0, dt);
    let alert = current;
    if (current) this.prevAlert = current;
    else if (alpha > 0.01 && this.prevAlert) alert = this.prevAlert;
    else { this.prevAlert = null; return; }

    const event = (alert.type || '').split('/')[0];
    // the background: solid at the top, fading down
    const base = ALERT_COLORS[alert.status] || ALERT_COLORS[0];
    const bgH = ['preLaneChangeLeft', 'preLaneChangeRight', 'laneChange'].includes(event) ? Math.round(H * 0.583)
      : event === 'laneChangeBlocked' ? Math.round(H * 0.833) : H;
    const solid = Math.round(bgH * 0.2);
    ctx.fillStyle = rgba(base, 255 * 0.9 * alpha);
    ctx.fillRect(0, 0, CW, solid);
    const g = ctx.createLinearGradient(0, solid, 0, bgH);
    g.addColorStop(0, rgba(base, 255 * 0.9 * alpha));
    g.addColorStop(1, rgba(base, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, solid, CW, bgH - solid);

    // the icon: the turn signal for a lane change, the blind spot when one's blocked
    let side = null, icon = null, mx = 20, my = 18, iconSize = null;
    if (event === 'preLaneChangeLeft' || event === 'preLaneChangeRight' || event === 'laneChange') {
      side = event === 'preLaneChangeLeft' ? 'left' : event === 'preLaneChangeRight' ? 'right' : this.lastIconSide;
      icon = 'turnSignal'; iconSize = [104, 96]; mx = 2; my = 5;
    } else if (event === 'laneChangeBlocked') {
      side = hud.leftBlinker ? 'left' : hud.rightBlinker ? 'right' : this.lastIconSide;
      icon = 'blindSpot'; iconSize = [133, 150]; mx = 8; my = 0;
    } else {
      this.signalTimer = 0;
    }
    this.lastIconSide = side;
    if (!side) icon = null;

    let tx = 18, tw = CW - 18;
    if (icon && side === 'left') { tx = 104; tw = CW - 18 - 104; } else if (icon && side === 'right') { tw = CW - 18 - 104; }
    const ty = this.alertY.x;

    const text1 = (alert.text1 || '').toLowerCase().replace('calibrating: ', 'calibrating:\n');
    let size1 = text1.length <= 12 ? 82 : text1.length <= 16 ? 70 : 54;
    if (icon) size1 -= 10;
    const align = side === 'left' && icon ? 'right' : 'left';
    const lines1 = wrapText(ctx, text1, 700, size1, size1 * -0.02, tw);
    const y1 = ty - (size1 >= 70 ? 11 : 4);
    const h1 = drawLines(ctx, lines1, 700, size1, size1 * -0.02, 0.86, tx, y1, tw, align, `rgba(255,255,255,${(0.9 * alpha).toFixed(3)})`);
    const text2 = (alert.text2 || '').toLowerCase();
    if (text2) {
      const size2 = text2.length > 24 ? 32 : text2.length > 18 ? 36 : 40;
      const lines2 = wrapText(ctx, text2, 400, size2, size2 * 0.025, tw);
      drawLines(ctx, lines2, 400, size2, size2 * 0.025, 0.86, tx, y1 + h1 - 4, tw, align, `rgba(255,255,255,${(0.65 * alpha).toFixed(3)})`);
    }

    if (icon) {
      let a = 255;
      if (icon === 'turnSignal') {
        if (now - this.signalTimer > TURN_SIGNAL_BLINK_PERIOD) { this.signalTimer = now; this.signalAlpha.x = 255 * 2; } else this.signalAlpha.update(255 * 0.2, dt);
        a = Math.min(this.signalAlpha.x, 255);
      }
      const img = this.img(icon);
      if (img) {
        const flip = side === 'right';
        const px = side === 'left' ? mx : CW - mx - iconSize[0];
        drawImage(ctx, img, px, my, iconSize[0], iconSize[1], { flip, alpha: (a / 255) * alpha });
      }
    }
  }

  // ---- hud_renderer.py, torque_bar.py, blind_spot_indicators.py ----------------------------------------------
  drawingTopIcons() { return this.setSpeedAlpha.x > 1e-2; }

  drawHud(ctx, hud, status, canDrawTop, critical, now, dt) {
    const engaged = !!hud.enabled;
    const setSpeed = hud.setSpeed ?? 255;
    if ((setSpeed !== this.setSpeed && engaged) || (engaged && !this.engaged)) this.setSpeedChangedAt = now;
    this.engaged = engaged;
    this.setSpeed = setSpeed;

    this.drawTorqueBar(ctx, hud, status, dt);
    if (setSpeed > 0 && setSpeed < 255) this.drawSetSpeed(ctx, hud, canDrawTop, now, dt);
    this.drawWheel(ctx, hud, status, critical, dt);
    this.drawBlindSpots(ctx, hud, dt);
  }

  drawTorqueBar(ctx, hud, status, dt) {
    const f = this.torque.update(hud.torque || 0, dt);
    const af = this.torqueAlpha.update(status !== STATUS.DISENGAGED && status !== STATUS.LONG_ONLY ? 1 : 0, dt);
    const a = Math.abs(f);
    const offset = interp(a, [0.5, 1], [22, 26]), height = interp(a, [0.5, 1], [14, 56]);
    const steering = status === STATUS.ENGAGED || status === STATUS.LAT_ONLY;
    const bg = [255, 255, 255, 255 * (steering ? interp(a, [0.5, 1], [0.25, 0.5]) : 0.15) * af];
    const radius = 1200, span = af * 12.7;
    const midR = radius + height / 2;
    const cx = CW / 2 + 8, cy = H + radius - offset;
    const shift = (pts) => pts.map(([x, y]) => [x + cx, y + cy]);
    const bgPts = shift(arcBarPts(midR, height, -90 - span / 2, -90 + span / 2));
    fill(ctx, bgPts, rgba(bg));
    const fgPts = shift(arcBarPts(midR, height, -90, -90 + span / 2 * f));
    const xs = bgPts.map(p => p[0]);
    const endX = cx * 0.35 + (f < 0 ? Math.min(...xs) : Math.max(...xs)) * 0.65;
    const orange = Math.max(0, a - 0.75) * 4;
    let c0 = blendColors([255, 255, 255, 255 * 0.9 * af], [255, 200, 0, 255 * af], orange);
    let c1 = blendColors([255, 255, 255, 255 * 0.9 * af], [255, 115, 0, 255 * af], orange);
    if (!steering) c0 = c1 = [255, 255, 255, 255 * 0.35 * af];
    if (Math.abs(endX - cx) > 0.5) {
      // the screen's gradient shader puts the first colour at the gradient's end, so the bar is orange at the centre
      // and yellower towards its tip (shader_polygon.py getGradientColor)
      const g = ctx.createLinearGradient(cx, 0, endX, 0);
      g.addColorStop(0, rgba(c1));
      g.addColorStop(1, rgba(c0));
      fill(ctx, fgPts, g);
    } else {
      fill(ctx, fgPts, rgba(c0));
    }
    if (a < 0.5) {
      ctx.fillStyle = rgba([182, 182, 182, 255 * 0.9 * af]);
      ctx.beginPath();
      ctx.arc(cx, H - offset - height / 2, 5, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  drawSetSpeed(ctx, hud, canDrawTop, now, dt) {
    const since = now - this.setSpeedChangedAt;
    const alpha = this.setSpeedAlpha.update(since > 0 && since < SET_SPEED_PERSISTENCE && canDrawTop && this.engaged ? 1 : 0, dt);
    if (alpha < 1e-2) return;
    const r = 81;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, `rgba(0,0,0,${(0.5 * alpha).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2 * r, 2 * r);
    const speed = hud.metric ? hud.setSpeed : hud.setSpeed * KM_TO_MILE;
    const color = `rgba(255,255,255,${(0.9 * alpha).toFixed(3)})`;
    drawText(ctx, String(Math.round(speed)), 700, 112, 0, 17, -4, color);
    drawText(ctx, 'MAX', 600, 36, 0, 25, 109, color);
  }

  drawWheel(ctx, hud, status, critical, dt) {
    const bsm = !!hud.blindspot && (this.bsLeft.x > 0.01 || this.bsRight.x > 0.01);
    if (critical) { this.wheelAlpha.update(255, dt); this.wheelY.update(0, dt); }
    else if (status === STATUS.DISENGAGED || bsm) { this.wheelAlpha.update(0, dt); this.wheelY.update(25, dt); }
    else { this.wheelAlpha.update(255 * 0.9, dt); this.wheelY.update(0, dt); }
    const px = 21 + 25, py = H - 14 - 25 + this.wheelY.x;

    // the turn intent: an arrow above the wheel that swings in for a lane change
    const events = hud.events || [];
    const left = events.includes('preLaneChangeLeft'), right = events.includes('preLaneChangeRight');
    if (left || right) {
      if (!this.turnPre) this.turnRot.x = left ? 30 : -30;
      this.turnPre = true;
      this.turnDir = left ? -1 : 1;
      this.turnAlpha.update(1, dt);
      this.turnRot.update(0, dt);
    } else if (events.includes('laneChange')) {
      this.turnPre = false;
      this.turnAlpha.update(0, dt);
      this.turnRot.update(this.turnDir * 30, dt);
    } else {
      this.turnPre = false;
      this.turnDir = 0;
      this.turnAlpha.update(0, dt);
      this.turnRot.update(0, dt);
    }
    const intent = this.img('turnIntent');
    if (intent && this.turnAlpha.x > 1e-2) {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(this.turnRot.x * Math.PI / 180);
      drawImage(ctx, intent, -24.5, -50, 49, 20, { flip: this.turnDir === 1, alpha: this.turnAlpha.x });
      ctx.restore();
    }

    const wheel = this.img(critical ? 'wheelCritical' : 'wheel');
    if (wheel && this.wheelAlpha.x > 0.5) {
      ctx.save();
      ctx.globalAlpha = this.wheelAlpha.x / 255;
      ctx.translate(px, py);
      ctx.rotate(-(hud.steeringAngle || 0) * Math.PI / 180);
      ctx.drawImage(wheel, -25, -25, 50, 50);
      ctx.restore();
    }
    const ex = this.img('exclamation');
    if (critical && ex) ctx.drawImage(ex, px - 4 + 25 + 10, py - 22, 8, 44);
  }

  drawBlindSpots(ctx, hud, dt) {
    this.bsLeft.update(hud.leftBlindspot ? 1 : 0, dt);
    this.bsRight.update(hud.rightBlindspot ? 1 : 0, dt);
    const img = this.img('blindSpot');
    if (!hud.blindspot || !img) return;
    if (this.bsLeft.x > 0.01) drawImage(ctx, img, 20, 100, 108, 121, { alpha: this.bsLeft.x });
    if (this.bsRight.x > 0.01) drawImage(ctx, img, CW - 20 - 108, 100, 108, 121, { alpha: this.bsRight.x, flip: true });
  }

  // ---- confidence_ball.py -----------------------------------------------------------------------------------
  drawConfidence(ctx, hud, status, dt) {
    let target;
    if (status === STATUS.DISENGAGED) target = -0.5;
    else if (status === STATUS.LAT_ONLY) target = 1 - (hud.steerProb ?? 1);
    else if (status === STATUS.LONG_ONLY) target = 1 - (hud.brakeProb ?? 1);
    else target = (1 - (hud.brakeProb ?? 1)) * (1 - (hud.steerProb ?? 1));
    const c = this.confidence.update(target, dt);
    const r = 24;
    const y = (1 - c) * (H - 2 * r) + r, x = W - r;
    let top, bottom;
    if (status === STATUS.ENGAGED) {
      [top, bottom] = c > 0.5 ? [[0, 255, 204], [0, 255, 38]] : c > 0.2 ? [[255, 200, 0], [255, 115, 0]] : [[255, 0, 21], [255, 0, 89]];
    } else if (BORDER_COLORS[status]) {
      top = bottom = BORDER_COLORS[status];
    } else if (status === STATUS.OVERRIDE) {
      [top, bottom] = [[255, 255, 255], [82, 82, 82]];
    } else {
      [top, bottom] = [[50, 50, 50], [13, 13, 13]];
    }
    const g = ctx.createLinearGradient(0, y - r, 0, y + r);
    g.addColorStop(0, rgba(top));
    g.addColorStop(1, rgba(bottom));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fill();
  }
}

// ---- drawing helpers ----------------------------------------------------------------------------------------

function fill(ctx, poly, style) {
  if (poly.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.fill();
}

function roundedClip(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.clip();
}

function hsla(h, s, l, a) {
  return `hsla(${(h * 360).toFixed(1)},${(s * 100).toFixed(1)}%,${(l * 100).toFixed(1)}%,${(Math.floor(a * 255) / 255).toFixed(3)})`;
}

function drawImage(ctx, img, x, y, w, h, { flip = false, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha *= clamp(alpha, 0, 1);
  if (flip) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(img, 0, 0, w, h); } else ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

const tintCache = new Map();
/** The image in one colour (raylib's tint multiplies; the cone is white). */
function tinted(img, [r, g, b], size) {
  const key = `${r},${g},${b}`;
  let c = tintCache.get(key);
  if (c) return c;
  if (tintCache.size > 64) tintCache.clear();
  c = document.createElement('canvas');
  c.width = c.height = size * 2;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, c.width, c.height);
  x.globalCompositeOperation = 'multiply';
  x.fillStyle = `rgb(${r},${g},${b})`;
  x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(img, 0, 0, c.width, c.height);
  tintCache.set(key, c);
  return c;
}

function setFont(ctx, weight, size, spacing) {
  ctx.font = `${weight} ${(size * EM_PER_SIZE).toFixed(2)}px ${FONT}, Inter, system-ui, sans-serif`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing.toFixed(2)}px`;
  ctx.textBaseline = 'alphabetic';
}

/** Text with its top at y, the way raylib's draw_text_ex places it. */
function drawText(ctx, text, weight, size, spacing, x, y, color, align = 'left') {
  setFont(ctx, weight, size, spacing);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y + ASCENT * size * EM_PER_SIZE);
}

function measure(ctx, text, weight, size, spacing) {
  setFont(ctx, weight, size, spacing);
  return ctx.measureText(text).width;
}

/** The label's word wrap (system/ui/lib/wrap_text.py): words onto lines that fit, explicit newlines kept. */
function wrapText(ctx, text, weight, size, spacing, width) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(ctx, next, weight, size, spacing) > width) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** UnifiedLabel's lines from the top of the rect: each after the first moves down its height times the line height. */
function drawLines(ctx, lines, weight, size, spacing, lineHeight, x, y, width, align, color) {
  const lineH = size * FONT_SCALE, step = lineH * lineHeight * 0.9;
  lines.forEach((ln, i) => drawText(ctx, ln, weight, size, spacing, align === 'right' ? x + width : x, y + i * step, color, align));
  return lines.length ? lineH + (lines.length - 1) * step : 0;
}
