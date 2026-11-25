import {
  SHINDO_CLASSES, analyzeImage, summarize, intensityToClass, intensityToRgb, p2pScaleToClass, formatValue,
  formatKmoniTime, formatJst, parseJst, parseKmoniEew,
} from './kmoni.js';
import { ShakeDetector } from './detector.js';
import { MapView } from './mapview.js';
import { P2PClient, tsunamiText } from './p2p.js';
import { unlockAudio, play } from './sound.js';

const $ = (id) => document.getElementById(id);
const HISTORY_MS = 5 * 60 * 1000;
const P2P_EEW_TTL = 3 * 60 * 1000;

const PRESETS = [
  ['2024-01-01T16:10:00', '2024/01/01 能登半島地震（M7.6・最大震度7）'],
  ['2024-08-08T16:42:45', '2024/08/08 日向灘の地震（M7.1・最大震度6弱）'],
  ['2022-03-16T23:36:20', '2022/03/16 福島県沖の地震（M7.4・最大震度6強）'],
  ['2021-02-13T23:07:40', '2021/02/13 福島県沖の地震（M7.3・最大震度6強）'],
  ['2018-09-06T03:07:50', '2018/09/06 北海道胆振東部地震（M6.7・最大震度7）'],
  ['2016-04-16T01:24:55', '2016/04/16 熊本地震 本震（M7.3・最大震度7）'],
];

// ---------------------------------------------------------------------------
// 設定（ブラウザに保存。保存できない環境でも動くようにする）
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'rtshindo.settings.v1';
const settings = { type: 'jma_s', overlays: true, detect: true, sound: false };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
} catch { /* 保存領域が使えない */ }
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 無視 */ }
}

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

const map = new MapView($('map'), $('tooltip'));
const detector = new ShakeDetector();

const state = {
  mode: 'live', // 'live' | 'replay'
  gen: 0, // 再生位置・観測点の種類を変えたら増やし、古い応答を捨てる
  offset: null, // 強震モニタの最新時刻 − 端末の時刻
  lastCal: 0,
  calibrating: false,
  fails: 0,
  lastRequested: 0,
  lastRendered: 0,
  inflight: 0,
  retryAt: 0, // 失敗が続いたときは間隔をあけて再試行する
  shakeEvent: null,
  replay: { base: 0, wallStart: 0, playing: false, pausedAt: 0, speed: 1 },
  history: [],
  kmoniEew: null,
  p2pEew: new Map(), // id -> { eew, receivedAt }
  notifiedEew: new Map(), // id -> { serial, warning }
  peakIdx: -1,
  quakes: [],
  freshQuake: null,
  openQuake: null,
};

const workCanvas = document.createElement('canvas');
const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

class HttpError extends Error {
  constructor(status) { super(`HTTP ${status}`); this.status = status; }
}

async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(res.status);
  const blob = await res.blob();
  try {
    // 色を正確に読むため、色空間の変換をしない
    return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    return createImageBitmap(blob); // オプション非対応のブラウザ
  }
}

async function loadImageData(url) {
  const bmp = await loadBitmap(url);
  const { width, height } = bmp;
  workCanvas.width = width;
  workCanvas.height = height;
  workCtx.clearRect(0, 0, width, height);
  workCtx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return { data: workCtx.getImageData(0, 0, width, height).data, width, height };
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new HttpError(res.status);
  return res.json();
}

// ---------------------------------------------------------------------------
// 時刻合わせとデータ取得のループ
// ---------------------------------------------------------------------------

async function calibrate() {
  state.calibrating = true;
  try {
    const j = await fetchJson('/api/kmoni/latest');
    const t = parseJst(j.latest_time);
    if (!Number.isFinite(t)) throw new Error('最新時刻を解釈できません');
    state.offset = t - Date.now();
    state.lastCal = Date.now();
    state.fails = 0;
  } catch (err) {
    console.warn('強震モニタの最新時刻を取得できません', err);
    state.lastCal = Date.now() - 50_000; // 10 秒後に再試行
    setConn('error', '強震モニタに接続できません');
    if (!state.lastRendered) map.setMessage('強震モニタに接続できません。再試行しています…');
  } finally {
    state.calibrating = false;
  }
}

function targetTime() {
  if (state.mode === 'live') {
    if (state.offset === null) return null;
    return Math.floor((Date.now() + state.offset - 300) / 1000) * 1000;
  }
  const r = state.replay;
  if (!r.playing) return r.pausedAt;
  return r.base + Math.floor(((Date.now() - r.wallStart) * r.speed) / 1000) * 1000;
}

function tick() {
  if (state.mode === 'live') {
    const due = state.offset === null || Date.now() - state.lastCal > 60_000 || state.fails >= 3;
    if (due && !state.calibrating) calibrate();
  } else if (state.replay.playing && targetTime() > Date.now() - 3000) {
    goLive(); // 再生が現在に追いついた
    return;
  }
  if (Date.now() < state.retryAt) return;
  const t = targetTime();
  if (t === null || t <= state.lastRequested || state.inflight >= 3) return;
  state.lastRequested = t;
  loadFrame(t, state.gen);
}

async function loadFrame(t, gen) {
  state.inflight++;
  const ts = formatKmoniTime(t);
  try {
    const [frame, eewJson] = await Promise.all([
      loadImageData(`/api/kmoni/rt/${settings.type}/${ts}`),
      fetchJson(`/api/kmoni/eew/${ts}`).catch(() => null),
    ]);
    if (gen !== state.gen || t <= state.lastRendered) return;
    const eew = parseKmoniEew(eewJson);
    let est = null;
    let ps = null;
    if (eew && !eew.isCancel && settings.overlays) {
      [est, ps] = await Promise.all([
        loadBitmap(`/api/kmoni/est/${ts}`).catch(() => null),
        loadBitmap(`/api/kmoni/ps/${ts}`).catch(() => null),
      ]);
      if (gen !== state.gen || t <= state.lastRendered) return;
    }
    state.lastRendered = t;
    state.fails = 0;
    state.retryAt = 0;
    onFrame(t, frame, eew, est, ps);
  } catch (err) {
    if (gen !== state.gen) return;
    state.fails++;
    if (state.fails >= 2) state.retryAt = Date.now() + Math.min(5000, 500 * state.fails);
    if (state.mode === 'live') {
      if (state.lastRequested === t) state.lastRequested = t - 1000; // 同じ時刻をもう一度試す
      if (state.fails >= 3) setConn('error', '強震モニタからデータを取得できません');
    } else if (state.fails >= 5 && !state.lastRendered) {
      map.setMessage('この日時のデータを取得できません（保存期間外の可能性があります）');
    }
  } finally {
    state.inflight--;
  }
}

// ---------------------------------------------------------------------------
// 1 秒ごとのデータを画面に反映
// ---------------------------------------------------------------------------

function onFrame(t, frame, kmoniEew, est, ps) {
  const points = analyzeImage(frame.data, frame.width, frame.height);
  map.setWorldSize(frame.width, frame.height);

  const det = settings.detect
    ? detector.update(points, t)
    : { triggered: new Set(), event: null, isNew: false };
  const sum = summarize(points);

  state.history.push({ t, v: sum.max ? sum.max.i : null });
  while (state.history.length && state.history[0].t < t - HISTORY_MS) state.history.shift();

  state.kmoniEew = kmoniEew;
  state.shakeEvent = det.event;

  map.setData({ points, triggered: det.triggered, event: det.event, est, ps });
  map.setMessage(points.length ? '' : 'この時刻の観測データがありません');

  setConn('ok', '強震モニタに接続しています');
  renderTime(t);
  renderMax(sum);
  renderBars(sum);
  renderShake(det.event);
  renderSpark();
  refreshEew();
  notifyShake(det);
}

/** 緊急地震速報の表示を更新する（強震モニタの受信時と P2P地震情報の受信時、定期的に呼ぶ） */
function refreshEew() {
  const eew = currentEew();
  renderEew(eew);
  renderTitle(state.shakeEvent, eew);
  if (eew) {
    const prev = state.notifiedEew.get(eew.id);
    if (!eew.isCancel && (!prev || (eew.isWarning && !prev.warning))) {
      play(eew.isWarning ? 'warning' : 'eew');
    }
    state.notifiedEew.set(eew.id, { serial: eew.serial, warning: eew.isWarning });
  }
}

function currentEew() {
  const now = Date.now();
  for (const [id, v] of state.p2pEew) if (now - v.receivedAt > P2P_EEW_TTL) state.p2pEew.delete(id);
  const k = state.kmoniEew;
  if (k) {
    const extra = state.p2pEew.get(k.id)?.eew;
    return extra ? { ...k, areas: extra.areas, isWarning: k.isWarning || extra.isWarning } : k;
  }
  if (state.mode !== 'live' || !state.p2pEew.size) return null;
  return [...state.p2pEew.values()].sort((a, b) => b.receivedAt - a.receivedAt)[0].eew;
}

function notifyShake(det) {
  if (det.event) {
    const idx = SHINDO_CLASSES.indexOf(det.event.peakClass);
    if (det.isNew) play('shake');
    else if (idx >= 3 && idx > state.peakIdx) play('strong');
    state.peakIdx = Math.max(state.peakIdx, idx);
  } else {
    state.peakIdx = -1;
  }
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

function classLabel(cls) {
  return cls ? `震度${cls.label}` : '震度不明';
}

function badge(cls, text = cls ? cls.label : '-') {
  const el = document.createElement('span');
  el.className = 'shindo-badge';
  el.textContent = text;
  if (cls) {
    el.style.background = cls.bg;
    el.style.color = cls.fg;
  }
  return el;
}

function setConn(kind, title) {
  const el = $('conn');
  el.dataset.state = kind;
  el.title = title;
  el.textContent = { ok: '受信中', error: '接続エラー', connecting: '接続中' }[kind];
}

function renderTime(t) {
  $('data-time').textContent = formatJst(t);
  if (state.mode === 'live') {
    const delay = (Date.now() - t) / 1000;
    $('delay').textContent = `遅れ ${delay.toFixed(1)}秒`;
  } else {
    $('delay').textContent = '';
    $('replay-time').textContent = formatJst(t);
  }
}

function renderMax(sum) {
  const el = $('max-badge');
  $('station-count').textContent = `観測点 ${sum.total.toLocaleString()} 点`;
  if (!sum.max) {
    $('max-value').textContent = '-.-';
    el.replaceChildren('-');
    el.style.background = '';
    el.style.color = '';
    return;
  }
  const cls = intensityToClass(sum.max.i);
  $('max-value').textContent = formatValue(sum.max.i);
  const small = document.createElement('small');
  small.textContent = '震度';
  el.replaceChildren(small, cls.label);
  el.style.background = cls.bg;
  el.style.color = cls.fg;
}

function renderBars(sum) {
  const box = $('class-bars');
  const classes = SHINDO_CLASSES.slice(1);
  const maxCount = Math.max(1, ...classes.map((c) => sum.counts[c.key]));
  if (!box.childElementCount) {
    for (const c of classes) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.background = c.bg;
      bar.append(fill);
      const count = document.createElement('span');
      count.className = 'count';
      box.append(badge(c), bar, count);
    }
  }
  classes.forEach((c, k) => {
    const n = sum.counts[c.key];
    const [b, bar, count] = [box.children[k * 3], box.children[k * 3 + 1], box.children[k * 3 + 2]];
    bar.firstChild.style.width = `${n ? Math.max(3, Math.sqrt(n / maxCount) * 100) : 0}%`;
    count.textContent = n;
    for (const el of [b, count]) el.classList.toggle('zero', n === 0);
  });
}

function renderShake(ev) {
  const el = $('shake-banner');
  if (!ev) { el.hidden = true; return; }
  el.hidden = false;
  const cls = ev.peakClass;
  el.style.borderColor = SHINDO_CLASSES.indexOf(cls) >= 3 ? cls.bg : '#ffd54a';
  const title = document.createElement('span');
  title.textContent = ev.active ? '揺れを検知しています' : '揺れ検知（収まりつつあります）';
  const info = document.createElement('span');
  info.className = 'muted';
  info.textContent = `検知後の最大 ${formatValue(ev.peak)}`;
  el.replaceChildren(badge(cls, classLabel(cls)), title, info);
}

function eewLines(eew) {
  const parts = [];
  if (eew.magnitude != null) parts.push(`M${eew.magnitude.toFixed(1)}`);
  if (eew.depth != null) parts.push(`深さ${Math.round(eew.depth)}km`);
  return parts.join('　');
}

function renderEew(eew) {
  const banner = $('eew-banner');
  const card = $('eew-card');
  if (!eew) {
    banner.hidden = true;
    card.hidden = true;
    return;
  }
  const kind = eew.isWarning ? '警報' : '予報';
  const training = eew.isTraining ? '【訓練】' : '';
  const serial = eew.serial ? `第${eew.serial}報${eew.isFinal ? '（最終）' : ''}` : '';
  banner.hidden = false;
  card.hidden = false;
  banner.className = `eew-banner${eew.isCancel ? ' cancel' : eew.isWarning ? ' warning' : ''}`;
  card.classList.toggle('warning', eew.isWarning);

  const title = document.createElement('div');
  title.className = 'eew-title';
  const line = document.createElement('div');
  line.className = 'eew-line';
  if (eew.isCancel) {
    title.textContent = `${training}緊急地震速報は取り消されました`;
    banner.replaceChildren(title);
  } else {
    title.textContent = `${training}緊急地震速報（${kind}）${serial ? ` ${serial}` : ''}`;
    const maxText = eew.maxClass ? `　予想最大震度 ${eew.maxClass.label}` : '';
    line.textContent = `${eew.region || '震源調査中'}　${eewLines(eew)}${maxText}`;
    banner.replaceChildren(title, line);
  }

  $('eew-serial').textContent = `${serial}${eew.source === 'p2p' ? '（P2P地震情報）' : ''}`;
  const dl = document.createElement('dl');
  dl.className = 'eew-grid';
  const add = (k, v) => {
    if (v == null || v === '') return;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (v instanceof Node) dd.append(v); else dd.textContent = v;
    dl.append(dt, dd);
  };
  add('種別', `${training}${eew.isCancel ? '取消' : kind}`);
  add('震源', eew.region || '調査中');
  if (Number.isFinite(eew.originTime)) add('発生時刻', formatJst(eew.originTime));
  add('規模', eew.magnitude != null ? `M${eew.magnitude.toFixed(1)}` : null);
  add('深さ', eew.depth != null ? `${Math.round(eew.depth)}km` : null);
  if (eew.maxClass) add('予想最大震度', badge(eew.maxClass, eew.maxClass.label));
  else if (eew.maxText) add('予想最大震度', eew.maxText);
  const body = $('eew-body');
  body.replaceChildren(dl);
  if (eew.areas?.length) {
    const areas = document.createElement('div');
    areas.className = 'eew-areas';
    areas.textContent = `強い揺れに警戒：${eew.areas.map((a) => a.name).join('、')}`;
    body.append(areas);
  }
}

function renderTitle(ev, eew) {
  const tags = [];
  if (eew && !eew.isCancel) tags.push(eew.isWarning ? '緊急地震速報（警報）' : '緊急地震速報');
  if (ev) tags.push(`揺れ検知 ${classLabel(ev.peakClass)}相当`);
  document.title = `${tags.length ? `【${tags.join('・')}】` : ''}リアルタイム震度モニタ`;
}

function renderSpark() {
  const c = $('spark');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
  if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const hist = state.history.filter((p) => p.v !== null);
  if (!hist.length) return;
  const tEnd = hist[hist.length - 1].t;
  const tStart = tEnd - HISTORY_MS;
  const vmax = Math.max(3, Math.ceil(Math.max(...hist.map((p) => p.v)) + 0.5));
  const vmin = Math.min(-1, Math.floor(Math.min(...hist.map((p) => p.v))));
  const x = (t) => ((t - tStart) / HISTORY_MS) * (w - 4) + 2;
  const y = (v) => h - 4 - ((v - vmin) / (vmax - vmin)) * (h - 8);

  const cs = getComputedStyle(document.documentElement);
  g.font = '10px system-ui, sans-serif';
  g.lineWidth = 1;
  let lastLabelY = Infinity;
  for (const c2 of SHINDO_CLASSES.slice(1)) {
    if (c2.min > vmax || c2.min < vmin) continue;
    const yy = Math.round(y(c2.min)) + 0.5;
    if (lastLabelY - yy < 12) continue; // 目盛りが詰まるときは間引く
    lastLabelY = yy;
    g.strokeStyle = cs.getPropertyValue('--border');
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(0, yy);
    g.lineTo(w, yy);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = cs.getPropertyValue('--muted');
    g.fillText(c2.label, 2, yy - 2);
  }

  g.lineWidth = 1.6;
  g.lineJoin = 'round';
  for (let k = 1; k < hist.length; k++) {
    const a = hist[k - 1];
    const b = hist[k];
    if (b.t - a.t > 5000) continue;
    g.strokeStyle = `rgb(${intensityToRgb(Math.max(a.v, b.v)).join(',')})`;
    g.beginPath();
    g.moveTo(x(a.t), y(a.v));
    g.lineTo(x(b.t), y(b.v));
    g.stroke();
  }
  const last = hist[hist.length - 1];
  g.fillStyle = `rgb(${intensityToRgb(last.v).join(',')})`;
  g.beginPath();
  g.arc(x(last.t), y(last.v), 3, 0, Math.PI * 2);
  g.fill();
}

function renderLegend() {
  const stops = [];
  for (let v = -3; v <= 7.001; v += 0.25) {
    stops.push(`rgb(${intensityToRgb(v).join(',')}) ${(((v + 3) / 10) * 100).toFixed(1)}%`);
  }
  $('legend-bar').style.background = `linear-gradient(to right, ${stops.join(',')})`;
  const ticks = $('legend-ticks');
  for (let v = -3; v <= 7; v++) {
    const s = document.createElement('span');
    s.style.left = `${((v + 3) / 10) * 100}%`;
    s.textContent = v;
    ticks.append(s);
  }
}

// ---------------------------------------------------------------------------
// 地震情報（P2P地震情報）
// ---------------------------------------------------------------------------

function renderQuakes() {
  const list = $('quake-list');
  list.replaceChildren();
  for (const q of state.quakes.slice(0, 15)) {
    const li = document.createElement('li');
    if (q === state.freshQuake) li.className = 'fresh';
    const row = document.createElement('div');
    row.className = 'quake-row';
    const cls = p2pScaleToClass(q.maxScale);
    const main = document.createElement('div');
    main.className = 'main';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = q.foreign ? `${q.name || '海外'}（遠地地震）` : (q.name || '震源を調査中');
    const sub = document.createElement('div');
    sub.className = 'sub';
    const bits = [Number.isFinite(q.time) ? `${formatJst(q.time, { seconds: false })}頃` : ''];
    if (q.magnitude != null) bits.push(`M${q.magnitude.toFixed(1)}`);
    if (q.depth != null) bits.push(q.depth === 0 ? 'ごく浅い' : `深さ${q.depth}km`);
    for (const b of bits.filter(Boolean)) {
      const span = document.createElement('span');
      span.textContent = b;
      sub.append(span);
    }
    main.append(name, sub);
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'play';
    playBtn.textContent = '再生';
    playBtn.title = 'この地震のリアルタイム震度を再生';
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startReplay(q.time - 10_000);
    });
    row.append(badge(cls), main);
    if (Number.isFinite(q.time) && !q.foreign) row.append(playBtn);
    row.addEventListener('click', () => {
      state.openQuake = state.openQuake === q.key ? null : q.key;
      renderQuakes();
    });
    li.append(row);
    if (state.openQuake === q.key) li.append(quakeDetail(q));
    list.append(li);
  }
  if (!state.quakes.length) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.style.padding = '8px 10px';
    li.textContent = '地震情報はまだありません';
    list.append(li);
  }
}

function quakeDetail(q) {
  const box = document.createElement('div');
  box.className = 'quake-detail';
  const ts = tsunamiText(q.tsunami);
  if (ts) {
    const p = document.createElement('p');
    p.className = 'tsunami';
    p.textContent = ts;
    box.append(p);
  }
  const byScale = new Map();
  for (const pt of q.points) {
    if (!byScale.has(pt.scale)) byScale.set(pt.scale, []);
    byScale.get(pt.scale).push(pt.addr);
  }
  const scales = [...byScale.keys()].sort((a, b) => b - a);
  if (!scales.length) {
    const p = document.createElement('div');
    p.className = 'muted';
    p.textContent = '各地の震度はまだ発表されていません';
    box.append(p);
  }
  for (const s of scales) {
    const names = byScale.get(s);
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('div');
    const shown = names.slice(0, 25).join('、');
    text.textContent = names.length > 25 ? `${shown} ほか${names.length - 25}地点` : shown;
    row.append(badge(p2pScaleToClass(s)), text);
    box.append(row);
  }
  return box;
}

const p2p = new P2PClient({
  onQuakes(list, updated, isNew) {
    state.quakes = list;
    if (updated) state.freshQuake = updated;
    if (isNew) play('info');
    $('p2p-status').textContent = 'P2P地震情報';
    renderQuakes();
  },
  onEew(eew) {
    state.p2pEew.set(eew.id, { eew, receivedAt: Date.now() });
    refreshEew();
  },
  onStatus(s) {
    if (s === 'error') $('p2p-status').textContent = '取得できません';
  },
});

// ---------------------------------------------------------------------------
// 再生（過去の日時）
// ---------------------------------------------------------------------------

function resetTimeline() {
  state.gen++;
  state.lastRequested = 0;
  state.lastRendered = 0;
  state.fails = 0;
  state.retryAt = 0;
  state.history = [];
  state.kmoniEew = null;
  detector.reset();
}

function clearDisplay() {
  state.shakeEvent = null;
  map.setData({ points: [], triggered: new Set(), event: null, est: null, ps: null });
  map.setMessage('読み込み中…');
  renderShake(null);
  refreshEew();
}

function startReplay(t) {
  if (!Number.isFinite(t)) return;
  t = Math.floor(t / 1000) * 1000;
  resetTimeline();
  state.mode = 'replay';
  Object.assign(state.replay, { base: t, wallStart: Date.now(), playing: true, pausedAt: t });
  clearDisplay();
  $('replay-bar').hidden = false;
  $('replay-time').textContent = formatJst(t);
  $('rp-toggle').textContent = '一時停止';
  $('mode-chip').className = 'chip chip-replay';
  $('mode-chip').textContent = '再生';
  updateUrl();
}

function replayPosition() {
  const r = state.replay;
  return r.playing ? r.base + Math.floor(((Date.now() - r.wallStart) * r.speed) / 1000) * 1000 : r.pausedAt;
}

function seekReplay(t) {
  const r = state.replay;
  const playing = r.playing;
  resetTimeline();
  Object.assign(r, { base: t, wallStart: Date.now(), pausedAt: t, playing });
}

function goLive() {
  resetTimeline();
  state.mode = 'live';
  state.replay.playing = false;
  clearDisplay();
  $('replay-bar').hidden = true;
  $('mode-chip').className = 'chip chip-live';
  $('mode-chip').textContent = 'ライブ';
  updateUrl();
}

function updateUrl() {
  try {
    const url = new URL(location.href);
    if (state.mode === 'replay') url.searchParams.set('replay', formatKmoniTime(state.replay.base));
    else url.searchParams.delete('replay');
    history.replaceState(null, '', url);
  } catch { /* 無視 */ }
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

function bindUi() {
  $('zoom-in').addEventListener('click', () => map.zoomBy(1.5));
  $('zoom-out').addEventListener('click', () => map.zoomBy(1 / 1.5));
  $('zoom-reset').addEventListener('click', () => map.fit());

  const soundBtn = $('btn-sound');
  const soundOpt = $('opt-sound');
  const applySound = () => {
    soundBtn.setAttribute('aria-pressed', String(settings.sound));
    soundOpt.checked = settings.sound;
  };
  const toggleSound = (on) => {
    settings.sound = on;
    saveSettings();
    applySound();
    if (on) {
      unlockAudio();
      play('info');
    }
  };
  soundBtn.addEventListener('click', () => toggleSound(!settings.sound));
  soundOpt.addEventListener('change', () => toggleSound(soundOpt.checked));
  applySound();
  // 音はユーザー操作の後でないと鳴らせないため、最初の操作で準備する
  const unlockOnce = () => {
    if (settings.sound) unlockAudio();
    window.removeEventListener('pointerdown', unlockOnce);
    window.removeEventListener('keydown', unlockOnce);
  };
  window.addEventListener('pointerdown', unlockOnce);
  window.addEventListener('keydown', unlockOnce);

  for (const radio of document.querySelectorAll('input[name="type"]')) {
    radio.checked = radio.value === settings.type;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      settings.type = radio.value;
      saveSettings();
      const pos = state.mode === 'replay' ? replayPosition() : null;
      if (pos !== null) seekReplay(pos); else resetTimeline();
    });
  }
  const overlays = $('opt-overlays');
  overlays.checked = settings.overlays;
  overlays.addEventListener('change', () => { settings.overlays = overlays.checked; saveSettings(); });
  const detect = $('opt-detect');
  detect.checked = settings.detect;
  detect.addEventListener('change', () => {
    settings.detect = detect.checked;
    saveSettings();
    detector.reset();
  });

  const preset = $('replay-preset');
  for (const [value, label] of PRESETS) preset.append(new Option(label, value));
  preset.addEventListener('change', () => {
    if (preset.value) $('replay-input').value = preset.value;
  });
  $('replay-input').value = PRESETS[0][0];
  $('replay-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = parseJst($('replay-input').value);
    if (!Number.isFinite(t)) return;
    if (t > Date.now() - 5000) { goLive(); return; }
    startReplay(t);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('rp-toggle').addEventListener('click', () => {
    const r = state.replay;
    if (r.playing) {
      r.pausedAt = Math.max(state.lastRendered || r.base, r.base);
      r.playing = false;
      $('rp-toggle').textContent = '再生';
    } else {
      Object.assign(r, { base: r.pausedAt, wallStart: Date.now(), playing: true });
      state.lastRequested = r.pausedAt;
      $('rp-toggle').textContent = '一時停止';
    }
  });
  $('rp-back').addEventListener('click', () => seekReplay(replayPosition() - 10_000));
  $('rp-fwd').addEventListener('click', () => seekReplay(replayPosition() + 10_000));
  $('rp-speed').addEventListener('click', () => {
    const r = state.replay;
    const pos = replayPosition();
    r.speed = r.speed === 1 ? 2 : 1;
    Object.assign(r, { base: pos, wallStart: Date.now() });
    $('rp-speed').textContent = `×${r.speed}`;
  });
  $('rp-live').addEventListener('click', goLive);

  document.addEventListener('visibilitychange', () => {
    // 裏に回っている間に溜まった遅れを持ち越さない
    if (!document.hidden && state.mode === 'live') state.lastCal = 0;
  });
}

async function loadBaseMap() {
  try {
    map.setBaseImage(await loadBitmap('/api/kmoni/basemap'));
  } catch (err) {
    console.warn('背景地図を取得できません（観測点のみ表示します）', err);
  }
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

if (location.protocol === 'file:') {
  // index.html を直接開いた場合は中継サーバーが無いので動かない
  alert('このページは index.html を直接開いても動きません。\nフォルダで npm start を実行し、表示された http://localhost:8080/ を開いてください。');
}

renderLegend();
bindUi();
renderQuakes();
loadBaseMap();
p2p.start();
map.setMessage('強震モニタに接続しています…');

const initialReplay = parseJst(new URLSearchParams(location.search).get('replay'));
if (Number.isFinite(initialReplay) && initialReplay < Date.now()) startReplay(initialReplay);

setInterval(tick, 200);
setInterval(refreshEew, 5000); // P2P地震情報の緊急地震速報を時間で消す
tick();
