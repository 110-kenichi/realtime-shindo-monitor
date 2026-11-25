import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../lib/server.js';
import { groupQuakes } from '../lib/archive.js';
import { startMockUpstream } from './mock-upstream.js';
import { formatJst, formatKmoniTime } from '../public/js/kmoni.js';

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

const quakeMsg = (time, maxScale, name = 'テスト震源') => ({
  code: 551,
  earthquake: { time: formatJst(time), maxScale, domesticTsunami: 'None', hypocenter: { name, magnitude: 5.1, depth: 10, latitude: 37, longitude: 137 } },
  issue: { type: 'DetailScale', time: formatJst(time + 120_000) },
  points: [],
});

test('P2P地震情報の発表を地震ごとにまとめる', () => {
  const t = Date.UTC(2026, 0, 1, 0, 0);
  const qs = groupQuakes([
    { code: 551, earthquake: { time: formatJst(t), maxScale: 30, hypocenter: { name: '' } }, issue: { type: 'ScalePrompt' } },
    quakeMsg(t, -1),
    { code: 551, earthquake: { time: formatJst(t + 60_000), maxScale: -1, hypocenter: { name: 'X' } }, issue: { type: 'Foreign' } },
    { code: 556 },
  ]);
  assert.equal(qs.length, 2);
  assert.equal(qs[0].maxScale, 30);
  assert.equal(qs[0].name, 'テスト震源');
  assert.equal(qs[1].foreign, true);
});

test('地震の前後を保存し、強震モニタから消えた後も保存データを返す', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shindo-archive-'));
  const origin = Math.floor((Date.now() - 330_000) / 60_000) * 60_000; // 5〜6 分前の「分」ちょうど
  const mock = await startMockUpstream({ scenario: { start: origin, firstQuakeAfter: 0, period: 100_000 } });
  // 保存対象：震度4。対象外：震度1、2 時間前の震度5強
  const p2p = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([quakeMsg(origin, 40), quakeMsg(origin - 600_000, 10, '小さい地震'), quakeMsg(origin - 7_200_000, 50, '古い地震')]));
  });
  const p2pUrl = await listen(p2p);
  t.after(async () => { await close(p2p); await mock.close(); await rm(dir, { recursive: true, force: true }); });

  const app = createServer({
    upstreams: [mock.url],
    archive: { dir, p2pUrl, beforeSec: 3, afterSec: 6, pollMs: 3_600_000 },
  });
  const base = await listen(app);
  for (let k = 0; k < 100 && !app.archive.items.length; k++) await new Promise((r) => setTimeout(r, 100));
  const list = await (await fetch(`${base}/api/archive`)).json();
  await close(app);

  assert.equal(list.enabled, true);
  assert.equal(list.items.length, 1, '震度3以上で新しい地震だけを保存する');
  const item = list.items[0];
  assert.equal(item.name, 'テスト震源');
  assert.equal(item.frames, 10);
  assert.equal(item.start, origin - 3000);
  const days = await readdir(dir);
  assert.ok(days.includes('index.json'));

  // 強震モニタに接続できない状態で、同じフォルダから返せること
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await close(dead);
  const offline = createServer({ upstreams: [deadUrl], timeoutMs: 500, archive: { dir, p2pUrl, pollMs: 3_600_000 } });
  await offline.archiveReady;
  const b2 = await listen(offline);
  t.after(() => close(offline));

  for (const kind of ['jma_s', 'jma_b']) {
    const r = await fetch(`${b2}/api/kmoni/rt/${kind}/${formatKmoniTime(origin + 2000)}`);
    assert.equal(r.status, 200, kind);
    assert.equal(r.headers.get('x-cache'), 'ARCHIVE');
    assert.equal(r.headers.get('content-type'), 'image/png');
    await r.arrayBuffer();
  }
  // 模擬の緊急地震速報は発生 4 秒後から出る
  const eew = await fetch(`${b2}/api/kmoni/eew/${formatKmoniTime(origin + 5000)}`);
  assert.equal(eew.headers.get('x-cache'), 'ARCHIVE');
  assert.ok((await eew.json()).report_id);
  for (const kind of ['ps', 'est']) {
    const r = await fetch(`${b2}/api/kmoni/${kind}/${formatKmoniTime(origin + 5000)}`);
    assert.equal(r.status, 200, kind);
    await r.arrayBuffer();
  }
  // 保存範囲の外は上流へ取りに行き、接続できないので 502
  const outside = await fetch(`${b2}/api/kmoni/rt/jma_s/${formatKmoniTime(origin + 60_000)}`);
  assert.equal(outside.status, 502);
  await outside.arrayBuffer();
});

test('ARCHIVE を指定しなければ記録しない', async () => {
  const app = createServer({ upstreams: ['http://127.0.0.1:9'] });
  const base = await listen(app);
  const j = await (await fetch(`${base}/api/archive`)).json();
  assert.deepEqual(j, { enabled: false, minScale: null, items: [] });
  await close(app);
});
