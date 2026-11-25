// 強震モニタ（防災科研）の画像解析と震度関連のユーティリティ。
// DOM に依存しないので、ブラウザと Node.js（テスト・模擬サーバー）の両方から使う。

/** 強震モニタ画像の大きさ（px） */
export const IMAGE_WIDTH = 352;
export const IMAGE_HEIGHT = 400;

const JST_OFFSET_MS = 9 * 3600 * 1000;

// ---------------------------------------------------------------------------
// 色 ⇔ リアルタイム震度
// ---------------------------------------------------------------------------

/** RGB(0-255) → HSV(各 0-1) */
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

/** HSV(各 0-1) → RGB(0-255) */
export function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ][i];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * 強震モニタのカラースケール上の位置（0〜1）を色から求める。
 * スケールに属さない色（地図の灰色・白・黒など）は null。
 * 色相・明度に対する多項式近似（KyoshinMonitorLib などで広く使われている係数）。
 */
export function colorToScale(r, g, b) {
  let [h, s, v] = rgbToHsv(r, g, b);
  if (v <= 0.1 || s <= 0.75) return null;
  if (h > 0.9) h = 0; // 赤のわずかな揺らぎ（色相が 1 付近に回り込むもの）は赤として扱う
  let p;
  if (h > 0.1476) {
    p = 280.31 * h ** 6 - 916.05 * h ** 5 + 1142.6 * h ** 4 - 709.95 * h ** 3
      + 234.65 * h ** 2 - 40.27 * h + 3.2217;
  } else if (h > 0.001) {
    p = 151.4 * h ** 4 - 49.32 * h ** 3 + 6.753 * h ** 2 - 2.481 * h + 0.9033;
  } else {
    p = -0.005171 * v ** 2 - 0.3282 * v + 1.2236;
  }
  return Math.min(Math.max(p, 0), 1.1);
}

/** 色 → リアルタイム震度（-3〜7 程度）。スケール外の色は null。 */
export function colorToIntensity(r, g, b) {
  const p = colorToScale(r, g, b);
  return p === null ? null : p * 10 - 3;
}

// 凡例や模擬データ用に、スケール上の色を震度の小さい順にサンプリングしておく。
const SCALE_SAMPLES = (() => {
  const out = [];
  for (let h = 0.667; h > 0.0011; h -= 0.0005) {
    const rgb = hsvToRgb(h, 1, 1);
    out.push({ i: colorToIntensity(...rgb), rgb });
  }
  for (let v = 1; v >= 0.6; v -= 0.002) {
    const rgb = hsvToRgb(0, 1, v);
    out.push({ i: colorToIntensity(...rgb), rgb });
  }
  return out.filter((s) => s.i !== null).sort((a, b) => a.i - b.i);
})();

/** リアルタイム震度 → 強震モニタ風の色 [r,g,b]（colorToIntensity の逆変換の近似） */
export function intensityToRgb(i) {
  const s = SCALE_SAMPLES;
  if (i <= s[0].i) return s[0].rgb;
  if (i >= s[s.length - 1].i) return s[s.length - 1].rgb;
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].i <= i) lo = mid; else hi = mid;
  }
  return i - s[lo].i <= s[hi].i - i ? s[lo].rgb : s[hi].rgb;
}

// ---------------------------------------------------------------------------
// 震度階級
// ---------------------------------------------------------------------------

/** 震度階級（色は気象庁の震度の推奨配色） */
export const SHINDO_CLASSES = [
  { key: '0', label: '0', min: -Infinity, bg: '#5b6573', fg: '#ffffff' },
  { key: '1', label: '1', min: 0.5, bg: '#f2f2ff', fg: '#1a1a1a' },
  { key: '2', label: '2', min: 1.5, bg: '#00aaff', fg: '#0b1020' },
  { key: '3', label: '3', min: 2.5, bg: '#0041ff', fg: '#ffffff' },
  { key: '4', label: '4', min: 3.5, bg: '#fae696', fg: '#1a1a1a' },
  { key: '5-', label: '5弱', min: 4.5, bg: '#ffe600', fg: '#1a1a1a' },
  { key: '5+', label: '5強', min: 5.0, bg: '#ff9900', fg: '#1a1a1a' },
  { key: '6-', label: '6弱', min: 5.5, bg: '#ff2800', fg: '#ffffff' },
  { key: '6+', label: '6強', min: 6.0, bg: '#a50021', fg: '#ffffff' },
  { key: '7', label: '7', min: 6.5, bg: '#b40068', fg: '#ffffff' },
];

const CLASS_BY_KEY = new Map(SHINDO_CLASSES.map((c) => [c.key, c]));

export function shindoClass(key) {
  return CLASS_BY_KEY.get(key) ?? null;
}

/** 計測震度（リアルタイム震度）→ 震度階級 */
export function intensityToClass(i) {
  const r = Math.round(i * 10) / 10;
  for (let k = SHINDO_CLASSES.length - 1; k > 0; k--) {
    if (r >= SHINDO_CLASSES[k].min) return SHINDO_CLASSES[k];
  }
  return SHINDO_CLASSES[0];
}

/** P2P地震情報の震度コード（10, 20, ... 70）→ 震度階級 */
export function p2pScaleToClass(scale) {
  const map = { 10: '1', 20: '2', 30: '3', 40: '4', 45: '5-', 46: '5-', 50: '5+', 55: '6-', 60: '6+', 70: '7' };
  return shindoClass(map[scale]) ?? null;
}

/** 強震モニタの緊急地震速報 JSON の予想震度（"5弱" "4" など）→ 震度階級 */
export function textToClass(text) {
  if (text == null) return null;
  const t = String(text).trim().replace('-', '弱').replace('+', '強');
  return SHINDO_CLASSES.find((c) => c.label === t) ?? null;
}

// ---------------------------------------------------------------------------
// 画像解析
// ---------------------------------------------------------------------------

/**
 * 強震モニタのリアルタイム震度画像（RGBA）から観測点を取り出す。
 * 透明でなく、スケール上の色を持つ画素を観測点とし、上下左右に隣接する画素は
 * 1つの観測点としてまとめる（観測点の描画サイズが 1px でも数 px でも扱える）。
 *
 * @param {Uint8ClampedArray|Uint8Array} data RGBA
 * @returns {{key:number,x:number,y:number,i:number,size:number,rgb:number[]}[]}
 *   key: 観測点を識別する画素番号（画像内で固定）、x,y: 中心（画素座標）、i: リアルタイム震度
 */
export function analyzeImage(data, width, height) {
  const n = width * height;
  const val = new Float32Array(n).fill(NaN);
  for (let k = 0; k < n; k++) {
    const o = k * 4;
    if (data[o + 3] < 128) continue;
    const v = colorToIntensity(data[o], data[o + 1], data[o + 2]);
    if (v !== null) val[k] = v;
  }

  const seen = new Uint8Array(n);
  const stack = [];
  const points = [];
  for (let k = 0; k < n; k++) {
    if (seen[k] || Number.isNaN(val[k])) continue;
    seen[k] = 1;
    stack.push(k);
    let sx = 0; let sy = 0; let cnt = 0; let maxV = -Infinity; let maxK = k;
    while (stack.length) {
      const c = stack.pop();
      const x = c % width;
      const y = (c - x) / width;
      sx += x; sy += y; cnt++;
      if (val[c] > maxV) { maxV = val[c]; maxK = c; }
      if (x > 0) visit(c - 1);
      if (x < width - 1) visit(c + 1);
      if (y > 0) visit(c - width);
      if (y < height - 1) visit(c + width);
    }
    points.push({
      key: k,
      x: sx / cnt,
      y: sy / cnt,
      i: maxV,
      size: cnt,
      rgb: [data[maxK * 4], data[maxK * 4 + 1], data[maxK * 4 + 2]],
    });
  }
  return points;

  function visit(c) {
    if (!seen[c] && !Number.isNaN(val[c])) { seen[c] = 1; stack.push(c); }
  }
}

/**
 * 診断用：画像の画素を数える（観測点の数が合わないときの調査用）。
 * 不透明な画素のうち、震度に換算できた数・できなかった色の内訳と、まとまり（観測点）の大きさの分布を返す。
 */
export function imageStats(data, width, height, points = analyzeImage(data, width, height)) {
  let opaque = 0;
  let accepted = 0;
  const rejected = new Map();
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] < 128) continue;
    opaque++;
    if (colorToIntensity(data[o], data[o + 1], data[o + 2]) !== null) { accepted++; continue; }
    const k = `${data[o]},${data[o + 1]},${data[o + 2]}`;
    rejected.set(k, (rejected.get(k) ?? 0) + 1);
  }
  const sizes = new Map();
  for (const p of points) sizes.set(p.size, (sizes.get(p.size) ?? 0) + 1);
  return {
    size: `${width}x${height}`,
    opaque,
    accepted,
    points: points.length,
    pointSizes: [...sizes.entries()].sort((a, b) => a[0] - b[0]).slice(0, 12),
    rejectedTop: [...rejected.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

/** リアルタイム震度の表示用の文字列（小数1桁、マイナスは全角幅の「−」） */
export function formatValue(i) {
  const s = (Math.round(i * 10) / 10).toFixed(1);
  return s === '-0.0' ? '0.0' : s.replace('-', '−');
}

/** 観測点の配列を集計する */
export function summarize(points) {
  const counts = Object.fromEntries(SHINDO_CLASSES.map((c) => [c.key, 0]));
  let max = null;
  for (const p of points) {
    counts[intensityToClass(p.i).key]++;
    if (!max || p.i > max.i) max = p;
  }
  return { total: points.length, counts, max };
}

// ---------------------------------------------------------------------------
// 時刻（強震モニタは日本時間）
// ---------------------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, '0');

function jstParts(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
  };
}

/** epoch ms → "yyyyMMddHHmmss"（日本時間） */
export function formatKmoniTime(ms) {
  const p = jstParts(ms);
  return `${p.y}${pad(p.mo)}${pad(p.d)}${pad(p.h)}${pad(p.mi)}${pad(p.s)}`;
}

/** epoch ms → "yyyy/MM/dd HH:mm:ss"（日本時間） */
export function formatJst(ms, { date = true, seconds = true } = {}) {
  const p = jstParts(ms);
  const time = `${pad(p.h)}:${pad(p.mi)}${seconds ? `:${pad(p.s)}` : ''}`;
  return date ? `${p.y}/${pad(p.mo)}/${pad(p.d)} ${time}` : time;
}

/** "yyyy/MM/dd HH:mm:ss" や "yyyyMMddHHmmss"（日本時間）→ epoch ms。解釈できなければ NaN */
export function parseJst(text) {
  if (text == null) return NaN;
  const m = String(text).trim().match(
    /^(\d{4})[/-]?(\d{1,2})[/-]?(\d{1,2})[ T]?(\d{1,2}):?(\d{2}):?(\d{2})?(?:\.\d+)?$/,
  );
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s = '0'] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - JST_OFFSET_MS;
}

// ---------------------------------------------------------------------------
// 強震モニタの緊急地震速報 JSON
// ---------------------------------------------------------------------------

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** 強震モニタの EEW JSON を扱いやすい形にする。速報が出ていなければ null。 */
export function parseKmoniEew(json) {
  if (!json || typeof json !== 'object' || !json.report_id) return null;
  const num = (v) => {
    const x = parseFloat(v);
    return Number.isFinite(x) ? x : null;
  };
  return {
    source: 'kmoni',
    id: String(json.report_id),
    serial: parseInt(json.report_num, 10) || null,
    isFinal: truthy(json.is_final),
    isCancel: truthy(json.is_cancel),
    isTraining: truthy(json.is_training),
    isWarning: String(json.alertflg ?? '').includes('警報'),
    region: json.region_name || '',
    latitude: num(json.latitude),
    longitude: num(json.longitude),
    depth: num(json.depth),
    magnitude: num(json.magunitude ?? json.magnitude),
    maxClass: textToClass(json.calcintensity),
    maxText: json.calcintensity || '',
    originTime: parseJst(json.origin_time),
    reportTime: parseJst(json.report_time),
    areas: [],
  };
}
