import test from 'node:test';
import assert from 'node:assert/strict';
import { ShakeDetector } from '../public/js/detector.js';

// 格子状に並んだ観測点。shaking(x, y, sec) が値を返す観測点だけ揺らす
function frames(seconds, shaking = () => null) {
  const out = [];
  for (let s = 0; s < seconds; s++) {
    const points = [];
    for (let gx = 0; gx < 20; gx++) {
      for (let gy = 0; gy < 20; gy++) {
        const x = gx * 10; const y = gy * 10;
        const quiet = -1.5 + ((gx * 7 + gy * 3 + s) % 5) * 0.05;
        points.push({ key: y * 1000 + x, x, y, i: shaking(x, y, s) ?? quiet });
      }
    }
    out.push({ t: s * 1000, points });
  }
  return out;
}

test('静かなときは検知しない', () => {
  const d = new ShakeDetector();
  for (const f of frames(60)) {
    const r = d.update(f.points, f.t);
    assert.equal(r.event, null);
    assert.equal(r.triggered.size, 0);
  }
});

test('1つの観測点だけの雑音では検知しない', () => {
  const d = new ShakeDetector();
  for (const f of frames(60, (x, y, s) => (x === 50 && y === 50 && s > 30 ? 3 : null))) {
    assert.equal(d.update(f.points, f.t).event, null);
  }
});

test('近くの複数の観測点が揺れたら検知し、範囲と最大値を返す', () => {
  const d = new ShakeDetector();
  let first = null;
  let last = null;
  const shake = (x, y, s) => (s >= 30 && s < 45 && Math.hypot(x - 100, y - 100) <= 20 ? 2.8 : null);
  for (const f of frames(80, shake)) {
    const r = d.update(f.points, f.t);
    if (r.isNew) first = f.t;
    if (f.t === 32_000) last = { ...r, event: { ...r.event } }; // event は後のフレームで更新されるので写し取る
    if (f.t === 79_000) assert.equal(r.event, null, '揺れが収まって 15 秒以上たったら解除');
  }
  assert.equal(first, 30_000);
  assert.ok(last.event.active);
  assert.ok(last.triggered.size >= 3);
  assert.equal(last.event.peakClass.key, '3');
  assert.ok(last.event.x0 >= 80 && last.event.x1 <= 120);
});

test('揺れ始めの直後（ベースラインが落ち着く前）は検知しない', () => {
  const d = new ShakeDetector({ warmup: 10 });
  for (const f of frames(8, (x, y, s) => (s >= 3 && Math.hypot(x - 100, y - 100) <= 30 ? 3 : null))) {
    assert.equal(d.update(f.points, f.t).event, null);
  }
});
