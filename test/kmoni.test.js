import test from 'node:test';
import assert from 'node:assert/strict';
import {
  colorToIntensity, intensityToRgb, intensityToClass, p2pScaleToClass, textToClass, analyzeImage, summarize,
  formatKmoniTime, formatJst, parseJst, parseKmoniEew, hsvToRgb, rgbToHsv,
} from '../public/js/kmoni.js';

test('強震モニタのスケール色をリアルタイム震度に変換できる', () => {
  // スケールの両端と代表的な色
  assert.ok(Math.abs(colorToIntensity(0, 0, 255) - -3) < 0.15, '青は -3 付近');
  assert.ok(Math.abs(colorToIntensity(255, 255, 0) - 2) < 0.3, '黄は 2 付近');
  assert.ok(Math.abs(colorToIntensity(255, 0, 0) - 5.9) < 0.2, '赤は 6 付近');
  assert.ok(colorToIntensity(170, 0, 0) > 6.8, '暗い赤は 7 付近');
  // スケール外（地図の白・灰・黒、透明部分）は null
  for (const rgb of [[255, 255, 255], [200, 200, 200], [128, 128, 128], [0, 0, 0], [20, 20, 30]]) {
    assert.equal(colorToIntensity(...rgb), null, rgb.join(','));
  }
});

test('色の変換はスケールに沿って単調に増える', () => {
  let prev = -Infinity;
  for (let h = 0.667; h > 0.002; h -= 0.001) {
    const v = colorToIntensity(...hsvToRgb(h, 1, 1));
    assert.ok(v >= prev - 1e-6, `h=${h.toFixed(3)} で減少`);
    prev = v;
  }
});

test('震度 → 色 → 震度 の往復で値が保たれる', () => {
  for (let i = -3; i <= 7; i += 0.1) {
    const back = colorToIntensity(...intensityToRgb(i));
    assert.ok(Math.abs(back - i) < 0.12, `${i.toFixed(1)} → ${back.toFixed(2)}`);
  }
});

test('HSV と RGB の相互変換', () => {
  for (const rgb of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 128, 0], [12, 200, 180]]) {
    const back = hsvToRgb(...rgbToHsv(...rgb));
    back.forEach((v, k) => assert.ok(Math.abs(v - rgb[k]) <= 1));
  }
});

test('計測震度から震度階級を決める（気象庁の境界値）', () => {
  const cases = [
    [-1.2, '0'], [0.44, '0'], [0.45, '1'], [0.5, '1'], [1.49, '2'], [2.5, '3'], [3.4, '3'], [3.5, '4'],
    [4.5, '5-'], [4.99, '5+'], [5.0, '5+'], [5.5, '6-'], [6.0, '6+'], [6.5, '7'], [7.2, '7'],
  ];
  for (const [i, key] of cases) assert.equal(intensityToClass(i).key, key, `I=${i}`);
  assert.equal(p2pScaleToClass(45).label, '5弱');
  assert.equal(p2pScaleToClass(70).label, '7');
  assert.equal(p2pScaleToClass(-1), null);
  assert.equal(textToClass('6強').key, '6+');
  assert.equal(textToClass('5-').key, '5-');
  assert.equal(textToClass('不明'), null);
});

function makeImage(width, height, stations, size) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const s of stations) {
    const rgb = intensityToRgb(s.i);
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) data.set([...rgb, 255], ((s.y + dy) * width + s.x + dx) * 4);
    }
  }
  return data;
}

for (const size of [1, 3]) {
  test(`画像から観測点を取り出せる（観測点の大きさ ${size}px）`, () => {
    const stations = [
      { x: 10, y: 10, i: -2.5 }, { x: 20, y: 12, i: 0.8 }, { x: 40, y: 40, i: 3.2 }, { x: 5, y: 45, i: 6.1 },
    ];
    const data = makeImage(60, 60, stations, size);
    // 背景地図の灰色や半透明の画素が混ざっていても無視されること
    data.set([180, 180, 180, 255], (30 * 60 + 30) * 4);
    data.set([255, 0, 0, 40], (50 * 60 + 50) * 4);
    const points = analyzeImage(data, 60, 60);
    assert.equal(points.length, stations.length);
    for (const s of stations) {
      const p = points.find((q) => Math.abs(q.x - (s.x + (size - 1) / 2)) < 0.01 && Math.abs(q.y - (s.y + (size - 1) / 2)) < 0.01);
      assert.ok(p, `(${s.x},${s.y}) が見つからない`);
      assert.ok(Math.abs(p.i - s.i) < 0.12, `${s.i} → ${p.i}`);
      assert.equal(p.size, size * size);
    }
    const sum = summarize(points);
    assert.equal(sum.total, 4);
    assert.equal(intensityToClass(sum.max.i).key, '6+');
    assert.equal(sum.counts['3'], 1);
  });
}

test('観測点の key は同じ位置なら毎回同じ', () => {
  const a = analyzeImage(makeImage(30, 30, [{ x: 3, y: 4, i: 1 }, { x: 20, y: 20, i: 2 }], 2), 30, 30);
  const b = analyzeImage(makeImage(30, 30, [{ x: 3, y: 4, i: 5 }, { x: 20, y: 20, i: -1 }], 2), 30, 30);
  assert.deepEqual(a.map((p) => p.key), b.map((p) => p.key));
});

test('日本時間の時刻の書式変換', () => {
  const t = Date.UTC(2024, 0, 1, 7, 10, 9); // 2024/01/01 16:10:09 JST
  assert.equal(formatKmoniTime(t), '20240101161009');
  assert.equal(formatJst(t), '2024/01/01 16:10:09');
  assert.equal(formatJst(t, { date: false, seconds: false }), '16:10');
  assert.equal(parseJst('2024/01/01 16:10:09'), t);
  assert.equal(parseJst('20240101161009'), t);
  assert.equal(parseJst('2024-01-01T16:10:09'), t);
  assert.equal(parseJst('2024-01-01T16:10'), t - 9000);
  assert.equal(parseJst('2026/11/25 23:17:10.261'), Date.UTC(2026, 10, 25, 14, 17, 10));
  assert.ok(Number.isNaN(parseJst('')));
  assert.ok(Number.isNaN(parseJst(null)));
});

test('強震モニタの緊急地震速報 JSON を解釈できる', () => {
  assert.equal(parseKmoniEew({ result: { message: 'データがありません' }, report_id: '' }), null);
  assert.equal(parseKmoniEew(null), null);
  const e = parseKmoniEew({
    result: { status: 'success', message: '' },
    report_time: '2024/01/01 16:10:32', region_name: '石川県能登地方', latitude: '37.6', longitude: '137.2',
    is_cancel: false, depth: '10km', calcintensity: '7', is_final: 'true', is_training: false,
    origin_time: '20240101161010', magunitude: '7.4', report_num: '5', report_id: '20240101161013', alertflg: '警報',
  });
  assert.equal(e.id, '20240101161013');
  assert.equal(e.serial, 5);
  assert.equal(e.isFinal, true);
  assert.equal(e.isWarning, true);
  assert.equal(e.depth, 10);
  assert.equal(e.magnitude, 7.4);
  assert.equal(e.maxClass.key, '7');
  assert.equal(e.originTime, Date.UTC(2024, 0, 1, 7, 10, 10));
});
