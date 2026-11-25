import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../lib/server.js';
import { startMockUpstream } from './mock-upstream.js';
import { formatKmoniTime } from '../public/js/kmoni.js';

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

test('中継サーバー', async (t) => {
  const mock = await startMockUpstream({ scenario: { start: Date.now() - 120_000, firstQuakeAfter: 60 } });
  // 1 つ目の上流は接続できないアドレス。2 つ目（模擬）に切り替わることも確認する
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await close(dead);
  const app = createServer({ upstreams: [deadUrl, mock.url], timeoutMs: 2000 });
  const base = await listen(app);
  t.after(async () => { await close(app); await mock.close(); });

  const ts = formatKmoniTime(Date.now() - 30_000); // 模擬地震の発生から 30 秒後

  await t.test('最新時刻を中継する（接続できない上流は飛ばす）', async () => {
    const res = await fetch(`${base}/api/kmoni/latest`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.match(j.latest_time, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.upstreams[0].ok, false);
    assert.equal(health.upstreams[1].ok, true);
  });

  await t.test('リアルタイム震度画像を中継し、同じ時刻はキャッシュから返す', async () => {
    const before = mock.stats.requests;
    const r1 = await fetch(`${base}/api/kmoni/rt/jma_s/${ts}`);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-cache'), 'MISS');
    assert.match(r1.headers.get('cache-control'), /max-age/);
    const body = Buffer.from(await r1.arrayBuffer());
    assert.equal(body.subarray(1, 4).toString(), 'PNG');
    const r2 = await fetch(`${base}/api/kmoni/rt/jma_s/${ts}`);
    assert.equal(r2.headers.get('x-cache'), 'HIT');
    await r2.arrayBuffer();
    assert.equal(mock.stats.requests - before, 1);
    assert.ok(mock.stats.paths.includes(`/data/map_img/RealTimeImg/jma_s/${ts.slice(0, 8)}/${ts}.jma_s.gif`));
  });

  await t.test('同時に来た同じリクエストは上流へ 1 回だけ送る', async () => {
    const ts2 = formatKmoniTime(Date.now() - 40_000);
    const before = mock.stats.requests;
    const results = await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/api/kmoni/rt/jma_b/${ts2}`)));
    for (const r of results) { assert.equal(r.status, 200); await r.arrayBuffer(); }
    assert.equal(mock.stats.requests - before, 1);
  });

  await t.test('緊急地震速報 JSON と P波/S波・推定震度画像を中継する', async () => {
    const eew = await (await fetch(`${base}/api/kmoni/eew/${ts}`)).json();
    assert.ok(eew.report_id);
    assert.equal(eew.alertflg, '警報');
    for (const kind of ['ps', 'est']) {
      const r = await fetch(`${base}/api/kmoni/${kind}/${ts}`);
      assert.equal(r.status, 200, kind);
      await r.arrayBuffer();
    }
    const base2 = await fetch(`${base}/api/kmoni/basemap`);
    assert.equal(base2.status, 200);
    await base2.arrayBuffer();
  });

  await t.test('未公開の時刻は 404 をそのまま返し、ブラウザにはキャッシュさせない', async () => {
    const future = formatKmoniTime(Date.now() + 60_000);
    const r = await fetch(`${base}/api/kmoni/rt/jma_s/${future}`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    await r.arrayBuffer();
  });

  await t.test('決められた形以外のパスは中継しない', async () => {
    for (const p of [
      '/api/kmoni/rt/jma_s/2024', '/api/kmoni/rt/acmap_s/20240101000000', '/api/kmoni/rt/jma_s/../../etc',
      '/api/kmoni/eew/20240101000000.json', '/api/proxy?url=http://example.com',
    ]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 404, p);
      await r.arrayBuffer();
    }
  });

  await t.test('画面のファイルを配信し、public の外は読ませない', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /connect-src 'self' https:\/\/api\.p2pquake\.net/);
    assert.match(await r.text(), /リアルタイム震度モニタ/);
    const js = await fetch(`${base}/js/kmoni.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
    await js.text();
    for (const p of ['/%2e%2e/server.js', '/..%2fpackage.json', '/js/../../server.js']) {
      const res = await fetch(base + p);
      assert.ok([403, 404].includes(res.status), `${p} → ${res.status}`);
      await res.arrayBuffer();
    }
    const post = await fetch(`${base}/api/kmoni/latest`, { method: 'POST' });
    assert.equal(post.status, 405);
    await post.arrayBuffer();
  });

  await t.test('どの上流にも接続できなければ 502', async () => {
    const dead2 = http.createServer();
    const url = await listen(dead2);
    await close(dead2);
    const lonely = createServer({ upstreams: [url], timeoutMs: 1000 });
    const b = await listen(lonely);
    const r = await fetch(`${b}/api/kmoni/latest`);
    assert.equal(r.status, 502);
    await r.json();
    // 直後の同じリクエストは上流に送らず、すぐ 502 を返す
    const before = lonely.stats.upstreamRequests;
    const r2 = await fetch(`${b}/api/kmoni/latest`);
    assert.equal(r2.status, 502);
    await r2.json();
    assert.equal(lonely.stats.upstreamRequests, before);
    await close(lonely);
  });
});
