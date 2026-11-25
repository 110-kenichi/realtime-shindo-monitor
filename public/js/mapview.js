// 地図の描画：強震モニタの画像と同じ画素座標系（352×400）の上に、
// 背景地図・推定震度・P波/S波・観測点・揺れ検知範囲を重ねて描く。

import { IMAGE_WIDTH, IMAGE_HEIGHT, SHINDO_CLASSES, intensityToClass, formatValue } from './kmoni.js';

const MIN_ZOOM = 0.8;
const MAX_ZOOM = 14;

export class MapView {
  constructor(canvas, tooltip) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltip;
    this.world = { w: IMAGE_WIDTH, h: IMAGE_HEIGHT };
    this.view = { scale: 1, ox: 0, oy: 0 };
    this.userMoved = false;
    this.data = { points: [], triggered: new Set(), event: null, est: null, ps: null };
    this.baseImage = null;
    this.baseLayer = null;
    this.message = '';
    this.pointers = new Map();
    this.hover = null;
    this.readTheme();

    new ResizeObserver(() => this.resize()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.readTheme();
      this.buildBaseLayer();
      this.requestRender();
    });
    this.bindInput();
    this.resize();
  }

  readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
    this.theme = {
      sea: v('--map-sea', '#0b1220'),
      land: v('--map-land', '#232c3b'),
      line: v('--map-line', '#55637a'),
      text: v('--text', '#e6e9ef'),
    };
  }

  // ---- データ ----

  setBaseImage(image) {
    this.baseImage = image;
    this.buildBaseLayer();
    this.requestRender();
  }

  setWorldSize(w, h) {
    if (w === this.world.w && h === this.world.h) return;
    this.world = { w, h };
    this.fit();
  }

  setData(data) {
    Object.assign(this.data, data);
    if (this.hover) this.updateHover(this.hover.sx, this.hover.sy);
    this.requestRender();
  }

  setMessage(text) {
    if (text === this.message) return;
    this.message = text;
    this.requestRender();
  }

  /** 背景地図を画面の配色に塗り直す（海は透明にして背景色で塗る） */
  buildBaseLayer() {
    const img = this.baseImage;
    if (!img) { this.baseLayer = null; return; }
    const w = img.width; const h = img.height;
    const layer = document.createElement('canvas');
    layer.width = w; layer.height = h;
    const g = layer.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const id = g.getImageData(0, 0, w, h);
    const d = id.data;
    const lum = (o) => (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]) / 255;

    // 最も多い色を海（または陸）とみなす
    const freq = new Map();
    let transparent = 0;
    for (let o = 0; o < d.length; o += 4) {
      if (d[o + 3] < 128) { transparent++; continue; }
      const k = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
    const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
    if (!sorted.length) { this.baseLayer = null; return; }
    const keyLum = (k) => (0.299 * (k >> 16) + 0.587 * ((k >> 8) & 255) + 0.114 * (k & 255)) / 255;
    const seaIsTransparent = transparent > (w * h) / 4;
    const seaL = seaIsTransparent ? null : keyLum(sorted[0][0]);
    const landEntry = seaIsTransparent ? sorted[0] : sorted.find(([k]) => Math.abs(keyLum(k) - seaL) > 0.03);
    const ref = seaL ?? 1;
    const landD = landEntry ? Math.abs(keyLum(landEntry[0]) - ref) : 0.1;
    let maxD = landD;
    for (let o = 0; o < d.length; o += 4) {
      if (d[o + 3] >= 128) maxD = Math.max(maxD, Math.abs(lum(o) - ref));
    }

    const land = parseColor(this.theme.land);
    const line = parseColor(this.theme.line);
    for (let o = 0; o < d.length; o += 4) {
      if (d[o + 3] < 128) { d[o + 3] = 0; continue; }
      const dist = Math.abs(lum(o) - ref);
      if (seaL !== null && dist < 0.02) { d[o + 3] = 0; continue; }
      let c = land;
      if (dist > landD * 1.15 && maxD > landD) {
        const u = Math.min(1, (dist - landD) / (maxD - landD));
        c = mix(land, line, 0.45 + 0.55 * u);
      }
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    this.baseLayer = layer;
  }

  // ---- 表示範囲 ----

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, r.width);
    this.cssH = Math.max(1, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    if (!this.userMoved) this.fit();
    this.requestRender();
  }

  fitScale() {
    return Math.min(this.cssW / this.world.w, this.cssH / this.world.h) * 0.97;
  }

  fit() {
    const s = this.fitScale();
    this.view = {
      scale: s,
      ox: (this.cssW - this.world.w * s) / 2,
      oy: (this.cssH - this.world.h * s) / 2,
    };
    this.userMoved = false;
    this.requestRender();
  }

  zoomAt(sx, sy, factor) {
    const base = this.fitScale();
    const s0 = this.view.scale;
    const s1 = Math.min(base * MAX_ZOOM, Math.max(base * MIN_ZOOM, s0 * factor));
    const k = s1 / s0;
    this.view = { scale: s1, ox: sx - (sx - this.view.ox) * k, oy: sy - (sy - this.view.oy) * k };
    this.userMoved = true;
    this.requestRender();
  }

  zoomBy(factor) {
    this.zoomAt(this.cssW / 2, this.cssH / 2, factor);
  }

  toScreen(wx, wy) {
    return [this.view.ox + wx * this.view.scale, this.view.oy + wy * this.view.scale];
  }

  // ---- 入力 ----

  bindInput() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    }, { passive: false });
    c.addEventListener('dblclick', () => this.fit());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, pos(e));
      if (e.pointerType !== 'mouse') this.hideTooltip();
    });
    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      const prev = this.pointers.get(e.pointerId);
      if (!prev) {
        if (e.pointerType === 'mouse') this.updateHover(p.x, p.y);
        return;
      }
      if (this.pointers.size === 1) {
        this.view.ox += p.x - prev.x;
        this.view.oy += p.y - prev.y;
        this.userMoved = true;
        this.pointers.set(e.pointerId, p);
        this.hideTooltip();
        this.requestRender();
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const other = a === prev ? b : a;
        const before = { mx: (prev.x + other.x) / 2, my: (prev.y + other.y) / 2, d: Math.hypot(prev.x - other.x, prev.y - other.y) };
        const after = { mx: (p.x + other.x) / 2, my: (p.y + other.y) / 2, d: Math.hypot(p.x - other.x, p.y - other.y) };
        this.pointers.set(e.pointerId, p);
        this.view.ox += after.mx - before.mx;
        this.view.oy += after.my - before.my;
        if (before.d > 0) this.zoomAt(after.mx, after.my, after.d / before.d);
      }
    });
    const up = (e) => this.pointers.delete(e.pointerId);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.hideTooltip(); });
  }

  updateHover(sx, sy) {
    let best = null;
    let bestD = 10 * 10;
    for (const p of this.data.points) {
      const [x, y] = this.toScreen(p.x + 0.5, p.y + 0.5);
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    this.hover = { sx, sy };
    if (!best) return this.hideTooltip(false);
    const cls = intensityToClass(best.i);
    const t = this.tooltip;
    t.replaceChildren();
    const v = document.createElement('b');
    v.textContent = formatValue(best.i);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = cls.bg;
    badge.style.color = cls.fg;
    badge.textContent = cls.key === '0' ? '震度0' : `震度${cls.label}`;
    t.append('リアルタイム震度 ', v, ' ', badge);
    t.hidden = false;
    const [x, y] = this.toScreen(best.x + 0.5, best.y + 0.5);
    const left = Math.min(x + 12, this.cssW - t.offsetWidth - 4);
    t.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, y - t.offsetHeight - 10)}px)`;
  }

  hideTooltip(clear = true) {
    this.tooltip.hidden = true;
    if (clear) this.hover = null;
  }

  // ---- 描画 ----

  requestRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  render() {
    const { ctx, dpr, view, data } = this;
    const { scale, ox, oy } = view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.theme.sea;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // 画像レイヤー（画素座標のまま拡大して描く）
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    if (this.baseLayer) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.baseLayer, 0, 0);
    }
    if (data.est) {
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.3;
      ctx.drawImage(data.est, 0, 0);
      ctx.globalAlpha = 1;
    }

    // 観測点（画面上の大きさで描く）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r0 = Math.min(9, Math.max(1.6, scale * 0.95));
    const pts = [...data.points].sort((a, b) => a.i - b.i);
    for (const p of pts) {
      if (p.i < 2.5) continue;
      const [x, y] = this.toScreen(p.x + 0.5, p.y + 0.5);
      ctx.fillStyle = `rgba(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]},0.22)`;
      ctx.beginPath();
      ctx.arc(x, y, r0 * (p.i >= 4.5 ? 4 : 3), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const p of pts) {
      const [x, y] = this.toScreen(p.x + 0.5, p.y + 0.5);
      if (x < -20 || y < -20 || x > this.cssW + 20 || y > this.cssH + 20) continue;
      const r = r0 * (p.i >= 4.5 ? 1.6 : p.i >= 2.5 ? 1.3 : 1);
      ctx.fillStyle = `rgb(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (data.triggered.has(p.key)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(x, y, r + 2.2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // P波・S波（強震モニタの画像）
    if (data.ps) {
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(data.ps, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // 揺れ検知範囲
    const ev = data.event;
    if (ev && Number.isFinite(ev.x0)) {
      const pad = 10;
      const [x0, y0] = this.toScreen(ev.x0 + 0.5, ev.y0 + 0.5);
      const [x1, y1] = this.toScreen(ev.x1 + 0.5, ev.y1 + 0.5);
      const rx = x0 - pad; const ry = y0 - pad;
      const rw = Math.max(x1 - x0 + pad * 2, 24); const rh = Math.max(y1 - y0 + pad * 2, 24);
      const color = ev.peakClass && SHINDO_CLASSES.indexOf(ev.peakClass) >= 3 ? ev.peakClass.bg : '#ffd54a';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = ev.active ? 1 : 0.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      roundRect(ctx, rx, ry, rw, rh, 8);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '600 12px system-ui, sans-serif';
      const label = '揺れ検知';
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = color;
      ctx.beginPath();
      roundRect(ctx, rx, ry - 20, tw, 18, 4);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.fillText(label, rx + 5, ry - 7);
      ctx.globalAlpha = 1;
    }

    if (this.message) {
      ctx.font = '500 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = this.theme.text;
      ctx.globalAlpha = 0.85;
      ctx.fillText(this.message, this.cssW / 2, this.cssH / 2);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'start';
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h); // 角丸に非対応の古いブラウザ
}

function parseColor(css) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = css;
  const v = c.fillStyle; // "#rrggbb" か "rgba(...)"
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
  return v.match(/\d+/g).slice(0, 3).map(Number);
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}
