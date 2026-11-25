#!/usr/bin/env node
// リアルタイム震度モニタ：静的ファイルの配信と、強震モニタ（防災科研）への中継サーバー。
// 強震モニタは CORS に対応していないため、ブラウザからは同じオリジンのこのサーバー経由で取得する。
// 同じ時刻のデータはキャッシュし、閲覧者が何人いても上流へのリクエストは 1 回にまとめる。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const DEFAULT_UPSTREAMS = [
  'http://www.kmoni.bosai.go.jp', // 強震モニタ
  'https://smi.lmoniexp.bosai.go.jp', // 長周期地震動モニタ（同じ形式のリアルタイム画像を配信）
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://api.p2pquake.net wss://api.p2pquake.net",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const TIME = '(\\d{14})';
const datePart = (ts) => ts.slice(0, 8);

/**
 * 中継できるパス。ブラウザから任意の URL を取得させないよう、ここに挙げた形だけを許可する。
 * ttl: 取得できたデータのキャッシュ時間、negTtl: 未公開（404 など）のときのキャッシュ時間
 */
const ROUTES = [
  {
    re: /^\/api\/kmoni\/latest$/,
    upstream: () => '/webservice/server/pros/latest.json',
    ttl: 1000, negTtl: 1000, browserCache: false,
  },
  {
    re: new RegExp(`^/api/kmoni/rt/(jma_s|jma_b)/${TIME}$`),
    upstream: (type, ts) => `/data/map_img/RealTimeImg/${type}/${datePart(ts)}/${ts}.${type}.gif`,
    ttl: 3600_000, negTtl: 1000, browserCache: true,
  },
  {
    re: new RegExp(`^/api/kmoni/ps/${TIME}$`),
    upstream: (ts) => `/data/map_img/PSWaveImg/eew/${datePart(ts)}/${ts}.eew.gif`,
    ttl: 3600_000, negTtl: 1000, browserCache: true,
  },
  {
    re: new RegExp(`^/api/kmoni/est/${TIME}$`),
    upstream: (ts) => `/data/map_img/EstShindoImg/eew/${datePart(ts)}/${ts}.eew.gif`,
    ttl: 3600_000, negTtl: 1000, browserCache: true,
  },
  {
    re: new RegExp(`^/api/kmoni/eew/${TIME}$`),
    upstream: (ts) => `/webservice/hypo/eew/${ts}.json`,
    // 速報が「無い」という応答は、直後に速報が出ることがあるので短く保持する
    ttl: 600_000, negTtl: 2000, browserCache: false,
    isPositive: (res) => res.status === 200 && /"report_id"\s*:\s*"[^"]+"/.test(res.body.toString('utf8')),
  },
  {
    re: /^\/api\/kmoni\/basemap$/,
    upstream: () => '/data/map_img/CommonImg/base_map_w.gif',
    ttl: 86_400_000, negTtl: 30_000, browserCache: true,
  },
];

export function createServer({
  upstreams = DEFAULT_UPSTREAMS,
  timeoutMs = 4000,
  maxCacheEntries = 2000,
  errorTtlMs = 1000, // 上流に接続できなかったことを覚えておく時間（再試行が上流に殺到しないように）
  userAgent = 'realtime-shindo-monitor/1.0',
  log = () => {},
} = {}) {
  const bases = upstreams.map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!bases.length) throw new Error('上流サーバーが指定されていません');
  const health = bases.map((base) => ({ base, ok: null, lastError: null, lastOkAt: null }));
  let preferred = 0;
  const cache = new Map(); // upstreamPath -> { status, type, body, expires }
  const inflight = new Map(); // upstreamPath -> Promise
  const stats = { upstreamRequests: 0, cacheHits: 0 };

  async function fetchFromUpstreams(upstreamPath) {
    let lastError;
    for (let n = 0; n < bases.length; n++) {
      const idx = (preferred + n) % bases.length;
      const h = health[idx];
      try {
        stats.upstreamRequests++;
        const res = await fetch(h.base + upstreamPath, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': userAgent },
          redirect: 'follow',
        });
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const body = Buffer.from(await res.arrayBuffer());
        Object.assign(h, { ok: true, lastOkAt: Date.now() });
        preferred = idx; // 応答した上流を次回から優先する
        return { status: res.status, type: res.headers.get('content-type'), body };
      } catch (err) {
        lastError = err;
        Object.assign(h, { ok: false, lastError: String(err?.cause?.code ?? err?.message ?? err) });
        log(`上流 ${h.base} に接続できません: ${h.lastError}`);
      }
    }
    throw lastError;
  }

  function getCached(route, upstreamPath) {
    const hit = cache.get(upstreamPath);
    if (hit && hit.expires > Date.now()) {
      stats.cacheHits++;
      if (hit.error) return Promise.reject(hit.error);
      cache.delete(upstreamPath); // LRU：末尾へ
      cache.set(upstreamPath, hit);
      return Promise.resolve({ ...hit, cache: 'HIT' });
    }
    if (inflight.has(upstreamPath)) return inflight.get(upstreamPath);

    const p = fetchFromUpstreams(upstreamPath)
      .then((res) => {
        const positive = route.isPositive ? route.isPositive(res) : res.status === 200;
        const entry = { ...res, positive, expires: Date.now() + (positive ? route.ttl : route.negTtl) };
        cache.set(upstreamPath, entry);
        while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
        return { ...entry, cache: 'MISS' };
      })
      .catch((error) => {
        cache.set(upstreamPath, { error, expires: Date.now() + errorTtlMs });
        throw error;
      })
      .finally(() => inflight.delete(upstreamPath));
    inflight.set(upstreamPath, p);
    return p;
  }

  async function handleApi(req, res, pathname) {
    if (pathname === '/api/health') {
      return sendJson(res, 200, { upstreams: health, cacheEntries: cache.size, ...stats });
    }
    for (const route of ROUTES) {
      const m = pathname.match(route.re);
      if (!m) continue;
      const upstreamPath = route.upstream(...m.slice(1));
      try {
        const r = await getCached(route, upstreamPath);
        const headers = {
          'content-type': r.type || guessType(upstreamPath),
          'x-cache': r.cache,
          'cache-control': route.browserCache && r.positive ? 'public, max-age=3600, immutable' : 'no-store',
        };
        res.writeHead(r.status, headers);
        return res.end(req.method === 'HEAD' ? undefined : r.body);
      } catch (err) {
        return sendJson(res, 502, { error: '強震モニタに接続できません', detail: String(err?.message ?? err) });
      }
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  async function handleStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 400, 'Bad Request');
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return sendText(res, 403, 'Forbidden');
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      return sendText(res, 404, 'Not Found');
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendText(res, 400, 'Bad Request');
    }
    try {
      if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
      else await handleStatic(req, res, pathname);
    } catch (err) {
      log(`内部エラー: ${err?.stack ?? err}`);
      if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
      else res.destroy();
    }
  });
  server.stats = stats;
  return server;
}

function guessType(p) {
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// `node server.js` で起動したときだけ待ち受ける（テストからは createServer を使う）
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '127.0.0.1';
  const upstreams = process.env.KMONI_UPSTREAMS ? process.env.KMONI_UPSTREAMS.split(',') : DEFAULT_UPSTREAMS;
  let lastLog = '';
  const server = createServer({
    upstreams,
    log: (msg) => {
      if (msg !== lastLog) console.warn(`[${new Date().toLocaleTimeString('ja-JP')}] ${msg}`);
      lastLog = msg;
    },
  });
  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`リアルタイム震度モニタ: http://${shown}:${port}/`);
    console.log(`データ取得元: ${upstreams.join(', ')}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
