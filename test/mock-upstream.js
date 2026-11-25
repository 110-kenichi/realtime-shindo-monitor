#!/usr/bin/env node
// 模擬の強震モニタ。本物と同じ URL 形式で、合成した観測点画像・緊急地震速報・背景地図を返す。
// 強震モニタに接続できない環境（国外など）での画面確認や、自動テストに使う。
//
//   node test/mock-upstream.js            # http://127.0.0.1:8090 で起動
//   MOCK_PORT=9000 node test/mock-upstream.js

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { encodePng } from './png.js';
import {
  IMAGE_WIDTH as W, IMAGE_HEIGHT as H, intensityToRgb, intensityToClass, formatKmoniTime, formatJst, parseJst,
} from '../public/js/kmoni.js';

// 模擬用の投影（経緯度 → 画素）。本物の強震モニタの投影とは一致しない。
const LON0 = 128; const LON1 = 146.5; const LAT0 = 46; const LAT1 = 30;
const toPx = (lon, lat) => [((lon - LON0) / (LON1 - LON0)) * W, ((LAT0 - lat) / (LAT0 - LAT1)) * H];
const toLonLat = (x, y) => [LON0 + (x / W) * (LON1 - LON0), LAT0 - (y / H) * (LAT0 - LAT1)];
const PX_PER_KM = 0.22;

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function distanceKm(lon1, lat1, lon2, lat2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** 日本の陸地の画素マスク（world-atlas の地形データから。無ければ大まかな楕円で代用） */
function buildLandMask() {
  const mask = new Uint8Array(W * H);
  let rings = [];
  try {
    const require = createRequire(import.meta.url);
    const topo = JSON.parse(readFileSync(require.resolve('world-atlas/countries-50m.json'), 'utf8'));
    const [sx, sy] = topo.transform.scale;
    const [tx, ty] = topo.transform.translate;
    const arcs = topo.arcs.map((arc) => {
      let x = 0; let y = 0;
      return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
    });
    const ringOf = (idxs) => idxs.flatMap((i, n) => {
      const a = i >= 0 ? arcs[i] : arcs[~i].slice().reverse();
      return n ? a.slice(1) : a;
    });
    const japan = topo.objects.countries.geometries.find((g) => g.id === '392');
    const polys = japan.type === 'Polygon' ? [japan.arcs] : japan.arcs;
    rings = polys.flatMap((poly) => poly.map(ringOf)).map((ring) => ring.map(([lon, lat]) => toPx(lon, lat)));
  } catch {
    const ellipse = (cx, cy, rx, ry, rot) => Array.from({ length: 48 }, (_, k) => {
      const a = (k / 48) * Math.PI * 2;
      const x = Math.cos(a) * rx; const y = Math.sin(a) * ry;
      return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)];
    });
    rings = [ellipse(290, 60, 45, 28, 0.2), ellipse(220, 190, 115, 26, -0.75), ellipse(70, 330, 30, 40, 0.3), ellipse(130, 300, 30, 12, 0)];
  }
  // 走査線で塗る（偶奇規則）
  for (let y = 0; y < H; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (const ring of rings) {
      for (let k = 0; k < ring.length; k++) {
        const [x1, y1] = ring[k];
        const [x2, y2] = ring[(k + 1) % ring.length];
        if ((y1 <= cy && y2 > cy) || (y2 <= cy && y1 > cy)) xs.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < Math.min(W, Math.floor(xs[k + 1] - 0.5) + 1); x++) mask[y * W + x] = 1;
    }
  }
  return mask;
}

function buildBaseMap(mask) {
  const rgba = new Uint8Array(W * H * 4).fill(255);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (!mask[k]) continue;
      const coast = (x > 0 && !mask[k - 1]) || (x < W - 1 && !mask[k + 1])
        || (y > 0 && !mask[k - W]) || (y < H - 1 && !mask[k + W]);
      const v = coast ? 110 : 214;
      rgba.set([v, v, v, 255], k * 4);
    }
  }
  return encodePng(W, H, rgba);
}

function placeStations(mask, { count = 1700, size = 1, seed = 42 } = {}) {
  const rnd = mulberry32(seed);
  const land = [];
  for (let k = 0; k < mask.length; k++) if (mask[k]) land.push(k);
  const minD2 = (size + 1.5) ** 2;
  const grid = new Map();
  const cell = (x, y) => `${Math.floor(x / 4)},${Math.floor(y / 4)}`;
  const stations = [];
  for (let tries = 0; tries < count * 30 && stations.length < count; tries++) {
    const k = land[Math.floor(rnd() * land.length)];
    const x = k % W; const y = (k - x) / W;
    if (x + size > W || y + size > H) continue;
    let ok = true;
    for (let gx = -1; gx <= 1 && ok; gx++) {
      for (let gy = -1; gy <= 1 && ok; gy++) {
        for (const s of grid.get(`${Math.floor(x / 4) + gx},${Math.floor(y / 4) + gy}`) ?? []) {
          if ((s.x - x) ** 2 + (s.y - y) ** 2 < minD2) { ok = false; break; }
        }
      }
    }
    if (!ok) continue;
    const [lon, lat] = toLonLat(x + size / 2, y + size / 2);
    const s = { x, y, lon, lat, base: -2.6 + rnd() * 2.0, id: stations.length };
    stations.push(s);
    const key = cell(x, y);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(s);
  }
  return stations;
}

export function createScenario({
  start = Date.now(), firstQuakeAfter = 20, period = 180, epicenter = [137.2, 37.5], depth = 10, magnitude = 7.0,
} = {}) {
  const [lon, lat] = epicenter;
  // 最大の揺れ（震源距離 R km でのリアルタイム震度）
  const peakAt = (R) => 6.7 - 3.3 * Math.log10(Math.max(R, 10) / 10);
  return {
    lon, lat, depth, magnitude, peakAt,
    /** 時刻 t（ms）に対応する地震の発生時刻（まだなら null） */
    originFor(t) {
      const first = Math.floor(start / 1000) * 1000 + firstQuakeAfter * 1000;
      if (t < first) return null;
      return first + Math.floor((t - first) / (period * 1000)) * period * 1000;
    },
  };
}

function stationIntensity(s, t, scenario, { borehole = false } = {}) {
  const sec = Math.floor(t / 1000);
  const noise = s.base + (hash(s.id, sec) - 0.5) * 0.3 - (borehole ? 0.6 : 0);
  const origin = scenario.originFor(t);
  if (origin === null) return noise;
  const e = (t - origin) / 1000;
  const R = Math.hypot(distanceKm(s.lon, s.lat, scenario.lon, scenario.lat), scenario.depth);
  const tp = R / 6.5; const ts = R / 3.6;
  const peak = scenario.peakAt(R) - (borehole ? 1.2 : 0) + (hash(s.id, 7) - 0.5) * 0.6;
  let v = -Infinity;
  if (e >= ts) {
    const rise = Math.min(1, (e - ts) / 3);
    const decay = Math.max(0, e - ts - 12) * 0.07;
    v = peak - 1.2 * (1 - rise) - decay;
  } else if (e >= tp) {
    v = peak - 2.2 - Math.max(0, 1.5 - (e - tp)) * 0.6;
  }
  return Math.min(7, Math.max(noise, v + (hash(s.id, sec + 99) - 0.5) * 0.2));
}

function renderRealtime(stations, size, t, scenario, opts) {
  const rgba = new Uint8Array(W * H * 4);
  for (const s of stations) {
    const [r, g, b] = intensityToRgb(stationIntensity(s, t, scenario, opts));
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) rgba.set([r, g, b, 255], ((s.y + dy) * W + s.x + dx) * 4);
    }
  }
  return encodePng(W, H, rgba);
}

function eewFor(t, scenario) {
  const ts = formatKmoniTime(t);
  const none = {
    result: { status: 'success', message: 'データがありません', is_auth: true },
    report_time: '', region_code: '', request_time: ts, region_name: '', longitude: '', is_cancel: '',
    depth: '', calcintensity: '', is_final: '', is_training: '', latitude: '', origin_time: '',
    security: { realm: '', hash: '' }, magunitude: '', report_num: '', request_hypo_type: '', report_id: '',
  };
  const origin = scenario.originFor(t);
  if (origin === null) return none;
  const e = (t - origin) / 1000;
  if (e < 4 || e > 150) return none;
  const n = Math.min(10, 1 + Math.floor((e - 4) / 3));
  const reportTime = origin + (4 + (n - 1) * 3) * 1000;
  const mag = Math.min(scenario.magnitude, 5.8 + n * 0.2);
  const est = intensityToClass(scenario.peakAt(scenario.depth) - (scenario.magnitude - mag) * 1.2);
  return {
    result: { status: 'success', message: '', is_auth: true },
    report_time: formatJst(reportTime),
    region_code: '390',
    request_time: ts,
    region_name: '石川県能登地方（模擬）',
    longitude: scenario.lon.toFixed(1),
    latitude: scenario.lat.toFixed(1),
    is_cancel: false,
    depth: `${scenario.depth}km`,
    calcintensity: est.label,
    is_final: n === 10,
    is_training: false,
    origin_time: formatKmoniTime(origin),
    security: { realm: '/kyoshin_monitor/static/jsondata/eew_est/', hash: '' },
    magunitude: mag.toFixed(1),
    report_num: String(n),
    request_hypo_type: 'eew',
    report_id: formatKmoniTime(origin + 3000),
    alertflg: n >= 2 ? '警報' : '予報',
  };
}

function renderPsWave(t, scenario) {
  const rgba = new Uint8Array(W * H * 4);
  const origin = scenario.originFor(t);
  const e = origin === null ? -1 : (t - origin) / 1000;
  const [cx, cy] = toPx(scenario.lon, scenario.lat);
  const ring = (radius, rgb) => {
    for (let a = 0; a < Math.PI * 2; a += 0.5 / Math.max(radius, 1)) {
      const x = Math.round(cx + Math.cos(a) * radius); const y = Math.round(cy + Math.sin(a) * radius);
      if (x >= 0 && y >= 0 && x < W && y < H) rgba.set([...rgb, 255], (y * W + x) * 4);
    }
  };
  if (e > 0) {
    ring(Math.sqrt(Math.max(0, (6.5 * e) ** 2 - scenario.depth ** 2)) * PX_PER_KM, [0, 90, 255]);
    ring(Math.sqrt(Math.max(0, (3.6 * e) ** 2 - scenario.depth ** 2)) * PX_PER_KM, [255, 30, 30]);
  }
  for (let d = -3; d <= 3; d++) {
    for (const [x, y] of [[cx + d, cy + d], [cx + d, cy - d]]) {
      const xi = Math.round(x); const yi = Math.round(y);
      if (xi >= 0 && yi >= 0 && xi < W && yi < H) rgba.set([255, 0, 0, 255], (yi * W + xi) * 4);
    }
  }
  return encodePng(W, H, rgba);
}

function renderEstShindo(mask, scenario) {
  const rgba = new Uint8Array(W * H * 4);
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    const x = k % W; const y = (k - x) / W;
    const [lon, lat] = toLonLat(x + 0.5, y + 0.5);
    const R = Math.hypot(distanceKm(lon, lat, scenario.lon, scenario.lat), scenario.depth);
    const cls = intensityToClass(scenario.peakAt(R));
    if (cls.key === '0') continue;
    const hex = cls.bg.slice(1);
    rgba.set([0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255), k * 4);
  }
  return encodePng(W, H, rgba);
}

export function startMockUpstream({
  port = 0, host = '127.0.0.1', stationSize = 1, scenario: scenarioOpts = {}, lagMs = 1000,
} = {}) {
  const mask = buildLandMask();
  const stations = placeStations(mask, { size: stationSize });
  const scenario = createScenario(scenarioOpts);
  const baseMap = buildBaseMap(mask);
  const estCache = renderEstShindo(mask, scenario);
  const stats = { requests: 0, paths: [] };

  const server = http.createServer((req, res) => {
    stats.requests++;
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    stats.paths.push(p);
    const latest = Math.floor((Date.now() - lagMs) / 1000) * 1000;
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    const notFound = () => send(404, 'text/html', '<h1>404 Not Found</h1>');
    const timeOk = (ts) => {
      const t = parseJst(ts);
      return Number.isFinite(t) && t <= latest ? t : null;
    };
    let m;
    if (p === '/webservice/server/pros/latest.json') {
      return send(200, 'application/json', JSON.stringify({
        latest_time: formatJst(latest), request_time: formatJst(Date.now()), result: { status: 'success', message: '' },
      }));
    }
    if (p === '/data/map_img/CommonImg/base_map_w.gif') return send(200, 'image/png', baseMap);
    if ((m = p.match(/^\/data\/map_img\/RealTimeImg\/(jma_s|jma_b)\/\d{8}\/(\d{14})\.(?:jma_s|jma_b)\.gif$/))) {
      const t = timeOk(m[2]);
      if (t === null) return notFound();
      return send(200, 'image/png', renderRealtime(stations, stationSize, t, scenario, { borehole: m[1] === 'jma_b' }));
    }
    if ((m = p.match(/^\/webservice\/hypo\/eew\/(\d{14})\.json$/))) {
      const t = timeOk(m[1]);
      if (t === null) return notFound();
      return send(200, 'application/json', JSON.stringify(eewFor(t, scenario)));
    }
    if ((m = p.match(/^\/data\/map_img\/PSWaveImg\/eew\/\d{8}\/(\d{14})\.eew\.gif$/))) {
      const t = timeOk(m[1]);
      if (t === null) return notFound();
      return send(200, 'image/png', renderPsWave(t, scenario));
    }
    if ((m = p.match(/^\/data\/map_img\/EstShindoImg\/eew\/\d{8}\/(\d{14})\.eew\.gif$/))) {
      if (timeOk(m[1]) === null) return notFound();
      return send(200, 'image/png', estCache);
    }
    return notFound();
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      resolve({
        server, stats, stations, scenario, url: `http://${host}:${actual}`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.MOCK_PORT) || 8090;
  const mock = await startMockUpstream({ port, stationSize: Number(process.env.MOCK_STATION_SIZE) || 1 });
  console.log(`模擬の強震モニタ: ${mock.url}（観測点 ${mock.stations.length} 点、20秒後から3分ごとに模擬地震）`);
}
